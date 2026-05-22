from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any

try:
    from .init_database import DEFAULT_DB_PATH, connect, init_database
except ImportError:
    from init_database import DEFAULT_DB_PATH, connect, init_database


SUPPORTED_PACKET_TYPES = {"realtime", "statistics", "alarm", "event", "heartbeat", "comm_status"}


def ingest_packet(conn: sqlite3.Connection, packet: dict[str, Any]) -> int:
    packet_type = str(packet.get("packetType") or "")
    if packet_type not in SUPPORTED_PACKET_TYPES:
        raise ValueError(f"unsupported packetType: {packet_type}")

    base = _packet_base(packet)
    _upsert_packet_entities(conn, packet)
    packet_id = _insert_ingest_packet(conn, packet, base)

    if packet_type == "realtime":
        _ingest_realtime(conn, packet_id, packet, base)
    elif packet_type == "statistics":
        _ingest_statistics(conn, packet_id, packet, base)
    elif packet_type == "alarm":
        _ingest_alarms(conn, packet_id, packet, base)
    elif packet_type == "event":
        _ingest_events(conn, packet_id, packet, base)
    elif packet_type == "heartbeat":
        _ingest_heartbeat(conn, packet_id, packet, base)
    elif packet_type == "comm_status":
        _ingest_comm_status(conn, packet_id, packet, base)

    _update_interface_status(conn, base, "online", None)
    return packet_id


def ingest_packet_file(db_path: Path, packet_path: Path) -> int:
    init_database(db_path)
    with connect(db_path) as conn:
        packet = json.loads(packet_path.read_text(encoding="utf-8-sig"))
        with conn:
            return ingest_packet(conn, packet)


def _packet_base(packet: dict[str, Any]) -> dict[str, Any]:
    station = _dict(packet.get("station"))
    gateway = _dict(packet.get("gateway"))
    meter = _dict(packet.get("meter"))
    timestamp = str(packet.get("timestamp") or "")
    if not timestamp:
        raise ValueError("packet.timestamp is required")
    return {
        "protocol_version": str(packet.get("protocolVersion") or "1.0"),
        "packet_type": str(packet.get("packetType") or ""),
        "sequence": _int_or_none(packet.get("sequence")),
        "packet_timestamp": timestamp,
        "station_id": str(station.get("id") or "substation-001"),
        "station_name": str(station.get("name") or "演示变电站"),
        "gateway_id": str(gateway.get("id") or "gateway-001"),
        "gateway_name": str(gateway.get("name") or "笔记本网关"),
        "meter_id": str(meter.get("id") or "amc-001"),
        "meter_name": str(meter.get("name") or "AMC智能电力仪表"),
        "meter_model": str(meter.get("model") or "AMC(II)-E4KC"),
    }


def _insert_ingest_packet(conn: sqlite3.Connection, packet: dict[str, Any], base: dict[str, Any]) -> int:
    raw_json = json.dumps(packet, ensure_ascii=False, separators=(",", ":"))
    conn.execute(
        """
        INSERT INTO ingest_packet (
            protocol_version, packet_type, station_id, station_name,
            gateway_id, gateway_name, meter_id, meter_name, meter_model,
            sequence, packet_timestamp, parse_status, raw_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(gateway_id, meter_id, packet_type, sequence, packet_timestamp) DO UPDATE SET
            received_at = CURRENT_TIMESTAMP,
            parse_status = 'duplicate',
            raw_json = excluded.raw_json
        """,
        (
            base["protocol_version"],
            base["packet_type"],
            base["station_id"],
            base["station_name"],
            base["gateway_id"],
            base["gateway_name"],
            base["meter_id"],
            base["meter_name"],
            base["meter_model"],
            base["sequence"],
            base["packet_timestamp"],
            "ok",
            raw_json,
        ),
    )
    row = conn.execute(
        """
        SELECT id
        FROM ingest_packet
        WHERE gateway_id = ?
          AND meter_id = ?
          AND packet_type = ?
          AND sequence IS ?
          AND packet_timestamp = ?
        """,
        (
            base["gateway_id"],
            base["meter_id"],
            base["packet_type"],
            base["sequence"],
            base["packet_timestamp"],
        ),
    ).fetchone()
    if row is None:
        raise RuntimeError("failed to read inserted ingest_packet id")
    return int(row["id"])


