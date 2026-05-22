from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[1]
DATABASE_DIR = Path(__file__).resolve().parent
DEFAULT_DB_PATH = DATABASE_DIR / "data" / "pq_monitor.sqlite3"
DEFAULT_SCHEMA_PATH = DATABASE_DIR / "schema.sql"
DEFAULT_POINT_TABLE_PATH = ROOT_DIR / "软件1" / "AMC-E4KC点表-v1.json"
DEFAULT_CONFIG_PATH = ROOT_DIR / "软件1" / "amc_gateway" / "meter_config.example.json"

DERIVED_POINTS = (
    {
        "code": "ep_import_delta",
        "name": "采样周期吸收有功电能增量",
        "unit": "kWh",
        "source": "amc-gateway-processing",
        "category": "derived",
    },
    {
        "code": "ep_import_rate",
        "name": "按电能增量折算平均有功功率",
        "unit": "kW",
        "source": "amc-gateway-processing",
        "category": "derived",
    },
)


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_database(
    db_path: Path = DEFAULT_DB_PATH,
    schema_path: Path = DEFAULT_SCHEMA_PATH,
    point_table_path: Path = DEFAULT_POINT_TABLE_PATH,
    config_path: Path = DEFAULT_CONFIG_PATH,
) -> None:
    with connect(db_path) as conn:
        conn.executescript(schema_path.read_text(encoding="utf-8-sig"))
        seed_from_config(conn, config_path)
        seed_point_dictionary(conn, point_table_path)
        seed_default_topology(conn)
        seed_point_mappings(conn)


def seed_from_config(conn: sqlite3.Connection, config_path: Path) -> None:
    config = _read_json(config_path)
    station = config.get("station") or {"id": "substation-001", "name": "演示变电站"}
    gateway = config.get("gateway") or {"id": "gateway-001", "name": "笔记本网关"}
    meters = config.get("meters") or [config.get("meter") or {"id": "amc-001", "name": "AMC智能电力仪表", "model": "AMC(II)-E4KC"}]

    station_id = str(station.get("id") or "substation-001")
    gateway_id = str(gateway.get("id") or "gateway-001")

    conn.execute(
        """
        INSERT INTO station (id, name, description)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            updated_at = CURRENT_TIMESTAMP
        """,
        (station_id, str(station.get("name") or "演示变电站"), "single-station demo"),
    )
    conn.execute(
        """
        INSERT INTO gateway (id, station_id, name, protocol_version, status)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            station_id = excluded.station_id,
            name = excluded.name,
            protocol_version = excluded.protocol_version
        """,
        (gateway_id, station_id, str(gateway.get("name") or "笔记本网关"), "1.0", "offline"),
    )

    for index, raw_meter in enumerate(meters):
        meter_id = str(raw_meter.get("id") or f"amc-{index + 1:03d}")
        device_id = f"device-{meter_id}"
        conn.execute(
            """
            INSERT INTO device (
                id, station_id, cabinet_id, circuit_id, code, name, device_type, model, status, description
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                station_id = excluded.station_id,
                cabinet_id = excluded.cabinet_id,
                circuit_id = excluded.circuit_id,
                name = excluded.name,
                model = excluded.model,
                status = excluded.status
            """,
            (
                device_id,
                station_id,
                None,
                None,
                meter_id,
                str(raw_meter.get("name") or "AMC智能电力仪表"),
                "meter",
                str(raw_meter.get("model") or "AMC(II)-E4KC"),
                "not_connected",
                "software1 AMC data source",
            ),
        )
        conn.execute(
            """
            INSERT INTO meter (
                id, station_id, gateway_id, device_id, name, model, slave_id, protocol, status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                station_id = excluded.station_id,
                gateway_id = excluded.gateway_id,
                device_id = excluded.device_id,
                name = excluded.name,
                model = excluded.model,
                slave_id = excluded.slave_id
            """,
            (
                meter_id,
                station_id,
                gateway_id,
                device_id,
                str(raw_meter.get("name") or "AMC智能电力仪表"),
                str(raw_meter.get("model") or "AMC(II)-E4KC"),
                _int_or_none(raw_meter.get("slaveId")),
                "Modbus-RTU",
                "offline",
            ),
        )


