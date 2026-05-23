const express = require("express");
const { config } = require("./config");
const { closePool, query, withTransaction } = require("./db");
const { initializeDatabase } = require("./init-db");
const { ingestPacket } = require("./ingest");

const app = express();

app.use(express.json({ limit: "1mb" }));

app.get("/api/ingest/health", async (_req, res) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true, service: "database-postgres-ingest", database: "postgres" });
  } catch (error) {
    res.status(503).json({ ok: false, error: "database unavailable" });
  }
});

app.post(["/api/ingest/packets", "/api/ingest/test"], requireIngestToken, async (req, res) => {
  try {
    const packetId = await withTransaction((client) => ingestPacket(client, req.body));
    res.json({ ok: true, packetId });
  } catch (error) {
    const message = String(error.message || "");
    const status = message.startsWith("unsupported") || message.includes("required") ? 400 : 500;
    res.status(status).json({ ok: false, error: status === 400 ? error.message : "ingest failed" });
  }
});

function requireIngestToken(req, res, next) {
  if (!config.ingestToken) {
    next();
    return;
  }
  const auth = req.get("Authorization") || "";
  const xToken = req.get("X-Access-Token") || "";
  if (auth === `Bearer ${config.ingestToken}` || xToken === config.ingestToken) {
    next();
    return;
  }
  res.status(401).json({ ok: false, error: "unauthorized" });
}

async function start() {
  await initializeDatabase();
  const server = app.listen(config.databaseIngestPort, config.databaseIngestHost, () => {
    console.log(`database ingest listening on http://${config.databaseIngestHost}:${config.databaseIngestPort}`);
  });

  const shutdown = async () => {
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  start().catch(async (error) => {
    console.error(error);
    await closePool();
    process.exit(1);
  });
}

module.exports = { app };
