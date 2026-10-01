const axios = require("axios");
const fs = require("fs");
const path = require("path");

/*
 * Chaque fournisseur SMS a sa propre API. Plutôt que de coder un client par
 * fournisseur, on utilise un adaptateur HTTP générique configuré en JSON
 * (config/providers.json). Si un fournisseur a une auth ou un format de
 * réponse trop spécifique, crée un fichier providers/<id>.js qui exporte
 * { send(route, body) } et enregistre-le dans CUSTOM_PROVIDERS ci-dessous.
 */

const configPath = path.join(__dirname, "..", "..", "config", "providers.json");

function loadProviderConfigs() {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Fichier de config fournisseurs introuvable: ${configPath}. Copie config/providers.example.json vers config/providers.json et adapte-le.`
    );
  }
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function interpolate(template, vars) {
  if (typeof template === "string") {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
  }
  if (Array.isArray(template)) return template.map((t) => interpolate(t, vars));
  if (template && typeof template === "object") {
    const out = {};
    for (const [k, v] of Object.entries(template)) out[k] = interpolate(v, vars);
    return out;
  }
  return template;
}

// Fournisseurs nécessitant un code sur-mesure (signature custom, auth complexe...)
const CUSTOM_PROVIDERS = {
  // exemple: "monfournisseur": require("./monfournisseur"),
};

async function sendViaGenericHttp(cfg, vars) {
  const url = interpolate(cfg.sendUrl, vars);
  const headers = interpolate(cfg.headers || {}, vars);
  const method = (cfg.method || "POST").toUpperCase();

  let axiosConfig = { method, url, headers, timeout: 15000 };

  if (cfg.bodyType === "json") {
    axiosConfig.data = interpolate(cfg.bodyTemplate, vars);
  } else if (cfg.bodyType === "form") {
    const form = new URLSearchParams(interpolate(cfg.bodyTemplate, vars));
    axiosConfig.data = form.toString();
    axiosConfig.headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (cfg.bodyType === "query") {
    axiosConfig.params = interpolate(cfg.bodyTemplate, vars);
  }

  const response = await axios(axiosConfig);

  // Chemin (dot notation) vers l'ID de message et le statut dans la réponse JSON,
  // défini dans providers.json (ex: "messageIdPath": "data.id")
  let messageId = cfg.messageIdPath ? getPath(response.data, cfg.messageIdPath) : null;

  // Repli générique : certains fournisseurs (ex: Emettance) imbriquent l'id
  // sous une clé IMPRÉVISIBLE à l'avance — chez Emettance c'est le numéro de
  // destination lui-même : { data: { "<numéro>": [{ id_state, ... }] } }. Un
  // messageIdPath fixe ("data.33759272672.0.id_state") ne fonctionne alors que
  // pour CE numéro précis : dès qu'une autre route (autre numéro) envoie, le
  // chemin ne correspond plus et messageId reste vide, cassant l'appariement
  // des DLR pour toutes les routes sauf celle d'origine. On ne devine pas la
  // clé : on prend le premier tableau trouvé sous "data" et on concatène les
  // id_state de ses entrées (plusieurs entrées = SMS multi-parties), au format
  // "id1.id2..." attendu par le matching des DLR (voir webhook.js, qui fait
  // un LIKE "idState.%" pour reconnaître une partie d'un envoi multi-parties).
  if (messageId == null) {
    messageId = extractNestedMessageId(response.data);
  }

  return {
    ok: true,
    httpStatus: response.status,
    // Toujours une chaîne : comparée telle quelle à provider_message_id (colonne
    // TEXT) lors du matching des DLR — un nombre JS stocké tel quel peut être
    // écrit en SQLite avec une affinité différente de la chaîne envoyée par le
    // DLR ("564900404" vs 564900404.0) et ne plus jamais correspondre à l'égalité.
    providerMessageId: messageId == null ? null : String(messageId),
    raw: response.data,
  };
}

function getPath(obj, dotPath) {
  return dotPath.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function extractNestedMessageId(data) {
  const inner = data && data.data;
  if (!inner || typeof inner !== "object") return null;
  for (const val of Object.values(inner)) {
    if (Array.isArray(val) && val.length) {
      const ids = val.map((e) => e && e.id_state).filter((v) => v != null);
      if (ids.length) return ids.join(".");
    }
  }
  return null;
}

// Certains fournisseurs (ex: envoi programmé) demandent la date/heure d'envoi
// dans le corps de la requête. On les calcule à l'appel, au format attendu
// (YYYY-MM-DD / HH:MM:SS), utilisables via {{date}} et {{time}} dans
// providers.json.
function nowDateTimeParts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  };
}

async function sendTestSms(providerId, { to, body, senderId }) {
  const configs = loadProviderConfigs();
  const cfg = configs[providerId];
  if (!cfg) throw new Error(`Fournisseur inconnu: ${providerId}. Vérifie config/providers.json`);

  // Priorité : senderId explicite (ex: saisi sur la page "Test manuel") >
  // valeur par défaut du fournisseur (staticVars.senderId dans providers.json)
  // > "SMS" en dernier recours. Utilisable dans bodyTemplate via {{senderId}}.
  const vars = {
    to,
    text: body,
    ...nowDateTimeParts(),
    senderId: "SMS",
    ...cfg.staticVars,
    ...(senderId && senderId.trim() ? { senderId: senderId.trim() } : {}),
  };

  if (CUSTOM_PROVIDERS[providerId]) {
    return CUSTOM_PROVIDERS[providerId].send(cfg, vars);
  }

  try {
    return await sendViaGenericHttp(cfg, vars);
  } catch (err) {
    return {
      ok: false,
      httpStatus: err.response?.status,
      error: err.response?.data || err.message,
      raw: err.response?.data,
    };
  }
}

module.exports = { sendTestSms, loadProviderConfigs };