def seed_point_dictionary(conn: sqlite3.Connection, point_table_path: Path) -> None:
    point_table = _read_json(point_table_path)
    for raw in point_table.get("points", []):
        code = str(raw["code"])
        conn.execute(
            """
            INSERT INTO point_dictionary (
                code, name, unit, value_type, source, category,
                address_hex, register_length, data_type, scale,
                enabled, default_quality, description
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(code) DO UPDATE SET
                name = excluded.name,
                unit = excluded.unit,
                source = excluded.source,
                category = excluded.category,
                address_hex = excluded.address_hex,
                register_length = excluded.register_length,
                data_type = excluded.data_type,
                scale = excluded.scale,
                enabled = excluded.enabled,
                default_quality = excluded.default_quality
            """,
            (
                code,
                str(raw.get("name") or code),
                str(raw.get("unit") or ""),
                "number",
                str(raw.get("source") or "amc-e4kc-secondary"),
                _point_category(code),
                str(raw.get("addressHex") or ""),
                _int_or_none(raw.get("length")) or 1,
                str(raw.get("dataType") or "uint16"),
                float(raw.get("scale") or 1),
                1 if raw.get("enabledInV1", False) else 0,
                raw.get("defaultQuality"),
                None,
            ),
        )

    for raw in DERIVED_POINTS:
        conn.execute(
            """
            INSERT INTO point_dictionary (code, name, unit, value_type, source, category, enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(code) DO UPDATE SET
                name = excluded.name,
                unit = excluded.unit,
                source = excluded.source,
                category = excluded.category,
                enabled = excluded.enabled
            """,
            (
                raw["code"],
                raw["name"],
                raw["unit"],
                "number",
                raw["source"],
                raw["category"],
                1,
            ),
        )


def seed_default_topology(conn: sqlite3.Connection) -> None:
    station_id = _single_value(conn, "SELECT id FROM station ORDER BY id LIMIT 1") or "substation-001"
    high_voltage = [
        ("hv-aa1", "AA1", "高压进线柜01", "10kV", "incoming"),
        ("hv-aa2", "AA2", "高压计量柜4", "10kV", "metering"),
        ("hv-aa3", "AA3", "高压出线柜11", "10kV", "outgoing"),
        ("hv-aa4", "AA4", "高压母联柜", "10kV", "bus-coupler"),
        ("hv-aa5", "AA5", "高压出线柜21", "10kV", "outgoing"),
        ("hv-aa6", "AA6", "高压计量柜5", "10kV", "metering"),
        ("hv-aa7", "AA7", "高压进线柜02", "10kV", "incoming"),
    ]
    low_voltage = [
        ("lv-aa0", "AA0", "负荷开关柜", "0.4kV", "load"),
        ("lv-aa1", "AA1", "负荷开关柜", "0.4kV", "load"),
        ("lv-aa2", "AA2", "负荷开关柜", "0.4kV", "load"),
        ("lv-aa3", "AA3", "电容补偿柜", "0.4kV", "capacitor"),
        ("lv-aa4", "AA4", "电容补偿柜", "0.4kV", "capacitor"),
        ("lv-aa5", "AA5", "低压主进线柜", "0.4kV", "incoming"),
        ("lv-aa6", "AA6", "低压联络柜", "0.4kV", "bus-coupler"),
        ("lv-aa7", "AA7", "电容补偿柜", "0.4kV", "capacitor"),
        ("lv-aa8", "AA8", "电容补偿柜", "0.4kV", "capacitor"),
        ("lv-aa9", "AA9", "负荷开关柜", "0.4kV", "load"),
        ("lv-aa10", "AA10", "负荷开关柜", "0.4kV", "load"),
        ("lv-aa11", "AA11", "低压主进线柜", "0.4kV", "incoming"),
    ]
    for order, (cabinet_id, code, name, voltage, cabinet_type) in enumerate(high_voltage + low_voltage, start=1):
        conn.execute(
            """
            INSERT INTO cabinet (id, station_id, code, name, voltage_level, cabinet_type, status, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                voltage_level = excluded.voltage_level,
                cabinet_type = excluded.cabinet_type,
                sort_order = excluded.sort_order
            """,
            (cabinet_id, station_id, code, name, voltage, cabinet_type, "not_connected", order),
        )

    conn.execute(
        """
        INSERT INTO circuit (
            id, station_id, cabinet_id, code, name, circuit_type, status, rated_voltage, rated_current
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            cabinet_id = excluded.cabinet_id,
            name = excluded.name,
            circuit_type = excluded.circuit_type,
            rated_voltage = excluded.rated_voltage,
            rated_current = excluded.rated_current
        """,
        (
            "lv-main-incoming",
            station_id,
            "lv-aa5",
            "LV-MAIN-IN",
            "低压主进线回路",
            "incoming",
            "not_connected",
            380.0,
            None,
        ),
    )
    conn.execute(
        """
        UPDATE device
        SET cabinet_id = COALESCE(cabinet_id, 'lv-aa5'),
            circuit_id = COALESCE(circuit_id, 'lv-main-incoming')
        WHERE device_type = 'meter'
        """
    )


