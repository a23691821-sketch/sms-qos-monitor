const express = require("express");
const db = require("./../db");
const { extractCode } = require("./../idgen");

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
    SET received_at = ?, received_from_number = ?, latency_ms = ?, final_status = 'delivered'
    WHERE id = ?
  `).run(receivedTs, from || null, latencyMs, testMsg.id);

  res.json({ matched: true, code, latencyMs });
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
const DELIVERED_SYNONYMS = new Set(["delivered", "delivered_to_terminal", "success", "ok", "3", "true"]);

function firstDefined(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return null;
}

function handleDlr(req, res) {
  const providerId = req.params.providerId;
  const payload = { ...req.query, ...(req.body || {}) };

  const dlrEventInsert = db
    .prepare(`INSERT INTO dlr_events (provider_id, matched_test_id, raw_body) VALUES (?, NULL, ?)`)
    .run(providerId, JSON.stringify(payload));

  const messageId = firstDefined(payload, MESSAGE_ID_FIELDS);
  const rawStatus = firstDefined(payload, STATUS_FIELDS);

  if (!messageId) {
    console.warn(`[dlr:${providerId}] payload sans ID de message reconnu:`, JSON.stringify(payload));
    return res.json({ matched: false, reason: "aucun champ d'ID de message reconnu, voir dlr_events pour le payload brut" });
  }

  const testMsg = db
    .prepare(`SELECT * FROM test_messages WHERE provider_message_id = ? OR provider_message_id LIKE ?`)
    .get(String(messageId), `${messageId}.%`);

  if (!testMsg) {
    console.warn(`[dlr:${providerId}] aucun test correspondant à messageId=${messageId}`);
    return res.json({ matched: false, reason: "messageId inconnu (déjà nettoyé, ou ne correspond à aucun test)" });
  }

  const normalizedStatus = rawStatus != null && DELIVERED_SYNONYMS.has(String(rawStatus).toLowerCase())
    ? "delivered"
    : (rawStatus != null ? String(rawStatus).toLowerCase() : "unknown");

  const dlrAt = new Date().toISOString();
  const dlrLatency = new Date(dlrAt).getTime() - new Date(testMsg.sent_at).getTime();

  db.prepare(`
    UPDATE test_messages SET dlr_status = ?, dlr_at = ?, dlr_latency_ms = ? WHERE id = ?
  `).run(normalizedStatus, dlrAt, dlrLatency, testMsg.id);

  db.prepare(`UPDATE dlr_events SET matched_test_id = ? WHERE id = ?`).run(testMsg.id, dlrEventInsert.lastInsertRowid);

  res.json({ matched: true, testId: testMsg.id, normalizedStatus });
}

router.post("/dlr/:providerId", handleDlr);
router.get("/dlr/:providerId", handleDlr);

module.exports = router;
