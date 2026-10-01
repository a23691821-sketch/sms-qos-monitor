const axios = require("axios");

/*
 * Client pour l'API TestSMS.com (https://app.testsms.com/api/apidocs).
 *
 * Contrairement aux fournisseurs "classiques" gérés par providers/index.js
 * (un seul POST = envoi direct), TestSMS fonctionne en 2 étapes inversées :
 *  1. On demande un numéro + un messageId pour un réseau donné (createTest).
 *  2. C'est NOUS qui envoyons le SMS (via un de nos fournisseurs existants)
 *     vers ce numéro, avec le messageId dans le corps. TestSMS confirme la
 *     réception réelle sur son parc d'appareils (receiptStatus), via
 *     callback HTTP ou polling GET /v1/smsTest/:id.
 *
 * Auth : OAuth2 Client Credentials Flow, token valable 24h (on le rafraîchit
 * un peu avant expiration par sécurité). Client ID/Secret viennent de
 * variables d'environnement (jamais committées) : TESTSMS_CLIENT_ID,
 * TESTSMS_CLIENT_SECRET.
 */

const BASE_URL = "https://api.testsms.com/api";

// Cache en mémoire (process unique, pas de cluster ici) : évite de refaire un
// appel d'auth à chaque requête. Pas besoin de persister en base, un simple
// redémarrage du service suffit à en reprendre un nouveau.
let cachedToken = null; // { accessToken, expiresAt (ms epoch) }

function credsConfigured() {
  return !!(process.env.TESTSMS_CLIENT_ID && process.env.TESTSMS_CLIENT_SECRET);
}

async function fetchNewToken() {
  if (!credsConfigured()) {
    throw new Error(
      "TESTSMS_CLIENT_ID / TESTSMS_CLIENT_SECRET non configurés (voir .env sur le serveur)."
    );
  }

  const response = await axios({
    method: "POST",
    url: `${BASE_URL}/v1/access-token`,
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    data: new URLSearchParams({
      client_id: process.env.TESTSMS_CLIENT_ID,
      client_secret: process.env.TESTSMS_CLIENT_SECRET,
      grant_type: "client_credentials",
    }).toString(),
    timeout: 15000,
  });

  const { access_token, expires_in } = response.data;
  // Marge de 5 minutes avant l'expiration réelle (évite un 401 en plein appel)
  const expiresAt = Date.now() + (Number(expires_in || 86400) - 300) * 1000;
  cachedToken = { accessToken: access_token, expiresAt };
  return cachedToken.accessToken;
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }
  return fetchNewToken();
}

// `retryOn401` : un seul essai de rafraîchissement forcé du token si l'appel
// échoue en 401 (ex: token révoqué côté TestSMS avant son expiration prévue).
async function authedRequest(config, retryOn401 = true) {
  const token = await getAccessToken();
  try {
    return await axios({
      ...config,
      url: `${BASE_URL}${config.url}`,
      headers: { ...(config.headers || {}), Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: config.timeout || 15000,
    });
  } catch (err) {
    if (retryOn401 && err.response && err.response.status === 401) {
      cachedToken = null;
      return authedRequest(config, false);
    }
    throw err;
  }
}

// GET /v1/mccmnc — liste complète des réseaux/pays disponibles pour le test
// (rafraîchie en continu côté TestSMS, "quelques minutes" selon leur doc).
// Pas de cache long ici : c'est justement ce qui permet au dashboard de
// proposer TOUS les pays couverts par TestSMS "à la demande", sans liste
// figée dans notre code. Un petit cache court (60s) évite juste de spammer
// l'API si le menu est ouvert/fermé plusieurs fois de suite.
let networksCache = null; // { data, fetchedAt }
const NETWORKS_CACHE_MS = 60 * 1000;

async function getNetworks({ forceRefresh = false } = {}) {
  if (!forceRefresh && networksCache && Date.now() - networksCache.fetchedAt < NETWORKS_CACHE_MS) {
    return networksCache.data;
  }
  const response = await authedRequest({ method: "GET", url: "/v1/mccmnc" });
  networksCache = { data: response.data, fetchedAt: Date.now() };
  return networksCache.data;
}

// POST /v1/createTest — demande un numéro de test pour un réseau donné.
// `callbackUrl` : notre endpoint public qui recevra le résultat dès que
// TestSMS l'aura (voir routes/webhook.js). numberSources par défaut laissé à
// TestSMS (shared_then_dedicated côté leur doc).
async function createTest({ mccmnc, mccmncOriginal, numberSources, callbackUrl }) {
  const network = { mccmnc };
  if (mccmncOriginal) network.mccmncOriginal = mccmncOriginal;
  if (numberSources) network.numberSources = numberSources;

  const response = await authedRequest({
    method: "POST",
    url: "/v1/createTest",
    headers: { "Content-Type": "application/json" },
    data: { callbackUrl, networks: [network] },
  });

  // Réponse: [{ phoneNumbers: [{ id, messageId, msisdn, price, currency, billingStatus, creditType, chargedAt }] }]
  const entry = Array.isArray(response.data) ? response.data[0] : null;
  const phoneEntry = entry && Array.isArray(entry.phoneNumbers) ? entry.phoneNumbers[0] : null;
  if (!phoneEntry) {
    throw new Error(`Réponse createTest inattendue: ${JSON.stringify(response.data)}`);
  }
  return { raw: response.data, ...phoneEntry };
}

// GET /v1/smsTest/:id — résultat courant d'un test (utilisé en polling de
// secours si le callback n'est jamais arrivé, ex: notre serveur temporairement
// inaccessible depuis l'extérieur).
async function getTestResult(testsmsTestId) {
  const response = await authedRequest({ method: "GET", url: `/v1/smsTest/${testsmsTestId}` });
  return response.data;
}

module.exports = { credsConfigured, getAccessToken, getNetworks, createTest, getTestResult };
