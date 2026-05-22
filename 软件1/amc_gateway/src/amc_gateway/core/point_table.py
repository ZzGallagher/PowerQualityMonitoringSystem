from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PREFERRED_POINT_NAMES: dict[str, str] = {
    "ua": "A相电压",
    "ub": "B相电压",
    "uc": "C相电压",
    "uab": "AB线电压",
    "ubc": "BC线电压",
    "uac": "AC线电压",
    "ia": "A相电流",
    "ib": "B相电流",
    "ic": "C相电流",
    "pa": "A相有功功率",
    "pb": "B相有功功率",
    "pc": "C相有功功率",
    "p_total": "总有功功率",
    "qa": "A相无功功率",
    "qb": "B相无功功率",
    "qc": "C相无功功率",
    "q_total": "总无功功率",
    "pfa": "A相功率因数",
    "pfb": "B相功率因数",
    "pfc": "C相功率因数",
    "pf_total": "总功率因数",
    "sa": "A相视在功率",
    "sb": "B相视在功率",
    "sc": "C相视在功率",
    "s_total": "总视在功率",
    "frequency": "频率",
    "ep_import": "吸收有功电能",
    "u0": "零序电压",
    "i0": "零序电流",
    "angle_ua": "电压UA相角",
    "angle_ub": "电压UB相角",
    "angle_uc": "电压UC相角",
    "voltage_unbalance": "电压不平衡度",
    "current_unbalance": "电流不平衡度",
    "switch_status": "DI1开关量状态",
}


@dataclass(frozen=True)
class ReadBlock:
    id: str
    start_address: int
    quantity: int
    enabled: bool
    point_codes: tuple[str, ...]
    default_quality: str | None = None


@dataclass(frozen=True)
class PointDefinition:
    code: str
    name: str
    address: int
    length: int
    data_type: str
    scale: float
    unit: str
    enabled: bool
    default_quality: str | None = None
    source: str = "amc-e4kc-secondary"


@dataclass(frozen=True)
class PointTable:
    schema_version: str
    read_blocks: tuple[ReadBlock, ...]
    points: dict[str, PointDefinition]
    packet_point_order: tuple[str, ...]

    @property
    def enabled_read_blocks(self) -> tuple[ReadBlock, ...]:
        return tuple(block for block in self.read_blocks if block.enabled)


def load_point_table(path: str | Path) -> PointTable:
    table_path = Path(path)
    with table_path.open("r", encoding="utf-8-sig") as fh:
        data: dict[str, Any] = json.load(fh)

    blocks = tuple(
        ReadBlock(
            id=str(block["id"]),
            start_address=_parse_hex(block["startAddressHex"]),
            quantity=int(block["quantity"]),
            enabled=bool(block.get("enabledInV1", False)),
            point_codes=tuple(str(code) for code in block.get("points", [])),
            default_quality=block.get("defaultQuality"),
        )
        for block in data.get("readBlocks", [])
    )

    points: dict[str, PointDefinition] = {}
    for raw in data.get("points", []):
        code = str(raw["code"])
        points[code] = PointDefinition(
            code=code,
            name=PREFERRED_POINT_NAMES.get(code, str(raw.get("name", code))),
            address=_parse_hex(raw["addressHex"]),
            length=int(raw.get("length", 1)),
            data_type=str(raw.get("dataType", "uint16")),
            scale=float(raw.get("scale", 1)),
            unit=str(raw.get("unit", "")),
            enabled=bool(raw.get("enabledInV1", False)),
            default_quality=raw.get("defaultQuality"),
        )

    packet_order = tuple(str(code) for code in data.get("packetPointOrder", points.keys()))
    return PointTable(str(data.get("schemaVersion", "1.0")), blocks, points, packet_order)


def _parse_hex(value: str | int) -> int:
    if isinstance(value, int):
        return value
    text = str(value).strip().upper().replace("H", "")
    return int(text, 16)
