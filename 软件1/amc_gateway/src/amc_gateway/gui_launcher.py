from __future__ import annotations

import argparse
import sys
from pathlib import Path

from amc_gateway.config import load_config
from amc_gateway.gui import run_gui


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AMC gateway GUI launcher")
    parser.add_argument("--config", help="configuration file path")
    parser.add_argument("--port", help="override first bus serial port")
    parser.add_argument("--slave-id", type=int, help="override first meter Modbus slave id")
    args = parser.parse_args(argv)

    from amc_gateway.cli import _apply_overrides

    config = load_config(args.config or _default_config_path())
    config = _apply_overrides(config, args)
    run_gui(config)
    return 0


def _default_config_path() -> Path:
    base_dir = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path.cwd()
    for name in ("meter_config.json", "meter_config.example.json", "config.example.json"):
        candidate = base_dir / name
        if candidate.exists():
            return candidate
    raise SystemExit(f"configuration file not found in {base_dir}")


if __name__ == "__main__":
    raise SystemExit(main())