def _upsert_packet_entities(conn: sqlite3.Connection, packet: dict[str, Any]) -> None:
    base = _packet_base(packet)
    conn.execute(
        """
        INSERT INTO station (id, name)
        VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            updated_at = CURRENT_TIMESTAMP
        """,
        (base["station_id"], base["station_name"]),
    )
    conn.execute(
        """
        INSERT INTO gateway (id, station_id, name, protocol_version, last_seen_at, status)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            station_id = excluded.station_id,
            name = excluded.name,
            protocol_version = excluded.protocol_version,
            last_seen_at = excluded.last_seen_at,
            status = excluded.status
        """,
        (
            base["gateway_id"],
            base["station_id"],
            base["gateway_name"],
            base["protocol_version"],
            base["packet_timestamp"],
            "online",
        ),
    )
    conn.execute(
        """
        INSERT INTO meter (id, station_id, gateway_id, name, model, status, last_sample_at, last_sequence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            station_id = excluded.station_id,
            gateway_id = excluded.gateway_id,
            name = excluded.name,
            model = excluded.model,
            status = excluded.status,
            last_sample_at = excluded.last_sample_at,
            last_sequence = excluded.last_sequence
        """,
        (
            base["meter_id"],
            base["station_id"],
            base["gateway_id"],
            base["meter_name"],
            base["meter_model"],
            "online",
            base["packet_timestamp"],
            base["sequence"],
        ),
    )


