const express = require("express");
const cors = require("cors");
const { config } = require("./config");
const { closePool, query, withTransaction } = require("./db");
const { initializeDatabase } = require("./init-db");
const { ingestPacket } = require("./ingest");

const app = express();

app.use(cors({ origin: config.corsOrigin === "*" ? "*" : config.corsOrigin.split(",") }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/ingest/health", async (_req, res) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true, service: "software2-backend", database: "postgres" });
  } catch (error) {
    res.status(503).json({ ok: false, error: "database unavailable" });
  }
});

app.post(["/api/ingest/packets", "/api/ingest/test"], requireIngestToken, async (req, res) => {
  try {
    const packetId = await withTransaction((client) => ingestPacket(client, req.body));
    res.json({ ok: true, packetId });
  } catch (error) {
    const status = String(error.message || "").startsWith("unsupported") || String(error.message || "").includes("required") ? 400 : 500;
    res.status(status).json({ ok: false, error: status === 400 ? error.message : "ingest failed" });
  }
});

app.get("/api/topology", async (_req, res) => {
  const result = await query(
    `
    SELECT DISTINCT ON (rv.meter_id)
      rv.meter_id,
      pm.circuit_id,
      pm.cabinet_id,
      rv.point_code,
      rv.value,
      rv.raw_value,
      rv.quality,
      rv.sample_time
    FROM realtime_value rv
    JOIN point_mapping pm ON pm.id = rv.mapping_id
    WHERE rv.point_code IN ('switch_status', 'dido_status')
    ORDER BY rv.meter_id, rv.sample_time DESC, rv.received_at DESC
    `,
  );
  res.json({
    ok: true,
    switches: result.rows.map((row) => ({
      meterId: row.meter_id,
      circuitId: row.circuit_id,
      cabinetId: row.cabinet_id,
      switchStatus: switchStatusFromRow(row),
      quality: row.quality,
      sampleTime: row.sample_time,
    })),
  });
});

app.get("/api/realtime", async (req, res) => {
  const meterId = req.query.meterId ? String(req.query.meterId) : null;
  const params = [];
  let where = "";
  if (meterId) {
    params.push(meterId);
    where = "WHERE rv.meter_id = $1";
  }
  const result = await query(
    `
    SELECT
      rv.meter_id,
      rv.point_code,
      rv.name,
      rv.value,
      rv.raw_value,
      rv.unit,
      rv.quality,
      rv.sample_time,
      rv.source,
      pm.circuit_id,
      pm.cabinet_id,
      pm.device_id
    FROM realtime_value rv
    JOIN point_mapping pm ON pm.id = rv.mapping_id
    ${where}
    ORDER BY rv.meter_id, rv.point_code
    `,
    params,
  );
  const meters = new Map();
  for (const row of result.rows) {
    if (!meters.has(row.meter_id)) {
      meters.set(row.meter_id, {
        meterId: row.meter_id,
        circuitId: row.circuit_id,
        cabinetId: row.cabinet_id,
        deviceId: row.device_id,
        sampleTime: row.sample_time,
        points: {},
      });
    }
    const meter = meters.get(row.meter_id);
    meter.points[row.point_code] = {
      code: row.point_code,
      name: row.name,
      value: row.value,
      rawValue: row.raw_value,
      unit: row.unit,
      quality: row.quality,
      sampleTime: row.sample_time,
      source: row.source,
    };
    if (!meter.sampleTime || new Date(row.sample_time) > new Date(meter.sampleTime)) {
      meter.sampleTime = row.sample_time;
    }
  }
  res.json({ ok: true, meters: Array.from(meters.values()) });
});

app.get("/api/history", async (req, res) => {
  const meterId = String(req.query.meterId || "");
  const pointCode = String(req.query.pointCode || "");
  if (!meterId || !pointCode) {
    res.status(400).json({ ok: false, error: "meterId and pointCode are required" });
    return;
  }
  const limit = Math.min(Number(req.query.limit || 500), 5000);
  const result = await query(
    `
    SELECT sample_time, value, raw_value, unit, quality
    FROM history_sample
    WHERE meter_id = $1 AND point_code = $2
    ORDER BY sample_time DESC
    LIMIT $3
    `,
    [meterId, pointCode, limit],
  );
  res.json({ ok: true, samples: result.rows.reverse() });
});

app.get("/api/alarms", async (_req, res) => {
  const result = await query(
    `
    SELECT *
    FROM alarm
    ORDER BY started_at DESC
    LIMIT 200
    `,
  );
  res.json({ ok: true, alarms: result.rows });
});

app.get("/api/events", async (_req, res) => {
  const result = await query(
    `
    SELECT *
    FROM event
    ORDER BY event_time DESC
    LIMIT 200
    `,
  );
  res.json({ ok: true, events: result.rows });
});

app.get("/api/interfaces/status", async (_req, res) => {
  const result = await query(
    `
    SELECT *
    FROM interface_status
    ORDER BY updated_at DESC
    `,
  );
  res.json({ ok: true, interfaces: result.rows });
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

function switchStatusFromRow(row) {
  if (row.value === null || row.value === undefined) return null;
  if (row.point_code === "switch_status") return Number(row.value);
  const raw = row.raw_value === null || row.raw_value === undefined ? Number(row.value) : Number(row.raw_value);
  if (!Number.isFinite(raw)) return null;
  return raw & 0x0100 ? 1 : 0;
}

async function start() {
  await initializeDatabase();
  const server = app.listen(config.port, config.host, () => {
    console.log(`software2 backend listening on http://${config.host}:${config.port}`);
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

module.exports = { app, switchStatusFromRow };
