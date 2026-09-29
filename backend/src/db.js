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
`);

module.exports = db;
