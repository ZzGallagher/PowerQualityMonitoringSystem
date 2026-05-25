const express = require("express");
const cors = require("cors");
const { config } = require("./config");
const { closePool, query, withTransaction } = require("./db");

const app = express();

app.use(cors({ origin: config.corsOrigin === "*" ? "*" : config.corsOrigin.split(",") }));
app.use(express.json({ limit: "1mb" }));

app.get(["/api/health", "/api/ingest/health"], async (_req, res) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true, service: "software2-backend-readonly", database: "postgres" });
  } catch (error) {
    res.status(503).json({ ok: false, error: "database unavailable" });
  }
});

app.get("/api/topology", async (_req, res) => {
  const result = await query(
    `
    WITH latest_switch_value AS (
      SELECT DISTINCT ON (rv.meter_id, rv.point_code)
        rv.meter_id,
        rv.point_code,
        rv.value,
        rv.raw_value,
        rv.quality,
        rv.sample_time,
        rv.received_at,
        pm.circuit_id AS mapped_circuit_id,
        pm.cabinet_id AS mapped_cabinet_id
      FROM realtime_value rv
      JOIN point_mapping pm ON pm.id = rv.mapping_id
      WHERE rv.point_code IN ('switch_status', 'dido_status')
      ORDER BY rv.meter_id, rv.point_code, rv.sample_time DESC, rv.received_at DESC
    )
    SELECT
      lsv.meter_id,
      COALESCE(csm.circuit_id, lsv.mapped_circuit_id) AS circuit_id,
      COALESCE(csm.cabinet_id, lsv.mapped_cabinet_id) AS cabinet_id,
      lsv.point_code,
      lsv.value,
      lsv.raw_value,
      lsv.quality,
      lsv.sample_time,
      csm.bit_mask,
      csm.display_name
    FROM latest_switch_value lsv
    LEFT JOIN circuit_switch_mapping csm
      ON csm.meter_id = lsv.meter_id
      AND csm.point_code = lsv.point_code
      AND csm.enabled = true
    WHERE csm.id IS NOT NULL OR lsv.mapped_circuit_id IS NOT NULL
    ORDER BY lsv.meter_id, lsv.point_code, csm.bit_mask NULLS LAST
    `,
  );
  res.json({
    ok: true,
    switches: result.rows.map((row) => ({
      meterId: row.meter_id,
      circuitId: row.circuit_id,
      cabinetId: row.cabinet_id,
      pointCode: row.point_code,
      rawValue: row.raw_value,
      bitMask: row.bit_mask,
      displayName: row.display_name,
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
  const pointCode = req.query.pointCode ? String(req.query.pointCode) : "";
  const pointCodes = String(req.query.pointCodes || "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);

  if (!meterId) {
    res.status(400).json({ ok: false, error: "meterId is required" });
    return;
  }

  if (pointCodes.length > 0) {
    const startTime = parseHistoryDate(req.query.startTime);
    const endTime = parseHistoryDate(req.query.endTime);
    if (!startTime || !endTime || startTime >= endTime) {
      res.status(400).json({ ok: false, error: "valid startTime and endTime are required" });
      return;
    }

    const limitPerPoint = boundedNumber(req.query.limitPerPoint, 1000, 1, 5000);
    const result = await query(
      `
      WITH ranked AS (
        SELECT
          point_code,
          name,
          sample_time,
          value,
          raw_value,
          unit,
          quality,
          row_number() OVER (PARTITION BY point_code ORDER BY sample_time DESC) AS row_index
        FROM history_sample
        WHERE meter_id = $1
          AND point_code = ANY($2)
          AND sample_time >= $3
          AND sample_time <= $4
      )
      SELECT point_code, name, sample_time, value, raw_value, unit, quality
      FROM ranked
      WHERE row_index <= $5
      ORDER BY point_code, sample_time ASC
      `,
      [meterId, pointCodes, startTime.toISOString(), endTime.toISOString(), limitPerPoint],
    );

    const seriesByCode = new Map(pointCodes.map((code) => [code, { pointCode: code, name: code, unit: "", samples: [] }]));
    for (const row of result.rows) {
      const series = seriesByCode.get(row.point_code);
      if (!series) continue;
      series.name = row.name || series.name;
      series.unit = row.unit || series.unit;
      series.samples.push(historySample(row));
    }

    res.json({ ok: true, series: Array.from(seriesByCode.values()) });
    return;
  }

  if (!pointCode) {
    res.status(400).json({ ok: false, error: "pointCode or pointCodes is required" });
    return;
  }

  const limit = boundedNumber(req.query.limit, 500, 1, 5000);
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

app.get("/api/history/records", async (req, res) => {
  const meterId = String(req.query.meterId || "");
  const circuitId = String(req.query.circuitId || "");
  const pointCodes = String(req.query.pointCodes || "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
  const startTime = parseHistoryDate(req.query.startTime);
  const endTime = parseHistoryDate(req.query.endTime);
  const page = boundedNumber(req.query.page, 1, 1, 100000);
  const pageSize = boundedNumber(req.query.pageSize, 20, 1, 500);
  const order = String(req.query.order || "asc").toLowerCase() === "desc" ? "desc" : "asc";
  const orderSql = order === "desc" ? "DESC" : "ASC";
  const params = [];
  const conditions = [];

  if (!meterId && !circuitId) {
    res.status(400).json({ ok: false, error: "meterId or circuitId is required" });
    return;
  }
  if (!startTime || !endTime || startTime >= endTime) {
    res.status(400).json({ ok: false, error: "valid startTime and endTime are required" });
    return;
  }

  params.push(startTime.toISOString());
  conditions.push(`hs.sample_time >= $${params.length}`);
  params.push(endTime.toISOString());
  conditions.push(`hs.sample_time <= $${params.length}`);
  if (meterId) {
    params.push(meterId);
    conditions.push(`hs.meter_id = $${params.length}`);
  } else {
    params.push(circuitId);
    conditions.push(`pm.circuit_id = $${params.length}`);
  }
  if (pointCodes.length > 0) {
    params.push(pointCodes);
    conditions.push(`hs.point_code = ANY($${params.length})`);
  }

  const whereSql = conditions.join("\n      AND ");
  const totalResult = await query(
    `
    SELECT COUNT(*)::int AS total
    FROM (
      SELECT hs.sample_time
      FROM history_sample hs
      JOIN point_mapping pm ON pm.id = hs.mapping_id
      WHERE ${whereSql}
      GROUP BY hs.sample_time
    ) grouped_sample_times
    `,
    params,
  );
  const total = Number(totalResult.rows[0]?.total || 0);
  const offset = (page - 1) * pageSize;
  const pageParams = [...params, pageSize, offset];
  const sampleTimesResult = await query(
    `
    SELECT hs.sample_time
    FROM history_sample hs
    JOIN point_mapping pm ON pm.id = hs.mapping_id
    WHERE ${whereSql}
    GROUP BY hs.sample_time
    ORDER BY hs.sample_time ${orderSql}
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
    `,
    pageParams,
  );
  const sampleTimes = sampleTimesResult.rows.map((row) => row.sample_time);
  if (sampleTimes.length === 0) {
    res.json({
      ok: true,
      page,
      pageSize,
      order,
      total,
      hasNext: false,
      columns: [],
      rows: [],
    });
    return;
  }

  const sampleParams = [...params, sampleTimes];
  const sampleResult = await query(
    `
    SELECT
      hs.sample_time,
      hs.point_code,
      hs.name,
      hs.value,
      hs.raw_value,
      hs.unit,
      hs.quality
    FROM history_sample hs
    JOIN point_mapping pm ON pm.id = hs.mapping_id
    WHERE ${whereSql}
      AND hs.sample_time = ANY($${params.length + 1}::timestamptz[])
    ORDER BY hs.sample_time ${orderSql}, hs.point_code
    `,
    sampleParams,
  );

  const rowsByTime = new Map(sampleTimes.map((sampleTime) => {
    const key = historyTimeKey(sampleTime);
    return [key, { sampleTime, points: {} }];
  }));
  const columnsByCode = new Map();
  for (const row of sampleResult.rows) {
    const key = historyTimeKey(row.sample_time);
    const record = rowsByTime.get(key);
    if (!record) continue;
    record.points[row.point_code] = {
      code: row.point_code,
      name: row.name,
      value: row.value,
      rawValue: row.raw_value,
      unit: row.unit,
      quality: row.quality,
    };
    if (!columnsByCode.has(row.point_code)) {
      columnsByCode.set(row.point_code, {
        code: row.point_code,
        name: row.name || row.point_code,
        unit: row.unit || "",
      });
    }
  }

  res.json({
    ok: true,
    page,
    pageSize,
    order,
    total,
    hasNext: offset + sampleTimes.length < total,
    columns: Array.from(columnsByCode.values()),
    rows: Array.from(rowsByTime.values()),
  });
});

function parseHistoryDate(value) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value || fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function historySample(row) {
  return {
    sampleTime: row.sample_time,
    value: row.value,
    rawValue: row.raw_value,
    quality: row.quality,
  };
}

function historyTimeKey(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

app.get("/api/alarms", async (req, res) => {
  try {
    const page = boundedNumber(req.query.page, 1, 1, 100000);
    const pageSize = boundedNumber(req.query.pageSize, 20, 1, 500);
    const { whereSql, params } = alarmEventFilters(req.query, "a", "started_at", {
      statusColumn: "status",
      levelColumn: "level",
      typeColumn: "alarm_type",
    });
    const countResult = await query(`SELECT COUNT(*)::int AS total FROM alarm a ${whereSql}`, params);
    const total = Number(countResult.rows[0]?.total || 0);
    const result = await query(
      `
      SELECT
        a.*,
        COALESCE(a.circuit_id, alarm_mapping.circuit_id) AS display_circuit_id,
        COALESCE(alarm_circuit.name, mapping_circuit.name, alarm_mapping.display_name) AS display_circuit_name
      FROM alarm a
      LEFT JOIN LATERAL (
        SELECT pm.circuit_id, pm.display_name
        FROM point_mapping pm
        WHERE pm.meter_id = a.meter_id
          AND (pm.point_code = a.point_code OR a.point_code IS NULL)
        ORDER BY CASE WHEN pm.point_code = a.point_code THEN 0 ELSE 1 END, pm.is_primary DESC
        LIMIT 1
      ) alarm_mapping ON true
      LEFT JOIN circuit alarm_circuit ON alarm_circuit.id = a.circuit_id
      LEFT JOIN circuit mapping_circuit ON mapping_circuit.id = alarm_mapping.circuit_id
      ${whereSql}
      ORDER BY started_at DESC, id DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
      `,
      [...params, pageSize, (page - 1) * pageSize],
    );
    res.json({
      ok: true,
      page,
      pageSize,
      total,
      hasNext: page * pageSize < total,
      alarms: result.rows,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: "alarm query failed" });
  }
});

app.get("/api/alarms/:id", async (req, res) => {
  const id = boundedNumber(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER);
  const result = await query(
    `
    SELECT
      a.*,
      COALESCE(a.circuit_id, alarm_mapping.circuit_id) AS display_circuit_id,
      COALESCE(alarm_circuit.name, mapping_circuit.name, alarm_mapping.display_name) AS display_circuit_name
    FROM alarm a
    LEFT JOIN LATERAL (
      SELECT pm.circuit_id, pm.display_name
      FROM point_mapping pm
      WHERE pm.meter_id = a.meter_id
        AND (pm.point_code = a.point_code OR a.point_code IS NULL)
      ORDER BY CASE WHEN pm.point_code = a.point_code THEN 0 ELSE 1 END, pm.is_primary DESC
      LIMIT 1
    ) alarm_mapping ON true
    LEFT JOIN circuit alarm_circuit ON alarm_circuit.id = a.circuit_id
    LEFT JOIN circuit mapping_circuit ON mapping_circuit.id = alarm_mapping.circuit_id
    WHERE a.id = $1
    `,
    [id],
  );
  if (!result.rows[0]) {
    res.status(404).json({ ok: false, error: "alarm not found" });
    return;
  }
  res.json({ ok: true, alarm: result.rows[0] });
});

app.post("/api/alarms/:id/ack", async (req, res) => {
  try {
    const alarm = await updateAlarmLifecycle(req.params.id, "ack", req.body || {});
    res.json({ ok: true, alarm });
  } catch (error) {
    alarmLifecycleError(res, error);
  }
});

app.post("/api/alarms/:id/close", async (req, res) => {
  try {
    const alarm = await updateAlarmLifecycle(req.params.id, "close", req.body || {});
    res.json({ ok: true, alarm });
  } catch (error) {
    alarmLifecycleError(res, error);
  }
});

app.get("/api/events", async (req, res) => {
  try {
    const page = boundedNumber(req.query.page, 1, 1, 100000);
    const pageSize = boundedNumber(req.query.pageSize, 20, 1, 500);
    const { whereSql, params } = alarmEventFilters(req.query, "e", "event_time", {
      levelColumn: "level",
      typeColumn: "event_type",
    });
    const countResult = await query(`SELECT COUNT(*)::int AS total FROM event e ${whereSql}`, params);
    const total = Number(countResult.rows[0]?.total || 0);
    const result = await query(
      `
      SELECT *
      FROM event e
      ${whereSql}
      ORDER BY event_time DESC, id DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
      `,
      [...params, pageSize, (page - 1) * pageSize],
    );
    res.json({
      ok: true,
      page,
      pageSize,
      total,
      hasNext: page * pageSize < total,
      events: result.rows,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: "event query failed" });
  }
});

function alarmEventFilters(queryParams, alias, timeColumn, options = {}) {
  const params = [];
  const conditions = [];
  const column = (name) => `${alias}.${name}`;
  const addTextList = (queryName, columnName) => {
    const values = stringList(queryParams[queryName]);
    if (values.length === 0 || !columnName) return;
    params.push(values);
    conditions.push(`${column(columnName)} = ANY($${params.length})`);
  };

  addTextList("status", options.statusColumn);
  addTextList("level", options.levelColumn);
  addTextList("type", options.typeColumn);
  addTextList("eventType", options.typeColumn);
  addTextList("alarmType", options.typeColumn);
  addTextList("meterId", "meter_id");
  if (options.statusColumn) {
    addTextList("circuitId", "circuit_id");
    addTextList("pointCode", "point_code");
  }

  const startTime = parseHistoryDate(queryParams.startTime);
  const endTime = parseHistoryDate(queryParams.endTime);
  if (startTime) {
    params.push(startTime.toISOString());
    conditions.push(`${column(timeColumn)} >= $${params.length}::timestamptz`);
  }
  if (endTime) {
    params.push(endTime.toISOString());
    conditions.push(`${column(timeColumn)} <= $${params.length}::timestamptz`);
  }

  const keyword = String(queryParams.keyword || "").trim();
  if (keyword) {
    params.push(`%${keyword}%`);
    const textColumns = ["title", "description", "meter_id"];
    if (options.statusColumn) textColumns.push("point_code", "alarm_type", "status", "acknowledged_by", "closed_by");
    if (options.typeColumn && !options.statusColumn) textColumns.push("event_type");
    conditions.push(`(${textColumns.map((name) => `COALESCE(${column(name)}, '') ILIKE $${params.length}`).join(" OR ")})`);
  }

  return {
    whereSql: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

async function updateAlarmLifecycle(rawId, action, body) {
  const id = boundedNumber(rawId, 0, 0, Number.MAX_SAFE_INTEGER);
  const operator = String(body.operator || "值班员").trim() || "值班员";
  const note = String(body.note || "").trim();

  return withTransaction(async (client) => {
    const current = await client.query("SELECT * FROM alarm WHERE id = $1 FOR UPDATE", [id]);
    const alarm = current.rows[0];
    if (!alarm) throw lifecycleError("not_found", "alarm not found");

    if (action === "ack") {
      if (alarm.status !== "active") throw lifecycleError("conflict", "only active alarms can be acknowledged");
      const result = await client.query(
        `
        UPDATE alarm
        SET status = 'acknowledged',
            acknowledged_at = now(),
            acknowledged_by = $2,
            ack_note = $3,
            updated_at = now()
        WHERE id = $1
        RETURNING *
        `,
        [id, operator, note],
      );
      await insertLifecycleEvent(client, result.rows[0], "alarm_ack", "告警确认", operator, note);
      return result.rows[0];
    }

    if (!["acknowledged", "recovered"].includes(alarm.status)) {
      throw lifecycleError("conflict", "only acknowledged or recovered alarms can be closed");
    }
    const result = await client.query(
      `
      UPDATE alarm
      SET status = 'closed',
          closed_at = now(),
          closed_by = $2,
          close_note = $3,
          updated_at = now()
      WHERE id = $1
      RETURNING *
      `,
      [id, operator, note],
    );
    await insertLifecycleEvent(client, result.rows[0], "alarm_close", "告警关闭", operator, note);
    return result.rows[0];
  });
}

async function insertLifecycleEvent(client, alarm, eventType, title, operator, note) {
  await client.query(
    `
    INSERT INTO event (
      external_id, station_id, meter_id, event_type, level, title,
      description, event_time, raw_json
    )
    VALUES ($1, $2, $3, $4, 'info', $5, $6, now(), $7::jsonb)
    `,
    [
      alarm.external_id || `alarm:${alarm.id}`,
      alarm.station_id,
      alarm.meter_id,
      eventType,
      title,
      `${operator}${note ? `：${note}` : ""}`,
      JSON.stringify({ alarmId: alarm.id, operator, note, status: alarm.status }),
    ],
  );
}

function stringList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function lifecycleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function alarmLifecycleError(res, error) {
  if (error.code === "not_found") {
    res.status(404).json({ ok: false, error: error.message });
    return;
  }
  if (error.code === "conflict") {
    res.status(409).json({ ok: false, error: error.message });
    return;
  }
  res.status(500).json({ ok: false, error: "alarm lifecycle update failed" });
}

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

function switchStatusFromRow(row) {
  if (
    (row.value === null || row.value === undefined)
    && (row.raw_value === null || row.raw_value === undefined)
  ) {
    return null;
  }
  if (row.bit_mask !== null && row.bit_mask !== undefined) {
    const raw = row.raw_value === null || row.raw_value === undefined ? Number(row.value) : Number(row.raw_value);
    const bitMask = Number(row.bit_mask);
    if (!Number.isFinite(raw) || !Number.isFinite(bitMask)) return null;
    return raw & bitMask ? 1 : 0;
  }
  if (row.point_code === "switch_status") return Number(row.value);
  const raw = row.raw_value === null || row.raw_value === undefined ? Number(row.value) : Number(row.raw_value);
  if (!Number.isFinite(raw)) return null;
  return raw & 0x0100 ? 1 : 0;
}

async function start() {
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
