const crypto = require("crypto");
const db = require("./db");
const { sendTestSms } = require("./providers");
const testsms = require("./providers/testsms");

// URL publique du backend, utilisée pour construire le callbackUrl envoyé à
// TestSMS (ils nous rappellent dès qu'ils ont un résultat). À défaut, on
// retombe sur le domaine sslip.io déjà utilisé pour l'APK/le dashboard.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://188-245-8-33.sslip.io").replace(/\/$/, "");
const CALLBACK_URL = `${PUBLIC_BASE_URL}/api/webhook/testsms-callback`;

// Exécute un test TestSMS complet sur un ou plusieurs réseaux à la fois (un
// seul réseau = test normal, plusieurs = "pays entier" : tous les opérateurs
// natifs d'un pays testés en une fois). Pour chaque réseau : (1) demande un
// numéro+messageId à TestSMS (un seul appel createTest pour tout le lot),
// (2) envoie nous-mêmes le SMS vers ce numéro via un de nos fournisseurs
// existants, (3) enregistre tout en base, une ligne par réseau. Le résultat
// réel (receiptStatus) arrive plus tard, par réseau, via webhook ou polling.
//
// `params`: { networks: [{ mccmnc, mccmncOriginal?, country, network }, ...],
//             outboundProviderId, senderId, scheduleId (optionnel),
//             triggerType ('manual'|'scheduled') }
// Retourne { batchId, testIds: [...] } (testIds dans l'ordre de `networks`).
async function runTestSmsTest(params) {
  const { networks, outboundProviderId, senderId, scheduleId = null, triggerType = "manual" } = params;

  if (!Array.isArray(networks) || !networks.length || !outboundProviderId) {
    throw new Error("networks (tableau non vide) et outboundProviderId sont requis");
  }

  const batchId = crypto.randomBytes(8).toString("hex");
  const insert = db.prepare(`
    INSERT INTO testsms_tests
      (schedule_id, trigger_type, mccmnc, mccmnc_original, country, network,
       outbound_provider_id, sender_id, create_test_status, final_status, batch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?)
  `);

  const testIds = networks.map((n) => {
    const { lastInsertRowid } = insert.run(
      scheduleId,
      triggerType === "scheduled" ? "scheduled" : "manual",
      n.mccmnc,
      n.mccmncOriginal || null,
      n.country || null,
      n.network || null,
      outboundProviderId,
      senderId && senderId.trim() ? senderId.trim() : null,
      batchId
    );
    return lastInsertRowid;
  });

  // Étape 1 : demande des numéros + messageId à TestSMS, en un seul appel
  // pour tout le lot (évite de multiplier les appels OAuth/HTTP par réseau).
  let created;
  try {
    created = await testsms.createTest(networks, { callbackUrl: CALLBACK_URL });
  } catch (err) {
    const errJson = JSON.stringify({ error: err.response?.data || String(err) });
    for (const id of testIds) {
      db.prepare(`
        UPDATE testsms_tests SET create_test_status = 'error', create_test_response = ?, final_status = 'failed'
        WHERE id = ?
      `).run(errJson, id);
    }
    return { batchId, testIds };
  }

  // Étape 2 : pour chaque réseau du lot, on enregistre le numéro obtenu puis
  // on envoie NOUS-mêmes le SMS vers ce numéro, avec le messageId dans le
  // corps (c'est ce que TestSMS attend pour reconnaître le test).
  await Promise.all(
    created.results.map(async (result, i) => {
      const localId = testIds[i];
      db.prepare(`
        UPDATE testsms_tests
        SET create_test_status = 'created', create_test_response = ?,
            testsms_test_id = ?, testsms_message_id = ?, msisdn = ?
        WHERE id = ?
      `).run(JSON.stringify(created.raw), String(result.id), result.messageId, result.msisdn, localId);

      const sentAt = new Date().toISOString();
      try {
        const sendResult = await sendTestSms(outboundProviderId, {
          to: result.msisdn,
          body: result.messageId,
          senderId,
        });
        db.prepare(`
          UPDATE testsms_tests
          SET our_provider_status = ?, our_provider_response = ?, our_provider_message_id = ?, sent_at = ?
          WHERE id = ?
        `).run(
          sendResult.ok ? "submitted" : "error",
          JSON.stringify(sendResult.raw ?? sendResult.error ?? {}),
          sendResult.providerMessageId || null,
          sentAt,
          localId
        );
        if (!sendResult.ok) {
          db.prepare(`UPDATE testsms_tests SET final_status = 'failed' WHERE id = ?`).run(localId);
        }
      } catch (err) {
        db.prepare(`
          UPDATE testsms_tests
          SET our_provider_status = 'error', our_provider_response = ?, sent_at = ?, final_status = 'failed'
          WHERE id = ?
        `).run(JSON.stringify({ error: String(err) }), sentAt, localId);
      }
    })
  );

  return { batchId, testIds };
}

// receiptStatus TestSMS -> final_status interne. TEXT_OR_SENDER_REPLACED est
// mappé sur 'delivered' quand même (le SMS EST arrivé) mais le mismatch
// contenu/expéditeur reste visible via delivered_text/delivered_sender dans
// le dashboard, comme pour le flag DLR existant.
const RECEIPT_TO_FINAL = {
  POSITIVE: "delivered",
  TEXT_OR_SENDER_REPLACED: "delivered",
  NEGATIVE: "failed",
  NUM_OFFLINE: "failed",
  NUM_NOT_AVAILABLE: "failed",
  WAIT: "pending",
  RECEIVED: "pending",
  EXTERNAL: "pending",
};

// Applique un résultat TestSMS (venant du callback OU du polling) à la ligne
// locale correspondante. Idempotent : peut être appelé plusieurs fois avec le
// même résultat (ex: callback + polling de secours qui arrivent tous les
// deux) sans effet de bord au-delà de la dernière valeur écrite.
function applyTestResult(testsmsTestId, result) {
  const row = db.prepare(`SELECT * FROM testsms_tests WHERE testsms_test_id = ?`).get(String(testsmsTestId));
  if (!row) return { matched: false };

  const receiptStatus = result.receiptStatus || null;
  const finalStatus = RECEIPT_TO_FINAL[receiptStatus] || row.final_status;
  const receiptTime = result.receiptTime || result.arrivalTs || null;
  const latencyMs =
    receiptTime && row.sent_at ? new Date(receiptTime).getTime() - new Date(row.sent_at).getTime() : row.latency_ms;

  db.prepare(`
    UPDATE testsms_tests SET
      receipt_status = ?, receipt_time = ?, delivered_sender = ?, delivered_text = ?,
      pdu = ?, price = ?, currency = ?, billing_status = ?, latency_ms = ?, final_status = ?
    WHERE id = ?
  `).run(
    receiptStatus,
    receiptTime,
    result.deliveredSender ?? row.delivered_sender,
    result.deliveredText ?? row.delivered_text,
    result.pdu ?? row.pdu,
    result.price ?? row.price,
    result.currency ?? row.currency,
    result.billingStatus ?? row.billing_status,
    latencyMs,
    finalStatus,
    row.id
  );

  return { matched: true, localId: row.id, finalStatus };
}

module.exports = { runTestSmsTest, applyTestResult, RECEIPT_TO_FINAL, CALLBACK_URL };
