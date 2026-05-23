from __future__ import annotations

import math
import random
import time

from amc_gateway.core.point_table import PointTable


DEFAULT_LIMIT_INTERVAL_SECONDS = 120.0

_LIMIT_CODES = (
    "ua",
    "ub",
    "uc",
    "ia",
    "ib",
    "ic",
    "frequency",
    "pfa",
    "pfb",
    "pfc",
    "pf_total",
    "voltage_unbalance",
    "current_unbalance",
    "i0",
)


class MockSource:
    def __init__(
        self,
        table: PointTable,
        limit_interval_seconds: float = DEFAULT_LIMIT_INTERVAL_SECONDS,
        clock=time.monotonic,
        rng: random.Random | None = None,
    ) -> None:
        self.table = table
        self.limit_interval_seconds = limit_interval_seconds
        self._clock = clock
        self._rng = rng or random.Random()
        self._start = self._clock()
        self._last_limit_at = self._start
        self._energy_register = 123456

    def read_all_blocks(self) -> dict[str, list[int]]:
        now = self._clock()
        limit_code = self._limit_code(now)
        secondary = _secondary_registers(self._rng, limit_code)
        self._energy_register += self._rng.randint(1, 6)
        return {
            "switch_status": [self._rng.choice([0x0100, 0x0000])],
            "secondary_energy_import": _uint32_registers(self._energy_register),
            "voltage_angles": _voltage_angle_registers(self._rng),
            "secondary_electrical_measurements": secondary,
            "unbalance": _unbalance_registers(self._rng, limit_code),
        }

    def _limit_code(self, now: float) -> str | None:
        if self.limit_interval_seconds <= 0 or now - self._last_limit_at < self.limit_interval_seconds:
            return None
        self._last_limit_at = now
        return self._rng.choice(_LIMIT_CODES)


def _secondary_registers(rng: random.Random, limit_code: str | None) -> list[int]:
    ua = _tenths(_limited_value(rng, "ua", limit_code, 218.0, 233.0, 192.0, 197.0))
    ub = _tenths(_limited_value(rng, "ub", limit_code, 218.0, 233.0, 192.0, 197.0))
    uc = _tenths(_limited_value(rng, "uc", limit_code, 218.0, 233.0, 192.0, 197.0))
    ia = _thousandths(_limited_value(rng, "ia", limit_code, 0.8, 4.8, 5.8, 7.2))
    ib = _thousandths(_limited_value(rng, "ib", limit_code, 0.8, 4.8, 5.8, 7.2))
    ic = _thousandths(_limited_value(rng, "ic", limit_code, 0.8, 4.8, 5.8, 7.2))
    pa = _signed_thousandths(rng.uniform(0.55, 1.45))
    pb = _signed_thousandths(rng.uniform(0.55, 1.45))
    pc = _signed_thousandths(rng.uniform(0.55, 1.45))
    p_total = pa + pb + pc
    qa = _signed_thousandths(rng.uniform(0.05, 0.18))
    qb = _signed_thousandths(rng.uniform(0.05, 0.18))
    qc = _signed_thousandths(rng.uniform(0.05, 0.18))
    q_total = qa + qb + qc
    pfa = _thousandths(_limited_value(rng, "pfa", limit_code, 0.94, 0.995, 0.72, 0.88))
    pfb = _thousandths(_limited_value(rng, "pfb", limit_code, 0.94, 0.995, 0.72, 0.88))
    pfc = _thousandths(_limited_value(rng, "pfc", limit_code, 0.94, 0.995, 0.72, 0.88))
    pf_total = _thousandths(_limited_value(rng, "pf_total", limit_code, 0.94, 0.995, 0.72, 0.88))
    sa = _thousandths(rng.uniform(0.6, 1.55))
    sb = _thousandths(rng.uniform(0.6, 1.55))
    sc = _thousandths(rng.uniform(0.6, 1.55))
    s_total = sa + sb + sc
    frequency = _hundredths(_limited_value(rng, "frequency", limit_code, 49.9, 50.1, 50.32, 50.65))
    u0 = _tenths(rng.uniform(0.0, 1.5))
    i0 = _thousandths(_limited_value(rng, "i0", limit_code, 0.0, 0.18, 0.6, 1.2))
    return [
        ua,
        ub,
        uc,
        int(round((ua + ub) / 2 * math.sqrt(3))),
        int(round((ub + uc) / 2 * math.sqrt(3))),
        int(round((ua + uc) / 2 * math.sqrt(3))),
        ia,
        ib,
        ic,
        pa,
        pb,
        pc,
        p_total,
        qa,
        qb,
        qc,
        q_total,
        pfa,
        pfb,
        pfc,
        pf_total,
        sa,
        sb,
        sc,
        s_total,
        frequency,
        u0,
        i0,
    ]


def _voltage_angle_registers(rng: random.Random) -> list[int]:
    return [
        _tenths(rng.uniform(358.0, 359.9)),
        _tenths(rng.uniform(118.0, 122.0)),
        _tenths(rng.uniform(238.0, 242.0)),
    ]


def _unbalance_registers(rng: random.Random, limit_code: str | None) -> list[int]:
    voltage = _limited_value(rng, "voltage_unbalance", limit_code, 0.3, 2.4, 4.8, 7.5)
    current = _limited_value(rng, "current_unbalance", limit_code, 5.0, 22.0, 32.0, 48.0)
    return [_tenths(voltage), _tenths(current)]


def _limited_value(
    rng: random.Random,
    code: str,
    limit_code: str | None,
    normal_low: float,
    normal_high: float,
    limit_low: float,
    limit_high: float,
) -> float:
    low, high = (limit_low, limit_high) if code == limit_code else (normal_low, normal_high)
    return rng.uniform(low, high)


def _tenths(value: float) -> int:
    return int(round(value * 10))


def _hundredths(value: float) -> int:
    return int(round(value * 100))


def _thousandths(value: float) -> int:
    return int(round(value * 1000))


def _signed_thousandths(value: float) -> int:
    raw = _thousandths(value)
    if raw < 0:
        return 0x10000 + raw
    return raw


def _uint32_registers(value: int) -> list[int]:
    return [(value >> 16) & 0xFFFF, value & 0xFFFF]
