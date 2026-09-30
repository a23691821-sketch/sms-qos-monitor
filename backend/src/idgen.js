const crypto = require("crypto");

// Génère un code court, non-ambigu (sans 0/O/1/I), embarqué dans le corps du SMS.
// Ex: "QOS-7K4D2A"
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function generateTestCode() {
  const bytes = crypto.randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `QOS-${code}`;
}

// customContent (optionnel, ex: depuis la page "Test manuel") : le code de
// suivi reste TOUJOURS présent dans le corps, quel que soit le contenu perso,
// car c'est le seul moyen de corréler la réception réelle sur le téléphone
// (voir extractCode ci-dessous) — sans lui, le test enverrait bien un SMS
// mais on ne saurait jamais s'il est arrivé.
function buildTestMessageBody(code, customContent) {
  if (customContent && customContent.trim()) {
    return `${customContent.trim()} ${code}`;
  }
  return `QOS-TEST ${code} - ne pas repondre`;
}

// Extrait le code d'un corps de SMS reçu (utilisé côté webhook, robuste aux espaces/casse)
function extractCode(text) {
  if (!text) return null;
  const match = text.toUpperCase().match(/QOS-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}/);
  return match ? match[0] : null;
}

module.exports = { generateTestCode, buildTestMessageBody, extractCode };
