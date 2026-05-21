from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import replace
from pathlib import Path

from .acquisition import packet_from_sample, sample_enabled_meters
from .config import AppConfig, load_config, serial_for_bus_meter
from .service import GatewayService, packet_to_json


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AMC acquisition gateway")
    parser.add_argument("--config", default="config.example.json", help="config file path")
    subparsers = parser.add_subparsers(dest="command", required=True)

    read_once = subparsers.add_parser("read-once", help="read once and print realtime JSON packet")
    _add_config_arg(read_once)
    _add_runtime_overrides(read_once)

    run = subparsers.add_parser("run", help="run acquisition, packaging, cache and upload loop")
    _add_config_arg(run)
    _add_runtime_overrides(run)

    gui = subparsers.add_parser("gui", help="open industrial gateway main window")
    _add_config_arg(gui)
    _add_serial_overrides(gui)

    list_ports = subparsers.add_parser("list-ports", help="list local serial ports")
    _add_config_arg(list_ports)

    make_test = subparsers.add_parser("make-test-packet", help="create and print mock test packet")
    _add_config_arg(make_test)
    make_test.add_argument("--send", action="store_true", help="send to receiver.testPath")

    generate_c = subparsers.add_parser("generate-c", help="generate C point table draft")
    _add_config_arg(generate_c)
    generate_c.add_argument("--output", default="", help="output file; print to console when empty")

    args = parser.parse_args(argv)
    config = _apply_overrides(load_config(args.config), args)
    _setup_logging(config)

    if args.command == "list-ports":
        from .platform.serial_rtu import list_serial_ports

        for port in list_serial_ports():
            print(port)
        return 0

    if args.command == "read-once":
        samples = sample_enabled_meters(config, args.mode)
        if not samples:
            raise SystemExit("no enabled meter in config")
        packet = packet_from_sample(config, samples[0])
        print(packet_to_json(packet))
        return 0

    if args.command == "gui":
        from .gui import run_gui

        run_gui(config)
        return 0

    service = GatewayService(config)

    if args.command == "run":
        service.run_forever(args.mode)
        return 0

    if args.command == "make-test-packet":
        _, packet, _ = service.read_once("mock")
        if args.send:
            result = service.sender.send_packet(packet, config.receiver.test_path)
            print(f"send ok={result.ok} status={result.status_code} error={result.error}")
        else:
            print(packet_to_json(packet))
        return 0

    if args.command == "generate-c":
        from .tools.generate_c_point_table import generate_c_point_table

        text = generate_c_point_table(config.point_table_path)
        if args.output:
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(text, encoding="utf-8")
        else:
            print(text)
        return 0

    return 1


def _add_runtime_overrides(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--mode", choices=["mock", "serial"], help="override runtime mode")
    _add_serial_overrides(parser)


def _add_serial_overrides(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--port", help="override first bus serial port, for example COM3")
    parser.add_argument("--slave-id", type=int, help="override first meter Modbus slave id")


def _add_config_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config", default=argparse.SUPPRESS, help="config file path")


def _apply_overrides(config: AppConfig, args: argparse.Namespace) -> AppConfig:
    if not any(getattr(args, name, None) for name in ("mode", "port", "slave_id")):
        return config

    buses = config.buses
    meters = config.meters
    if buses and getattr(args, "port", None):
        buses = (replace(buses[0], port=args.port),) + buses[1:]
    if meters and getattr(args, "slave_id", None):
        meters = (replace(meters[0], slave_id=args.slave_id),) + meters[1:]

    serial = serial_for_bus_meter(buses[0], meters[0]) if buses and meters else config.serial
    meter = meters[0].as_packet_meter() if meters else config.meter
    return AppConfig(
        source_path=config.source_path,
        root_dir=config.root_dir,
        point_table_path=config.point_table_path,
        mode=args.mode or config.mode,
        station=config.station,
        gateway=config.gateway,
        meter=meter,
        serial=serial,
        buses=buses,
        meters=meters,
        receiver=config.receiver,
        cache=config.cache,
        collection=config.collection,
        thresholds=config.thresholds,
        log_file=config.log_file,
        log_level=config.log_level,
    )


def _setup_logging(config: AppConfig) -> None:
    config.log_file.parent.mkdir(parents=True, exist_ok=True)
    level = getattr(logging, config.log_level.upper(), logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            logging.FileHandler(config.log_file, encoding="utf-8"),
            logging.StreamHandler(sys.stderr),
        ],
    )


if __name__ == "__main__":
    raise SystemExit(main())
