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

-- Réglages globaux simples (clé/valeur), ex: mise en pause de l'envoi de SMS
-- (bouton d'urgence dans la sidebar). Persisté en base plutôt qu'en mémoire
-- pour que la pause survive à un redémarrage du service.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Tests vers un fournisseur externe de test SMS (TestSMS.com) : contrairement
-- aux routes ci-dessus (on envoie VERS un téléphone qu'on contrôle, qui
-- confirme via l'app Android), ici la cible est un numéro appartenant à
-- TestSMS lui-même — on ne peut donc jamais recevoir de confirmation par
-- l'app. Le flux est aussi inversé : on demande d'abord un numéro + un
-- messageId à TestSMS (createTest), PUIS on envoie nous-mêmes le SMS vers ce
-- numéro via un de nos fournisseurs existants (outbound_provider_id,
-- réutilise sendTestSms()), et c'est TestSMS qui confirme la réception réelle
-- (receiptStatus) via callback ou polling. "schedule" = config d'un test
-- répété automatiquement (équivalent de "routes" mais pour ce flux-ci).
CREATE TABLE IF NOT EXISTS testsms_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mccmnc TEXT NOT NULL,
  mccmnc_original TEXT,
  country TEXT,
  network TEXT,
  outbound_provider_id TEXT NOT NULL,
  sender_id TEXT,
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS testsms_tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER REFERENCES testsms_schedules(id),
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  mccmnc TEXT NOT NULL,
  mccmnc_original TEXT,
  country TEXT,
  network TEXT,
  outbound_provider_id TEXT NOT NULL,
  sender_id TEXT,
  -- Côté TestSMS (créé par POST /v1/createTest)
  testsms_test_id TEXT,
  testsms_message_id TEXT,
  msisdn TEXT,
  create_test_status TEXT DEFAULT 'pending',
  create_test_response TEXT,
  -- Côté notre envoi (notre fournisseur -> numéro TestSMS)
  our_provider_status TEXT,
  our_provider_response TEXT,
  our_provider_message_id TEXT,
  sent_at TEXT,
  -- Côté résultat TestSMS (callback ou polling GET /v1/smsTest/:id)
  receipt_status TEXT,
  receipt_time TEXT,
  delivered_sender TEXT,
  delivered_text TEXT,
  pdu TEXT,
  price REAL,
  currency TEXT,
  billing_status TEXT,
  latency_ms INTEGER,
  final_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_testsms_tests_testid ON testsms_tests(testsms_test_id);
CREATE INDEX IF NOT EXISTS idx_testsms_tests_status ON testsms_tests(final_status);
CREATE INDEX IF NOT EXISTS idx_testsms_tests_schedule ON testsms_tests(schedule_id);
`);

// Migration : la page "Test manuel" permet un contenu personnalisé, donc le
// corps du SMS n'est plus toujours déductible du seul code (voir idgen.js).
// Ajouté après coup avec ALTER TABLE (CREATE TABLE IF NOT EXISTS ne modifie
// pas une table déjà existante) ; sans effet si la colonne existe déjà.
const testMessageColumns = db.prepare("PRAGMA table_info(test_messages)").all().map((c) => c.name);
if (!testMessageColumns.includes("body")) {
  db.exec("ALTER TABLE test_messages ADD COLUMN body TEXT");
}
// trigger_type distingue les tests du cycle planifié ("scheduled", valeur par
// défaut) de ceux lancés à la main depuis la page "Test manuel" ("manual"),
// pour pouvoir filtrer l'historique de cette page sans polluer les stats QoS
// globales. sender_id enregistre la valeur réellement utilisée pour CE test
// (vide = valeur par défaut du fournisseur, jamais surchargée).
if (!testMessageColumns.includes("trigger_type")) {
  db.exec("ALTER TABLE test_messages ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'scheduled'");
}
if (!testMessageColumns.includes("sender_id")) {
  db.exec("ALTER TABLE test_messages ADD COLUMN sender_id TEXT");
}
// Contenu du SMS tel que réellement reçu par le téléphone (rapporté par
// l'app Android), pour pouvoir le comparer au contenu envoyé (colonne
// "body") et détecter une corruption/troncature en transit.
if (!testMessageColumns.includes("received_body")) {
  db.exec("ALTER TABLE test_messages ADD COLUMN received_body TEXT");
}

// "Heartbeat" périodique envoyé par l'app Android indépendamment de toute
// réception de SMS (contrairement à last_seen_at, qui ne bouge que quand un
// SMS de test est reçu et donc ne dit rien si une route ne teste pas ce
// téléphone en ce moment). Permet de savoir si le téléphone/l'app est bien
// vivant même en l'absence de tout trafic SMS.
const devicesColumns = db.prepare("PRAGMA table_info(devices)").all().map((c) => c.name);
if (!devicesColumns.includes("last_heartbeat_at")) {
  db.exec("ALTER TABLE devices ADD COLUMN last_heartbeat_at TEXT");
}

// Etat détaillé remonté par le heartbeat de l'app (APK 04.2+) : permet de
// diagnostiquer un téléphone à distance (batterie, exemption d'optimisation,
// Doze, réseau) sans devoir le consulter physiquement.
for (const [col, type] of [
  ["app_version", "TEXT"],
  ["battery_level", "INTEGER"],
  ["battery_charging", "INTEGER"],
  ["battery_exempt", "INTEGER"],
  ["doze_mode", "INTEGER"],
  ["network_type", "TEXT"],
]) {
  if (!devicesColumns.includes(col)) db.exec(`ALTER TABLE devices ADD COLUMN ${col} ${type}`);
}

// Instant où le serveur a reçu le rapport de l'app, à comparer à received_at
// (horloge du téléphone au moment où le SMS est arrivé) : l'écart mesure le
// retard de REMONTÉE (Android qui endort l'app), distinct du retard de
// livraison de l'opérateur.
if (!testMessageColumns.includes("reported_at")) {
  db.exec("ALTER TABLE test_messages ADD COLUMN reported_at TEXT");
}

// Copie de la boîte de réception SMS du téléphone (lue par l'app avec
// READ_SMS, envoyée avec le heartbeat) : équivalent d'ouvrir l'app Messages
// à distance. Lecture réservée à l'admin.
db.exec(`
  CREATE TABLE IF NOT EXISTS device_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    sms_at TEXT NOT NULL,
    address TEXT,
    body TEXT,
    synced_at TEXT NOT NULL,
    UNIQUE (device_id, sms_at, address, body)
  );
  CREATE INDEX IF NOT EXISTS idx_device_inbox_device_time ON device_inbox (device_id, sms_at DESC);
`);

// "Pays entier" : une planification/un test peut désormais cibler TOUS les
// opérateurs natifs d'un pays TestSMS en une fois, plutôt qu'un seul
// mccmnc choisi à l'avance. Pour une planification en mode pays, on ne
// figure jamais la liste des opérateurs au moment de la création : à chaque
// exécution, on interroge à nouveau TestSMS pour repartir de la liste à jour
// (voir scheduler.js) — country_iso est donc tout ce qu'il faut stocker,
// mccmnc reste rempli (= country_iso) juste pour satisfaire la contrainte
// NOT NULL existante, sans signification propre en mode pays.
const testsmsSchedulesColumns = db.prepare("PRAGMA table_info(testsms_schedules)").all().map((c) => c.name);
if (!testsmsSchedulesColumns.includes("is_country")) {
  db.exec("ALTER TABLE testsms_schedules ADD COLUMN is_country INTEGER NOT NULL DEFAULT 0");
}
if (!testsmsSchedulesColumns.includes("country_iso")) {
  db.exec("ALTER TABLE testsms_schedules ADD COLUMN country_iso TEXT");
}

// Un test "pays entier" crée plusieurs lignes testsms_tests d'un coup (une
// par opérateur natif) : batch_id (même valeur pour toutes) permet de les
// regrouper à l'affichage (résultat du test ponctuel, historique).
const testsmsTestsColumns = db.prepare("PRAGMA table_info(testsms_tests)").all().map((c) => c.name);
if (!testsmsTestsColumns.includes("batch_id")) {
  db.exec("ALTER TABLE testsms_tests ADD COLUMN batch_id TEXT");
}

// Vue cliente (externe) : chaque client a son propre identifiant/mot de
// passe et ne voit que les données des opérateurs/pays qui lui sont
// explicitement assignés — jamais les routes, fournisseurs ou numéros de
// destination sous-jacents (voir client-api.js, qui ne sélectionne jamais
// ces colonnes-là dans ses requêtes).
db.exec(`
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- country NULL = l'opérateur est visible pour ce client quel que soit le
-- pays (utile si le nom d'opérateur ne se recoupe pas entre pays dans ton
-- usage ; sinon assigne des lignes (operator, country) précises).
CREATE TABLE IF NOT EXISTS client_operator_scopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  operator TEXT NOT NULL,
  country TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_scopes_client ON client_operator_scopes(client_id);
`);

// Tarifs unitaires des SMS de test, par pays (page "Coûts" du dashboard).
// Saisis à la main : unit_cost NULL = tarif pas encore renseigné (les SMS de
// ce pays sont comptés mais leur coût reste "inconnu" tant que ce n'est pas
// rempli). Le coût affiché est calculé à la lecture (nombre de SMS x tarif
// ACTUEL), il n'est pas figé à l'envoi : modifier un tarif recalcule aussi
// le passé. country_code = code ISO 3166-1 alpha-2 en majuscules.
db.exec(`
CREATE TABLE IF NOT EXISTS sms_costs (
  country_code TEXT PRIMARY KEY,
  country_name TEXT NOT NULL,
  unit_cost REAL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);
// Pré-remplissage seulement à la toute première création de la table : si
// un pays est supprimé ensuite, il ne doit pas réapparaître au redémarrage.
if (db.prepare(`SELECT COUNT(*) AS n FROM sms_costs`).get().n === 0) {
  const seedCost = db.prepare(`INSERT INTO sms_costs (country_code, country_name, unit_cost) VALUES (?, ?, NULL)`);
  [["FR", "France"], ["IT", "Italie"], ["DE", "Allemagne"], ["ES", "Espagne"]].forEach(([code, name]) => seedCost.run(code, name));
}

module.exports = db;
