const GOOD_INTERFACE_STATUSES = new Set(["online", "ok", "good"]);
const SUPPORTED_PACKET_TYPES = new Set(["realtime", "statistics", "alarm", "event", "heartbeat", "comm_status"]);

function packetBase(packet) {
  const station = objectOrEmpty(packet.station);
  const gateway = objectOrEmpty(packet.gateway);
  const meter = objectOrEmpty(packet.meter);
  if (!packet.timestamp) throw new Error("packet.timestamp is required");
  return {
    protocolVersion: String(packet.protocolVersion || "1.0"),
    packetType: String(packet.packetType || ""),
    sequence: integerOrNull(packet.sequence),
    packetTimestamp: String(packet.timestamp),
    stationId: String(station.id || "substation-001"),
    stationName: String(station.name || "演示变电站"),
    gatewayId: String(gateway.id || "gateway-001"),
    gatewayName: String(gateway.name || "笔记本网关"),
    meterId: String(meter.id || "amc-001"),
    meterName: String(meter.name || "AMC智能电力仪表"),
    meterModel: String(meter.model || "AMC(II)-E4KC"),
  };
}

async function ingestPacket(client, packet) {
  const base = packetBase(packet);
  if (!SUPPORTED_PACKET_TYPES.has(base.packetType)) {
    throw new Error(`unsupported packetType: ${base.packetType}`);
  }

  await upsertPacketEntities(client, base);
  const { packetId, duplicate } = await insertIngestPacket(client, packet, base);
  if (duplicate) return packetId;

  if (base.packetType === "realtime") await ingestRealtime(client, packetId, packet, base);
  if (base.packetType === "statistics") await ingestStatistics(client, packetId, packet, base);
  if (base.packetType === "alarm") await ingestAlarms(client, packetId, packet, base);
  if (base.packetType === "event") await ingestEvents(client, packetId, packet, base);
  if (base.packetType === "heartbeat") await ingestHeartbeat(client, packetId, packet, base);
  if (base.packetType === "comm_status") await ingestCommStatus(client, packetId, packet, base);

  await updateInterfaceStatus(client, base, "online", null);
  return packetId;
}

async function upsertPacketEntities(client, base) {
  await client.query(
    `
    INSERT INTO station (id, name)
    VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
    `,
    [base.stationId, base.stationName],
  );
  await client.query(
    `
    INSERT INTO gateway (id, station_id, name, protocol_version, last_seen_at, status)
    VALUES ($1, $2, $3, $4, $5::timestamptz, 'online')
    ON CONFLICT (id) DO UPDATE SET
      station_id = EXCLUDED.station_id,
      name = EXCLUDED.name,
      protocol_version = EXCLUDED.protocol_version,
      last_seen_at = EXCLUDED.last_seen_at,
      status = EXCLUDED.status
    `,
    [base.gatewayId, base.stationId, base.gatewayName, base.protocolVersion, base.packetTimestamp],
  );
  await client.query(
    `
    INSERT INTO meter (id, station_id, gateway_id, name, model, status, last_sample_at, last_sequence)
    VALUES ($1, $2, $3, $4, $5, 'online', $6::timestamptz, $7)
    ON CONFLICT (id) DO UPDATE SET
      station_id = EXCLUDED.station_id,
      gateway_id = EXCLUDED.gateway_id,
      name = EXCLUDED.name,
      model = EXCLUDED.model,
      status = EXCLUDED.status,
      last_sample_at = EXCLUDED.last_sample_at,
      last_sequence = EXCLUDED.last_sequence
    `,
    [base.meterId, base.stationId, base.gatewayId, base.meterName, base.meterModel, base.packetTimestamp, base.sequence],
  );
}

async function insertIngestPacket(client, packet, base) {
  const result = await client.query(
    `
    INSERT INTO ingest_packet (
      protocol_version, packet_type, station_id, station_name,
      gateway_id, gateway_name, meter_id, meter_name, meter_model,
      sequence, packet_timestamp, parse_status, raw_json
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, 'ok', $12::jsonb)
    ON CONFLICT (gateway_id, meter_id, packet_type, sequence, packet_timestamp) DO UPDATE SET
      received_at = now(),
      parse_status = 'duplicate',
      raw_json = EXCLUDED.raw_json
    RETURNING id, parse_status
    `,
    [
      base.protocolVersion,
      base.packetType,
      base.stationId,
      base.stationName,
      base.gatewayId,
      base.gatewayName,
      base.meterId,
      base.meterName,
      base.meterModel,
      base.sequence,
      base.packetTimestamp,
      JSON.stringify(packet),
    ],
  );
  return {
    packetId: Number(result.rows[0].id),
    duplicate: result.rows[0].parse_status === "duplicate",
  };
}

