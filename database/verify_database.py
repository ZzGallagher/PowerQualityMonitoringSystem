from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

try:
    from .init_database import DEFAULT_CONFIG_PATH, DEFAULT_DB_PATH, connect, init_database
    from .packet_ingest import ingest_packet
except ImportError:
    from init_database import DEFAULT_CONFIG_PATH, DEFAULT_DB_PATH, connect, init_database
    from packet_ingest import ingest_packet


ROOT_DIR = Path(__file__).resolve().parents[1]
SOFTWARE1_SRC = ROOT_DIR / "软件1" / "amc_gateway" / "src"


def verify(db_path: Path = DEFAULT_DB_PATH, config_path: Path = DEFAULT_CONFIG_PATH) -> dict[str, int]:
    sys.path.insert(0, str(SOFTWARE1_SRC))
    from amc_gateway.config import load_config
    from amc_gateway.core.decoder import decode_points
    from amc_gateway.core.packet import PacketFactory
    from amc_gateway.core.point_table import load_point_table
    from amc_gateway.core.processing import DataProcessor
    from amc_gateway.platform.mock_source import MockSource

    init_database(db_path, config_path=config_path)
    config = load_config(config_path)
    table = load_point_table(config.point_table_path)
    timestamp = datetime.now().astimezone()
    points = decode_points(table, MockSource(table).read_all_blocks(), timestamp, default_quality="simulated")
    processed = DataProcessor(config.thresholds).process(points, timestamp)
    packet_factory = PacketFactory(config.station, config.gateway, config.meter)
    realtime_packet = packet_factory.realtime(processed.points, timestamp)

    with connect(db_path) as conn:
        with conn:
            packet_id = ingest_packet(conn, realtime_packet)
            if processed.alarms:
                packet_time = datetime.fromisoformat(str(realtime_packet["timestamp"]))
                alarm_packet = packet_factory.alarm(processed.alarms, packet_time)
                ingest_packet(conn, alarm_packet)
        counts = {
            "packet_id": packet_id,
            "ingest_packet": _count(conn, "ingest_packet"),
            "realtime_value": _count(conn, "realtime_value"),
            "history_sample": _count(conn, "history_sample"),
            "statistic_record": _count(conn, "statistic_record"),
            "alarm": _count(conn, "alarm"),
            "event": _count(conn, "event"),
        }
    return counts


def _count(conn, table: str) -> int:
    return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify database schema with one software1 mock realtime packet.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH, help="SQLite database path.")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH, help="Software1 gateway config JSON path.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    counts = verify(args.db, args.config)
    for key, value in counts.items():
        print(f"{key}={value}")


if __name__ == "__main__":
    main()
