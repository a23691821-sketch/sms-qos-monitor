const axios = require("axios");
const db = require("./db");

// Seuils par défaut, surchageables via variables d'environnement (voir .env.example).
const DELIVERY_RATE_THRESHOLD = parseFloat(process.env.ALERT_DELIVERY_RATE_THRESHOLD || "0.8");
const DELIVERY_RATE_MIN_SAMPLES = parseInt(process.env.ALERT_DELIVERY_RATE_MIN_SAMPLES || "5", 10);
const DEVICE_STALE_MINUTES = parseInt(process.env.ALERT_DEVICE_STALE_MINUTES || "60", 10);
// Le heartbeat de l'app tourne toutes les 15 min (minimum imposé par WorkManager
// côté Android) ; seuil un peu au-dessus pour tolérer un battement manqué
// (réseau temporairement indisponible) sans fausse alerte.
const HEARTBEAT_STALE_MINUTES = parseInt(process.env.ALERT_HEARTBEAT_STALE_MINUTES || "20", 10);
const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || null;

async function notifyWebhook(alert) {
  if (!WEBHOOK_URL) return;
  try {
    // Payload compatible Slack/Discord/Mattermost (le champ "text" est celui que
    // tous ces services affichent tel quel) ; les services qui l'ignorent
    // reçoivent quand même le JSON complet.
    await axios.post(
      WEBHOOK_URL,
      {
        text: `[SMS QoS Monitor] ${alert.severity.toUpperCase()}: ${alert.message}`,
        ...alert,
      },
      { timeout: 10000 }
    );
  } catch (err) {
    console.error("[alerts] échec envoi webhook:", err.message);
  }
}

// Ouvre une alerte si elle n'est pas déjà active pour ce (type, scope_key).
// Retourne true si une NOUVELLE alerte a été créée (pour ne notifier qu'une fois).
function openAlert(type, scopeKey, severity, message) {
  const existing = db
    .prepare(`SELECT id FROM alerts WHERE type = ? AND scope_key = ? AND status = 'active'`)
    .get(type, scopeKey);
  if (existing) return null;

  const { lastInsertRowid } = db
    .prepare(`INSERT INTO alerts (type, scope_key, severity, message, status) VALUES (?, ?, ?, ?, 'active')`)
    .run(type, scopeKey, severity, message);
  return { id: lastInsertRowid, type, scopeKey, severity, message };
}

// Referme une alerte active quand la condition qui l'a déclenchée n'est plus vraie.
function resolveAlert(type, scopeKey) {
  db.prepare(`
    UPDATE alerts SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP
    WHERE type = ? AND scope_key = ? AND status = 'active'
  `).run(type, scopeKey);
}

async function evaluateAlerts() {
  const newAlerts = [];

  // --- Taux de délivrance par route, sur les derniers tests ---
  const routes = db.prepare(`SELECT id, name FROM routes WHERE active = 1`).all();
  for (const route of routes) {
    const recent = db
      .prepare(`
        SELECT final_status FROM test_messages
        WHERE route_id = ? ORDER BY sent_at DESC LIMIT ?
      `)
      .all(route.id, DELIVERY_RATE_MIN_SAMPLES * 2); // fenêtre un peu large, on filtre après

    const sample = recent.slice(0, Math.max(recent.length, DELIVERY_RATE_MIN_SAMPLES));
    if (sample.length < DELIVERY_RATE_MIN_SAMPLES) continue; // pas assez de données encore

    const delivered = sample.filter((r) => r.final_status === "delivered").length;
    const rate = delivered / sample.length;
    const scopeKey = `route:${route.id}`;

    if (rate < DELIVERY_RATE_THRESHOLD) {
      const alert = openAlert(
        "delivery_rate",
        scopeKey,
        rate < DELIVERY_RATE_THRESHOLD / 2 ? "critical" : "warning",
        `Route "${route.name}": taux de délivrance à ${(rate * 100).toFixed(0)}% sur les ${sample.length} derniers tests (seuil: ${(DELIVERY_RATE_THRESHOLD * 100).toFixed(0)}%)`
      );
      if (alert) newAlerts.push(alert);
    } else {
      resolveAlert("delivery_rate", scopeKey);
    }
  }

  // --- Devices silencieux depuis trop longtemps (mais utilisés par une route active) ---
  const devices = db
    .prepare(`
      SELECT DISTINCT d.id, d.name, d.last_seen_at
      FROM devices d JOIN routes r ON r.device_id = d.id
      WHERE r.active = 1
    `)
    .all();

  const staleCutoff = Date.now() - DEVICE_STALE_MINUTES * 60 * 1000;
  for (const device of devices) {
    const scopeKey = `device:${device.id}`;
    const lastSeenMs = device.last_seen_at ? new Date(device.last_seen_at).getTime() : null;

    if (lastSeenMs === null || lastSeenMs < staleCutoff) {
      const alert = openAlert(
        "device_stale",
        scopeKey,
        "warning",
        `Device "${device.name}": aucune activité depuis ${device.last_seen_at ? "plus de " + DEVICE_STALE_MINUTES + " min" : "sa création"} — vérifier qu'il est allumé, chargé et connecté au réseau`
      );
      if (alert) newAlerts.push(alert);
    } else {
      resolveAlert("device_stale", scopeKey);
    }
  }

  // --- Heartbeat de l'app (indépendant des SMS) : ne concerne que les
  // téléphones dont l'app a déjà envoyé au moins un heartbeat (les anciennes
  // versions de l'app, pas encore mises à jour, n'en envoient jamais et ne
  // doivent donc pas déclencher de fausses alertes en continu) ---
  const heartbeatDevices = db
    .prepare(`SELECT id, name, last_heartbeat_at FROM devices WHERE last_heartbeat_at IS NOT NULL`)
    .all();

  const heartbeatCutoff = Date.now() - HEARTBEAT_STALE_MINUTES * 60 * 1000;
  for (const device of heartbeatDevices) {
    const scopeKey = `device_heartbeat:${device.id}`;
    const lastMs = new Date(device.last_heartbeat_at).getTime();

    if (lastMs < heartbeatCutoff) {
      const alert = openAlert(
        "device_offline",
        scopeKey,
        "critical",
        `Téléphone "${device.name}": aucun heartbeat depuis plus de ${HEARTBEAT_STALE_MINUTES} min — l'app est peut-être arrêtée, le téléphone éteint ou hors réseau`
      );
      if (alert) newAlerts.push(alert);
    } else {
      resolveAlert("device_offline", scopeKey);
    }
  }

  for (const alert of newAlerts) {
    console.warn(`[alerts] nouvelle alerte: ${alert.message}`);
    await notifyWebhook(alert);
  }
}

module.exports = { evaluateAlerts, openAlert, resolveAlert };
