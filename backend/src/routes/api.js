const express = require("express");
const crypto = require("crypto");
const db = require("./../db");
const { runTestForRoute } = require("./../scheduler");
const { loadProviderConfigs } = require("./../providers");

const router = express.Router();

// Percentile "nearest rank" simple, suffisant pour du monitoring (pas besoin
// d'interpolation linéaire ici). `values` n'a pas besoin d'être trié.
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function aggregate(rows) {
  const delivered = rows.filter((r) => r.final_status === "delivered");
  const latencies = delivered.map((r) => r.latency_ms).filter((v) => v != null);
  const dlrMismatch = rows.filter((r) => r.dlr_status === "delivered" && r.final_status !== "delivered").length;

  return {
    total: rows.length,
    delivered: delivered.length,
    timeout: rows.filter((r) => r.final_status === "timeout").length,
    failed: rows.filter((r) => r.final_status === "failed").length,
    pending: rows.filter((r) => r.final_status === "pending").length,
    deliveryRate: rows.length ? delivered.length / rows.length : null,
    avgLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
    p95LatencyMs: percentile(latencies, 95),
    p99LatencyMs: percentile(latencies, 99),
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
  res.json(db.prepare(`SELECT id, name, phone_number, api_key, last_seen_at, created_at FROM devices`).all());
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
  const route = db.prepare(`SELECT * FROM routes WHERE id = ?`).get(req.params.id);
  if (!route) return res.status(404).json({ error: "route introuvable" });
  await runTestForRoute(route);
  res.json({ ok: true });
});

// ---------- Stats pour le dashboard ----------

router.get("/stats/overview", (req, res) => {
  const sinceHours = parseInt(req.query.sinceHours || "24", 10);
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();

  const rows = db
    .prepare(`
      SELECT t.*, r.id as route_id, r.name as route_name, r.provider_id, r.country, r.operator
      FROM test_messages t JOIN routes r ON r.id = t.route_id
      WHERE t.sent_at >= ?
    `)
    .all(since);

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

  const rows = db
    .prepare(`
      SELECT t.*, r.country, r.operator
      FROM test_messages t JOIN routes r ON r.id = t.route_id
      WHERE t.sent_at >= ?
    `)
    .all(since);

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

  const rows = db
    .prepare(`
      SELECT t.id, t.code, t.sent_at, t.final_status, t.provider_status, t.dlr_status,
             t.latency_ms, t.dlr_latency_ms, t.received_from_number,
             r.name as route_name, r.provider_id, r.country, r.operator
      FROM test_messages t JOIN routes r ON r.id = t.route_id
      WHERE t.sent_at >= ?
      ORDER BY t.sent_at DESC
    `)
    .all(since);

  const headers = [
    "id", "code", "sent_at", "final_status", "provider_status", "dlr_status",
    "latency_ms", "dlr_latency_ms", "received_from_number",
    "route_name", "provider_id", "country", "operator",
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

router.get("/stats/timeseries", (req, res) => {
  const sinceHours = parseInt(req.query.sinceHours || "24", 10);
  const bucketMinutes = parseInt(req.query.bucketMinutes || "60", 10);
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();

  // Bucketing simple fait en JS pour rester lisible et indépendant du moteur SQL
  const rows = db
    .prepare(`SELECT sent_at, final_status, latency_ms FROM test_messages WHERE sent_at >= ? ORDER BY sent_at`)
    .all(since);

  const buckets = new Map();
  for (const row of rows) {
    const t = new Date(row.sent_at).getTime();
    const bucketStart = Math.floor(t / (bucketMinutes * 60000)) * (bucketMinutes * 60000);
    const key = new Date(bucketStart).toISOString();
    if (!buckets.has(key)) buckets.set(key, { time: key, total: 0, delivered: 0, latencies: [] });
    const b = buckets.get(key);
    b.total += 1;
    if (row.final_status === "delivered") {
      b.delivered += 1;
      if (row.latency_ms != null) b.latencies.push(row.latency_ms);
    }
  }

  const series = [...buckets.values()]
    .sort((a, b) => a.time.localeCompare(b.time))
    .map((b) => ({
      time: b.time,
      total: b.total,
      delivered: b.delivered,
      deliveryRate: b.total ? b.delivered / b.total : null,
      avgLatencyMs: b.latencies.length ? b.latencies.reduce((a, c) => a + c, 0) / b.latencies.length : null,
    }));

  res.json(series);
});

router.get("/stats/recent", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
  const rows = db
    .prepare(`
      SELECT t.*, r.name as route_name, r.provider_id, r.country, r.operator
      FROM test_messages t JOIN routes r ON r.id = t.route_id
      ORDER BY t.sent_at DESC LIMIT ?
    `)
    .all(limit);
  res.json(rows);
});

module.exports = router;
