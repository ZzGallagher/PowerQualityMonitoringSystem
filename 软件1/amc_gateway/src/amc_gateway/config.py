from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SerialConfig:
    port: str
    slave_id: int
    baud_rate: int
    parity: str
    data_bits: int
    stop_bits: int
    timeout_ms: int


@dataclass(frozen=True)
class BusConfig:
    id: str
    type: str
    port: str
    baud_rate: int
    parity: str
    data_bits: int
    stop_bits: int
    timeout_ms: int


@dataclass(frozen=True)
class MeterConfig:
    id: str
    name: str
    model: str
    enabled: bool
    bus_id: str
    slave_id: int
    point_table_path: Path | None = None

    def as_packet_meter(self) -> dict[str, str]:
        return {"id": self.id, "name": self.name, "model": self.model}


@dataclass(frozen=True)
class ReceiverConfig:
    base_url: str
    ingest_path: str
    health_path: str
    test_path: str
    token: str
    timeout_seconds: float
    retry_attempts: int


@dataclass(frozen=True)
class CacheConfig:
    sqlite_path: Path
    max_packets: int


@dataclass(frozen=True)
class CollectionConfig:
    poll_interval_seconds: float
    upload_interval_seconds: float
    statistics_window_seconds: float


@dataclass(frozen=True)
class AppConfig:
    source_path: Path
    root_dir: Path
    point_table_path: Path
    mode: str
    station: dict[str, str]
    gateway: dict[str, str]
    meter: dict[str, str]
    serial: SerialConfig
    buses: tuple[BusConfig, ...]
    meters: tuple[MeterConfig, ...]
    receiver: ReceiverConfig
    cache: CacheConfig
    collection: CollectionConfig
    thresholds: dict[str, dict[str, float | str]]
    log_file: Path
    log_level: str

    @property
    def enabled_meters(self) -> tuple[MeterConfig, ...]:
        return tuple(meter for meter in self.meters if meter.enabled)

    @property
    def primary_meter(self) -> MeterConfig:
        meters = self.enabled_meters
        if not meters:
            raise ValueError("no enabled meter in config")
        return meters[0]

    def bus_for_meter(self, meter: MeterConfig) -> BusConfig:
        for bus in self.buses:
            if bus.id == meter.bus_id:
                return bus
        raise ValueError(f"meter {meter.id} references unknown bus {meter.bus_id}")


def load_config(path: str | Path) -> AppConfig:
    config_path = Path(path).resolve()
    root_dir = config_path.parent
    with config_path.open("r", encoding="utf-8-sig") as fh:
        data: dict[str, Any] = json.load(fh)

    serial_data = data.get("serial", {})
    serial = SerialConfig(
        port=str(serial_data.get("port", "COM3")),
        slave_id=int(serial_data.get("slaveId", 8)),
        baud_rate=int(serial_data.get("baudRate", 9600)),
        parity=str(serial_data.get("parity", "E")),
        data_bits=int(serial_data.get("dataBits", 8)),
        stop_bits=int(serial_data.get("stopBits", 1)),
        timeout_ms=int(serial_data.get("timeoutMs", 1200)),
    )
    point_table_path = _resolve_path(root_dir, data.get("pointTablePath", "../AMC-E4KC点表-v1.json"))
    buses = _load_buses(data, serial)
    meters = _load_meters(data, root_dir, point_table_path, serial)

    receiver = data.get("receiver", {})
    cache = data.get("cache", {})
    collection = data.get("collection", {})
    logging_config = data.get("logging", {})

    return AppConfig(
        source_path=config_path,
        root_dir=root_dir,
        point_table_path=point_table_path,
        mode=str(data.get("mode", "mock")),
        station=dict(data.get("station", {})),
        gateway=dict(data.get("gateway", {})),
        meter=meters[0].as_packet_meter() if meters else dict(data.get("meter", {})),
        serial=serial_for_bus_meter(buses[0], meters[0]) if buses and meters else serial,
        buses=buses,
        meters=meters,
        receiver=ReceiverConfig(
            base_url=str(receiver.get("baseUrl", "")),
            ingest_path=str(receiver.get("ingestPath", "/api/ingest/packets")),
            health_path=str(receiver.get("healthPath", "/api/ingest/health")),
            test_path=str(receiver.get("testPath", "/api/ingest/test")),
            token=str(receiver.get("token", "")),
            timeout_seconds=float(receiver.get("timeoutSeconds", 3)),
            retry_attempts=int(receiver.get("retryAttempts", 2)),
        ),
        cache=CacheConfig(
            sqlite_path=_resolve_path(root_dir, cache.get("sqlitePath", "runtime/cache.db")),
            max_packets=int(cache.get("maxPackets", 5000)),
        ),
        collection=CollectionConfig(
            poll_interval_seconds=float(collection.get("pollIntervalSeconds", 2)),
            upload_interval_seconds=float(collection.get("uploadIntervalSeconds", 3)),
            statistics_window_seconds=float(collection.get("statisticsWindowSeconds", 3)),
        ),
        thresholds={k: dict(v) for k, v in data.get("thresholds", {}).items()},
        log_file=_resolve_path(root_dir, logging_config.get("file", "runtime/gateway.log")),
        log_level=str(logging_config.get("level", "INFO")),
    )


