from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from . import quality
from .point_table import PointDefinition, PointTable


@dataclass(frozen=True)
class PointValue:
    code: str
    name: str
    value: float | int | None
    raw_value: int | None
    unit: str
    quality: str
    source: str
    timestamp: str

    def as_dict(self) -> dict[str, object]:
        return {
            "code": self.code,
            "name": self.name,
            "value": self.value,
            "rawValue": self.raw_value,
            "unit": self.unit,
            "quality": self.quality,
            "source": self.source,
            "timestamp": self.timestamp,
        }


def decode_points(
    table: PointTable,
    block_registers: dict[str, list[int]],
    timestamp: datetime,
    default_quality: str = quality.GOOD,
) -> list[PointValue]:
    register_map = _build_register_map(table, block_registers)
    timestamp_text = timestamp.isoformat(timespec="seconds")
    decoded: dict[str, PointValue] = {}
    point_order = list(table.packet_point_order)
    point_order.extend(code for code in table.points.keys() if code not in decoded and code not in point_order)

    for code in point_order:
        point = table.points.get(code)
        if point is None:
            continue
        if not point.enabled:
            decoded[code] = _unsupported_point(point, timestamp_text)
            continue
        try:
            raw_value = _decode_raw(point, register_map)
            value = raw_value * point.scale
            point_quality = _range_quality(point, value, default_quality)
            decoded[code] = PointValue(
                code=point.code,
                name=point.name,
                value=_round_value(value),
                raw_value=raw_value,
                unit=point.unit,
                quality=point_quality,
                source=point.source,
                timestamp=timestamp_text,
            )
        except KeyError:
            decoded[code] = _bad_point(point, timestamp_text, quality.TIMEOUT)
        except (ValueError, IndexError):
            decoded[code] = _bad_point(point, timestamp_text, quality.PARSE_ERROR)

    return [decoded[code] for code in point_order if code in decoded]


def decode_register_value(point: PointDefinition, registers: list[int]) -> int:
    if point.data_type == "uint16":
        return registers[0]
    if point.data_type == "int16":
        value = registers[0]
        return value - 0x10000 if value & 0x8000 else value
    if point.data_type == "uint32_be":
        return (registers[0] << 16) | registers[1]
    raise ValueError(f"unsupported data type: {point.data_type}")


def _build_register_map(table: PointTable, block_registers: dict[str, list[int]]) -> dict[int, int]:
    register_map: dict[int, int] = {}
    for block in table.read_blocks:
        registers = block_registers.get(block.id)
        if registers is None:
            continue
        for offset, register in enumerate(registers):
            register_map[block.start_address + offset] = int(register) & 0xFFFF
    return register_map


def _decode_raw(point: PointDefinition, register_map: dict[int, int]) -> int:
    registers = [register_map[point.address + offset] for offset in range(point.length)]
    return decode_register_value(point, registers)


def _unsupported_point(point: PointDefinition, timestamp_text: str) -> PointValue:
    return PointValue(
        code=point.code,
        name=point.name,
        value=None,
        raw_value=None,
        unit=point.unit,
        quality=point.default_quality or quality.UNSUPPORTED,
        source=point.source,
        timestamp=timestamp_text,
    )


def _bad_point(point: PointDefinition, timestamp_text: str, point_quality: str) -> PointValue:
    return PointValue(
        code=point.code,
        name=point.name,
        value=None,
        raw_value=None,
        unit=point.unit,
        quality=point_quality,
        source=point.source,
        timestamp=timestamp_text,
    )


def _range_quality(point: PointDefinition, value: float, default_quality: str) -> str:
    bounds = _reasonable_bounds(point.code)
    if bounds is None:
        return default_quality
    low, high = bounds
    if value < low or value > high:
        return quality.OUT_OF_RANGE
    return default_quality


def _reasonable_bounds(code: str) -> tuple[float, float] | None:
    if code in {"ua", "ub", "uc", "uab", "ubc", "uac", "u0"}:
        return (0, 1000)
    if code in {"ia", "ib", "ic", "i0"}:
        return (0, 10000)
    if code == "frequency":
        return (45, 65)
    if code in {"pfa", "pfb", "pfc", "pf_total"}:
        return (-1, 1)
    if code in {"voltage_unbalance", "current_unbalance", "thd_ua", "thd_ub", "thd_uc", "thd_ia", "thd_ib", "thd_ic"}:
        return (0, 100)
    if code in {"angle_ua", "angle_ub", "angle_uc"}:
        return (0, 360)
    if code == "ep_import":
        return (0, 1_000_000_000)
    return None


def _round_value(value: float) -> float | int:
    rounded = round(value, 6)
    if rounded == int(rounded):
        return int(rounded)
    return rounded