def seed_point_mappings(conn: sqlite3.Connection) -> None:
    station_id = _single_value(conn, "SELECT id FROM station ORDER BY id LIMIT 1") or "substation-001"
    meters = conn.execute("SELECT id, device_id FROM meter ORDER BY id").fetchall()
    points = conn.execute("SELECT code, name FROM point_dictionary ORDER BY code").fetchall()
    for meter in meters:
        meter_id = str(meter["id"])
        device_id = str(meter["device_id"] or f"device-{meter_id}")
        for point in points:
            point_code = str(point["code"])
            mapping_id = f"{meter_id}:{point_code}"
            conn.execute(
                """
                INSERT INTO point_mapping (
                    id, station_id, meter_id, point_code, cabinet_id, circuit_id,
                    device_id, display_name, is_primary
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(meter_id, point_code) DO UPDATE SET
                    station_id = excluded.station_id,
                    cabinet_id = excluded.cabinet_id,
                    circuit_id = excluded.circuit_id,
                    device_id = excluded.device_id,
                    display_name = excluded.display_name
                """,
                (
                    mapping_id,
                    station_id,
                    meter_id,
                    point_code,
                    "lv-aa5",
                    "lv-main-incoming",
                    device_id,
                    str(point["name"] or point_code),
                    1,
                ),
            )


def _point_category(code: str) -> str:
    if code.startswith(("ua", "ub", "uc", "u0")) or code in {"uab", "ubc", "uac", "voltage_unbalance"}:
        return "voltage"
    if code.startswith(("ia", "ib", "ic", "i0")) or code == "current_unbalance":
        return "current"
    if code.startswith(("pa", "pb", "pc", "qa", "qb", "qc", "sa", "sb", "sc")) or code.endswith("_total"):
        return "power"
    if code.startswith("pf"):
        return "power_factor"
    if code.startswith("thd"):
        return "harmonic"
    if code.startswith("angle"):
        return "angle"
    if code.startswith("ep_"):
        return "energy"
    if code == "frequency":
        return "frequency"
    if code == "dido_status":
        return "digital"
    return "other"


def _read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig") as fh:
        return json.load(fh)


def _single_value(conn: sqlite3.Connection, sql: str) -> Any:
    row = conn.execute(sql).fetchone()
    if row is None:
        return None
    return row[0]


def _int_or_none(value: Any) -> int | None:
    if value in (None, ""):
        return None
    return int(value)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Initialize the lightweight SQLite database for software2.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH, help="SQLite database path.")
    parser.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA_PATH, help="Schema SQL path.")
    parser.add_argument("--point-table", type=Path, default=DEFAULT_POINT_TABLE_PATH, help="Software1 AMC point table JSON path.")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH, help="Software1 gateway config JSON path.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    init_database(args.db, args.schema, args.point_table, args.config)
    with connect(args.db) as conn:
        table_count = conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'").fetchone()[0]
        point_count = conn.execute("SELECT COUNT(*) FROM point_dictionary").fetchone()[0]
        mapping_count = conn.execute("SELECT COUNT(*) FROM point_mapping").fetchone()[0]
    print(f"initialized {args.db}")
    print(f"tables={table_count} point_dictionary={point_count} point_mapping={mapping_count}")


if __name__ == "__main__":
    main()
