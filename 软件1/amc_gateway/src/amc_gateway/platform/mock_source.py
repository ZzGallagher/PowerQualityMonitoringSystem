from __future__ import annotations

import math
import time

from amc_gateway.core.point_table import PointTable


class MockSource:
    def __init__(self, table: PointTable) -> None:
        self.table = table
        self._start = time.monotonic()

    def read_all_blocks(self) -> dict[str, list[int]]:
        phase = time.monotonic() - self._start
        secondary = _secondary_registers(phase)
        return {
            "switch_status": [0x0100 if int(phase) % 10 < 5 else 0x0000],
            "secondary_energy_import": [0x0000, 123456 + int(phase)],
            "voltage_angles": [0, 1200, 2400],
            "secondary_electrical_measurements": secondary,
            "unbalance": [12, 18],
        }


def _secondary_registers(phase: float) -> list[int]:
    ua = int(round(2322 + math.sin(phase / 4) * 8))
    ub = int(round(2319 + math.sin(phase / 5 + 2) * 8))
    uc = int(round(2324 + math.sin(phase / 6 + 4) * 8))
    ia = int(round(1240 + math.sin(phase / 3) * 50))
    ib = int(round(1210 + math.sin(phase / 3 + 2) * 50))
    ic = int(round(1190 + math.sin(phase / 3 + 4) * 50))
    pa = 820
    pb = 790
    pc = 760
    p_total = pa + pb + pc
    qa = 90
    qb = 80
    qc = 85
    q_total = qa + qb + qc
    pfa = 986
    pfb = 982
    pfc = 979
    pf_total = 982
    sa = 835
    sb = 804
    sc = 776
    s_total = sa + sb + sc
    frequency = int(round(4998 + math.sin(phase / 10) * 3))
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
        0,
        0,
    ]
