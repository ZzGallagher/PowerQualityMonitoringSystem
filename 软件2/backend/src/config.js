const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const rootDir = path.resolve(__dirname, "..", "..", "..");

function resolveFromBackend(value, fallback) {
  const raw = value || fallback;
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(__dirname, "..", raw);
}

const config = {
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 8000),
  databaseIngestHost: process.env.DATABASE_INGEST_HOST || process.env.INGEST_HOST || "0.0.0.0",
  databaseIngestPort: Number(process.env.DATABASE_INGEST_PORT || process.env.INGEST_PORT || 9000),
  databaseUrl: process.env.DATABASE_URL || "postgres://pq_app:change_me@127.0.0.1:5432/pq_monitor",
  ingestToken: process.env.INGEST_TOKEN || "",
  corsOrigin: process.env.CORS_ORIGIN || "*",
  schemaPath: path.join(rootDir, "database", "postgres", "schema.sql"),
  pointTablePath: resolveFromBackend(process.env.POINT_TABLE_PATH, "../../软件1/AMC-E4KC点表-v1.json"),
  software1ConfigPath: resolveFromBackend(
    process.env.SOFTWARE1_CONFIG_PATH,
    "../../软件1/amc_gateway/meter_config.example.json",
  ),
};

module.exports = { config };
