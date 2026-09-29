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

function buildTestMessageBody(code) {
  return `QOS-TEST ${code} - ne pas repondre`;
}

// Extrait le code d'un corps de SMS reçu (utilisé côté webhook, robuste aux espaces/casse)
function extractCode(text) {
  if (!text) return null;
  const match = text.toUpperCase().match(/QOS-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}/);
  return match ? match[0] : null;
}

module.exports = { generateTestCode, buildTestMessageBody, extractCode };
