from __future__ import annotations

from pathlib import Path

from amc_gateway.core.point_table import load_point_table


def generate_c_point_table(point_table_path: str | Path) -> str:
    table = load_point_table(point_table_path)
    lines = [
        "/* Auto-generated draft from AMC-E4KC point table. */",
        "#include <stdint.h>",
        "",
        "typedef enum {",
        "    AMC_UINT16,",
        "    AMC_INT16,",
        "    AMC_UINT32_BE,",
        "    AMC_DI1_STATUS",
        "} amc_data_type_t;",
        "",
        "typedef struct {",
        "    const char *code;",
        "    uint16_t address;",
        "    uint8_t length;",
        "    amc_data_type_t type;",
        "    float scale;",
        "    const char *unit;",
        "    uint8_t enabled;",
        "} amc_point_def_t;",
        "",
        "static const amc_point_def_t AMC_POINTS[] = {",
    ]
    point_order = list(table.packet_point_order)
    point_order.extend(code for code in table.points.keys() if code not in point_order)
    for code in point_order:
        point = table.points.get(code)
        if point is None:
            continue
        data_type = {
            "uint16": "AMC_UINT16",
            "int16": "AMC_INT16",
            "uint32_be": "AMC_UINT32_BE",
            "di1_status": "AMC_DI1_STATUS",
        }.get(point.data_type, "AMC_UINT16")
        enabled = 1 if point.enabled else 0
        lines.append(
            f'    {{"{point.code}", 0x{point.address:04X}, {point.length}, {data_type}, {_c_float(point.scale)}, "{point.unit}", {enabled}}},'
        )
    lines.extend(["};", ""])
    return "\n".join(lines)


def _c_float(value: float) -> str:
    text = f"{value:g}"
    if "." not in text and "e" not in text.lower():
        text += ".0"
    return f"{text}f"
