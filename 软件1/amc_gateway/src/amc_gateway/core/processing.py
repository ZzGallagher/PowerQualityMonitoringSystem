from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Iterable

from . import quality
from .decoder import PointValue


DERIVED_SOURCE = "amc-gateway-processing"
GOOD_FOR_PROCESSING = {quality.GOOD, quality.SIMULATED}
GOOD_FOR_ALARM = {quality.GOOD, quality.SIMULATED, quality.OUT_OF_RANGE}

DEFAULT_THRESHOLDS: dict[str, dict[str, float | str]] = {
    "ua": {"min": 198.0, "max": 235.4, "severity": "critical", "basis": "GB/T 12325-2008 220V +7%/-10%"},
    "ub": {"min": 198.0, "max": 235.4, "severity": "critical", "basis": "GB/T 12325-2008 220V +7%/-10%"},
    "uc": {"min": 198.0, "max": 235.4, "severity": "critical", "basis": "GB/T 12325-2008 220V +7%/-10%"},
    "uab": {"min": 353.4, "max": 406.6, "severity": "critical", "basis": "GB/T 12325-2008 380V +/-7%"},
    "ubc": {"min": 353.4, "max": 406.6, "severity": "critical", "basis": "GB/T 12325-2008 380V +/-7%"},
    "uac": {"min": 353.4, "max": 406.6, "severity": "critical", "basis": "GB/T 12325-2008 380V +/-7%"},
    "frequency": {"min": 49.8, "max": 50.2, "severity": "critical", "basis": "GB/T 15945-2008 +/-0.2Hz"},
    "voltage_unbalance": {"max": 4.0, "severity": "critical", "basis": "GB/T 15543-2008 short-time maximum"},
    "current_unbalance": {"max": 30.0, "severity": "warning", "basis": "project operational threshold"},
    "ia": {"max": 5.5, "severity": "warning", "basis": "project secondary-side 5A CT demo threshold"},
    "ib": {"max": 5.5, "severity": "warning", "basis": "project secondary-side 5A CT demo threshold"},
    "ic": {"max": 5.5, "severity": "warning", "basis": "project secondary-side 5A CT demo threshold"},
    "i0": {"max": 0.5, "severity": "warning", "basis": "project residual-current demo threshold"},
    "pf_total": {"min": 0.9, "severity": "warning", "basis": "power factor assessment threshold"},
    "pfa": {"min": 0.9, "severity": "warning", "basis": "phase power factor operational threshold"},
    "pfb": {"min": 0.9, "severity": "warning", "basis": "phase power factor operational threshold"},
    "pfc": {"min": 0.9, "severity": "warning", "basis": "phase power factor operational threshold"},
}


@dataclass(frozen=True)
class ProcessingResult:
    points: list[PointValue]
    alarms: list[dict[str, object]]


@dataclass
class _EnergyState:
    value_kwh: float
    timestamp: datetime


