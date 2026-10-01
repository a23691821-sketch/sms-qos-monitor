const db = require("./db");
const { sendTestSms } = require("./providers");
const testsms = require("./providers/testsms");

// URL publique du backend, utilisée pour construire le callbackUrl envoyé à
// TestSMS (ils nous rappellent dès qu'ils ont un résultat). À défaut, on
// retombe sur le domaine sslip.io déjà utilisé pour l'APK/le dashboard.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://188-245-8-33.sslip.io").replace(/\/$/, "");
const CALLBACK_URL = `${PUBLIC_BASE_URL}/api/webhook/testsms-callback`;

// Exécute un test TestSMS complet : (1) demande un numéro+messageId à
// TestSMS, (2) envoie nous-mêmes le SMS vers ce numéro via un de nos
// fournisseurs existants, (3) enregistre tout en base. Le résultat réel
// (receiptStatus) arrive plus tard, via webhook ou polling (voir
// scheduler.js / routes/webhook.js) — cette fonction ne fait qu'amorcer le
// test et retourne dès que notre propre envoi est parti.
//
// `params`: { mccmnc, mccmncOriginal, country, network, outboundProviderId, senderId,
//             scheduleId (optionnel), triggerType ('manual'|'scheduled') }
async function runTestSmsTest(params) {
  const {
    mccmnc,
    mccmncOriginal,
    country,
    network,
    outboundProviderId,
    senderId,
    scheduleId = null,
    triggerType = "manual",
  } = params;

  if (!mccmnc || !outboundProviderId) {
    throw new Error("mccmnc et outboundProviderId sont requis");
  }

  // Étape 1 : demande du numéro + messageId à TestSMS
  const insert = db.prepare(`
    INSERT INTO testsms_tests
      (schedule_id, trigger_type, mccmnc, mccmnc_original, country, network,
       outbound_provider_id, sender_id, create_test_status, final_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending')
  `);
  const { lastInsertRowid: localId } = insert.run(
    scheduleId,
    triggerType === "scheduled" ? "scheduled" : "manual",
    mccmnc,
    mccmncOriginal || null,
    country || null,
    network || null,
    outboundProviderId,
    senderId && senderId.trim() ? senderId.trim() : null
  );

  let created;
  try {
    created = await testsms.createTest({
      mccmnc,
      mccmncOriginal,
      callbackUrl: CALLBACK_URL,
    });
  } catch (err) {
    db.prepare(`
      UPDATE testsms_tests
      SET create_test_status = 'error', create_test_response = ?, final_status = 'failed'
      WHERE id = ?
    `).run(JSON.stringify({ error: err.response?.data || String(err) }), localId);
    return localId;
  }

  db.prepare(`
    UPDATE testsms_tests
    SET create_test_status = 'created', create_test_response = ?,
        testsms_test_id = ?, testsms_message_id = ?, msisdn = ?
    WHERE id = ?
  `).run(JSON.stringify(created.raw), String(created.id), created.messageId, created.msisdn, localId);

  // Étape 2 : on envoie NOUS-mêmes le SMS vers le numéro fourni par TestSMS,
  // avec le messageId dans le corps (c'est ce que TestSMS attend pour
  // reconnaître le test sur son réseau de terminaux réels).
  const sentAt = new Date().toISOString();
  try {
    const result = await sendTestSms(outboundProviderId, {
      to: created.msisdn,
      body: created.messageId,
      senderId,
    });
    db.prepare(`
      UPDATE testsms_tests
      SET our_provider_status = ?, our_provider_response = ?, our_provider_message_id = ?, sent_at = ?
      WHERE id = ?
    `).run(
      result.ok ? "submitted" : "error",
      JSON.stringify(result.raw ?? result.error ?? {}),
      result.providerMessageId || null,
      sentAt,
      localId
    );
    if (!result.ok) {
      db.prepare(`UPDATE testsms_tests SET final_status = 'failed' WHERE id = ?`).run(localId);
    }
  } catch (err) {
    db.prepare(`
      UPDATE testsms_tests
      SET our_provider_status = 'error', our_provider_response = ?, sent_at = ?, final_status = 'failed'
      WHERE id = ?
    `).run(JSON.stringify({ error: String(err) }), sentAt, localId);
  }

  return localId;
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
