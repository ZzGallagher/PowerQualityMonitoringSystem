CREATE TABLE IF NOT EXISTS schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_version (id, version)
VALUES (1, '1.0.0-postgres')
ON CONFLICT (id) DO UPDATE SET
    version = EXCLUDED.version,
    applied_at = now();

CREATE TABLE IF NOT EXISTS station (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cabinet (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL REFERENCES station(id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    voltage_level TEXT,
    cabinet_type TEXT,
    status TEXT NOT NULL DEFAULT 'not_connected',
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS circuit (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL REFERENCES station(id),
    cabinet_id TEXT REFERENCES cabinet(id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    circuit_type TEXT,
    status TEXT NOT NULL DEFAULT 'not_connected',
    rated_voltage DOUBLE PRECISION,
    rated_current DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS device (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL REFERENCES station(id),
    cabinet_id TEXT REFERENCES cabinet(id),
    circuit_id TEXT REFERENCES circuit(id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    device_type TEXT NOT NULL,
    model TEXT,
    manufacturer TEXT,
    status TEXT NOT NULL DEFAULT 'not_connected',
    description TEXT
);

CREATE TABLE IF NOT EXISTS gateway (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL REFERENCES station(id),
    name TEXT NOT NULL,
    protocol_version TEXT,
    last_seen_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'offline',
    description TEXT
);

CREATE TABLE IF NOT EXISTS meter (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL REFERENCES station(id),
    gateway_id TEXT NOT NULL REFERENCES gateway(id),
    device_id TEXT REFERENCES device(id),
    name TEXT NOT NULL,
    model TEXT,
    slave_id INTEGER,
    protocol TEXT NOT NULL DEFAULT 'Modbus-RTU',
    status TEXT NOT NULL DEFAULT 'offline',
    last_sample_at TIMESTAMPTZ,
    last_sequence INTEGER
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
    scale DOUBLE PRECISION,
    enabled BOOLEAN NOT NULL DEFAULT true,
    default_quality TEXT,
    description TEXT
);

CREATE TABLE IF NOT EXISTS point_mapping (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL REFERENCES station(id),
    meter_id TEXT NOT NULL REFERENCES meter(id),
    point_code TEXT NOT NULL REFERENCES point_dictionary(code),
    cabinet_id TEXT REFERENCES cabinet(id),
    circuit_id TEXT REFERENCES circuit(id),
    device_id TEXT REFERENCES device(id),
    display_name TEXT,
    is_primary BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (meter_id, point_code)
);

CREATE TABLE IF NOT EXISTS circuit_switch_mapping (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL REFERENCES station(id),
    circuit_id TEXT NOT NULL REFERENCES circuit(id),
    cabinet_id TEXT REFERENCES cabinet(id),
    meter_id TEXT NOT NULL REFERENCES meter(id),
    point_code TEXT NOT NULL REFERENCES point_dictionary(code),
    bit_mask INTEGER,
    closed_value DOUBLE PRECISION DEFAULT 1,
    display_name TEXT,
    enabled BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (circuit_id, meter_id, point_code, bit_mask)
);

CREATE TABLE IF NOT EXISTS ingest_packet (
    id BIGSERIAL PRIMARY KEY,
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
    packet_timestamp TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    parse_status TEXT NOT NULL DEFAULT 'ok',
    error_message TEXT,
    raw_json JSONB NOT NULL,
    UNIQUE (gateway_id, meter_id, packet_type, sequence, packet_timestamp)
);

CREATE INDEX IF NOT EXISTS idx_ingest_packet_meter_time
ON ingest_packet (meter_id, packet_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_ingest_packet_type_time
ON ingest_packet (packet_type, packet_timestamp DESC);

CREATE TABLE IF NOT EXISTS realtime_value (
    mapping_id TEXT PRIMARY KEY REFERENCES point_mapping(id),
    station_id TEXT NOT NULL,
    meter_id TEXT NOT NULL,
    point_code TEXT NOT NULL,
    name TEXT,
    value DOUBLE PRECISION,
    raw_value BIGINT,
    unit TEXT,
    quality TEXT NOT NULL,
    sample_time TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    source TEXT,
    packet_id BIGINT REFERENCES ingest_packet(id)
);

CREATE TABLE IF NOT EXISTS history_sample (
    id BIGSERIAL PRIMARY KEY,
    mapping_id TEXT NOT NULL REFERENCES point_mapping(id),
    station_id TEXT NOT NULL,
    meter_id TEXT NOT NULL,
    point_code TEXT NOT NULL,
    name TEXT,
    value DOUBLE PRECISION,
    raw_value BIGINT,
    unit TEXT,
    quality TEXT NOT NULL,
    sample_time TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    source TEXT,
    packet_id BIGINT REFERENCES ingest_packet(id)
);

CREATE INDEX IF NOT EXISTS idx_history_mapping_time
ON history_sample (mapping_id, sample_time DESC);

CREATE INDEX IF NOT EXISTS idx_history_meter_point_time
ON history_sample (meter_id, point_code, sample_time DESC);

CREATE TABLE IF NOT EXISTS statistic_record (
    id BIGSERIAL PRIMARY KEY,
    mapping_id TEXT REFERENCES point_mapping(id),
    station_id TEXT NOT NULL,
    meter_id TEXT NOT NULL,
    point_code TEXT NOT NULL,
    statistic_time TIMESTAMPTZ NOT NULL,
    window_start TIMESTAMPTZ,
    window_end TIMESTAMPTZ,
    min_value DOUBLE PRECISION,
    max_value DOUBLE PRECISION,
    avg_value DOUBLE PRECISION,
    sample_count INTEGER NOT NULL DEFAULT 0,
    quality TEXT NOT NULL DEFAULT 'good',
    packet_id BIGINT REFERENCES ingest_packet(id)
);

CREATE INDEX IF NOT EXISTS idx_stat_mapping_time
ON statistic_record (mapping_id, statistic_time DESC);

CREATE TABLE IF NOT EXISTS alarm (
    id BIGSERIAL PRIMARY KEY,
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
    trigger_value DOUBLE PRECISION,
    trigger_unit TEXT,
    min_value DOUBLE PRECISION,
    max_value DOUBLE PRECISION,
    basis TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    started_at TIMESTAMPTZ NOT NULL,
    recovered_at TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by TEXT,
    ack_note TEXT,
    closed_at TIMESTAMPTZ,
    closed_by TEXT,
    close_note TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    packet_id BIGINT REFERENCES ingest_packet(id),
    raw_json JSONB
);

ALTER TABLE alarm ADD COLUMN IF NOT EXISTS ack_note TEXT;
ALTER TABLE alarm ADD COLUMN IF NOT EXISTS close_note TEXT;
ALTER TABLE alarm ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_alarm_status_time
ON alarm (status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_alarm_meter_point_time
ON alarm (meter_id, point_code, started_at DESC);

CREATE TABLE IF NOT EXISTS event (
    id BIGSERIAL PRIMARY KEY,
    external_id TEXT,
    station_id TEXT NOT NULL,
    meter_id TEXT,
    event_type TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    description TEXT,
    event_time TIMESTAMPTZ NOT NULL,
    packet_id BIGINT REFERENCES ingest_packet(id),
    raw_json JSONB
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
    last_packet_at TIMESTAMPTZ,
    last_received_at TIMESTAMPTZ,
    error_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_record (
    id BIGSERIAL PRIMARY KEY,
    station_id TEXT NOT NULL,
    report_type TEXT NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'generated',
    summary_json JSONB,
    file_path TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meter_reading_record (
    id BIGSERIAL PRIMARY KEY,
    station_id TEXT NOT NULL,
    meter_id TEXT NOT NULL,
    reading_time TIMESTAMPTZ NOT NULL,
    ep_import DOUBLE PRECISION,
    unit TEXT DEFAULT 'kWh',
    quality TEXT NOT NULL DEFAULT 'good',
    source TEXT NOT NULL DEFAULT 'auto',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meter_reading_meter_time
ON meter_reading_record (meter_id, reading_time DESC);