class DataProcessor:
    def __init__(self, thresholds: dict[str, dict[str, float | str]] | None = None) -> None:
        self.thresholds = _merge_thresholds(thresholds or {})
        self.active_alarms: set[str] = set()
        self._energy_state: _EnergyState | None = None

    def process(self, points: Iterable[PointValue], timestamp: datetime) -> ProcessingResult:
        processed = self._derive_points(list(points), timestamp)
        alarms = self._evaluate_alarms(processed, timestamp)
        return ProcessingResult(points=processed, alarms=alarms)

    def _derive_points(self, points: list[PointValue], timestamp: datetime) -> list[PointValue]:
        point_map = {point.code: point for point in points}
        result = list(points)
        replacements: dict[str, PointValue] = {}

        self._derive_total(point_map, replacements, timestamp, "p_total", ("pa", "pb", "pc"), "总有功功率", "W")
        self._derive_total(point_map, replacements, timestamp, "q_total", ("qa", "qb", "qc"), "总无功功率", "var")
        self._derive_total(point_map, replacements, timestamp, "s_total", ("sa", "sb", "sc"), "总视在功率", "VA")
        self._derive_total_power_factor(point_map, replacements, timestamp)

        if replacements:
            result = [replacements.get(point.code, point) for point in result]
            point_map.update(replacements)

        result.extend(self._derive_energy_points(point_map, timestamp))
        return result

    def _derive_total(
        self,
        point_map: dict[str, PointValue],
        replacements: dict[str, PointValue],
        timestamp: datetime,
        total_code: str,
        phase_codes: tuple[str, str, str],
        name: str,
        unit: str,
    ) -> None:
        total = point_map.get(total_code)
        if _usable(total):
            return
        values = [_numeric_value(point_map.get(code)) for code in phase_codes]
        if any(value is None for value in values):
            return
        replacements[total_code] = _derived_point(total_code, name, sum(value for value in values if value is not None), unit, timestamp)

    def _derive_total_power_factor(
        self,
        point_map: dict[str, PointValue],
        replacements: dict[str, PointValue],
        timestamp: datetime,
    ) -> None:
        pf_total = point_map.get("pf_total")
        if _usable(pf_total):
            return
        p_total = _numeric_value(_processed_point(point_map, replacements, "p_total"))
        s_total = _numeric_value(_processed_point(point_map, replacements, "s_total"))
        if p_total is None or s_total in (None, 0):
            return
        replacements["pf_total"] = _derived_point("pf_total", "总功率因数", max(-1.0, min(1.0, p_total / s_total)), "", timestamp)

    def _derive_energy_points(self, point_map: dict[str, PointValue], timestamp: datetime) -> list[PointValue]:
        ep_import = point_map.get("ep_import")
        value = _numeric_value(ep_import)
        if value is None or ep_import is None or ep_import.quality not in GOOD_FOR_PROCESSING:
            return [
                _derived_point("ep_import_delta", "采样周期吸收有功电能增量", None, "kWh", timestamp, quality.STALE),
                _derived_point("ep_import_rate", "按电能增量折算平均有功功率", None, "kW", timestamp, quality.STALE),
            ]

        previous = self._energy_state
        self._energy_state = _EnergyState(value_kwh=value, timestamp=timestamp)
        if previous is None:
            return [
                _derived_point("ep_import_delta", "采样周期吸收有功电能增量", 0, "kWh", timestamp, ep_import.quality),
                _derived_point("ep_import_rate", "按电能增量折算平均有功功率", None, "kW", timestamp, quality.STALE),
            ]

        elapsed_seconds = (timestamp - previous.timestamp).total_seconds()
        if value < previous.value_kwh or elapsed_seconds <= 0:
            return [
                _derived_point("ep_import_delta", "采样周期吸收有功电能增量", None, "kWh", timestamp, quality.OUT_OF_RANGE),
                _derived_point("ep_import_rate", "按电能增量折算平均有功功率", None, "kW", timestamp, quality.OUT_OF_RANGE),
            ]

        delta = value - previous.value_kwh
        rate = delta * 3600 / elapsed_seconds
        return [
            _derived_point("ep_import_delta", "采样周期吸收有功电能增量", delta, "kWh", timestamp, ep_import.quality),
            _derived_point("ep_import_rate", "按电能增量折算平均有功功率", rate, "kW", timestamp, ep_import.quality),
        ]

    def _evaluate_alarms(self, points: Iterable[PointValue], timestamp: datetime) -> list[dict[str, object]]:
        alarms: list[dict[str, object]] = []
        point_map = {point.code: point for point in points}
        for code, rule in self.thresholds.items():
            point = point_map.get(code)
            if point is None or point.quality not in GOOD_FOR_ALARM:
                continue
            value = _numeric_value(point)
            if value is None:
                continue
            low = _float_or_none(rule.get("min"))
            high = _float_or_none(rule.get("max"))
            violated = (low is not None and value < low) or (high is not None and value > high)
            alarm_id = f"limit:{code}"
            if violated and alarm_id not in self.active_alarms:
                self.active_alarms.add(alarm_id)
                alarms.append(_alarm(alarm_id, "active", point, timestamp, rule))
            elif not violated and alarm_id in self.active_alarms:
                self.active_alarms.remove(alarm_id)
                alarms.append(_alarm(alarm_id, "cleared", point, timestamp, rule))
        return alarms


def _merge_thresholds(overrides: dict[str, dict[str, float | str]]) -> dict[str, dict[str, float | str]]:
    merged: dict[str, dict[str, float | str]] = {code: dict(rule) for code, rule in DEFAULT_THRESHOLDS.items()}
    for code, rule in overrides.items():
        merged[code] = merged.get(code, {}) | dict(rule)
    return merged


def _usable(point: PointValue | None) -> bool:
    return point is not None and point.quality in GOOD_FOR_PROCESSING and isinstance(point.value, (int, float))


def _numeric_value(point: PointValue | None) -> float | None:
    if point is None or not isinstance(point.value, (int, float)):
        return None
    return float(point.value)


def _processed_point(
    point_map: dict[str, PointValue],
    replacements: dict[str, PointValue],
    code: str,
) -> PointValue | None:
    point = point_map.get(code)
    if _usable(point):
        return point
    return replacements.get(code)


def _float_or_none(value: object) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _derived_point(
    code: str,
    name: str,
    value: float | int | None,
    unit: str,
    timestamp: datetime,
    point_quality: str = quality.GOOD,
) -> PointValue:
    return PointValue(
        code=code,
        name=name,
        value=_round_value(value),
        raw_value=None,
        unit=unit,
        quality=point_quality,
        source=DERIVED_SOURCE,
        timestamp=timestamp.isoformat(timespec="seconds"),
    )


def _round_value(value: float | int | None) -> float | int | None:
    if value is None:
        return None
    rounded = round(float(value), 6)
    if rounded == int(rounded):
        return int(rounded)
    return rounded


def _alarm(
    alarm_id: str,
    state: str,
    point: PointValue,
    timestamp: datetime,
    rule: dict[str, float | str],
) -> dict[str, object]:
    return {
        "id": alarm_id,
        "state": state,
        "code": point.code,
        "name": point.name,
        "value": point.value,
        "unit": point.unit,
        "min": _float_or_none(rule.get("min")),
        "max": _float_or_none(rule.get("max")),
        "severity": str(rule.get("severity", "warning")),
        "basis": str(rule.get("basis", "")),
        "timestamp": timestamp.isoformat(timespec="seconds"),
    }