async function ingestRealtime(client, packetId, packet, base) {
  for (const point of arrayOrEmpty(packet.points)) {
    const code = String(point.code || "");
    if (!code) continue;
    await ensurePoint(client, code, point);
    const mappingId = await ensureMapping(client, base, code, String(point.name || code));
    const sampleTime = String(point.timestamp || base.packetTimestamp);
    const params = [
      mappingId,
      base.stationId,
      base.meterId,
      code,
      String(point.name || code),
      numberOrNull(point.value),
      integerOrNull(point.rawValue),
      String(point.unit || ""),
      String(point.quality || "good"),
      sampleTime,
      String(point.source || ""),
      packetId,
    ];
    await client.query(
      `
      INSERT INTO history_sample (
        mapping_id, station_id, meter_id, point_code, name, value, raw_value,
        unit, quality, sample_time, source, packet_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11, $12)
      `,
      params,
    );
    await client.query(
      `
      INSERT INTO realtime_value (
        mapping_id, station_id, meter_id, point_code, name, value, raw_value,
        unit, quality, sample_time, source, packet_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11, $12)
      ON CONFLICT (mapping_id) DO UPDATE SET
        name = EXCLUDED.name,
        value = EXCLUDED.value,
        raw_value = EXCLUDED.raw_value,
        unit = EXCLUDED.unit,
        quality = EXCLUDED.quality,
        sample_time = EXCLUDED.sample_time,
        received_at = now(),
        source = EXCLUDED.source,
        packet_id = EXCLUDED.packet_id
      `,
      params,
    );
  }
}

async function ingestStatistics(client, packetId, packet, base) {
  for (const stat of arrayOrEmpty(packet.statistics)) {
    const code = String(stat.code || "");
    if (!code) continue;
    await ensurePoint(client, code, { code, name: code });
    const mappingId = await ensureMapping(client, base, code, code);
    await client.query(
      `
      INSERT INTO statistic_record (
        mapping_id, station_id, meter_id, point_code, statistic_time,
        min_value, max_value, avg_value, sample_count, quality, packet_id
      )
      VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11)
      `,
      [
        mappingId,
        base.stationId,
        base.meterId,
        code,
        base.packetTimestamp,
        numberOrNull(stat.min),
        numberOrNull(stat.max),
        numberOrNull(stat.avg),
        integerOrNull(stat.count) || 0,
        String(stat.quality || "good"),
        packetId,
      ],
    );
  }
}

async function ingestAlarms(client, packetId, packet, base) {
  for (const alarm of arrayOrEmpty(packet.alarms)) {
    const code = String(alarm.code || "");
    const externalId = String(alarm.id || `limit:${code}`);
    const state = String(alarm.state || "active");
    const alarmTime = String(alarm.timestamp || base.packetTimestamp);
    if (state === "cleared") {
      const updated = await client.query(
        `
        UPDATE alarm
        SET status = 'recovered', recovered_at = $1::timestamptz, packet_id = $2, updated_at = now()
        WHERE external_id = $3 AND meter_id = $4 AND status IN ('active', 'acknowledged')
        `,
        [alarmTime, packetId, externalId, base.meterId],
      );
      if (updated.rowCount > 0) {
        await insertEvent(client, packetId, base, "alarm_cleared", "info", `告警恢复: ${code}`, alarmTime, alarm);
        continue;
      }
    }
    await client.query(
      `
      INSERT INTO alarm (
        external_id, station_id, meter_id, point_code, alarm_type, level,
        title, description, trigger_value, trigger_unit, min_value, max_value,
        basis, status, started_at, packet_id, raw_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz, $16, $17::jsonb)
      `,
      [
        externalId,
        base.stationId,
        base.meterId,
        code || null,
        externalId.split(":")[0],
        String(alarm.severity || "warning"),
        String(alarm.name || code || externalId),
        String(alarm.basis || ""),
        numberOrNull(alarm.value),
        String(alarm.unit || ""),
        numberOrNull(alarm.min),
        numberOrNull(alarm.max),
        String(alarm.basis || ""),
        state === "cleared" ? "recovered" : "active",
        alarmTime,
        packetId,
        JSON.stringify(alarm),
      ],
    );
    await insertEvent(client, packetId, base, "alarm", String(alarm.severity || "warning"), `告警: ${code}`, alarmTime, alarm);
  }
}

async function ingestEvents(client, packetId, packet, base) {
  for (const event of arrayOrEmpty(packet.events)) {
    await insertEvent(
      client,
      packetId,
      base,
      String(event.type || event.eventType || "event"),
      String(event.level || "info"),
      String(event.title || event.name || "事件"),
      String(event.timestamp || event.time || base.packetTimestamp),
      event,
      String(event.description || event.detail || ""),
      String(event.id || ""),
    );
  }
}

