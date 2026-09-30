const cron = require("node-cron");
const db = require("./db");
const { generateTestCode, buildTestMessageBody } = require("./idgen");
const { sendTestSms } = require("./providers");
const { evaluateAlerts } = require("./alerts");

const TIMEOUT_MINUTES = parseInt(process.env.TIMEOUT_MINUTES || "15", 10);

// Suivi en mémoire de la dernière exécution par route (évite une table de plus)
const lastRunByRoute = new Map();

// Retourne l'id du test créé : permet à l'appelant (ex: bouton "Lancer un
// test" du dashboard) de suivre ce test précis immédiatement, plutôt que
// d'attendre le prochain cycle planifié ou de deviner quel id vient d'être créé.
// `overrides` (optionnel) : { content, senderId } — utilisé par la page
// "Test manuel" pour personnaliser un envoi ponctuel ; le cycle planifié
// normal (tickRoutes) n'en passe jamais.
async function runTestForRoute(route, overrides = {}) {
  const code = generateTestCode();
  const body = buildTestMessageBody(code, overrides.content);
  const sentAt = new Date().toISOString();

  const insert = db.prepare(`
    INSERT INTO test_messages (route_id, code, sent_at, body, provider_status, final_status)
    VALUES (?, ?, ?, ?, 'sending', 'pending')
  `);
  const { lastInsertRowid: testId } = insert.run(route.id, code, sentAt, body);

  try {
    const result = await sendTestSms(route.provider_id, { to: route.destination_number, body, senderId: overrides.senderId });
    db.prepare(`
      UPDATE test_messages
      SET provider_status = ?, provider_response = ?, provider_message_id = ?
      WHERE id = ?
    `).run(
      result.ok ? "submitted" : "error",
      JSON.stringify(result.raw ?? result.error ?? {}),
      result.providerMessageId || null,
      testId
    );

    if (!result.ok) {
      db.prepare(`UPDATE test_messages SET final_status = 'failed' WHERE id = ?`).run(testId);
    }
  } catch (err) {
    db.prepare(`
      UPDATE test_messages
      SET provider_status = 'error', provider_response = ?, final_status = 'failed'
      WHERE id = ?
    `).run(JSON.stringify({ error: String(err) }), testId);
  }

  return testId;
}

function tickRoutes() {
  const routes = db.prepare(`SELECT * FROM routes WHERE active = 1`).all();
  const now = Date.now();

  for (const route of routes) {
    const last = lastRunByRoute.get(route.id) || 0;
    const intervalMs = route.interval_minutes * 60 * 1000;
    if (now - last >= intervalMs) {
      lastRunByRoute.set(route.id, now);
      runTestForRoute(route).catch((e) => console.error(`[scheduler] route ${route.id} erreur:`, e));
    }
  }
}

function tickTimeouts() {
  const cutoff = new Date(Date.now() - TIMEOUT_MINUTES * 60 * 1000).toISOString();
  db.prepare(`
    UPDATE test_messages
    SET final_status = 'timeout'
    WHERE final_status = 'pending' AND received_at IS NULL AND sent_at < ?
  `).run(cutoff);
}

function startScheduler() {
  // Vérifie chaque minute quelles routes doivent être testées et si des tests ont expiré
  cron.schedule("* * * * *", () => {
    tickRoutes();
    tickTimeouts();
  });

  // Les seuils d'alerte se basent sur les derniers tests déjà enregistrés, donc un
  // cycle un peu plus espacé (toutes les 5 min) suffit et évite de spammer le webhook.
  cron.schedule("*/5 * * * *", () => {
    evaluateAlerts().catch((e) => console.error("[alerts] erreur d'évaluation:", e));
  });

  console.log(`[scheduler] démarré (timeout = ${TIMEOUT_MINUTES} min)`);
}

module.exports = { startScheduler, runTestForRoute };
