from __future__ import annotations

import time
from typing import Any

from amc_gateway.config import SerialConfig
from amc_gateway.core.modbus import build_read_holding_registers_request, parse_read_holding_registers_response


class SerialTimeoutError(TimeoutError):
    pass


class SerialRtuClient:
    def __init__(self, config: SerialConfig) -> None:
        self.config = config
        self._serial: Any | None = None

    def open(self) -> None:
        try:
            import serial
        except ImportError as exc:
            raise RuntimeError("真实串口采集需要安装 pyserial：python -m pip install pyserial") from exc

        timeout_seconds = self.config.timeout_ms / 1000.0
        self._serial = serial.Serial(
            port=self.config.port,
            baudrate=self.config.baud_rate,
            bytesize=self.config.data_bits,
            parity=_parity(self.config.parity),
            stopbits=self.config.stop_bits,
            timeout=timeout_seconds,
            write_timeout=timeout_seconds,
        )

    def close(self) -> None:
        if self._serial is not None and self._serial.is_open:
            self._serial.close()

    def read_holding_registers(self, start_address: int, quantity: int) -> list[int]:
        if self._serial is None or not self._serial.is_open:
            self.open()
        assert self._serial is not None

        request = build_read_holding_registers_request(self.config.slave_id, start_address, quantity)
        self._serial.reset_input_buffer()
        self._serial.write(request)
        self._serial.flush()

        header = self._read_exact(3)
        if header[1] & 0x80:
            rest = self._read_exact(2)
            return parse_read_holding_registers_response(self.config.slave_id, quantity, header + rest)
        byte_count = header[2]
        body_and_crc = self._read_exact(byte_count + 2)
        return parse_read_holding_registers_response(self.config.slave_id, quantity, header + body_and_crc)

    def _read_exact(self, count: int) -> bytes:
        assert self._serial is not None
        deadline = time.monotonic() + self.config.timeout_ms / 1000.0
        chunks = bytearray()
        while len(chunks) < count:
            chunk = self._serial.read(count - len(chunks))
            if chunk:
                chunks.extend(chunk)
                continue
            if time.monotonic() >= deadline:
                raise SerialTimeoutError(f"serial timeout while reading {count} bytes")
        return bytes(chunks)


def list_serial_ports() -> list[str]:
    try:
        from serial.tools import list_ports
    except ImportError as exc:
        raise RuntimeError("列出串口需要安装 pyserial：python -m pip install pyserial") from exc
    return [port.device for port in list_ports.comports()]


def _parity(value: str) -> str:
    upper = value.upper()
    if upper in {"E", "EVEN"}:
        return "E"
    if upper in {"O", "ODD"}:
        return "O"
    if upper in {"N", "NONE"}:
        return "N"
    raise ValueError(f"unsupported parity: {value}")

