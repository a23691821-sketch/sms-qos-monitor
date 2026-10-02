const crypto = require("crypto");

/*
 * Hachage de mot de passe sans dépendance externe (scrypt est natif à
 * `crypto`, pas besoin de bcrypt) — même choix que session-auth.js pour le
 * reste de l'authentification du projet.
 */

const KEY_LEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  if (!password || !hash || !salt) return false;
  const candidate = crypto.scryptSync(String(password), salt, KEY_LEN);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

module.exports = { hashPassword, verifyPassword };
