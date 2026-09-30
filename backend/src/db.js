const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH || "./data/qos.sqlite";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  api_key TEXT NOT NULL UNIQUE,
  phone_number TEXT,
  last_seen_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  country TEXT,
  operator TEXT,
  destination_number TEXT NOT NULL,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  interval_minutes INTEGER NOT NULL DEFAULT 15,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS test_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id INTEGER NOT NULL REFERENCES routes(id),
  code TEXT NOT NULL UNIQUE,
  sent_at TEXT NOT NULL,
  provider_status TEXT DEFAULT 'submitted',
  provider_response TEXT,
  provider_message_id TEXT,
  dlr_status TEXT,
  dlr_at TEXT,
  received_at TEXT,
  received_from_number TEXT,
  latency_ms INTEGER,
  dlr_latency_ms INTEGER,
  final_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_test_messages_code ON test_messages(code);
CREATE INDEX IF NOT EXISTS idx_test_messages_route ON test_messages(route_id);
CREATE INDEX IF NOT EXISTS idx_test_messages_status ON test_messages(final_status);

-- Un "type" + "scope_key" identifie ce qui a déclenché l'alerte (ex: type=delivery_rate,
-- scope_key=route:1). Tant qu'une ligne du même (type, scope_key) reste "active", on ne
-- recrée pas de doublon à chaque tick du scheduler — on se contente de la garder ouverte.
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_active_unique ON alerts(type, scope_key) WHERE status = 'active';

-- DLR bruts reçus des fournisseurs, même quand on n'a pas pu les corréler à un test
-- (utile pour débugger le format exact envoyé par un fournisseur donné).
CREATE TABLE IF NOT EXISTS dlr_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  matched_test_id INTEGER REFERENCES test_messages(id),
  raw_body TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

// Migration : la page "Test manuel" permet un contenu personnalisé, donc le
// corps du SMS n'est plus toujours déductible du seul code (voir idgen.js).
// Ajouté après coup avec ALTER TABLE (CREATE TABLE IF NOT EXISTS ne modifie
// pas une table déjà existante) ; sans effet si la colonne existe déjà.
const testMessageColumns = db.prepare("PRAGMA table_info(test_messages)").all().map((c) => c.name);
if (!testMessageColumns.includes("body")) {
  db.exec("ALTER TABLE test_messages ADD COLUMN body TEXT");
}

module.exports = db;
