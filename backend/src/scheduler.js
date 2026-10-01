const cron = require("node-cron");
const db = require("./db");
const { generateTestCode, buildTestMessageBody } = require("./idgen");
const { sendTestSms } = require("./providers");
const { evaluateAlerts } = require("./alerts");
const { runTestSmsTest, applyTestResult } = require("./testsmsRunner");
const testsms = require("./providers/testsms");

const TIMEOUT_MINUTES = parseInt(process.env.TIMEOUT_MINUTES || "15", 10);

// La dernière exécution de chaque route/schedule est déduite du dernier test
// déjà enregistré en base (MAX(sent_at)/MAX(created_at)), PAS d'un suivi en
// mémoire : un suivi en mémoire repart à zéro à chaque redémarrage du
// service, et le cron (tickRoutes/tickTestSmsSchedules) pense alors qu'aucun
// test n'a jamais été envoyé — il relance donc immédiatement TOUTES les
// routes actives au tick suivant, même si l'intervalle réel n'est pas
// écoulé. Ce bug a provoqué une rafale de tests en double lors des multiples
// redémarrages du service pendant un déploiement (observé le 01/10).
function lastRouteRunAt(routeId) {
  const row = db.prepare(`SELECT MAX(sent_at) as last FROM test_messages WHERE route_id = ?`).get(routeId);
  return row && row.last ? new Date(row.last).getTime() : 0;
}
function lastTestSmsScheduleRunAt(scheduleId) {
  const row = db.prepare(`SELECT MAX(created_at) as last FROM testsms_tests WHERE schedule_id = ?`).get(scheduleId);
  return row && row.last ? new Date(row.last).getTime() : 0;
}

