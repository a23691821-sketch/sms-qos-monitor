const express = require("express");
const crypto = require("crypto");
const db = require("./../db");
const { runTestForRoute } = require("./../scheduler");

const router = express.Router();

function requireAdmin(req, res, next) {
  const key = req.header("x-admin-key");
  if (key !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: "clé admin invalide" });
  next();
}

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

router.get("/devices", requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT id, name, phone_number, last_seen_at, created_at FROM devices`).all());
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

router.patch("/routes/:id", requireAdmin, (req, res) => {
  const { active, intervalMinutes } = req.body || {};
  const route = db.prepare(`SELECT * FROM routes WHERE id = ?`).get(req.params.id);
  if (!route) return res.status(404).json({ error: "route introuvable" });

  db.prepare(`
    UPDATE routes SET active = COALESCE(?, active), interval_minutes = COALESCE(?, interval_minutes)
    WHERE id = ?
  `).run(active === undefined ? null : (active ? 1 : 0), intervalMinutes || null, req.params.id);

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

  const totals = db
    .prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN final_status = 'delivered' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN final_status = 'timeout' THEN 1 ELSE 0 END) as timeout,
        SUM(CASE WHEN final_status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN final_status = 'pending' THEN 1 ELSE 0 END) as pending,
        AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END) as avg_latency_ms
      FROM test_messages WHERE sent_at >= ?
    `)
    .get(since);

  const byRoute = db
    .prepare(`
      SELECT
        r.id as route_id, r.name as route_name, r.provider_id, r.country, r.operator,
        COUNT(t.id) as total,
        SUM(CASE WHEN t.final_status = 'delivered' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN t.final_status = 'timeout' THEN 1 ELSE 0 END) as timeout,
        SUM(CASE WHEN t.final_status = 'failed' THEN 1 ELSE 0 END) as failed,
        AVG(CASE WHEN t.latency_ms IS NOT NULL THEN t.latency_ms END) as avg_latency_ms,
        SUM(CASE WHEN t.dlr_status = 'delivered' AND t.final_status != 'delivered' THEN 1 ELSE 0 END) as dlr_mismatch
      FROM routes r
      LEFT JOIN test_messages t ON t.route_id = r.id AND t.sent_at >= ?
      GROUP BY r.id
      ORDER BY r.id
    `)
    .all(since);

  res.json({
    sinceHours,
    totals: {
      ...totals,
      deliveryRate: totals.total ? totals.delivered / totals.total : null,
    },
    byRoute: byRoute.map((r) => ({
      ...r,
      deliveryRate: r.total ? r.delivered / r.total : null,
    })),
  });
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
