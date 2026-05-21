from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from .config import AppConfig, BusConfig, MeterConfig, serial_for_bus_meter
from .core import quality
from .core.decoder import PointValue, decode_points
from .core.modbus import ModbusCrcError, ModbusError, ModbusParseError
from .core.packet import PacketFactory
from .core.point_table import PointTable, load_point_table
from .core.processing import DataProcessor
from .platform.mock_source import MockSource
from .platform.serial_rtu import SerialRtuClient, SerialTimeoutError


@dataclass(frozen=True)
class MeterSample:
    meter: MeterConfig
    bus: BusConfig
    timestamp: datetime
    status: str
    points: list[PointValue]
    error: str = ""

    @property
    def ok(self) -> bool:
        return self.status in {quality.GOOD, quality.SIMULATED}


def sample_enabled_meters(config: AppConfig, mode: str | None = None) -> list[MeterSample]:
    mode = (mode or config.mode).lower()
    samples: list[MeterSample] = []
    for meter in config.enabled_meters:
        samples.append(sample_meter(config, meter, mode))
    return samples


def sample_meter(config: AppConfig, meter: MeterConfig, mode: str | None = None) -> MeterSample:
    mode = (mode or config.mode).lower()
    bus = config.bus_for_meter(meter)
    table = load_point_table(meter.point_table_path or config.point_table_path)
    timestamp = datetime.now().astimezone()

    if mode == "mock":
        source = MockSource(table)
        blocks = source.read_all_blocks()
        points = decode_points(table, blocks, timestamp, default_quality=quality.SIMULATED)
        return MeterSample(meter=meter, bus=bus, timestamp=timestamp, status=quality.SIMULATED, points=points)

    try:
        blocks, errors = _read_serial_blocks(table, bus, meter)
        points = decode_points(table, blocks, timestamp, default_quality=quality.GOOD)
        if errors:
            status = errors[0][1]
            error_text = "; ".join(f"{block_id}: {message}" for block_id, _, message in errors)
            return MeterSample(meter=meter, bus=bus, timestamp=timestamp, status=status, points=points, error=error_text)
        return MeterSample(meter=meter, bus=bus, timestamp=timestamp, status=quality.GOOD, points=points)
    except Exception as exc:
        return MeterSample(
            meter=meter,
            bus=bus,
            timestamp=timestamp,
            status=_status_from_exception(exc),
            points=[],
            error=str(exc),
        )


def packet_from_sample(config: AppConfig, sample: MeterSample) -> dict[str, object]:
    factory = PacketFactory(config.station, config.gateway, sample.meter.as_packet_meter())
    processed = DataProcessor(config.thresholds).process(sample.points, sample.timestamp)
    return factory.realtime(processed.points, sample.timestamp)


def _read_serial_blocks(table: PointTable, bus: BusConfig, meter: MeterConfig) -> tuple[dict[str, list[int]], list[tuple[str, str, str]]]:
    client = SerialRtuClient(serial_for_bus_meter(bus, meter))
    try:
        blocks: dict[str, list[int]] = {}
        errors: list[tuple[str, str, str]] = []
        for block in table.enabled_read_blocks:
            try:
                blocks[block.id] = client.read_holding_registers(block.start_address, block.quantity)
            except Exception as exc:
                errors.append((block.id, _status_from_exception(exc), str(exc)))
        return blocks, errors
    finally:
        client.close()


def _status_from_exception(exc: Exception) -> str:
    if isinstance(exc, SerialTimeoutError):
        return quality.TIMEOUT
    if isinstance(exc, ModbusCrcError):
        return quality.CRC_ERROR
    if isinstance(exc, (ModbusParseError, ModbusError)):
        return quality.PARSE_ERROR
    return "offline"
