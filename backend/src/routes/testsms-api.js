const express = require("express");
const axios = require("axios");
const db = require("./../db");
const testsms = require("./../providers/testsms");
const { loadProviderConfigs } = require("./../providers");
const { runTestSmsTest, applyTestResult } = require("./../testsmsRunner");
const { isPaused } = require("./../scheduler");

const router = express.Router();

// Même garde que api.js : clé admin en header, pas de session (ces endpoints
// envoient des SMS réels et consomment du crédit TestSMS, donc même niveau de
// protection que /routes, /devices, /tests).
function requireAdmin(req, res, next) {
  const key = req.header("x-admin-key");
  if (key !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: "clé admin invalide" });
  next();
}
router.use(requireAdmin);

// ---------- Réseaux disponibles (pays/opérateurs couverts par TestSMS) ----------

// "À la demande" : toujours interrogé en direct chez TestSMS (voir le cache
// court dans providers/testsms.js), jamais une liste figée dans notre code —
// pour couvrir la totalité des pays/opérateurs qu'ils proposent, y compris
// quand leur catalogue change.
router.get("/networks", async (req, res) => {
  try {
    const networks = await testsms.getNetworks({ forceRefresh: req.query.refresh === "1" });
    res.json(networks);
  } catch (err) {
    console.error("[testsms] GET /networks erreur:", err.response?.status, JSON.stringify(err.response?.data) || err.message);
    res.status(502).json({ error: String(err.response?.data?.message || err.response?.data?.error || err.message || err) });
  }
});

router.get("/balance", async (req, res) => {
  try {
    const token = await testsms.getAccessToken();
    const response = await axios.get("https://api.testsms.com/api/v1/balance", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 15000,
    });
    res.json(response.data);
  } catch (err) {
    console.error("[testsms] GET /balance erreur:", err.response?.status, JSON.stringify(err.response?.data) || err.message);
    res.status(502).json({ error: String(err.response?.data?.message || err.response?.data?.error || err.message || err) });
  }
});

