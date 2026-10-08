const express = require("express");
const crypto = require("crypto");
const db = require("./../db");
const { runTestForRoute, isPaused, setPaused } = require("./../scheduler");
const { loadProviderConfigs } = require("./../providers");
const { buildTestMessageBody, extractCode } = require("./../idgen");
const { hashPassword } = require("./../password");

const router = express.Router();

// Percentile "nearest rank" simple, suffisant pour du monitoring (pas besoin
// d'interpolation linéaire ici). `values` n'a pas besoin d'être trié.
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// Filtre optionnel ?triggerType=scheduled|manual : isole les tests automatiques
// du cycle planifié des tests lancés à la main (même table, même colonne
// trigger_type). Sans valeur reconnue = pas de filtre (les deux, comme avant).
// Renvoie un fragment SQL à ajouter à un WHERE existant + ses paramètres.
function triggerFilter(req, column = "t.trigger_type") {
  const v = req.query.triggerType;
  if (v === "scheduled" || v === "manual") return { sql: ` AND ${column} = ?`, params: [v] };
  return { sql: "", params: [] };
}

function aggregate(rows) {
  const delivered = rows.filter((r) => r.final_status === "delivered");
  const latencies = delivered.map((r) => r.latency_ms).filter((v) => v != null);
  const dlrMismatch = rows.filter((r) => r.dlr_status === "delivered" && r.final_status !== "delivered").length;

  // Latence fournisseur (envoi -> DLR) : volontairement PAS filtrée sur
  // final_status === 'delivered' comme latencies ci-dessus, parce que le DLR
  // peut arriver même quand le téléphone n'a jamais reçu le SMS (ou l'inverse)
  // — c'est justement ce qui permet de distinguer un ralentissement "réseau
  // opérateur" (DLR rapide, réception lente/absente) d'un ralentissement côté
  // fournisseur (DLR lui-même lent à arriver).
  const dlrLatencies = rows.map((r) => r.dlr_latency_ms).filter((v) => v != null);

  return {
    total: rows.length,
    // Répartition automatique / manuel, pour pouvoir les distinguer d'un coup
    // d'oeil même quand aucun filtre n'est actif.
    manualCount: rows.filter((r) => r.trigger_type === "manual").length,
    scheduledCount: rows.filter((r) => r.trigger_type !== "manual").length,
    delivered: delivered.length,
    timeout: rows.filter((r) => r.final_status === "timeout").length,
    failed: rows.filter((r) => r.final_status === "failed").length,
    pending: rows.filter((r) => r.final_status === "pending").length,
    deliveryRate: rows.length ? delivered.length / rows.length : null,
    avgLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
    p95LatencyMs: percentile(latencies, 95),
    p99LatencyMs: percentile(latencies, 99),
    avgDlrLatencyMs: dlrLatencies.length ? dlrLatencies.reduce((a, b) => a + b, 0) / dlrLatencies.length : null,
    p95DlrLatencyMs: percentile(dlrLatencies, 95),
    dlrMismatch,
  };
}

function requireAdmin(req, res, next) {
  const key = req.header("x-admin-key");
  if (key !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: "clé admin invalide" });
  next();
}

// ---------- Fournisseurs (lecture seule, juste la liste des IDs configurés) ----------