// Bouton d'urgence "mettre en pause l'envoi de SMS" (sidebar du dashboard) :
// persisté en base (table settings) pour survivre à un redémarrage du
// service, plutôt qu'un simple booléen en mémoire.
function isPaused() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'paused'`).get();
  return !!row && row.value === "1";
}
function setPaused(paused) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('paused', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(paused ? "1" : "0");
}

// Retourne l'id du test créé : permet à l'appelant (ex: bouton "Lancer un
// test" du dashboard) de suivre ce test précis immédiatement, plutôt que
// d'attendre le prochain cycle planifié ou de deviner quel id vient d'être créé.
// `overrides` (optionnel) : { content, senderId, triggerType } — utilisé par
// la page "Test manuel" pour personnaliser un envoi ponctuel et le marquer
// comme tel (triggerType: 'manual') ; le cycle planifié normal (tickRoutes)
// n'en passe jamais, donc reste 'scheduled' par défaut.
async function runTestForRoute(route, overrides = {}) {
  const code = generateTestCode();
  const body = buildTestMessageBody(code, overrides.content);
  const sentAt = new Date().toISOString();
  const triggerType = overrides.triggerType === "manual" ? "manual" : "scheduled";

  const insert = db.prepare(`
    INSERT INTO test_messages (route_id, code, sent_at, body, trigger_type, sender_id, provider_status, final_status)
    VALUES (?, ?, ?, ?, ?, ?, 'sending', 'pending')
  `);
  const { lastInsertRowid: testId } = insert.run(
    route.id,
    code,
    sentAt,
    body,
    triggerType,
    overrides.senderId && overrides.senderId.trim() ? overrides.senderId.trim() : null
  );

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
  if (isPaused()) return;

  const routes = db.prepare(`SELECT * FROM routes WHERE active = 1`).all();
  const now = Date.now();

  for (const route of routes) {
    const last = lastRouteRunAt(route.id);
    const intervalMs = route.interval_minutes * 60 * 1000;
    if (now - last >= intervalMs) {
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

// Résout la liste des réseaux à tester pour un schedule donné. En mode
// normal (is_country = 0), c'est juste le réseau figé à la création. En mode
// "pays entier" (is_country = 1), on NE fige jamais la liste : on interroge
// TestSMS à chaque exécution pour repartir des opérateurs natifs actuellement
// disponibles pour ce pays (ils peuvent changer dans le temps).
async function resolveScheduleNetworks(schedule) {
  if (!schedule.is_country) {
    return [{ mccmnc: schedule.mccmnc, mccmncOriginal: schedule.mccmnc_original, country: schedule.country, network: schedule.network }];
  }
  const allNetworks = await testsms.getNetworks();
  const countryNetworks = allNetworks.filter((n) => n.isoAlpha2 === schedule.country_iso || n.country === schedule.country);
  return countryNetworks.map((n) => ({ mccmnc: n.mccmnc, mccmncOriginal: null, country: n.country, network: n.network }));
}

// Déclenche chaque schedule TestSMS actif selon son propre interval_minutes,
// même logique que tickRoutes() ci-dessus. Ignore silencieusement si les
// credentials TestSMS ne sont pas configurés (évite de spammer les logs sur
// une install qui n'utilise pas cette fonctionnalité).
function tickTestSmsSchedules() {
  if (isPaused() || !testsms.credsConfigured()) return;

  const schedules = db.prepare(`SELECT * FROM testsms_schedules WHERE active = 1`).all();
  const now = Date.now();

  for (const schedule of schedules) {
    const last = lastTestSmsScheduleRunAt(schedule.id);
    const intervalMs = schedule.interval_minutes * 60 * 1000;
    if (now - last >= intervalMs) {
      resolveScheduleNetworks(schedule)
        .then((networks) => {
          if (!networks.length) {
            console.warn(`[scheduler] testsms schedule ${schedule.id} (${schedule.name}) : aucun réseau résolu, test ignoré`);
            return;
          }
          return runTestSmsTest({
            networks,
            outboundProviderId: schedule.outbound_provider_id,
            senderId: schedule.sender_id,
            scheduleId: schedule.id,
            triggerType: "scheduled",
          });
        })
        .catch((e) => console.error(`[scheduler] testsms schedule ${schedule.id} erreur:`, e));
    }
  }
}

// Filet de sécurité si le callbackUrl de TestSMS ne nous atteint jamais (ex:
// serveur temporairement inaccessible depuis l'extérieur au moment de la
// réception). TestSMS attend jusqu'à 60 min avant de conclure NEGATIVE côté
// eux ; on interroge donc nous-mêmes GET /v1/smsTest/:id pour les tests
// encore 'pending' entre 3 et 65 minutes d'âge (sous 3 min : laisse le temps
// au callback normal d'arriver et évite de sur-solliciter l'API).
const TESTSMS_POLL_MIN_AGE_MINUTES = 3;
const TESTSMS_POLL_MAX_AGE_MINUTES = 65;

async function tickTestSmsPoll() {
  if (!testsms.credsConfigured()) return;

  const minCutoff = new Date(Date.now() - TESTSMS_POLL_MIN_AGE_MINUTES * 60 * 1000).toISOString();
  const maxCutoff = new Date(Date.now() - TESTSMS_POLL_MAX_AGE_MINUTES * 60 * 1000).toISOString();

  const pending = db
    .prepare(`
      SELECT * FROM testsms_tests
      WHERE final_status = 'pending' AND testsms_test_id IS NOT NULL
        AND created_at <= ? AND created_at >= ?
    `)
    .all(minCutoff, maxCutoff);

  for (const row of pending) {
    try {
      const result = await testsms.getTestResult(row.testsms_test_id);
      applyTestResult(row.testsms_test_id, result);
    } catch (e) {
      console.error(`[scheduler] polling testsms test ${row.id} erreur:`, e.response?.data || String(e));
    }
  }

  // Au-delà de 65 min sans résultat exploitable (callback ni polling), on
  // arrête d'attendre : TestSMS annonce lui-même qu'il bascule en NEGATIVE
  // après 60 min, donc un 'pending' encore plus vieux est un test qu'on ne
  // reverra jamais confirmé.
  db.prepare(`
    UPDATE testsms_tests SET final_status = 'timeout'
    WHERE final_status = 'pending' AND created_at < ?
  `).run(maxCutoff);
}

function startScheduler() {
  // Vérifie chaque minute quelles routes doivent être testées et si des tests ont expiré
  cron.schedule("* * * * *", () => {
    tickRoutes();
    tickTimeouts();
    tickTestSmsSchedules();
    tickTestSmsPoll().catch((e) => console.error("[scheduler] tickTestSmsPoll erreur:", e));
  });

  // Les seuils d'alerte se basent sur les derniers tests déjà enregistrés, donc un
  // cycle un peu plus espacé (toutes les 5 min) suffit et évite de spammer le webhook.
  cron.schedule("*/5 * * * *", () => {
    evaluateAlerts().catch((e) => console.error("[alerts] erreur d'évaluation:", e));
  });

  console.log(`[scheduler] démarré (timeout = ${TIMEOUT_MINUTES} min)`);
}

module.exports = { startScheduler, runTestForRoute, isPaused, setPaused };