// Fournisseurs sortants disponibles pour envoyer le SMS vers le numéro
// TestSMS (ce sont les mêmes que config/providers.json utilisé par les
// routes classiques — aucune config dupliquée).
router.get("/outbound-providers", (req, res) => {
  try {
    res.json(Object.keys(loadProviderConfigs()));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------- Schedules (tests TestSMS répétés automatiquement) ----------

router.get("/schedules", (req, res) => {
  res.json(db.prepare(`SELECT * FROM testsms_schedules ORDER BY id DESC`).all());
});

// Deux modes : un réseau précis (mccmnc requis) OU "pays entier" (isCountry +
// countryIso requis, mccmnc/network ignorés — la liste des opérateurs natifs
// est re-résolue à chaque exécution, voir scheduler.js::resolveScheduleNetworks).
router.post("/schedules", (req, res) => {
  const {
    name, isCountry, countryIso, mccmnc, mccmncOriginal, country, network,
    outboundProviderId, senderId, intervalMinutes,
  } = req.body || {};

  if (!name || !outboundProviderId) {
    return res.status(400).json({ error: "name et outboundProviderId requis" });
  }
  if (isCountry && !countryIso) {
    return res.status(400).json({ error: "countryIso requis en mode pays entier" });
  }
  if (!isCountry && !mccmnc) {
    return res.status(400).json({ error: "mccmnc requis (ou isCountry + countryIso pour un pays entier)" });
  }

  const { lastInsertRowid } = db
    .prepare(`
      INSERT INTO testsms_schedules
        (name, mccmnc, mccmnc_original, country, network, outbound_provider_id, sender_id,
         interval_minutes, active, is_country, country_iso)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `)
    .run(
      name,
      isCountry ? countryIso : mccmnc, // satisfait la contrainte NOT NULL ; sans signification propre en mode pays
      isCountry ? null : (mccmncOriginal || null),
      country || null,
      isCountry ? null : (network || null),
      outboundProviderId,
      senderId && senderId.trim() ? senderId.trim() : null,
      intervalMinutes || 60,
      isCountry ? 1 : 0,
      isCountry ? countryIso : null
    );
  res.json({ id: lastInsertRowid });
});

router.patch("/schedules/:id", (req, res) => {
  const { active, intervalMinutes, name } = req.body || {};
  const schedule = db.prepare(`SELECT * FROM testsms_schedules WHERE id = ?`).get(req.params.id);
  if (!schedule) return res.status(404).json({ error: "schedule introuvable" });

  db.prepare(`
    UPDATE testsms_schedules SET
      active = COALESCE(?, active),
      interval_minutes = COALESCE(?, interval_minutes),
      name = COALESCE(?, name)
    WHERE id = ?
  `).run(active === undefined ? null : (active ? 1 : 0), intervalMinutes || null, name || null, req.params.id);

  res.json({ ok: true });
});

router.delete("/schedules/:id", (req, res) => {
  db.prepare(`DELETE FROM testsms_schedules WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ---------- Tests (manuel immédiat + historique) ----------

// `networks` : tableau de { mccmnc, mccmncOriginal?, country, network }, un
// élément = test normal, plusieurs = "pays entier" (le dashboard envoie déjà
// tous les opérateurs natifs du pays choisi, depuis sa liste en cache).
router.post("/tests", async (req, res) => {
  if (isPaused()) {
    return res.status(409).json({ error: "Envoi de SMS en pause — reprends l'envoi depuis la sidebar pour lancer un test." });
  }
  const { networks, outboundProviderId, senderId } = req.body || {};
  if (!Array.isArray(networks) || !networks.length || !outboundProviderId) {
    return res.status(400).json({ error: "networks (tableau non vide) et outboundProviderId requis" });
  }
  try {
    const { batchId, testIds } = await runTestSmsTest({ networks, outboundProviderId, senderId, triggerType: "manual" });
    res.json({ ok: true, batchId, testIds });
  } catch (err) {
    res.status(502).json({ error: String(err.response?.data?.message || err.message || err) });
  }
});

// Vue groupée d'un lot (ex: test "pays entier" = plusieurs lignes créées en
// une seule requête /tests) — utilisée par le dashboard pour suivre en direct
// toutes les lignes d'un même lancement sans connaître leurs ids individuels.
router.get("/tests/batch/:batchId", (req, res) => {
  const rows = db.prepare(`SELECT * FROM testsms_tests WHERE batch_id = ? ORDER BY id`).all(req.params.batchId);
  res.json(rows);
});

// since/until (ISO 8601, optionnels) : mêmes filtres rapides "Dernière heure /
// Aujourd'hui / Hier" que sur /api/tests et /api/stats/recent.
router.get("/tests", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
  const { since, until } = req.query;

  const conditions = [];
  const params = [];
  if (["scheduled", "manual"].includes(req.query.triggerType)) {
    conditions.push("trigger_type = ?");
    params.push(req.query.triggerType);
  }
  if (since) { conditions.push("created_at >= ?"); params.push(since); }
  if (until) { conditions.push("created_at <= ?"); params.push(until); }
  params.push(limit);

  const rows = db
    .prepare(`
      SELECT * FROM testsms_tests
      ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}
      ORDER BY id DESC LIMIT ?
    `)
    .all(...params);
  res.json(rows);
});

router.get("/tests/:id", (req, res) => {
  const test = db.prepare(`SELECT * FROM testsms_tests WHERE id = ?`).get(req.params.id);
  if (!test) return res.status(404).json({ error: "test introuvable" });
  res.json(test);
});

// Force une relecture immédiate du résultat côté TestSMS (bouton "Rafraîchir"
// sur un test encore pending dans le dashboard), sans attendre le prochain
// cycle de polling automatique.
router.post("/tests/:id/refresh", async (req, res) => {
  const test = db.prepare(`SELECT * FROM testsms_tests WHERE id = ?`).get(req.params.id);
  if (!test) return res.status(404).json({ error: "test introuvable" });
  if (!test.testsms_test_id) return res.status(409).json({ error: "test pas encore créé côté TestSMS" });

  try {
    const result = await testsms.getTestResult(test.testsms_test_id);
    const outcome = applyTestResult(test.testsms_test_id, result);
    res.json(outcome);
  } catch (err) {
    res.status(502).json({ error: String(err.response?.data?.message || err.message || err) });
  }
});

module.exports = router;
