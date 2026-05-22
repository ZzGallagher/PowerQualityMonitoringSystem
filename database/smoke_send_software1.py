from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
SOFTWARE1_SRC = ROOT_DIR / "软件1" / "amc_gateway" / "src"
DEFAULT_CONFIG_PATH = ROOT_DIR / "软件1" / "amc_gateway" / "meter_config.example.json"


def send_once(config_path: Path = DEFAULT_CONFIG_PATH, mode: str = "mock") -> None:
    sys.path.insert(0, str(SOFTWARE1_SRC))
    from amc_gateway.config import load_config
    from amc_gateway.core.decoder import decode_points
    from amc_gateway.core.packet import PacketFactory
    from amc_gateway.core.point_table import load_point_table
    from amc_gateway.core.processing import DataProcessor
    from amc_gateway.platform.mock_source import MockSource
    from amc_gateway.platform.sender import HttpPacketSender

    if mode != "mock":
        raise ValueError("smoke_send_software1.py only generates software1 mock packets; use software1 runtime for serial mode.")

    config = load_config(config_path)
    table = load_point_table(config.point_table_path)
    timestamp = datetime.now().astimezone()
    blocks = MockSource(table).read_all_blocks()
    points = decode_points(table, blocks, timestamp, default_quality="simulated")
    processed = DataProcessor(config.thresholds).process(points, timestamp)
    packet_factory = PacketFactory(config.station, config.gateway, config.meter)
    sender = HttpPacketSender(config.receiver)

    realtime_result = sender.send_packet(packet_factory.realtime(processed.points, timestamp))
    print(f"realtime ok={realtime_result.ok} status={realtime_result.status_code} error={realtime_result.error}")
    if not realtime_result.ok:
        raise SystemExit(1)

    if processed.alarms:
        alarm_result = sender.send_packet(packet_factory.alarm(processed.alarms, timestamp))
        print(f"alarm ok={alarm_result.ok} status={alarm_result.status_code} error={alarm_result.error}")
        if not alarm_result.ok:
            raise SystemExit(1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a software1 packet and send it to the configured ingest server.")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH, help="Software1 gateway config JSON path.")
    parser.add_argument("--mode", default="mock", choices=["mock"], help="Packet data source.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    send_once(args.config, args.mode)


if __name__ == "__main__":
    main()
