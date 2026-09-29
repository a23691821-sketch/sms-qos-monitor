const cron = require("node-cron");
const db = require("./db");
const { generateTestCode, buildTestMessageBody } = require("./idgen");
const { sendTestSms } = require("./providers");

const TIMEOUT_MINUTES = parseInt(process.env.TIMEOUT_MINUTES || "15", 10);

// Suivi en mémoire de la dernière exécution par route (évite une table de plus)
const lastRunByRoute = new Map();

async function runTestForRoute(route) {
  const code = generateTestCode();
  const body = buildTestMessageBody(code);
  const sentAt = new Date().toISOString();

  const insert = db.prepare(`
    INSERT INTO test_messages (route_id, code, sent_at, provider_status, final_status)
    VALUES (?, ?, ?, 'sending', 'pending')
  `);
  const { lastInsertRowid } = insert.run(route.id, code, sentAt);

  try {
    const result = await sendTestSms(route.provider_id, { to: route.destination_number, body });
    db.prepare(`
      UPDATE test_messages
      SET provider_status = ?, provider_response = ?, provider_message_id = ?
      WHERE id = ?
    `).run(
      result.ok ? "submitted" : "error",
      JSON.stringify(result.raw ?? result.error ?? {}),
      result.providerMessageId || null,
      lastInsertRowid
    );

    if (!result.ok) {
      db.prepare(`UPDATE test_messages SET final_status = 'failed' WHERE id = ?`).run(lastInsertRowid);
    }
  } catch (err) {
    db.prepare(`
      UPDATE test_messages
      SET provider_status = 'error', provider_response = ?, final_status = 'failed'
      WHERE id = ?
    `).run(JSON.stringify({ error: String(err) }), lastInsertRowid);
  }
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
  console.log(`[scheduler] démarré (timeout = ${TIMEOUT_MINUTES} min)`);
}

module.exports = { startScheduler, runTestForRoute };
