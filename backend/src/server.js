require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const webhookRoutes = require("./routes/webhook");
const apiRoutes = require("./routes/api");
const testsmsApiRoutes = require("./routes/testsms-api");
const clientApiRoutes = require("./routes/client-api");
const { startScheduler } = require("./scheduler");
const { requireSession, handleLogin, handleLogout } = require("./session-auth");
const { handleClientLogin, handleClientLogout } = require("./client-auth");

const app = express();
app.use(cors());
app.use(express.json());

// Appelés automatiquement par le fournisseur SMS et par l'app Android : ces
// systèmes tiers ne peuvent pas s'authentifier, donc montés AVANT le
// middleware de session ci-dessous, jamais concernés par lui.
app.use("/api/webhook", webhookRoutes);

// Routes publiques d'authentification + health check (aucune donnée sensible)
app.post("/api/login", handleLogin);
app.post("/api/logout", handleLogout);
app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get("/login.html", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "login.html")));

// Téléchargement de l'APK Android depuis le téléphone de test (Google Drive
// bloque souvent le téléchargement direct d'un .apk sur mobile). Chemin non
// devinable plutôt que protégé par login, pour rester ouvrable directement
// depuis le navigateur du téléphone sans avoir à se connecter au dashboard.
app.get("/dl-8f3k1q/sms-qos-monitor.apk", (req, res) => {
  res.download(path.join(__dirname, "..", "downloads", "sms-qos-monitor.apk"), "sms-qos-monitor.apk");
});

// Vue cliente : auth + API + page statique montées ICI, AVANT le middleware
// de session admin ci-dessous, puisqu'elles ont leur propre authentification
// (cookie séparé, voir client-auth.js) — un client ne doit jamais avoir
// besoin d'une session admin pour atteindre sa propre page.
app.post("/api/client/login", handleClientLogin);
app.post("/api/client/logout", handleClientLogout);
app.use("/api/client", clientApiRoutes);
app.get("/client.html", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "client.html")));

// Tout ce qui est déclaré après cette ligne exige un cookie de session admin valide
app.use(requireSession);

app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/api", apiRoutes);
app.use("/api/testsms", testsmsApiRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] SMS QoS Monitor backend démarré sur http://localhost:${PORT}`);
  console.log(`[server] Dashboard: http://localhost:${PORT}/dashboard.html`);
  startScheduler();
});
