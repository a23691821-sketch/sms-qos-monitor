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

// Optionnel: endpoint pour recevoir les DLR asynchrones de fournisseurs qui en envoient (webhook côté fournisseur)
// À adapter au format exact du fournisseur (ceci est un format générique raisonnable).
router.post("/dlr/:providerId", (req, res) => {
  const { messageId, status } = req.body || {};
  if (!messageId) return res.status(400).json({ error: "messageId requis" });

  const testMsg = db.prepare(`SELECT * FROM test_messages WHERE provider_message_id = ?`).get(messageId);
  if (!testMsg) return res.json({ matched: false });

  const dlrAt = new Date().toISOString();
  const dlrLatency = new Date(dlrAt).getTime() - new Date(testMsg.sent_at).getTime();

  db.prepare(`
    UPDATE test_messages SET dlr_status = ?, dlr_at = ?, dlr_latency_ms = ? WHERE id = ?
  `).run(status || "unknown", dlrAt, dlrLatency, testMsg.id);

  res.json({ matched: true });
});

module.exports = router;
