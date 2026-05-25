const fs = require("node:fs");
const { closePool, pool } = require("./db");
const { config } = require("./config");

const DERIVED_POINTS = [
  { code: "ep_import_delta", name: "采样周期吸收有功电能增量", unit: "kWh", source: "amc-gateway-processing", category: "derived" },
  { code: "ep_import_rate", name: "按电能增量折算平均有功功率", unit: "kW", source: "amc-gateway-processing", category: "derived" },
];

async function initializeDatabase() {
  const schemaSql = fs.readFileSync(config.schemaPath, "utf8");
  await pool.query(schemaSql);
  await seedFromSoftware1Config();
  await seedTopology();
  await seedPointDictionary();
  await seedPointMappings();
  await seedSwitchMappings();
}

async function seedFromSoftware1Config() {
  const raw = JSON.parse(fs.readFileSync(config.software1ConfigPath, "utf8"));
  const station = raw.station || { id: "substation-001", name: "演示变电站" };
  const gateway = raw.gateway || { id: "gateway-001", name: "笔记本网关" };
  const meters = raw.meters || [raw.meter || { id: "amc-001", name: "AMC智能电力仪表", model: "AMC(II)-E4KC" }];

  await pool.query(
    `
    INSERT INTO station (id, name, description)
    VALUES ($1, $2, 'single-station demo')
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
    `,
    [station.id || "substation-001", station.name || "演示变电站"],
  );
  await pool.query(
    `
    INSERT INTO gateway (id, station_id, name, protocol_version, status)
    VALUES ($1, $2, $3, '1.0', 'offline')
    ON CONFLICT (id) DO UPDATE SET station_id = EXCLUDED.station_id, name = EXCLUDED.name
    `,
    [gateway.id || "gateway-001", station.id || "substation-001", gateway.name || "笔记本网关"],
  );

  for (let index = 0; index < meters.length; index += 1) {
    const meter = meters[index];
    const meterId = String(meter.id || `amc-${String(index + 1).padStart(3, "0")}`);
    const deviceId = `device-${meterId}`;
    await pool.query(
      `
      INSERT INTO device (id, station_id, code, name, device_type, model, status, description)
      VALUES ($1, $2, $3, $4, 'meter', $5, 'not_connected', 'software1 AMC data source')
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, model = EXCLUDED.model
      `,
      [deviceId, station.id || "substation-001", meterId, meter.name || "AMC智能电力仪表", meter.model || "AMC(II)-E4KC"],
    );
    await pool.query(
      `
      INSERT INTO meter (id, station_id, gateway_id, device_id, name, model, slave_id, protocol, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'Modbus-RTU', 'offline')
      ON CONFLICT (id) DO UPDATE SET
        station_id = EXCLUDED.station_id,
        gateway_id = EXCLUDED.gateway_id,
        device_id = EXCLUDED.device_id,
        name = EXCLUDED.name,
        model = EXCLUDED.model,
        slave_id = EXCLUDED.slave_id
      `,
      [
        meterId,
        station.id || "substation-001",
        gateway.id || "gateway-001",
        deviceId,
        meter.name || "AMC智能电力仪表",
        meter.model || "AMC(II)-E4KC",
        meter.slaveId || null,
      ],
    );
  }
}