router.get("/providers", requireAdmin, (req, res) => {
  try {
    res.json(Object.keys(loadProviderConfigs()));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------- Devices (téléphones Android de test) ----------

router.post("/devices", requireAdmin, (req, res) => {
  const { name, phoneNumber } = req.body || {};
  if (!name) return res.status(400).json({ error: "name requis" });
  const apiKey = crypto.randomBytes(16).toString("hex");
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO devices (name, api_key, phone_number) VALUES (?, ?, ?)`)
    .run(name, apiKey, phoneNumber || null);
  res.json({ id: lastInsertRowid, name, apiKey, phoneNumber });
});

// Inclut api_key : endpoint protégé par la clé admin, nécessaire pour ré-afficher
// la clé de pairage d'un appareil déjà créé (ex: réinstallation de l'app).
router.get("/devices", requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT id, name, phone_number, api_key, last_seen_at, last_heartbeat_at, created_at, app_version, battery_level, battery_charging, battery_exempt, doze_mode, network_type FROM devices`).all());
});

// Boîte de réception SMS du téléphone, telle que remontée par l'app avec son
// heartbeat (équivalent de l'app Messages, en lecture seule). Réservé admin.
// ?limit=1..200 (défaut 50). Le champ `qos` signale les SMS de test QoS.
router.get("/devices/:id/inbox", requireAdmin, (req, res) => {
  const device = db.prepare(`SELECT id FROM devices WHERE id = ?`).get(req.params.id);
  if (!device) return res.status(404).json({ error: "appareil introuvable" });
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || "50", 10) || 50, 200));
  const rows = db
    .prepare(`SELECT sms_at, address, body, synced_at FROM device_inbox WHERE device_id = ? ORDER BY sms_at DESC, id DESC LIMIT ?`)
    .all(device.id, limit);
  res.json(rows.map((r) => ({ ...r, qos: !!extractCode(r.body || "") })));
});

// Renomme un appareil et/ou corrige son numéro (jamais la clé API, qui ne
// change que si l'appareil est recréé).
router.patch("/devices/:id", requireAdmin, (req, res) => {
  const { name, phoneNumber } = req.body || {};
  const device = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(req.params.id);
  if (!device) return res.status(404).json({ error: "appareil introuvable" });

  db.prepare(`
    UPDATE devices SET
      name = COALESCE(?, name),
      phone_number = COALESCE(?, phone_number)
    WHERE id = ?
  `).run(name || null, phoneNumber === undefined ? null : (phoneNumber || ""), req.params.id);

  res.json({ ok: true });
});

// ---------- Routes (couples fournisseur/pays/opérateur/SIM à tester) ----------

router.post("/routes", requireAdmin, (req, res) => {
  const { name, providerId, country, operator, destinationNumber, deviceId, intervalMinutes } = req.body || {};
  if (!name || !providerId || !destinationNumber || !deviceId) {
    return res.status(400).json({ error: "name, providerId, destinationNumber, deviceId requis" });
  }
  const { lastInsertRowid } = db
    .prepare(`
      INSERT INTO routes (name, provider_id, country, operator, destination_number, device_id, interval_minutes, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `)
    .run(name, providerId, country || null, operator || null, destinationNumber, deviceId, intervalMinutes || 15);
  res.json({ id: lastInsertRowid });
});

router.get("/routes", requireAdmin, (req, res) => {
  res.json(
    db
      .prepare(`
        SELECT r.*, d.name as device_name, d.phone_number as device_phone
        FROM routes r JOIN devices d ON d.id = r.device_id
        ORDER BY r.id DESC
      `)
      .all()
  );
});

// Champs partiels : seuls ceux fournis (non-undefined) sont modifiés. Le
// paramètre le plus demandé est intervalMinutes (fréquence d'envoi par SIM),
// mais on permet aussi de corriger le reste sans devoir recréer la route.
router.patch("/routes/:id", requireAdmin, (req, res) => {
  const { active, intervalMinutes, name, country, operator, destinationNumber } = req.body || {};
  const route = db.prepare(`SELECT * FROM routes WHERE id = ?`).get(req.params.id);
  if (!route) return res.status(404).json({ error: "route introuvable" });

  db.prepare(`
    UPDATE routes SET
      active = COALESCE(?, active),
      interval_minutes = COALESCE(?, interval_minutes),
      name = COALESCE(?, name),
      country = COALESCE(?, country),
      operator = COALESCE(?, operator),
      destination_number = COALESCE(?, destination_number)
    WHERE id = ?
  `).run(
    active === undefined ? null : (active ? 1 : 0),
    intervalMinutes || null,
    name || null,
    country === undefined ? null : (country || ""),
    operator === undefined ? null : (operator || ""),
    destinationNumber || null,
    req.params.id
  );

  res.json({ ok: true });
});

