PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO schema_version (id, version)
VALUES (1, '1.0.0')
ON CONFLICT(id) DO UPDATE SET
    version = excluded.version,
    applied_at = CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS station (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cabinet (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    voltage_level TEXT,
    cabinet_type TEXT,
    status TEXT NOT NULL DEFAULT 'not_connected',
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (station_id) REFERENCES station(id)
);

CREATE TABLE IF NOT EXISTS circuit (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL,
    cabinet_id TEXT,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    circuit_type TEXT,
    status TEXT NOT NULL DEFAULT 'not_connected',
    rated_voltage REAL,
    rated_current REAL,
    FOREIGN KEY (station_id) REFERENCES station(id),
    FOREIGN KEY (cabinet_id) REFERENCES cabinet(id)
);

CREATE TABLE IF NOT EXISTS device (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL,
    cabinet_id TEXT,
    circuit_id TEXT,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    device_type TEXT NOT NULL,
    model TEXT,
    manufacturer TEXT,
    status TEXT NOT NULL DEFAULT 'not_connected',
    description TEXT,
    FOREIGN KEY (station_id) REFERENCES station(id),
    FOREIGN KEY (cabinet_id) REFERENCES cabinet(id),
    FOREIGN KEY (circuit_id) REFERENCES circuit(id)
);

CREATE TABLE IF NOT EXISTS gateway (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL,
    name TEXT NOT NULL,
    protocol_version TEXT,
    last_seen_at TEXT,
    status TEXT NOT NULL DEFAULT 'offline',
    description TEXT,
    FOREIGN KEY (station_id) REFERENCES station(id)
);

CREATE TABLE IF NOT EXISTS meter (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL,
    gateway_id TEXT NOT NULL,
    device_id TEXT,
    name TEXT NOT NULL,
    model TEXT,
    slave_id INTEGER,
    protocol TEXT NOT NULL DEFAULT 'Modbus-RTU',
    status TEXT NOT NULL DEFAULT 'offline',
    last_sample_at TEXT,
    last_sequence INTEGER,
    FOREIGN KEY (station_id) REFERENCES station(id),
    FOREIGN KEY (gateway_id) REFERENCES gateway(id),
    FOREIGN KEY (device_id) REFERENCES device(id)
);

CREATE TABLE IF NOT EXISTS point_dictionary (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    unit TEXT,
    value_type TEXT NOT NULL DEFAULT 'number',
    source TEXT,
    category TEXT,
    address_hex TEXT,
    register_length INTEGER,
    data_type TEXT,
    scale REAL,
    enabled INTEGER NOT NULL DEFAULT 1,
    default_quality TEXT,
    description TEXT
);

CREATE TABLE IF NOT EXISTS point_mapping (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL,
    meter_id TEXT NOT NULL,
    point_code TEXT NOT NULL,
    cabinet_id TEXT,
    circuit_id TEXT,
    device_id TEXT,
    display_name TEXT,
    is_primary INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (station_id) REFERENCES station(id),
    FOREIGN KEY (meter_id) REFERENCES meter(id),
    FOREIGN KEY (point_code) REFERENCES point_dictionary(code),
    FOREIGN KEY (cabinet_id) REFERENCES cabinet(id),
    FOREIGN KEY (circuit_id) REFERENCES circuit(id),
    FOREIGN KEY (device_id) REFERENCES device(id),
    UNIQUE (meter_id, point_code)
);

CREATE TABLE IF NOT EXISTS ingest_packet (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    protocol_version TEXT NOT NULL,
    packet_type TEXT NOT NULL,
    station_id TEXT,
    station_name TEXT,
    gateway_id TEXT,
    gateway_name TEXT,
    meter_id TEXT,
    meter_name TEXT,
    meter_model TEXT,
    sequence INTEGER,
    packet_timestamp TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    parse_status TEXT NOT NULL DEFAULT 'ok',
    error_message TEXT,
    raw_json TEXT NOT NULL,
    UNIQUE (gateway_id, meter_id, packet_type, sequence, packet_timestamp)
);

CREATE INDEX IF NOT EXISTS idx_ingest_packet_meter_time
ON ingest_packet (meter_id, packet_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_ingest_packet_type_time
ON ingest_packet (packet_type, packet_timestamp DESC);

CREATE TABLE IF NOT EXISTS realtime_value (
    mapping_id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL,
    meter_id TEXT NOT NULL,
    point_code TEXT NOT NULL,
    name TEXT,
    value REAL,
    raw_value INTEGER,
    unit TEXT,
    quality TEXT NOT NULL,
    sample_time TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source TEXT,
    packet_id INTEGER,
    FOREIGN KEY (mapping_id) REFERENCES point_mapping(id),
    FOREIGN KEY (packet_id) REFERENCES ingest_packet(id)
);

CREATE TABLE IF NOT EXISTS history_sample (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mapping_id TEXT NOT NULL,
    station_id TEXT NOT NULL,
    meter_id TEXT NOT NULL,
    point_code TEXT NOT NULL,
    name TEXT,
    value REAL,
    raw_value INTEGER,
    unit TEXT,
    quality TEXT NOT NULL,
    sample_time TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source TEXT,
    packet_id INTEGER,
    FOREIGN KEY (mapping_id) REFERENCES point_mapping(id),
    FOREIGN KEY (packet_id) REFERENCES ingest_packet(id)
);

CREATE INDEX IF NOT EXISTS idx_history_mapping_time
ON history_sample (mapping_id, sample_time DESC);

CREATE INDEX IF NOT EXISTS idx_history_meter_point_time
ON history_sample (meter_id, point_code, sample_time DESC);

CREATE TABLE IF NOT EXISTS statistic_record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mapping_id TEXT,
    station_id TEXT NOT NULL,
    meter_id TEXT NOT NULL,
    point_code TEXT NOT NULL,
    statistic_time TEXT NOT NULL,
    window_start TEXT,
    window_end TEXT,
    min_value REAL,
    max_value REAL,
    avg_value REAL,
    sample_count INTEGER NOT NULL DEFAULT 0,
    quality TEXT NOT NULL DEFAULT 'good',
    packet_id INTEGER,
    FOREIGN KEY (mapping_id) REFERENCES point_mapping(id),
    FOREIGN KEY (packet_id) REFERENCES ingest_packet(id)
);

CREATE INDEX IF NOT EXISTS idx_stat_mapping_time
ON statistic_record (mapping_id, statistic_time DESC);

CREATE TABLE IF NOT EXISTS alarm (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT,
    station_id TEXT NOT NULL,
    meter_id TEXT,
    point_code TEXT,
    cabinet_id TEXT,
    circuit_id TEXT,
    device_id TEXT,
    alarm_type TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'warning',
    title TEXT NOT NULL,
    description TEXT,
    trigger_value REAL,
    trigger_unit TEXT,
    min_value REAL,
    max_value REAL,
    basis TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    started_at TEXT NOT NULL,
    recovered_at TEXT,
    acknowledged_at TEXT,
    acknowledged_by TEXT,
    ack_note TEXT,
    closed_at TEXT,
    closed_by TEXT,
    close_note TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    packet_id INTEGER,
    raw_json TEXT,
    FOREIGN KEY (packet_id) REFERENCES ingest_packet(id)
);

CREATE INDEX IF NOT EXISTS idx_alarm_status_time
ON alarm (status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_alarm_meter_point_time
ON alarm (meter_id, point_code, started_at DESC);

CREATE TABLE IF NOT EXISTS event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT,
    station_id TEXT NOT NULL,
    meter_id TEXT,
    event_type TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    description TEXT,
    event_time TEXT NOT NULL,
    packet_id INTEGER,
    raw_json TEXT,
    FOREIGN KEY (packet_id) REFERENCES ingest_packet(id)
);

CREATE INDEX IF NOT EXISTS idx_event_type_time
ON event (event_type, event_time DESC);

CREATE TABLE IF NOT EXISTS interface_status (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL,
    gateway_id TEXT,
    meter_id TEXT,
    status TEXT NOT NULL,
    detail TEXT,
    last_packet_type TEXT,
    last_sequence INTEGER,
    last_packet_at TEXT,
    last_received_at TEXT,
    error_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS report_record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT NOT NULL,
    report_type TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'generated',
    summary_json TEXT,
    file_path TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS meter_reading_record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT NOT NULL,
    meter_id TEXT NOT NULL,
    reading_time TEXT NOT NULL,
    ep_import REAL,
    unit TEXT DEFAULT 'kWh',
    quality TEXT NOT NULL DEFAULT 'good',
    source TEXT NOT NULL DEFAULT 'auto',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_meter_reading_meter_time
ON meter_reading_record (meter_id, reading_time DESC);

CREATE TABLE IF NOT EXISTS maintenance_record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT NOT NULL,
    device_id TEXT,
    title TEXT NOT NULL,
    content TEXT,
    operator TEXT,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_user (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'operator',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
