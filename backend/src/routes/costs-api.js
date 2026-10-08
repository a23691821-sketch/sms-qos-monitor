const express = require("express");
const db = require("./../db");

const router = express.Router();

// Même garde que api.js / testsms-api.js : clé admin en header (ce sont des
// données commerciales, au même niveau de protection que la configuration).
function requireAdmin(req, res, next) {
  const key = req.header("x-admin-key");
  if (key !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: "clé admin invalide" });
  next();
}
router.use(requireAdmin);

// ---------- Normalisation des pays ----------
//
// Les pays ne sont pas stockés dans un format unique : routes.country est
// saisi à la main (ex. "FR"), tandis que testsms_tests.country reprend le nom
// renvoyé par TestSMS (ex. "France"). On ramène tout au code ISO alpha-2
// pour que les mêmes SMS ne se retrouvent pas répartis sur deux lignes.

const COUNTRY_ALIASES = {
  france: "FR", francia: "FR",
  italy: "IT", italie: "IT", italia: "IT",
  germany: "DE", allemagne: "DE", deutschland: "DE", germania: "DE",
  spain: "ES", espagne: "ES", espana: "ES", "españa": "ES", spagna: "ES",
};
// Repli sur le MCC (3 premiers chiffres du MCC-MNC) quand le nom de pays est
// absent ou inconnu — ne couvre que les pays pré-remplis, les autres
// tombent dans "pays inconnu" tant qu'un alias n'existe pas.
const MCC_TO_ISO = { "208": "FR", "222": "IT", "262": "DE", "214": "ES" };

function stripAccents(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function buildCountryResolver() {
  const byName = new Map(Object.entries(COUNTRY_ALIASES));
  const rates = db.prepare(`SELECT country_code, country_name FROM sms_costs`).all();
  for (const r of rates) {
    byName.set(stripAccents(r.country_name).toLowerCase(), r.country_code);
    byName.set(r.country_code.toLowerCase(), r.country_code);
  }
  return function resolve(country, mccmnc) {
    if (country) {
      const raw = String(country).trim();
      const key = stripAccents(raw).toLowerCase();
      if (byName.has(key)) return byName.get(key);
      if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
    }
    if (mccmnc) {
      const iso = MCC_TO_ISO[String(mccmnc).slice(0, 3)];
      if (iso) return iso;
    }
    return country ? String(country).trim().toUpperCase() : null;
  };
}

// ---------- Tarifs ----------

function parseCost(v) {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const n = Number(String(v).replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

router.get("/rates", (req, res) => {
  res.json(db.prepare(`SELECT country_code, country_name, unit_cost FROM sms_costs ORDER BY country_name`).all());
});

router.post("/rates", (req, res) => {
  const { countryCode, countryName, unitCost } = req.body || {};
  const code = String(countryCode || "").trim().toUpperCase();
  const name = String(countryName || "").trim();
  if (!/^[A-Z]{2}$/.test(code)) return res.status(400).json({ error: "code pays invalide (2 lettres, ex. GB)" });
  if (!name) return res.status(400).json({ error: "nom du pays requis" });
  const cost = parseCost(unitCost);
  if (!cost.ok) return res.status(400).json({ error: "coût unitaire invalide" });
  if (db.prepare(`SELECT 1 FROM sms_costs WHERE country_code = ?`).get(code)) {
    return res.status(409).json({ error: `le pays ${code} existe déjà` });
  }
  db.prepare(`INSERT INTO sms_costs (country_code, country_name, unit_cost) VALUES (?, ?, ?)`).run(code, name, cost.value);
  res.status(201).json({ country_code: code, country_name: name, unit_cost: cost.value });
});

router.put("/rates/:code", (req, res) => {
  const code = String(req.params.code).toUpperCase();
  const existing = db.prepare(`SELECT * FROM sms_costs WHERE country_code = ?`).get(code);
  if (!existing) return res.status(404).json({ error: "pays introuvable" });
  const { unitCost, countryName } = req.body || {};
  const cost = parseCost(unitCost);
  if (!cost.ok) return res.status(400).json({ error: "coût unitaire invalide" });
  const name = countryName !== undefined && String(countryName).trim() ? String(countryName).trim() : existing.country_name;
  db.prepare(`UPDATE sms_costs SET unit_cost = ?, country_name = ? WHERE country_code = ?`).run(cost.value, name, code);
  res.json({ country_code: code, country_name: name, unit_cost: cost.value });
});

router.delete("/rates/:code", (req, res) => {
  const info = db.prepare(`DELETE FROM sms_costs WHERE country_code = ?`).run(String(req.params.code).toUpperCase());
  if (!info.changes) return res.status(404).json({ error: "pays introuvable" });
  res.json({ ok: true });
});

// ---------- Statistiques ----------

const TIMEZONE = "Europe/Paris";
const GRANULARITIES = {
  hour: { windowMs: 48 * 3600 * 1000, label: "48 dernières heures" },
  day: { windowMs: 31 * 24 * 3600 * 1000, label: "31 derniers jours" },
  month: { windowMs: 366 * 24 * 3600 * 1000, label: "12 derniers mois" },
};

// Clé de regroupement en heure locale (Europe/Paris, la même que celle que
// voit l'utilisateur dans le dashboard), pas en UTC : un SMS envoyé à 00:30
// heure de Paris doit tomber dans le bon jour/mois.
const partsFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
});
function periodKey(iso, granularity) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  const hour = p.hour === "24" ? "00" : p.hour;
  if (granularity === "month") return `${p.year}-${p.month}`;
  if (granularity === "day") return `${p.year}-${p.month}-${p.day}`;
  return `${p.year}-${p.month}-${p.day} ${hour}:00`;
}

