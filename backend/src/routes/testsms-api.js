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
    res.status(502).json({ error: String(err.response?.data?.message || err.message || err) });
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
    res.status(502).json({ error: String(err.response?.data?.message || err.message || err) });
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

router.post("/schedules", (req, res) => {
  const { name, mccmnc, mccmncOriginal, country, network, outboundProviderId, senderId, intervalMinutes } =
    req.body || {};
  if (!name || !mccmnc || !outboundProviderId) {
    return res.status(400).json({ error: "name, mccmnc, outboundProviderId requis" });
  }
  const { lastInsertRowid } = db
    .prepare(`
      INSERT INTO testsms_schedules
        (name, mccmnc, mccmnc_original, country, network, outbound_provider_id, sender_id, interval_minutes, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `)
    .run(
      name,
      mccmnc,
      mccmncOriginal || null,
      country || null,
      network || null,
      outboundProviderId,
      senderId && senderId.trim() ? senderId.trim() : null,
      intervalMinutes || 60
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

router.post("/tests", async (req, res) => {
  if (isPaused()) {
    return res.status(409).json({ error: "Envoi de SMS en pause — reprends l'envoi depuis la sidebar pour lancer un test." });
  }
  const { mccmnc, mccmncOriginal, country, network, outboundProviderId, senderId } = req.body || {};
  if (!mccmnc || !outboundProviderId) {
    return res.status(400).json({ error: "mccmnc et outboundProviderId requis" });
  }
  try {
    const localId = await runTestSmsTest({
      mccmnc,
      mccmncOriginal,
      country,
      network,
      outboundProviderId,
      senderId,
      triggerType: "manual",
    });
    res.json({ ok: true, testId: localId });
  } catch (err) {
    res.status(502).json({ error: String(err.response?.data?.message || err.message || err) });
  }
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