// Déclenche un test immédiat sur une route (utile pour valider une config avant d'attendre le prochain cycle)
router.post("/routes/:id/run-now", requireAdmin, async (req, res) => {
  // Le bouton d'urgence "pause" (sidebar) coupe aussi les envois manuels,
  // pas seulement le cycle planifié : c'est un arrêt d'urgence, pas juste
  // une pause de la routine automatique.
  if (isPaused()) {
    return res.status(409).json({ error: "Envoi de SMS en pause — reprends l'envoi depuis la sidebar pour lancer un test." });
  }
  const route = db.prepare(`SELECT * FROM routes WHERE id = ?`).get(req.params.id);
  if (!route) return res.status(404).json({ error: "route introuvable" });
  const { content, senderId } = req.body || {};
  const testId = await runTestForRoute(route, { content, senderId, triggerType: "manual" });
  res.json({ ok: true, testId });
});

// Bouton d'urgence "pause de l'envoi de SMS" (sidebar du dashboard) : coupe à
// la fois le cycle planifié (tickRoutes) et les envois manuels ("Test
// manuel"), sans toucher aux données déjà enregistrées ni aux routes/appareils
// configurés — juste un coupe-circuit temporaire, réversible en un clic.
router.get("/scheduler/status", requireAdmin, (req, res) => {
  res.json({ paused: isPaused() });
});
router.post("/scheduler/pause", requireAdmin, (req, res) => {
  setPaused(true);
  res.json({ paused: true });
});
router.post("/scheduler/resume", requireAdmin, (req, res) => {
  setPaused(false);
  res.json({ paused: false });
});

// Détail complet d'un test (utilisé par la page "Test manuel" pour suivre en
// direct un test qu'on vient de lancer soi-même : contenu envoyé, réponse
// fournisseur brute, réception réelle par le téléphone, et le DLR brut associé
// si un webhook fournisseur l'a déjà relié via dlr_events.matched_test_id).
router.get("/tests/:id", requireAdmin, (req, res) => {
  const test = db
    .prepare(`
      SELECT t.*, r.name as route_name, r.provider_id, r.country, r.operator,
             r.destination_number, d.name as device_name
      FROM test_messages t
      JOIN routes r ON r.id = t.route_id
      JOIN devices d ON d.id = r.device_id
      WHERE t.id = ?
    `)
    .get(req.params.id);
  if (!test) return res.status(404).json({ error: "test introuvable" });

  const dlrEvent = db
    .prepare(`SELECT raw_body, received_at FROM dlr_events WHERE matched_test_id = ? ORDER BY id DESC LIMIT 1`)
    .get(req.params.id);

  res.json({
    ...test,
    // Les tests envoyés avant l'ajout de la colonne "body" n'ont rien
    // d'enregistré (contenu personnalisé impossible à l'époque) : on retombe
    // sur le texte par défaut reconstruit à partir du code dans ce seul cas.
    message_body: test.body || buildTestMessageBody(test.code),
    dlr_raw: dlrEvent ? dlrEvent.raw_body : null,
    dlr_received_at: dlrEvent ? dlrEvent.received_at : null,
  });
});

// Historique des tests lancés à la main depuis la page "Test manuel" (une
// ligne par envoi). Volontairement séparé des stats QoS globales (qui ne
// portent que sur les tests planifiés) — voir trigger_type dans db.js.
// MCC/MNC ne sont pas exposés ici (demande explicite: pas nécessaires pour
// cette vue historique).
// since/until (ISO 8601, optionnels) : filtres rapides "Dernière heure /
// Aujourd'hui / Hier" côté dashboard — calculés côté client (qui connaît le
// fuseau horaire réel de la personne) plutôt que par un nombre d'heures
// glissant, pour que "Aujourd'hui"/"Hier" tombent sur de vraies frontières de
// journée locale et non sur un multiple de 24h depuis maintenant.
router.get("/tests", requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const { since, until } = req.query;

  const conditions = ["t.trigger_type = 'manual'"];
  const params = [];
  if (since) { conditions.push("t.sent_at >= ?"); params.push(since); }
  if (until) { conditions.push("t.sent_at <= ?"); params.push(until); }
  params.push(limit);

  const tests = db
    .prepare(`
      SELECT
        t.id, t.code, t.sent_at, t.body, t.sender_id,
        t.provider_status, t.final_status,
        t.dlr_status, t.dlr_at,
        t.received_at, t.received_from_number, t.received_body,
        t.latency_ms, t.dlr_latency_ms,
        r.name as route_name, r.provider_id, r.operator,
        r.destination_number, d.name as device_name
      FROM test_messages t
      JOIN routes r ON r.id = t.route_id
      JOIN devices d ON d.id = r.device_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY t.id DESC
      LIMIT ?
    `)
    .all(...params);

  res.json(
    tests.map((t) => ({
      ...t,
      message_body: t.body || buildTestMessageBody(t.code),
    }))
  );
});