// Évite d'afficher/renvoyer des artefacts flottants (0.39999999999999997).
const round6 = (x) => Math.round(x * 1e6) / 1e6;

router.get("/stats", (req, res) => {
  const granularity = GRANULARITIES[req.query.granularity] ? req.query.granularity : "day";
  const includeManual = req.query.includeManual !== "0";
  const includeTestsms = req.query.includeTestsms !== "0";
  const sinceIso = new Date(Date.now() - GRANULARITIES[granularity].windowMs).toISOString();

  const rates = db.prepare(`SELECT country_code, country_name, unit_cost FROM sms_costs ORDER BY country_name`).all();
  const rateByCode = new Map(rates.map((r) => [r.country_code, r]));
  const resolve = buildCountryResolver();

  // Un SMS est facturé dès que le fournisseur l'a accepté, qu'il arrive ou
  // non : on compte donc tout ce qui a été soumis, et on exclut seulement
  // les envois refusés d'emblée (provider_status = 'error').
  const events = [];

  const routeRows = db.prepare(`
    SELECT t.sent_at AS at, t.trigger_type, r.country AS country
    FROM test_messages t JOIN routes r ON r.id = t.route_id
    WHERE t.sent_at >= ? AND COALESCE(t.provider_status, '') != 'error'
  `).all(sinceIso);
  for (const r of routeRows) {
    if (!includeManual && r.trigger_type === "manual") continue;
    events.push({ at: r.at, code: resolve(r.country, null), source: "routes" });
  }

  if (includeTestsms) {
    const tsRows = db.prepare(`
      SELECT sent_at AS at, trigger_type, country, mccmnc
      FROM testsms_tests
      WHERE sent_at IS NOT NULL AND sent_at >= ? AND COALESCE(our_provider_status, '') NOT IN ('', 'error')
    `).all(sinceIso);
    for (const r of tsRows) {
      if (!includeManual && r.trigger_type === "manual") continue;
      events.push({ at: r.at, code: resolve(r.country, r.mccmnc), source: "testsms" });
    }
  }

  // Colonnes = pays tarifés + (si nécessaire) pays rencontrés sans tarif.
  const unknownCodes = new Set();
  const periods = new Map();
  const totalsByCountry = {};
  let totalCount = 0;
  let totalCost = 0;
  let unpricedCount = 0;

  for (const e of events) {
    const code = e.code || "?";
    if (!rateByCode.has(code)) unknownCodes.add(code);
    const rate = rateByCode.get(code);
    const unit = rate && rate.unit_cost != null ? rate.unit_cost : null;
    const key = periodKey(e.at, granularity);
    if (!periods.has(key)) periods.set(key, { period: key, byCountry: {}, totalCount: 0, totalCost: 0 });
    const row = periods.get(key);
    const cell = (row.byCountry[code] = row.byCountry[code] || { count: 0, cost: 0 });
    cell.count += 1;
    row.totalCount += 1;
    const tot = (totalsByCountry[code] = totalsByCountry[code] || { count: 0, cost: 0 });
    tot.count += 1;
    totalCount += 1;
    if (unit != null) {
      cell.cost += unit;
      row.totalCost += unit;
      tot.cost += unit;
      totalCost += unit;
    } else {
      unpricedCount += 1;
    }
  }

  const countries = [
    ...rates.map((r) => ({ code: r.country_code, name: r.country_name, unitCost: r.unit_cost })),
    ...[...unknownCodes].sort().map((c) => ({ code: c, name: c === "?" ? "Pays inconnu" : c, unitCost: null })),
  ];

  res.json({
    granularity,
    windowLabel: GRANULARITIES[granularity].label,
    timezone: TIMEZONE,
    currency: "EUR",
    countries,
    rows: [...periods.values()]
      .map((r) => ({
        ...r,
        totalCost: round6(r.totalCost),
        byCountry: Object.fromEntries(Object.entries(r.byCountry).map(([k, v]) => [k, { count: v.count, cost: round6(v.cost) }])),
      }))
      .sort((a, b) => b.period.localeCompare(a.period)),
    totals: {
      count: totalCount,
      cost: round6(totalCost),
      byCountry: Object.fromEntries(Object.entries(totalsByCountry).map(([k, v]) => [k, { count: v.count, cost: round6(v.cost) }])),
    },
    unpricedCount,
  });
});

module.exports = router;