def _ingest_realtime(conn: sqlite3.Connection, packet_id: int, packet: dict[str, Any], base: dict[str, Any]) -> None:
    for raw_point in _list(packet.get("points")):
        point = _dict(raw_point)
        code = str(point.get("code") or "")
        if not code:
            continue
        _ensure_point(conn, code, point)
        mapping_id = _ensure_mapping(conn, base, code, str(point.get("name") or code))
        sample_time = str(point.get("timestamp") or base["packet_timestamp"])
        values = (
            mapping_id,
            base["station_id"],
            base["meter_id"],
            code,
            str(point.get("name") or code),
            _float_or_none(point.get("value")),
            _int_or_none(point.get("rawValue")),
            str(point.get("unit") or ""),
            str(point.get("quality") or "good"),
            sample_time,
            str(point.get("source") or ""),
            packet_id,
        )
        conn.execute(
            """
            INSERT INTO history_sample (
                mapping_id, station_id, meter_id, point_code, name, value, raw_value,
                unit, quality, sample_time, source, packet_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            values,
        )
        conn.execute(
            """
            INSERT INTO realtime_value (
                mapping_id, station_id, meter_id, point_code, name, value, raw_value,
                unit, quality, sample_time, source, packet_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(mapping_id) DO UPDATE SET
                name = excluded.name,
                value = excluded.value,
                raw_value = excluded.raw_value,
                unit = excluded.unit,
                quality = excluded.quality,
                sample_time = excluded.sample_time,
                received_at = CURRENT_TIMESTAMP,
                source = excluded.source,
                packet_id = excluded.packet_id
            """,
            values,
        )
        if code == "ep_import" and point.get("value") is not None:
            conn.execute(
                """
                INSERT INTO meter_reading_record (
                    station_id, meter_id, reading_time, ep_import, unit, quality, source
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    base["station_id"],
                    base["meter_id"],
                    sample_time,
                    _float_or_none(point.get("value")),
                    str(point.get("unit") or "kWh"),
                    str(point.get("quality") or "good"),
                    str(point.get("source") or "packet"),
                ),
            )


def _ingest_statistics(conn: sqlite3.Connection, packet_id: int, packet: dict[str, Any], base: dict[str, Any]) -> None:
    for raw_stat in _list(packet.get("statistics")):
        stat = _dict(raw_stat)
        code = str(stat.get("code") or "")
        if not code:
            continue
        _ensure_point(conn, code, {"code": code, "name": code})
        mapping_id = _ensure_mapping(conn, base, code, code)
        conn.execute(
            """
            INSERT INTO statistic_record (
                mapping_id, station_id, meter_id, point_code, statistic_time,
                min_value, max_value, avg_value, sample_count, quality, packet_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                mapping_id,
                base["station_id"],
                base["meter_id"],
                code,
                base["packet_timestamp"],
                _float_or_none(stat.get("min")),
                _float_or_none(stat.get("max")),
                _float_or_none(stat.get("avg")),
                _int_or_none(stat.get("count")) or 0,
                str(stat.get("quality") or "good"),
                packet_id,
            ),
        )


def _ingest_alarms(conn: sqlite3.Connection, packet_id: int, packet: dict[str, Any], base: dict[str, Any]) -> None:
    for raw_alarm in _list(packet.get("alarms")):
        alarm = _dict(raw_alarm)
        state = str(alarm.get("state") or "active")
        code = str(alarm.get("code") or "")
        external_id = str(alarm.get("id") or f"limit:{code}")
        alarm_time = str(alarm.get("timestamp") or base["packet_timestamp"])
        if state == "cleared":
            updated = conn.execute(
                """
                UPDATE alarm
                SET status = 'recovered',
                    recovered_at = ?,
                    packet_id = ?
                WHERE external_id = ?
                  AND meter_id = ?
                  AND status = 'active'
                """,
                (alarm_time, packet_id, external_id, base["meter_id"]),
            ).rowcount
            if updated:
                _insert_event(conn, packet_id, base, "alarm_cleared", "info", f"告警恢复: {code}", alarm_time, alarm)
                continue

        conn.execute(
            """
            INSERT INTO alarm (
                external_id, station_id, meter_id, point_code, alarm_type, level,
                title, description, trigger_value, trigger_unit, min_value, max_value,
                basis, status, started_at, packet_id, raw_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                external_id,
                base["station_id"],
                base["meter_id"],
                code or None,
                external_id.split(":", 1)[0],
                str(alarm.get("severity") or "warning"),
                str(alarm.get("name") or code or external_id),
                str(alarm.get("basis") or ""),
                _float_or_none(alarm.get("value")),
                str(alarm.get("unit") or ""),
                _float_or_none(alarm.get("min")),
                _float_or_none(alarm.get("max")),
                str(alarm.get("basis") or ""),
                "active" if state != "cleared" else "recovered",
                alarm_time,
                packet_id,
                json.dumps(alarm, ensure_ascii=False, separators=(",", ":")),
            ),
        )
        _insert_event(conn, packet_id, base, "alarm", str(alarm.get("severity") or "warning"), f"告警: {code}", alarm_time, alarm)


def _ingest_events(conn: sqlite3.Connection, packet_id: int, packet: dict[str, Any], base: dict[str, Any]) -> None:
    for raw_event in _list(packet.get("events")):
        event = _dict(raw_event)
        _insert_event(
            conn,
            packet_id,
            base,
            str(event.get("type") or event.get("eventType") or "event"),
            str(event.get("level") or "info"),
            str(event.get("title") or event.get("name") or "事件"),
            str(event.get("timestamp") or event.get("time") or base["packet_timestamp"]),
            event,
            str(event.get("description") or event.get("detail") or ""),
            str(event.get("id") or ""),
        )


def _ingest_heartbeat(conn: sqlite3.Connection, packet_id: int, packet: dict[str, Any], base: dict[str, Any]) -> None:
    status = _dict(packet.get("status"))
    _update_interface_status(conn, base, str(status.get("status") or "online"), json.dumps(status, ensure_ascii=False))
    _insert_event(conn, packet_id, base, "heartbeat", "info", "网关心跳", base["packet_timestamp"], status)


def _ingest_comm_status(conn: sqlite3.Connection, packet_id: int, packet: dict[str, Any], base: dict[str, Any]) -> None:
    communication = _dict(packet.get("communication"))
    status = str(communication.get("status") or "unknown")
    detail = str(communication.get("detail") or "")
    _update_interface_status(conn, base, status, detail)
    level = "info" if status == "online" else "warning"
    title = "通信恢复" if status == "online" else "通信异常"
    _insert_event(conn, packet_id, base, "comm_status", level, title, base["packet_timestamp"], communication, detail)
    if status != "online":
        conn.execute(
            """
            INSERT INTO alarm (
                external_id, station_id, meter_id, alarm_type, level, title,
                description, status, started_at, packet_id, raw_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                f"comm:{base['meter_id']}",
                base["station_id"],
                base["meter_id"],
                "communication",
                "warning",
                "通信异常",
                detail,
                "active",
                base["packet_timestamp"],
                packet_id,
                json.dumps(communication, ensure_ascii=False, separators=(",", ":")),
            ),
        )
    else:
        conn.execute(
            """
            UPDATE alarm
            SET status = 'recovered',
                recovered_at = ?,
                packet_id = ?
            WHERE external_id = ?
              AND status = 'active'
            """,
            (base["packet_timestamp"], packet_id, f"comm:{base['meter_id']}"),
        )


def _insert_event(
    conn: sqlite3.Connection,
    packet_id: int,
    base: dict[str, Any],
    event_type: str,
    level: str,
    title: str,
    event_time: str,
    raw: dict[str, Any],
    description: str = "",
    external_id: str = "",
) -> None:
    conn.execute(
        """
        INSERT INTO event (
            external_id, station_id, meter_id, event_type, level, title,
            description, event_time, packet_id, raw_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            external_id or None,
            base["station_id"],
            base["meter_id"],
            event_type,
            level,
            title,
            description,
            event_time,
            packet_id,
            json.dumps(raw, ensure_ascii=False, separators=(",", ":")),
        ),
    )


def _update_interface_status(
    conn: sqlite3.Connection,
    base: dict[str, Any],
    status: str,
    detail: str | None,
) -> None:
    interface_id = f"{base['gateway_id']}:{base['meter_id']}"
    is_error = status not in {"online", "ok", "good"}
    conn.execute(
        """
        INSERT INTO interface_status (
            id, station_id, gateway_id, meter_id, status, detail, last_packet_type,
            last_sequence, last_packet_at, last_received_at, error_count, last_error
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            detail = excluded.detail,
            last_packet_type = excluded.last_packet_type,
            last_sequence = excluded.last_sequence,
            last_packet_at = excluded.last_packet_at,
            last_received_at = excluded.last_received_at,
            error_count = CASE WHEN ? THEN interface_status.error_count + 1 ELSE 0 END,
            last_error = excluded.last_error,
            updated_at = CURRENT_TIMESTAMP
        """,
        (
            interface_id,
            base["station_id"],
            base["gateway_id"],
            base["meter_id"],
            status,
            detail,
            base["packet_type"],
            base["sequence"],
            base["packet_timestamp"],
            1 if is_error else 0,
            detail if is_error else None,
            1 if is_error else 0,
        ),
    )


def _ensure_point(conn: sqlite3.Connection, code: str, point: dict[str, Any]) -> None:
    conn.execute(
        """
        INSERT INTO point_dictionary (code, name, unit, value_type, source, enabled)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
            name = COALESCE(NULLIF(excluded.name, ''), point_dictionary.name),
            unit = COALESCE(NULLIF(excluded.unit, ''), point_dictionary.unit),
            source = COALESCE(NULLIF(excluded.source, ''), point_dictionary.source)
        """,
        (
            code,
            str(point.get("name") or code),
            str(point.get("unit") or ""),
            "number",
            str(point.get("source") or ""),
            1,
        ),
    )


def _ensure_mapping(conn: sqlite3.Connection, base: dict[str, Any], code: str, display_name: str) -> str:
    row = conn.execute(
        "SELECT id FROM point_mapping WHERE meter_id = ? AND point_code = ?",
        (base["meter_id"], code),
    ).fetchone()
    if row is not None:
        return str(row["id"])
    mapping_id = f"{base['meter_id']}:{code}"
    conn.execute(
        """
        INSERT INTO point_mapping (id, station_id, meter_id, point_code, display_name, is_primary)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(meter_id, point_code) DO NOTHING
        """,
        (mapping_id, base["station_id"], base["meter_id"], code, display_name, 1),
    )
    return mapping_id


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _float_or_none(value: Any) -> float | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return float(str(value))


def _int_or_none(value: Any) -> int | None:
    if value in (None, ""):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return int(str(value))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest one software1 JSON packet into the lightweight database.")
    parser.add_argument("packet", type=Path, help="Packet JSON file.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH, help="SQLite database path.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    packet_id = ingest_packet_file(args.db, args.packet)
    print(f"ingested packet id={packet_id}")


if __name__ == "__main__":
    main()