async function seedTopology() {
  const stationId = await firstValue("SELECT id FROM station ORDER BY id LIMIT 1", "substation-001");
  const cabinets = [
    ["hv-aa1", "AA1", "高压进线柜01", "10kV", "incoming"],
    ["hv-aa2", "AA2", "高压计量柜4", "10kV", "metering"],
    ["hv-aa3", "AA3", "高压出线柜11", "10kV", "outgoing"],
    ["hv-aa4", "AA4", "高压母联柜", "10kV", "bus-coupler"],
    ["hv-aa5", "AA5", "高压出线柜21", "10kV", "outgoing"],
    ["hv-aa6", "AA6", "高压计量柜5", "10kV", "metering"],
    ["hv-aa7", "AA7", "高压进线柜02", "10kV", "incoming"],
    ["lv-aa0", "AA0", "低压负荷开关柜", "0.4kV", "load"],
    ["lv-aa1", "AA1", "低压负荷开关柜", "0.4kV", "load"],
    ["lv-aa2", "AA2", "低压负荷开关柜", "0.4kV", "load"],
    ["lv-aa3", "AA3", "电容补偿柜", "0.4kV", "capacitor"],
    ["lv-aa4", "AA4", "电容补偿柜", "0.4kV", "capacitor"],
    ["lv-aa5", "AA5", "低压主进线柜", "0.4kV", "incoming"],
    ["lv-aa6", "AA6", "低压联络柜", "0.4kV", "bus-coupler"],
    ["lv-aa7", "AA7", "电容补偿柜", "0.4kV", "capacitor"],
    ["lv-aa8", "AA8", "电容补偿柜", "0.4kV", "capacitor"],
    ["lv-aa9", "AA9", "低压负荷开关柜", "0.4kV", "load"],
    ["lv-aa10", "AA10", "低压负荷开关柜", "0.4kV", "load"],
    ["lv-aa11", "AA11", "低压主进线柜", "0.4kV", "incoming"],
  ];

  for (let index = 0; index < cabinets.length; index += 1) {
    const [id, code, name, voltage, type] = cabinets[index];
    await pool.query(
      `
      INSERT INTO cabinet (id, station_id, code, name, voltage_level, cabinet_type, status, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6, 'not_connected', $7)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, voltage_level = EXCLUDED.voltage_level, cabinet_type = EXCLUDED.cabinet_type
      `,
      [id, stationId, code, name, voltage, type, index + 1],
    );
  }

  await pool.query(
    `
    INSERT INTO circuit (id, station_id, cabinet_id, code, name, circuit_type, status, rated_voltage)
    VALUES ('lv-main-incoming', $1, 'lv-aa5', 'LV-MAIN-IN', '低压主进线回路', 'incoming', 'not_connected', 380.0)
    ON CONFLICT (id) DO UPDATE SET cabinet_id = EXCLUDED.cabinet_id, name = EXCLUDED.name
    `,
    [stationId],
  );

  const aa1Circuits = [
    ["d010101", "AA1-01", "路灯照明"],
    ["d010102", "AA1-02", "3号楼照明"],
    ["d010103", "AA1-03", "4、5号楼照明"],
    ["d010104", "AA1-04", "1号楼照明"],
  ];
  for (const [id, code, name] of aa1Circuits) {
    await pool.query(
      `
      INSERT INTO circuit (id, station_id, cabinet_id, code, name, circuit_type, status, rated_voltage)
      VALUES ($1, $2, 'lv-aa1', $3, $4, 'load', 'not_connected', 380.0)
      ON CONFLICT (id) DO UPDATE SET cabinet_id = EXCLUDED.cabinet_id, code = EXCLUDED.code, name = EXCLUDED.name
      `,
      [id, stationId, code, name],
    );
  }

  await pool.query(
    `
    UPDATE device
    SET cabinet_id = COALESCE(cabinet_id, 'lv-aa5'),
        circuit_id = COALESCE(circuit_id, 'lv-main-incoming')
    WHERE device_type = 'meter'
    `,
  );
}

async function seedPointDictionary() {
  const pointTable = JSON.parse(fs.readFileSync(config.pointTablePath, "utf8"));
  for (const raw of pointTable.points || []) {
    const code = String(raw.code);
    await pool.query(
      `
      INSERT INTO point_dictionary (
        code, name, unit, value_type, source, category,
        address_hex, register_length, data_type, scale, enabled, default_quality
      )
      VALUES ($1, $2, $3, 'number', $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        unit = EXCLUDED.unit,
        source = EXCLUDED.source,
        category = EXCLUDED.category,
        address_hex = EXCLUDED.address_hex,
        register_length = EXCLUDED.register_length,
        data_type = EXCLUDED.data_type,
        scale = EXCLUDED.scale,
        enabled = EXCLUDED.enabled,
        default_quality = EXCLUDED.default_quality
      `,
      [
        code,
        raw.name || code,
        raw.unit || "",
        raw.source || "amc-e4kc-secondary",
        pointCategory(code),
        raw.addressHex || "",
        raw.length || 1,
        raw.dataType || "uint16",
        raw.scale || 1,
        Boolean(raw.enabledInV1),
        raw.defaultQuality || null,
      ],
    );
  }

  for (const raw of DERIVED_POINTS) {
    await pool.query(
      `
      INSERT INTO point_dictionary (code, name, unit, value_type, source, category, enabled)
      VALUES ($1, $2, $3, 'number', $4, $5, true)
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, unit = EXCLUDED.unit
      `,
      [raw.code, raw.name, raw.unit, raw.source, raw.category],
    );
  }
}

