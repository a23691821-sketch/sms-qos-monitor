const express = require("express");
const db = require("./../db");
const { extractCode } = require("./../idgen");
const { applyTestResult } = require("./../testsmsRunner");

const router = express.Router();

// Appelé par l'app Android à chaque SMS reçu sur le téléphone de test.
// Body attendu: { apiKey, from, body, receivedAt (ISO, horloge du téléphone) }
router.post("/sms-received", (req, res) => {
  const { apiKey, from, body, receivedAt } = req.body || {};

  if (!apiKey || !body) {
    return res.status(400).json({ error: "apiKey et body sont requis" });
  }

  const device = db.prepare(`SELECT * FROM devices WHERE api_key = ?`).get(apiKey);
  if (!device) return res.status(401).json({ error: "apiKey invalide" });

  db.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`).run(new Date().toISOString(), device.id);

  const code = extractCode(body);
  if (!code) {
    // SMS reçu sur le device de test mais qui n'est pas un SMS de test QoS : on l'ignore silencieusement
    return res.json({ matched: false, reason: "aucun code QOS-TEST trouvé dans le message" });
  }

  const testMsg = db.prepare(`SELECT * FROM test_messages WHERE code = ?`).get(code);
  if (!testMsg) {
    return res.json({ matched: false, reason: "code inconnu (expiré ou déjà nettoyé ?)" });
  }

  if (testMsg.received_at) {
    // Déjà corrélé (ex: retry réseau de l'app) -> idempotent, on ne recalcule rien
    return res.json({ matched: true, alreadyCorrelated: true });
  }

  const receivedTs = receivedAt || new Date().toISOString();
  const latencyMs = new Date(receivedTs).getTime() - new Date(testMsg.sent_at).getTime();

  db.prepare(`
    UPDATE test_messages
    SET received_at = ?, received_from_number = ?, received_body = ?, latency_ms = ?, final_status = 'delivered'
    WHERE id = ?
  `).run(receivedTs, from || null, body, latencyMs, testMsg.id);

  res.json({ matched: true, code, latencyMs });
});

// Heartbeat périodique envoyé par l'app Android (indépendamment de toute
// réception de SMS), pour savoir si le téléphone/l'app est vivant même sans
// trafic de test en cours. Body attendu: { apiKey }
router.post("/heartbeat", (req, res) => {
  const { apiKey } = req.body || {};
  // Log temporaire de debug (device "Free" resté bloqué sur "Inconnu" malgré
  // une app à jour) : permet de voir si l'appareil appelle bien ce endpoint,
  // et avec quelle clé, sans exposer la clé complète dans les logs. À
  // retirer une fois le problème confirmé/résolu.
  const keyPreview = apiKey ? `${String(apiKey).slice(0, 6)}…(${String(apiKey).length} car.)` : "(absente)";
  console.log(`[heartbeat] reçu à ${new Date().toISOString()} — clé: ${keyPreview}`);

  if (!apiKey) return res.status(400).json({ error: "apiKey requis" });

  const device = db.prepare(`SELECT id, name FROM devices WHERE api_key = ?`).get(apiKey);
  if (!device) {
    console.log(`[heartbeat] clé inconnue (${keyPreview}) — aucun appareil ne correspond`);
    return res.status(401).json({ error: "apiKey invalide" });
  }
  console.log(`[heartbeat] appareil reconnu: "${device.name}" (id ${device.id})`);

  db.prepare(`UPDATE devices SET last_heartbeat_at = ? WHERE id = ?`).run(new Date().toISOString(), device.id);
  res.json({ ok: true });
});

// DLR (accusé de livraison) envoyé de manière asynchrone par le fournisseur.
// Chaque fournisseur a son propre format et vocabulaire de statut — plutôt que
// de deviner à l'avance, on : (1) accepte GET et POST, JSON ou query string,
// (2) essaie plusieurs noms de champs courants pour l'ID de message et le
// statut, (3) journalise TOUJOURS le payload brut dans dlr_events, matché ou
// non, pour pouvoir regarder ce qu'un fournisseur envoie réellement et ajuster
// les noms de champs ci-dessous si besoin.
const MESSAGE_ID_FIELDS = ["messageId", "message_id", "id_state", "id", "sms_id", "smsId"];
const STATUS_FIELDS = ["status", "state", "dlr_status", "delivery_status"];
const DELIVERED_SYNONYMS = new Set([
  "delivered", "delivered_to_terminal", "success", "ok", "3", "true",
  "delivrd", // Emettance envoie l'état SMPP brut "DELIVRD"
]);

function firstDefined(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return null;
}

function normalizeStatus(rawStatus) {
  if (rawStatus == null) return "unknown";
  const s = String(rawStatus).toLowerCase();
  return DELIVERED_SYNONYMS.has(s) ? "delivered" : s;
}

// Extrait une ou plusieurs entrées (idState, status) d'un payload de DLR.
// Deux formats sont supportés :
//  1. Plat : les champs id/status sont directement à la racine du payload
//     (format générique attendu par défaut).
//  2. Emettance : un objet dont les clés sont des index numériques ("0", "1", ...
//     un par partie de SMS), chacun contenant { id_state, state, ... }. Utile
//     aussi pour les envois multi-parties (num_parts > 1).
function extractEntries(payload) {
  const flatId = firstDefined(payload, MESSAGE_ID_FIELDS);
  if (flatId) {
    return [{ idState: flatId, status: firstDefined(payload, STATUS_FIELDS) }];
  }

  const entries = [];
  for (const key of Object.keys(payload)) {
    const val = payload[key];
    if (val && typeof val === "object") {
      const idState = firstDefined(val, MESSAGE_ID_FIELDS);
      if (idState) {
        entries.push({ idState, status: firstDefined(val, STATUS_FIELDS) });
      }
    }
  }
  return entries;
}

function handleDlr(req, res) {
  const providerId = req.params.providerId;
  const payload = { ...req.query, ...(req.body || {}) };

  const dlrEventInsert = db
    .prepare(`INSERT INTO dlr_events (provider_id, matched_test_id, raw_body) VALUES (?, NULL, ?)`)
    .run(providerId, JSON.stringify(payload));

  const entries = extractEntries(payload);

  if (!entries.length) {
    console.warn(`[dlr:${providerId}] payload sans ID de message reconnu:`, JSON.stringify(payload));
    return res.json({ matched: false, reason: "aucun champ d'ID de message reconnu, voir dlr_events pour le payload brut" });
  }

  const results = [];
  let firstMatchedTestId = null;

  for (const entry of entries) {
    const idState = String(entry.idState);
    const testMsg = db
      .prepare(`SELECT * FROM test_messages WHERE provider_message_id = ? OR provider_message_id LIKE ?`)
      .get(idState, `${idState}.%`);

    if (!testMsg) {
      console.warn(`[dlr:${providerId}] aucun test correspondant à idState=${idState}`);
      results.push({ idState, matched: false });
      continue;
    }

    const normalizedStatus = normalizeStatus(entry.status);
    const dlrAt = new Date().toISOString();
    const dlrLatency = new Date(dlrAt).getTime() - new Date(testMsg.sent_at).getTime();

    db.prepare(`
      UPDATE test_messages SET dlr_status = ?, dlr_at = ?, dlr_latency_ms = ? WHERE id = ?
    `).run(normalizedStatus, dlrAt, dlrLatency, testMsg.id);

    if (firstMatchedTestId === null) firstMatchedTestId = testMsg.id;
    results.push({ idState, matched: true, testId: testMsg.id, normalizedStatus });
  }

  db.prepare(`UPDATE dlr_events SET matched_test_id = ? WHERE id = ?`).run(
    firstMatchedTestId,
    dlrEventInsert.lastInsertRowid
  );

  res.json({ matched: firstMatchedTestId !== null, results });
}

router.post("/dlr/:providerId", handleDlr);
router.get("/dlr/:providerId", handleDlr);

// Callback appelé par TestSMS.com dès qu'un résultat de test est disponible
// (voir testsmsRunner.js : callbackUrl transmis à chaque createTest). Payload
// attendu de même forme que GET /v1/smsTest/:id (testId, messageId,
// receiptStatus, deliveredSender, deliveredText, phone, pdu, scts, scn,
// arrivalTs, price, currency, billingStatus, chargedAt...). On matche sur
// testId (colonne testsms_test_id), pas sur messageId, pour rester robuste
// même si TestSMS réutilisait un jour un messageId sur deux tests différents.
router.post("/testsms-callback", (req, res) => {
  const payload = req.body || {};
  const testsmsTestId = payload.testId ?? payload.id;

  if (testsmsTestId == null) {
    console.warn("[testsms-callback] payload sans testId:", JSON.stringify(payload));
    return res.json({ matched: false, reason: "testId manquant dans le payload" });
  }

  const outcome = applyTestResult(testsmsTestId, payload);
  if (!outcome.matched) {
    console.warn(`[testsms-callback] aucun test local pour testsms_test_id=${testsmsTestId}`);
  }
  res.json(outcome);
});

module.exports = router;