// Export CSV des tests manuels uniquement (voir /export/csv pour l'export
// global). Public comme /export/csv : protégé par la session du dashboard,
// pas par la clé admin, puisqu'il s'agit d'une simple lecture — ça permet
// aussi au lien de téléchargement de fonctionner en <a href> tout simple,
// sans passer par adminFetch (le navigateur n'ajoute pas de header perso
// sur une navigation classique).
router.get("/tests/export/csv", (req, res) => {
  const hours = parseInt(req.query.hours || "24", 10);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const rows = db
    .prepare(`
      SELECT
        t.id, t.code, t.sent_at, t.body, t.sender_id, t.received_from_number,
        t.received_body, t.provider_status, t.final_status, t.dlr_status, t.dlr_at,
        t.received_at, t.latency_ms, t.dlr_latency_ms,
        r.name as route_name, r.provider_id, r.operator, r.destination_number,
        d.name as device_name
      FROM test_messages t
      JOIN routes r ON r.id = t.route_id
      JOIN devices d ON d.id = r.device_id
      WHERE t.trigger_type = 'manual' AND t.sent_at >= ?
      ORDER BY t.sent_at DESC
    `)
    .all(since);

  const headers = [
    "id", "code", "sent_at", "destination_number", "message_body",
    "received_body", "sender_id", "received_from_number", "route_name", "operator",
    "device_name", "provider_id", "provider_status",
    "dlr_status", "dlr_at", "received_at",
    "latency_ms", "dlr_latency_ms", "final_status",
  ];
  const escapeCsv = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    headers.join(","),
    ...rows.map((r) => {
      const record = { ...r, message_body: r.body || buildTestMessageBody(r.code) };
      return headers.map((h) => escapeCsv(record[h])).join(",");
    }),
  ].join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="sms-qos-tests-manuels-${hours}h.csv"`);
  res.send(csv);
});

// ---------- Stats pour le dashboard ----------

router.get("/stats/overview", (req, res) => {
  const sinceHours = parseInt(req.query.sinceHours || "24", 10);
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const tf = triggerFilter(req);

  const rows = db
    .prepare(`
      SELECT t.*, r.id as route_id, r.name as route_name, r.provider_id, r.country, r.operator
      FROM test_messages t JOIN routes r ON r.id = t.route_id
      WHERE t.sent_at >= ?${tf.sql}
    `)
    .all(since, ...tf.params);

  const totals = aggregate(rows);
  totals.testsPerHour = sinceHours ? totals.total / sinceHours : null;

  const routeIds = [...new Set(rows.map((r) => r.route_id))];
  const routeMeta = new Map(rows.map((r) => [r.route_id, r]));
  const byRoute = routeIds.map((id) => {
    const meta = routeMeta.get(id);
    const routeRows = rows.filter((r) => r.route_id === id);
    return {
      routeId: id,
      routeName: meta.route_name,
      providerId: meta.provider_id,
      country: meta.country,
      operator: meta.operator,
      ...aggregate(routeRows),
    };
  });

  // Inclut aussi les routes sans aucun test sur la période, pour ne pas les faire
  // disparaître silencieusement du tableau de bord.
  const allRoutes = db.prepare(`SELECT id, name, provider_id, country, operator FROM routes ORDER BY id`).all();
  const byRouteFull = allRoutes.map((r) => {
    const existing = byRoute.find((br) => br.routeId === r.id);
    if (existing) return existing;
    return {
      routeId: r.id,
      routeName: r.name,
      providerId: r.provider_id,
      country: r.country,
      operator: r.operator,
      ...aggregate([]),
      testsPerHour: 0,
    };
  });

  res.json({ sinceHours, totals, byRoute: byRouteFull });
});

// Ventilation par pays ou par opérateur (dimension déclarée sur chaque route),
// pour comparer la QoS à un niveau plus agrégé qu'une route individuelle.
router.get("/stats/by-dimension", (req, res) => {
  const sinceHours = parseInt(req.query.sinceHours || "24", 10);
  const dimension = req.query.dimension === "operator" ? "operator" : "country";
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const tf = triggerFilter(req);

  const rows = db
    .prepare(`
      SELECT t.*, r.country, r.operator
      FROM test_messages t JOIN routes r ON r.id = t.route_id
      WHERE t.sent_at >= ?${tf.sql}
    `)
    .all(since, ...tf.params);

  const groups = new Map();
  for (const row of rows) {
    const key = row[dimension] || "(non renseigné)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const result = [...groups.entries()]
    .map(([key, groupRows]) => ({ [dimension]: key, ...aggregate(groupRows) }))
    .sort((a, b) => (a.deliveryRate ?? 1) - (b.deliveryRate ?? 1)); // pires en premier

  res.json({ sinceHours, dimension, groups: result });
});

// Export CSV brut des tests sur la période, pour analyse externe (Excel, etc.)
router.get("/export/csv", (req, res) => {
  const sinceHours = parseInt(req.query.sinceHours || "24", 10);
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const tf = triggerFilter(req);

  const rows = db
    .prepare(`
      SELECT t.id, t.code, t.sent_at, t.final_status, t.provider_status, t.dlr_status,
             t.latency_ms, t.dlr_latency_ms, t.received_from_number,
             r.name as route_name, r.provider_id, r.country, r.operator, t.trigger_type
      FROM test_messages t JOIN routes r ON r.id = t.route_id
      WHERE t.sent_at >= ?${tf.sql}
      ORDER BY t.sent_at DESC
    `)
    .all(since, ...tf.params);

  const headers = [
    "id", "code", "sent_at", "final_status", "provider_status", "dlr_status",
    "latency_ms", "dlr_latency_ms", "received_from_number",
    "route_name", "provider_id", "country", "operator", "trigger_type",
  ];
  const escapeCsv = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => escapeCsv(r[h])).join(",")),
  ].join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="sms-qos-export-${sinceHours}h.csv"`);
  res.send(csv);
});

