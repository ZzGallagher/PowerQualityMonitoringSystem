from __future__ import annotations


class ModbusError(Exception):
    """Modbus协议错误基类。"""


class ModbusCrcError(ModbusError):
    """CRC校验错误。"""


class ModbusParseError(ModbusError):
    """响应报文结构错误。"""


class ModbusExceptionResponse(ModbusError):
    def __init__(self, function_code: int, exception_code: int) -> None:
        super().__init__(f"Modbus exception response: function=0x{function_code:02X}, exception=0x{exception_code:02X}")
        self.function_code = function_code
        self.exception_code = exception_code


def crc16_modbus(payload: bytes) -> int:
    crc = 0xFFFF
    for byte in payload:
        crc ^= byte
        for _ in range(8):
            if crc & 0x0001:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
            crc &= 0xFFFF
    return crc


def append_crc(payload: bytes) -> bytes:
    crc = crc16_modbus(payload)
    return payload + bytes((crc & 0xFF, (crc >> 8) & 0xFF))


def build_read_holding_registers_request(slave_id: int, start_address: int, quantity: int) -> bytes:
    if not 1 <= slave_id <= 247:
        raise ValueError("slave_id must be in 1..247")
    if not 1 <= quantity <= 125:
        raise ValueError("quantity must be in 1..125")
    payload = bytes(
        (
            slave_id,
            0x03,
            (start_address >> 8) & 0xFF,
            start_address & 0xFF,
            (quantity >> 8) & 0xFF,
            quantity & 0xFF,
        )
    )
    return append_crc(payload)


def parse_read_holding_registers_response(slave_id: int, quantity: int, response: bytes) -> list[int]:
    if len(response) < 5:
        raise ModbusParseError("response too short")

    expected_crc = crc16_modbus(response[:-2])
    actual_crc = response[-2] | (response[-1] << 8)
    if actual_crc != expected_crc:
        raise ModbusCrcError(f"CRC mismatch: expected 0x{expected_crc:04X}, got 0x{actual_crc:04X}")

    if response[0] != slave_id:
        raise ModbusParseError(f"slave mismatch: expected {slave_id}, got {response[0]}")

    function_code = response[1]
    if function_code & 0x80:
        if len(response) != 5:
            raise ModbusParseError("invalid exception response length")
        raise ModbusExceptionResponse(function_code, response[2])
    if function_code != 0x03:
        raise ModbusParseError(f"function mismatch: expected 0x03, got 0x{function_code:02X}")

    byte_count = response[2]
    if byte_count != quantity * 2:
        raise ModbusParseError(f"byte count mismatch: expected {quantity * 2}, got {byte_count}")
    if len(response) != 3 + byte_count + 2:
        raise ModbusParseError("response length does not match byte count")

    registers: list[int] = []
    body = response[3 : 3 + byte_count]
    for i in range(0, len(body), 2):
        registers.append((body[i] << 8) | body[i + 1])
    return registers