def serial_for_bus_meter(bus: BusConfig, meter: MeterConfig) -> SerialConfig:
    return SerialConfig(
        port=bus.port,
        slave_id=meter.slave_id,
        baud_rate=bus.baud_rate,
        parity=bus.parity,
        data_bits=bus.data_bits,
        stop_bits=bus.stop_bits,
        timeout_ms=bus.timeout_ms,
    )


def _load_buses(data: dict[str, Any], serial: SerialConfig) -> tuple[BusConfig, ...]:
    raw_buses = data.get("buses")
    if raw_buses:
        return tuple(
            BusConfig(
                id=str(bus.get("id", f"rs485-{index + 1}")),
                type=str(bus.get("type", "modbus_rtu")),
                port=str(bus.get("port", serial.port)),
                baud_rate=int(bus.get("baudRate", serial.baud_rate)),
                parity=str(bus.get("parity", serial.parity)),
                data_bits=int(bus.get("dataBits", serial.data_bits)),
                stop_bits=int(bus.get("stopBits", serial.stop_bits)),
                timeout_ms=int(bus.get("timeoutMs", serial.timeout_ms)),
            )
            for index, bus in enumerate(raw_buses)
        )
    return (
        BusConfig(
            id="rs485-1",
            type="modbus_rtu",
            port=serial.port,
            baud_rate=serial.baud_rate,
            parity=serial.parity,
            data_bits=serial.data_bits,
            stop_bits=serial.stop_bits,
            timeout_ms=serial.timeout_ms,
        ),
    )


def _load_meters(
    data: dict[str, Any],
    root_dir: Path,
    default_point_table_path: Path,
    serial: SerialConfig,
) -> tuple[MeterConfig, ...]:
    raw_meters = data.get("meters")
    if raw_meters:
        meters: list[MeterConfig] = []
        for index, meter in enumerate(raw_meters):
            point_table_value = meter.get("pointTablePath")
            meters.append(
                MeterConfig(
                    id=str(meter.get("id", f"amc-{index + 1:03d}")),
                    name=str(meter.get("name", f"AMC meter {index + 1}")),
                    model=str(meter.get("model", "AMC(II)-E4KC")),
                    enabled=bool(meter.get("enabled", True)),
                    bus_id=str(meter.get("busId", "rs485-1")),
                    slave_id=int(meter.get("slaveId", serial.slave_id)),
                    point_table_path=_resolve_path(root_dir, point_table_value) if point_table_value else default_point_table_path,
                )
            )
        return tuple(meters)

    legacy_meter = data.get("meter", {})
    return (
        MeterConfig(
            id=str(legacy_meter.get("id", "amc-001")),
            name=str(legacy_meter.get("name", "AMC intelligent meter")),
            model=str(legacy_meter.get("model", "AMC(II)-E4KC")),
            enabled=True,
            bus_id="rs485-1",
            slave_id=serial.slave_id,
            point_table_path=default_point_table_path,
        ),
    )


def _resolve_path(root_dir: Path, value: str | Path) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return (root_dir / path).resolve()