async function seedSwitchMappings() {
  const stationId = await firstValue("SELECT id FROM station ORDER BY id LIMIT 1", "substation-001");
  const meterId = await firstValue("SELECT id FROM meter ORDER BY id LIMIT 1", "amc-001");
  await pool.query(
    `
    INSERT INTO point_dictionary (code, name, unit, value_type, source, category, enabled)
    VALUES ('dido_status', '开关量状态', '', 'digital', 'amc-e4kc-secondary', 'digital', true)
    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, value_type = EXCLUDED.value_type, category = EXCLUDED.category
    `,
  );

  const mappings = [
    ["aa1-c1-dido", "d010101", 0x0100, "路灯照明"],
    ["aa1-c2-dido", "d010102", 0x0200, "3号楼照明"],
    ["aa1-c3-dido", "d010103", 0x0400, "4、5号楼照明"],
    ["aa1-c4-dido", "d010104", 0x0800, "1号楼照明"],
  ];
  for (const [id, circuitId, bitMask, displayName] of mappings) {
    await pool.query(
      `
      INSERT INTO circuit_switch_mapping (
        id, station_id, circuit_id, cabinet_id, meter_id, point_code, bit_mask, closed_value, display_name, enabled
      )
      VALUES ($1, $2, $3, 'lv-aa1', $4, 'dido_status', $5, 1, $6, true)
      ON CONFLICT (circuit_id, meter_id, point_code, bit_mask) DO UPDATE SET
        cabinet_id = EXCLUDED.cabinet_id,
        display_name = EXCLUDED.display_name,
        enabled = EXCLUDED.enabled
      `,
      [id, stationId, circuitId, meterId, bitMask, displayName],
    );
  }
}

async function seedPointMappings() {
  const stationId = await firstValue("SELECT id FROM station ORDER BY id LIMIT 1", "substation-001");
  const meters = await pool.query("SELECT id, device_id FROM meter ORDER BY id");
  const points = await pool.query("SELECT code, name FROM point_dictionary ORDER BY code");
  for (const meter of meters.rows) {
    for (const point of points.rows) {
      await pool.query(
        `
        INSERT INTO point_mapping (
          id, station_id, meter_id, point_code, cabinet_id, circuit_id, device_id, display_name, is_primary
        )
        VALUES ($1, $2, $3, $4, 'lv-aa5', 'lv-main-incoming', $5, $6, true)
        ON CONFLICT (meter_id, point_code) DO UPDATE SET display_name = EXCLUDED.display_name
        `,
        [`${meter.id}:${point.code}`, stationId, meter.id, point.code, meter.device_id || `device-${meter.id}`, point.name || point.code],
      );
    }
  }
}

async function firstValue(sql, fallback) {
  const result = await pool.query(sql);
  return result.rows[0] ? Object.values(result.rows[0])[0] : fallback;
}

function pointCategory(code) {
  if (["ua", "ub", "uc", "uab", "ubc", "uac", "u0", "voltage_unbalance"].includes(code)) return "voltage";
  if (["ia", "ib", "ic", "i0", "current_unbalance"].includes(code)) return "current";
  if (["pa", "pb", "pc", "qa", "qb", "qc", "sa", "sb", "sc"].includes(code) || code.endsWith("_total")) return "power";
  if (code.startsWith("pf")) return "power_factor";
  if (code.startsWith("thd")) return "harmonic";
  if (code.startsWith("angle")) return "angle";
  if (code.startsWith("ep_")) return "energy";
  if (code === "frequency") return "frequency";
  if (code === "switch_status" || code === "dido_status") return "digital";
  return "other";
}

if (require.main === module) {
  initializeDatabase()
    .then(async () => {
      console.log("PostgreSQL schema and seed data initialized.");
      await closePool();
    })
    .catch(async (error) => {
      console.error(error);
      await closePool();
      process.exit(1);
    });
}

module.exports = { initializeDatabase };
