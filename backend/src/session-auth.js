const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/*
 * Authentification de session pour tout le site (dashboard + API), en
 * remplacement du popup natif du navigateur (basic auth) qui n'offre pas de
 * vraie déconnexion. Choix volontaire de ne dépendre d'aucun package externe
 * (uniquement le module natif `crypto`) : cookie signé par HMAC, sans état
 * côté serveur à part le secret de signature.
 */

const SECRET_PATH = path.join(__dirname, "..", "data", "session_secret.txt");
const SESSION_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // 30 jours
const COOKIE_NAME = "sms_qos_session";

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
      "[auth] impossible d'écrire le secret de session sur disque (sera régénéré à chaque redémarrage, ce qui déconnectera tout le monde) :",
      err.message
    );
  }
  return secret;
}

const SECRET = getOrCreateSecret();

function sign(payload) {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}

function timingSafeStringEqual(a, b) {
  const aBuf = Buffer.from(String(a ?? ""));
  const bBuf = Buffer.from(String(b ?? ""));
  if (aBuf.length !== bBuf.length) {
    // Comparaison bidon pour garder un temps constant même si les longueurs
    // diffèrent (évite de fuiter la longueur attendue via le timing).
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function createSessionToken(username) {
  const expiry = Date.now() + SESSION_MAX_AGE_MS;
  const payload = `${username}:${expiry}`;
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

  const [username, expiryStr] = payload.split(":");
  const expiry = parseInt(expiryStr, 10);
  if (!username || !expiry || Date.now() > expiry) return null;
  return { username };
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

// Middleware : à placer APRÈS les routes publiques (login, logout, webhooks,
// health) — tout ce qui passe par ici doit présenter un cookie de session
// valide.
function requireSession(req, res, next) {
  const cookies = parseCookies(req);
  const session = verifySessionToken(cookies[COOKIE_NAME]);
  if (session) {
    req.session = session;
    return next();
  }

  const wantsHtml = (req.headers.accept || "").includes("text/html");
  if (wantsHtml) return res.redirect("/login.html");
  return res.status(401).json({ error: "authentification requise" });
}

function handleLogin(req, res) {
  const { username, password } = req.body || {};
  const expectedUser = process.env.DASHBOARD_USER;
  const expectedPass = process.env.DASHBOARD_PASSWORD;

  if (!expectedUser || !expectedPass) {
    return res.status(500).json({ error: "DASHBOARD_USER / DASHBOARD_PASSWORD non configurés côté serveur (voir .env)" });
  }

  const userOk = timingSafeStringEqual(username, expectedUser);
  const passOk = timingSafeStringEqual(password, expectedPass);
  if (!userOk || !passOk) {
    return res.status(401).json({ error: "identifiants invalides" });
  }

  const token = createSessionToken(username);
  const maxAgeSeconds = Math.floor(SESSION_MAX_AGE_MS / 1000);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`
  );
  res.json({ ok: true });
}

function handleLogout(req, res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
}

module.exports = { requireSession, handleLogin, handleLogout, COOKIE_NAME };
