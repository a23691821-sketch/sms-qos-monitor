require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const webhookRoutes = require("./routes/webhook");
const apiRoutes = require("./routes/api");
const { startScheduler } = require("./scheduler");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api/webhook", webhookRoutes);
app.use("/api", apiRoutes);

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] SMS QoS Monitor backend démarré sur http://localhost:${PORT}`);
  console.log(`[server] Dashboard: http://localhost:${PORT}/dashboard.html`);
  startScheduler();
});
