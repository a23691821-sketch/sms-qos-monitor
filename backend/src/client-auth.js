const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const { verifyPassword } = require("./password");

/*
 * Authentification de session pour la vue cliente (externe), séparée de la
 * session admin (session-auth.js) : cookie différent, identifiants stockés
 * en base (table clients) plutôt qu'en variables d'environnement, puisqu'il
 * peut y avoir un nombre quelconque de clients. Même mécanique (cookie signé
 * par HMAC, sans état serveur à part le secret).
 */

const SECRET_PATH = path.join(__dirname, "..", "data", "client_session_secret.txt");
const SESSION_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // 30 jours
const COOKIE_NAME = "sms_qos_client_session";

function getOrCreateSecret() {
  try {
    if (fs.existsSync(SECRET_PATH)) return fs.readFileSync(SECRET_PATH, "utf-8").trim();
  } catch (err) {
    // on retombe sur la génération ci-dessous
  }
  const secret = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
    fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  } catch (err) {
    console.warn(
      "[client-auth] impossible d'écrire le secret de session sur disque (sera régénéré à chaque redémarrage, ce qui déconnectera tous les clients) :",
      err.message
    );
  }
  return secret;
}

const SECRET = getOrCreateSecret();

function sign(payload) {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}

function createSessionToken(clientId) {
  const expiry = Date.now() + SESSION_MAX_AGE_MS;
  const payload = `${clientId}:${expiry}`;
  const sig = sign(payload);
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || !token.includes(".")) return null;
  const [payloadB64, sig] = token.split(".");

  let payload;
  try {
    payload = Buffer.from(payloadB64, "base64url").toString("utf-8");
  } catch (err) {
    return null;
  }

  const expectedSig = sign(payload);
  const sigBuf = Buffer.from(sig || "", "hex");
  const expectedBuf = Buffer.from(expectedSig, "hex");
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  const [clientIdStr, expiryStr] = payload.split(":");
  const clientId = parseInt(clientIdStr, 10);
  const expiry = parseInt(expiryStr, 10);
  if (!clientId || !expiry || Date.now() > expiry) return null;
  return { clientId };
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

// Middleware : exige un cookie de session client valide, et charge le
// client correspondant (actif) sur req.client. Ne redirige jamais vers une
// page HTML (contrairement à requireSession côté admin) : la page cliente
// gère elle-même l'affichage du formulaire de connexion en cas de 401, pour
// rester une page statique simple sans route serveur dédiée par état.
function requireClientSession(req, res, next) {
  const cookies = parseCookies(req);
  const session = verifySessionToken(cookies[COOKIE_NAME]);
  if (!session) return res.status(401).json({ error: "authentification requise" });

  const client = db.prepare(`SELECT * FROM clients WHERE id = ? AND active = 1`).get(session.clientId);
  if (!client) return res.status(401).json({ error: "compte introuvable ou désactivé" });

  req.client = client;
  next();
}

function handleClientLogin(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username et password requis" });

  const client = db.prepare(`SELECT * FROM clients WHERE username = ? AND active = 1`).get(String(username).trim());
  if (!client || !verifyPassword(password, client.password_hash, client.password_salt)) {
    return res.status(401).json({ error: "identifiants invalides" });
  }

  const token = createSessionToken(client.id);
  const maxAgeSeconds = Math.floor(SESSION_MAX_AGE_MS / 1000);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`
  );
  res.json({ ok: true, name: client.name });
}

function handleClientLogout(req, res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
}

module.exports = { requireClientSession, handleClientLogin, handleClientLogout, COOKIE_NAME };
