const express = require("express");
const db = require("./../db");
const { requireClientSession } = require("./../client-auth");

const router = express.Router();

/*
 * API lecture seule pour la vue cliente. Deux restrictions, toutes deux
 * volontaires et non négociables côté client :
 *
 * 1. Uniquement les envois vers NOS téléphones de test (table test_messages,
 *    liée à routes — jamais testsms_tests, qui cible des numéros appartenant
 *    à un fournisseur de test externe type TestSMS.com). Les deux flux ne
 *    sont d'ailleurs jamais mélangés dans ce fichier : seule la jointure
 *    test_messages JOIN routes est utilisée.
 * 2. Uniquement les tests du cycle AUTOMATIQUE planifié (trigger_type =
 *    'scheduled'), jamais les tests manuels qu'un admin lance à la main
 *    depuis "Test manuel" pour déboguer — ceux-ci ne reflètent pas la QoS
 *    réelle sur la durée et n'ont rien à faire dans une vue client.
 *
 * Par ailleurs, chaque requête est filtrée aux (opérateur, pays) assignés au
 * client connecté (table client_operator_scopes) et ne sélectionne JAMAIS
 * route_name, provider_id, destination_number, device_name, sender_id,
 * received_from_number ou provider_response — uniquement operator, country,
 * horodatages et statuts/latences. Toute nouvelle colonne ajoutée à routes/
 * test_messages ne doit être exposée ici qu'après relecture explicite.
 */

const AUTOMATIC_ONLY = `t.trigger_type = 'scheduled'`;

router.use(requireClientSession);

// Construit la clause WHERE + les params correspondant aux scopes du
// client. Un scope avec country = NULL matche l'opérateur dans n'importe
// quel pays ; un scope avec country précis ne matche que ce couple exact.
function scopeFilter(clientId) {
  const scopes = db.prepare(`SELECT operator, country FROM client_operator_scopes WHERE client_id = ?`).all(clientId);
  if (!scopes.length) return { sql: "0 = 1", params: [] }; // aucun scope => aucune donnée, jamais "tout" par défaut
  const clauses = [];
  const params = [];
  scopes.forEach((s) => {
    if (s.country) {
      clauses.push("(r.operator = ? AND r.country = ?)");
      params.push(s.operator, s.country);
    } else {
      // Pas de pays précisé pour ce scope : matche l'opérateur quel que
      // soit le pays de la route.
      clauses.push("r.operator = ?");
      params.push(s.operator);
    }
  });
  return { sql: clauses.join(" OR "), params };
}

router.get("/me", (req, res) => {
  res.json({ name: req.client.name, username: req.client.username });
});

router.get("/scopes", (req, res) => {
  const scopes = db
    .prepare(`SELECT operator, country FROM client_operator_scopes WHERE client_id = ? ORDER BY operator`)
    .all(req.client.id);
  res.json(scopes);
});

// Même bucketing que /api/stats/timeseries (admin), mais filtré aux scopes
// du client et sans aucune colonne liée à la route/au fournisseur.
router.get("/stats/timeseries", (req, res) => {
  const sinceHours = parseInt(req.query.sinceHours || "24", 10);
  const bucketMinutes = parseInt(req.query.bucketMinutes || "60", 10);
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();

  const { sql: scopeSql, params: scopeParams } = scopeFilter(req.client.id);

  const rows = db
    .prepare(`
      SELECT t.sent_at, t.final_status, t.latency_ms, t.dlr_latency_ms, r.operator
      FROM test_messages t JOIN routes r ON r.id = t.route_id
      WHERE t.sent_at >= ? AND ${AUTOMATIC_ONLY} AND (${scopeSql})
      ORDER BY t.sent_at
    `)
    .all(since, ...scopeParams);

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

// Log des tests, strictement limité à operator/country/horodatages/statut —
// jamais route_name, provider_id, destination_number, device_name,
// sender_id, received_from_number ni provider_response. Volontairement plus
// "profond" que les graphiques (limite plus haute, et indépendant de la
// période du dashboard) : un client peut vouloir consulter plusieurs jours
// d'historique de tests même si les graphiques se limitent à 24h max.
// `operator` (optionnel) filtre sur un seul opérateur parmi ceux assignés
// au client (toujours recoupé avec ses scopes, jamais un passe-droit).
router.get("/tests", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 500);
  const { since, until, operator } = req.query;
  const { sql: scopeSql, params: scopeParams } = scopeFilter(req.client.id);

  const conditions = [AUTOMATIC_ONLY, `(${scopeSql})`];
  const params = [...scopeParams];
  if (operator) { conditions.push("r.operator = ?"); params.push(operator); }
  if (since) { conditions.push("t.sent_at >= ?"); params.push(since); }
  if (until) { conditions.push("t.sent_at <= ?"); params.push(until); }
  params.push(limit);

  const rows = db
    .prepare(`
      SELECT t.sent_at, t.final_status, t.latency_ms, t.dlr_latency_ms, r.operator, r.country
      FROM test_messages t JOIN routes r ON r.id = t.route_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY t.id DESC
      LIMIT ?
    `)
    .all(...params);

  res.json(rows);
});

module.exports = router;