// ---------- Alertes ----------

router.get("/alerts", (req, res) => {
  const status = req.query.status === "all" ? null : req.query.status || "active";
  const rows = status
    ? db.prepare(`SELECT * FROM alerts WHERE status = ? ORDER BY created_at DESC LIMIT 100`).all(status)
    : db.prepare(`SELECT * FROM alerts ORDER BY created_at DESC LIMIT 100`).all();
  res.json(rows);
});

router.post("/alerts/:id/resolve", requireAdmin, (req, res) => {
  db.prepare(`UPDATE alerts SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
    req.params.id
  );
  res.json({ ok: true });
});

// Intervalle d'envoi le plus fin parmi les routes actives : sert au dashboard
// à caler la granularité des graphiques temporels sur la vraie cadence de test
// plutôt que sur une heuristique déconnectée de la config (pas besoin de la
// clé admin, aucune donnée sensible n'est exposée ici).
router.get("/stats/interval", (req, res) => {
  const row = db
    .prepare(`SELECT MIN(interval_minutes) as intervalMinutes FROM routes WHERE active = 1`)
    .get();
  res.json({ intervalMinutes: row.intervalMinutes || 15 });
});

// Chaque point porte aussi l'opérateur de sa route (rows séparées par
// opérateur, PAS agrégées), pour que le dashboard puisse tracer une courbe
// par opérateur en plus de la courbe globale, sans appel supplémentaire.
router.get("/stats/timeseries", (req, res) => {
  const sinceHours = parseInt(req.query.sinceHours || "24", 10);
  const bucketMinutes = parseInt(req.query.bucketMinutes || "60", 10);
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const tf = triggerFilter(req);

  // Bucketing simple fait en JS pour rester lisible et indépendant du moteur SQL
  const rows = db
    .prepare(`
      SELECT t.sent_at, t.final_status, t.latency_ms, t.dlr_latency_ms, r.operator
      FROM test_messages t JOIN routes r ON r.id = t.route_id
      WHERE t.sent_at >= ?${tf.sql}
      ORDER BY t.sent_at
    `)
    .all(since, ...tf.params);

  // Une entrée par (bucket temporel, opérateur) : la clé "__all__" cumule
  // tous les opérateurs pour garder la courbe globale historique.
  const buckets = new Map();
  const touchBucket = (bucketIso, operator, row) => {
    const key = `${bucketIso}|${operator}`;
    if (!buckets.has(key)) buckets.set(key, { time: bucketIso, operator, total: 0, delivered: 0, latencies: [], dlrLatencies: [] });
    const b = buckets.get(key);
    b.total += 1;
    if (row.final_status === "delivered") {
      b.delivered += 1;
      if (row.latency_ms != null) b.latencies.push(row.latency_ms);
    }
    // Latence DLR comptée indépendamment du statut final (voir aggregate()
    // dans ce même fichier pour le raisonnement détaillé) : le DLR fournisseur
    // peut arriver même sans réception confirmée sur le téléphone.
    if (row.dlr_latency_ms != null) b.dlrLatencies.push(row.dlr_latency_ms);
  };

  for (const row of rows) {
    const t = new Date(row.sent_at).getTime();
    const bucketStart = Math.floor(t / (bucketMinutes * 60000)) * (bucketMinutes * 60000);
    const bucketIso = new Date(bucketStart).toISOString();
    touchBucket(bucketIso, "__all__", row);
    touchBucket(bucketIso, row.operator || "(non renseigné)", row);
  }

  const series = [...buckets.values()]
    .sort((a, b) => a.time.localeCompare(b.time))
    .map((b) => ({
      time: b.time,
      operator: b.operator,
      total: b.total,
      delivered: b.delivered,
      deliveryRate: b.total ? b.delivered / b.total : null,
      avgLatencyMs: b.latencies.length ? b.latencies.reduce((a, c) => a + c, 0) / b.latencies.length : null,
      avgDlrLatencyMs: b.dlrLatencies.length ? b.dlrLatencies.reduce((a, c) => a + c, 0) / b.dlrLatencies.length : null,
    }));

  res.json(series);
});

// triggerType (optionnel) : "scheduled" ou "manual", pour isoler les tests
// automatiques du cycle planifié des tests manuels lancés depuis "Test manuel"
// dans la vue "Tests récents" (par défaut, sans filtre, on garde les deux).
// since/until (ISO 8601, optionnels) : mêmes filtres rapides "Dernière heure /
// Aujourd'hui / Hier" que sur /tests, voir le commentaire là-bas.
router.get("/stats/recent", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
  const { since, until } = req.query;

  const conditions = [];
  const params = [];
  if (["scheduled", "manual"].includes(req.query.triggerType)) {
    conditions.push("t.trigger_type = ?");
    params.push(req.query.triggerType);
  }
  if (since) { conditions.push("t.sent_at >= ?"); params.push(since); }
  if (until) { conditions.push("t.sent_at <= ?"); params.push(until); }
  params.push(limit);

  const rows = db
    .prepare(`
      SELECT t.*, r.name as route_name, r.provider_id, r.country, r.operator
      FROM test_messages t JOIN routes r ON r.id = t.route_id
      ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}
      ORDER BY t.sent_at DESC LIMIT ?
    `)
    .all(...params);
  res.json(rows);
});

// ---------- Clients (vue externe en lecture seule) ----------
// Gestion admin des comptes clients et de ce qu'ils peuvent voir (couples
// opérateur/pays). Le mot de passe en clair ne transite que sur ces deux
// endpoints (création/reset) et n'est jamais stocké : seuls le hash + le sel
// le sont (voir password.js).

router.get("/clients", requireAdmin, (req, res) => {
  const clients = db.prepare(`SELECT id, name, username, active, created_at FROM clients ORDER BY name`).all();
  const scopes = db.prepare(`SELECT client_id, operator, country FROM client_operator_scopes ORDER BY operator`).all();
  const scopesByClient = new Map();
  for (const s of scopes) {
    if (!scopesByClient.has(s.client_id)) scopesByClient.set(s.client_id, []);
    scopesByClient.get(s.client_id).push({ operator: s.operator, country: s.country });
  }
  res.json(clients.map((c) => ({ ...c, scopes: scopesByClient.get(c.id) || [] })));
});

// Couples (opérateur, pays) distincts vus dans les routes existantes, pour
// peupler le sélecteur d'assignation côté admin sans ressaisie manuelle.
router.get("/clients/available-operators", requireAdmin, (req, res) => {
  const rows = db
    .prepare(`SELECT DISTINCT operator, country FROM routes WHERE operator IS NOT NULL AND operator != '' ORDER BY operator, country`)
    .all();
  res.json(rows);
});

router.post("/clients", requireAdmin, (req, res) => {
  const { name, username, password, scopes } = req.body || {};
  if (!name || !username || !password) {
    return res.status(400).json({ error: "name, username et password sont requis" });
  }
  const { hash, salt } = hashPassword(password);
  try {
    const { lastInsertRowid: clientId } = db
      .prepare(`INSERT INTO clients (name, username, password_hash, password_salt) VALUES (?, ?, ?, ?)`)
      .run(name.trim(), username.trim(), hash, salt);

    const insertScope = db.prepare(`INSERT INTO client_operator_scopes (client_id, operator, country) VALUES (?, ?, ?)`);
    (Array.isArray(scopes) ? scopes : []).forEach((s) => {
      if (s && s.operator) insertScope.run(clientId, s.operator, s.country || null);
    });

    res.json({ id: clientId });
  } catch (err) {
    if (String(err.message || "").includes("UNIQUE")) {
      return res.status(409).json({ error: "ce nom d'utilisateur existe déjà" });
    }
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Remplace entièrement le nom + les scopes d'un client (l'admin renvoie la
// liste complète à chaque sauvegarde depuis le dashboard, plus simple que
// des opérations incrémentales côté UI). Le mot de passe se change à part
// via /clients/:id/password, jamais ici.
router.patch("/clients/:id", requireAdmin, (req, res) => {
  const client = db.prepare(`SELECT * FROM clients WHERE id = ?`).get(req.params.id);
  if (!client) return res.status(404).json({ error: "client introuvable" });

  const { name, active, scopes } = req.body || {};
  db.prepare(`
    UPDATE clients SET
      name = COALESCE(?, name),
      active = COALESCE(?, active)
    WHERE id = ?
  `).run(name || null, active === undefined ? null : (active ? 1 : 0), req.params.id);

  if (Array.isArray(scopes)) {
    const tx = db.transaction((rows) => {
      db.prepare(`DELETE FROM client_operator_scopes WHERE client_id = ?`).run(req.params.id);
      const insertScope = db.prepare(`INSERT INTO client_operator_scopes (client_id, operator, country) VALUES (?, ?, ?)`);
      rows.forEach((s) => { if (s && s.operator) insertScope.run(req.params.id, s.operator, s.country || null); });
    });
    tx(scopes);
  }

  res.json({ ok: true });
});

router.post("/clients/:id/password", requireAdmin, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 6) {
    return res.status(400).json({ error: "mot de passe requis (6 caractères minimum)" });
  }
  const client = db.prepare(`SELECT * FROM clients WHERE id = ?`).get(req.params.id);
  if (!client) return res.status(404).json({ error: "client introuvable" });

  const { hash, salt } = hashPassword(password);
  db.prepare(`UPDATE clients SET password_hash = ?, password_salt = ? WHERE id = ?`).run(hash, salt, req.params.id);
  res.json({ ok: true });
});

router.delete("/clients/:id", requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM client_operator_scopes WHERE client_id = ?`).run(req.params.id);
  db.prepare(`DELETE FROM clients WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