async function ingestHeartbeat(client, packetId, packet, base) {
  const status = objectOrEmpty(packet.status);
  await updateInterfaceStatus(client, base, String(status.status || "online"), JSON.stringify(status));
  await insertEvent(client, packetId, base, "heartbeat", "info", "网关心跳", base.packetTimestamp, status);
}

async function ingestCommStatus(client, packetId, packet, base) {
  const communication = objectOrEmpty(packet.communication);
  const status = String(communication.status || "unknown");
  const detail = String(communication.detail || "");
  await updateInterfaceStatus(client, base, status, detail);
  await insertEvent(
    client,
    packetId,
    base,
    "comm_status",
    status === "online" ? "info" : "warning",
    status === "online" ? "通信恢复" : "通信异常",
    base.packetTimestamp,
    communication,
    detail,
  );
  if (status !== "online") {
    await client.query(
      `
      INSERT INTO alarm (
        external_id, station_id, meter_id, alarm_type, level, title,
        description, status, started_at, packet_id, raw_json
      )
      VALUES ($1, $2, $3, 'communication', 'warning', '通信异常', $4, 'active', $5::timestamptz, $6, $7::jsonb)
      `,
      [`comm:${base.meterId}`, base.stationId, base.meterId, detail, base.packetTimestamp, packetId, JSON.stringify(communication)],
    );
  } else {
    await client.query(
      `
      UPDATE alarm
      SET status = 'recovered', recovered_at = $1::timestamptz, packet_id = $2, updated_at = now()
      WHERE external_id = $3 AND status IN ('active', 'acknowledged')
      `,
      [base.packetTimestamp, packetId, `comm:${base.meterId}`],
    );
  }
}

async function insertEvent(client, packetId, base, eventType, level, title, eventTime, raw, description = "", externalId = "") {
  await client.query(
    `
    INSERT INTO event (
      external_id, station_id, meter_id, event_type, level, title,
      description, event_time, packet_id, raw_json
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10::jsonb)
    `,
    [
      externalId || null,
      base.stationId,
      base.meterId,
      eventType,
      level,
      title,
      description,
      eventTime,
      packetId,
      JSON.stringify(raw || {}),
    ],
  );
}

async function updateInterfaceStatus(client, base, status, detail) {
  const id = `${base.gatewayId}:${base.meterId}`;
  const isError = !GOOD_INTERFACE_STATUSES.has(status);
  await client.query(
    `
    INSERT INTO interface_status (
      id, station_id, gateway_id, meter_id, status, detail, last_packet_type,
      last_sequence, last_packet_at, last_received_at, error_count, last_error
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, now(), $10, $11)
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      detail = EXCLUDED.detail,
      last_packet_type = EXCLUDED.last_packet_type,
      last_sequence = EXCLUDED.last_sequence,
      last_packet_at = EXCLUDED.last_packet_at,
      last_received_at = EXCLUDED.last_received_at,
      error_count = CASE WHEN $12 THEN interface_status.error_count + 1 ELSE 0 END,
      last_error = EXCLUDED.last_error,
      updated_at = now()
    `,
    [
      id,
      base.stationId,
      base.gatewayId,
      base.meterId,
      status,
      detail,
      base.packetType,
      base.sequence,
      base.packetTimestamp,
      isError ? 1 : 0,
      isError ? detail : null,
      isError,
    ],
  );
}

async function ensurePoint(client, code, point) {
  await client.query(
    `
    INSERT INTO point_dictionary (code, name, unit, value_type, source, enabled)
    VALUES ($1, $2, $3, 'number', $4, true)
    ON CONFLICT (code) DO UPDATE SET
      name = COALESCE(NULLIF(EXCLUDED.name, ''), point_dictionary.name),
      unit = COALESCE(NULLIF(EXCLUDED.unit, ''), point_dictionary.unit),
      source = COALESCE(NULLIF(EXCLUDED.source, ''), point_dictionary.source)
    `,
    [code, String(point.name || code), String(point.unit || ""), String(point.source || "")],
  );
}

async function ensureMapping(client, base, code, displayName) {
  const existing = await client.query("SELECT id FROM point_mapping WHERE meter_id = $1 AND point_code = $2", [
    base.meterId,
    code,
  ]);
  if (existing.rows[0]) return existing.rows[0].id;
  const id = `${base.meterId}:${code}`;
  await client.query(
    `
    INSERT INTO point_mapping (id, station_id, meter_id, point_code, display_name, is_primary)
    VALUES ($1, $2, $3, $4, $5, true)
    ON CONFLICT (meter_id, point_code) DO NOTHING
    `,
    [id, base.stationId, base.meterId, code, displayName],
  );
  return id;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrNull(value) {
  const parsed = numberOrNull(value);
  return parsed === null ? null : Math.trunc(parsed);
}

module.exports = { ingestPacket };
