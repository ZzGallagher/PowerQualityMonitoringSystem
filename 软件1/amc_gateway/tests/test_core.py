from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from amc_gateway.acquisition import sample_enabled_meters
from amc_gateway.config import load_config
from amc_gateway.core.decoder import PointValue, decode_points
from amc_gateway.core.modbus import append_crc, build_read_holding_registers_request, crc16_modbus, parse_read_holding_registers_response
from amc_gateway.core.point_table import load_point_table
from amc_gateway.core.processing import DataProcessor
from amc_gateway.gui import GuiRuntimeController
from amc_gateway.platform.sender import SendResult
from amc_gateway.platform.serial_rtu import SerialTimeoutError


ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "amc_gateway"
POINT_TABLE = ROOT / "AMC-E4KC点表-v1.json"
NEW_CONFIG = PROJECT / "meter_config.example.json"
LEGACY_CONFIG = PROJECT / "config.example.json"


class ModbusCoreTests(unittest.TestCase):
    def test_crc16_known_request(self) -> None:
        request_without_crc = bytes.fromhex("08 03 01 00 00 1C")
        self.assertEqual(crc16_modbus(request_without_crc), 0x6645)
        self.assertEqual(build_read_holding_registers_request(8, 0x0100, 28), bytes.fromhex("08 03 01 00 00 1C 45 66"))

    def test_parse_read_response(self) -> None:
        payload = bytes([8, 3, 4, 0x09, 0x12, 0x13, 0x86])
        response = append_crc(payload)
        self.assertEqual(parse_read_holding_registers_response(8, 2, response), [2322, 4998])


class DecoderTests(unittest.TestCase):
    def test_decode_modscan_sample_block(self) -> None:
        table = load_point_table(POINT_TABLE)
        secondary = [
            2322,
            0,
            0,
            2322,
            0,
            2322,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            256,
            256,
            0,
            2322,
            4998,
            2322,
            0,
        ]
        points = decode_points(
            table,
            {
                "secondary_electrical_measurements": secondary,
                "secondary_energy_import": [0, 1000],
                "voltage_angles": [0, 1200, 2400],
                "unbalance": [10, 20],
                "switch_status": [0x0100],
            },
            datetime(2026, 5, 21, 14, 30, tzinfo=timezone.utc),
        )
        by_code = {point.code: point for point in points}
        self.assertEqual(by_code["ua"].value, 232.2)
        self.assertEqual(by_code["frequency"].value, 49.98)
        self.assertEqual(by_code["ep_import"].value, 1)
        self.assertEqual(by_code["switch_status"].value, 1)
        self.assertEqual(by_code["switch_status"].raw_value, 0x0100)
        self.assertNotIn("dido_status", by_code)
        self.assertFalse(any(code.startswith("thd_") for code in by_code))

    def test_di1_switch_status_decodes_closed_and_open(self) -> None:
        table = load_point_table(POINT_TABLE)
        timestamp = datetime(2026, 5, 21, 14, 30, tzinfo=timezone.utc)

        closed = decode_points(table, {"switch_status": [0x0100]}, timestamp)
        open_ = decode_points(table, {"switch_status": [0x0000]}, timestamp)

        closed_by_code = {point.code: point for point in closed}
        open_by_code = {point.code: point for point in open_}
        self.assertEqual(closed_by_code["switch_status"].value, 1)
        self.assertEqual(closed_by_code["switch_status"].raw_value, 0x0100)
        self.assertEqual(open_by_code["switch_status"].value, 0)
        self.assertEqual(open_by_code["switch_status"].raw_value, 0x0000)

    def test_decode_single_phase_modscan_registers_keeps_unwired_phases_zero(self) -> None:
        table = load_point_table(POINT_TABLE)
        secondary = [
            2325,
            0,
            0,
            2325,
            0,
            2325,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            4096,
            2326,
            0,
            0,
            0,
            0,
            0,
        ]
        timestamp = datetime(2026, 5, 21, 14, 30, tzinfo=timezone.utc)
        decoded = decode_points(
            table,
            {
                "secondary_electrical_measurements": secondary,
                "secondary_energy_import": [0, 0],
                "voltage_angles": [0, 0, 0],
                "unbalance": [0, 0],
                "switch_status": [0],
            },
            timestamp,
        )
        by_code = {point.code: point for point in decoded}

        self.assertEqual(by_code["ua"].value, 232.5)
        self.assertEqual(by_code["ub"].value, 0)
        self.assertEqual(by_code["uc"].value, 0)

        processed = DataProcessor({}).process(decoded, timestamp)
        alarms_by_code = {alarm["code"]: alarm for alarm in processed.alarms}
        self.assertNotIn("ua", alarms_by_code)
        self.assertEqual(alarms_by_code["ub"]["state"], "active")
        self.assertEqual(alarms_by_code["uc"]["state"], "active")


class ConfigTests(unittest.TestCase):
    def test_new_meter_config_loads_com3_meter(self) -> None:
        config = load_config(NEW_CONFIG)
        self.assertEqual(config.buses[0].port, "COM3")
        self.assertEqual(config.buses[0].baud_rate, 9600)
        self.assertEqual(config.buses[0].parity, "N")
        self.assertEqual(config.meters[0].id, "amc-001")
        self.assertEqual(config.meters[0].slave_id, 8)

    def test_legacy_config_is_converted_to_single_meter(self) -> None:
        config = load_config(LEGACY_CONFIG)
        self.assertEqual(len(config.buses), 1)
        self.assertEqual(len(config.meters), 1)
        self.assertEqual(config.serial.port, config.buses[0].port)
        self.assertEqual(config.serial.slave_id, config.meters[0].slave_id)

    def test_mock_sampling_returns_points_with_units(self) -> None:
        config = load_config(NEW_CONFIG)
        samples = sample_enabled_meters(config, "mock")
        self.assertEqual(len(samples), 1)
        by_code = {point.code: point for point in samples[0].points}
        self.assertIn("ua", by_code)
        self.assertEqual(by_code["ua"].unit, "V")
        self.assertEqual(by_code["ua"].quality, "simulated")
        self.assertIn("switch_status", by_code)
        self.assertIn(by_code["switch_status"].value, {0, 1})
        self.assertFalse(any(code.startswith("thd_") for code in by_code))


class ProcessingTests(unittest.TestCase):
    def test_energy_delta_and_rate_are_derived_from_cumulative_energy(self) -> None:
        processor = DataProcessor({})
        first_time = datetime(2026, 5, 21, 14, 30, tzinfo=timezone.utc)
        second_time = datetime(2026, 5, 21, 14, 30, 10, tzinfo=timezone.utc)

        first = processor.process([_point("ep_import", 100, "kWh", first_time)], first_time)
        first_by_code = {point.code: point for point in first.points}
        self.assertEqual(first_by_code["ep_import_delta"].value, 0)
        self.assertEqual(first_by_code["ep_import_rate"].quality, "stale")

        second = processor.process([_point("ep_import", 100.01, "kWh", second_time)], second_time)
        second_by_code = {point.code: point for point in second.points}
        self.assertEqual(second_by_code["ep_import_delta"].value, 0.01)
        self.assertEqual(second_by_code["ep_import_rate"].value, 3.6)

    def test_alarm_active_and_cleared_events_are_deduplicated(self) -> None:
        processor = DataProcessor({"ua": {"min": 198, "max": 235.4}})
        timestamp = datetime(2026, 5, 21, 14, 30, tzinfo=timezone.utc)

        active = processor.process([_point("ua", 240, "V", timestamp)], timestamp)
        repeated = processor.process([_point("ua", 241, "V", timestamp)], timestamp)
        cleared = processor.process([_point("ua", 220, "V", timestamp)], timestamp)

        self.assertEqual(len(active.alarms), 1)
        self.assertEqual(active.alarms[0]["state"], "active")
        self.assertEqual(repeated.alarms, [])
        self.assertEqual(len(cleared.alarms), 1)
        self.assertEqual(cleared.alarms[0]["state"], "cleared")

    def test_single_phase_voltage_input_raises_missing_phase_voltage_alarms(self) -> None:
        processor = DataProcessor({})
        timestamp = datetime(2026, 5, 21, 14, 30, tzinfo=timezone.utc)

        result = processor.process(
            [
                _point("ua", 220, "V", timestamp),
                _point("ub", 0, "V", timestamp),
                _point("uc", 0, "V", timestamp),
            ],
            timestamp,
        )

        alarms_by_code = {alarm["code"]: alarm for alarm in result.alarms}
        self.assertNotIn("ua", alarms_by_code)
        self.assertEqual(alarms_by_code["ub"]["state"], "active")
        self.assertEqual(alarms_by_code["uc"]["state"], "active")

    def test_out_of_range_voltage_value_still_raises_threshold_alarm(self) -> None:
        processor = DataProcessor({})
        timestamp = datetime(2026, 5, 21, 14, 30, tzinfo=timezone.utc)

        result = processor.process(
            [
                PointValue(
                    code="ub",
                    name="B相电压",
                    value=6553.5,
                    raw_value=65535,
                    unit="V",
                    quality="out_of_range",
                    source="test",
                    timestamp=timestamp.isoformat(timespec="seconds"),
                )
            ],
            timestamp,
        )

        self.assertEqual(len(result.alarms), 1)
        self.assertEqual(result.alarms[0]["code"], "ub")
        self.assertEqual(result.alarms[0]["state"], "active")


class GuiRuntimeControllerTests(unittest.TestCase):
    def test_multi_meter_poll_sends_one_realtime_packet_per_meter(self) -> None:
        with TemporaryDirectory() as tmp:
            config = _two_meter_config(Path(tmp))
            controller = GuiRuntimeController(config, "serial")
            sender = _RecordingSender()
            controller.sender = sender  # type: ignore[assignment]
            controller._read_blocks = _read_blocks_from_mock_source  # type: ignore[method-assign]

            snapshot = controller.poll_once()

            self.assertEqual(snapshot.online_count, 2)
            self.assertEqual(snapshot.abnormal_count, 0)
            realtime_packets = [packet for packet in sender.packets if packet["packetType"] == "realtime"]
            self.assertEqual(len(realtime_packets), 2)
            self.assertEqual({packet["meter"]["id"] for packet in realtime_packets}, {"amc-001", "amc-002"})

    def test_failed_meter_is_counted_as_abnormal_without_breaking_other_meter(self) -> None:
        with TemporaryDirectory() as tmp:
            config = _two_meter_config(Path(tmp))
            controller = GuiRuntimeController(config, "serial")
            sender = _RecordingSender()
            controller.sender = sender  # type: ignore[assignment]

            def fake_read_blocks(runtime):
                if runtime.meter.id == "amc-002":
                    raise SerialTimeoutError("read timed out")
                return runtime.mock_source.read_all_blocks(), []

            controller._read_blocks = fake_read_blocks  # type: ignore[method-assign]
            snapshot = controller.poll_once()

            self.assertEqual(snapshot.online_count, 1)
            self.assertEqual(snapshot.abnormal_count, 1)
            by_meter = {update.meter.id: update for update in snapshot.meters}
            self.assertEqual(by_meter["amc-002"].status, "timeout")
            realtime_packets = [packet for packet in sender.packets if packet["packetType"] == "realtime"]
            self.assertEqual(len(realtime_packets), 1)
            self.assertEqual(realtime_packets[0]["meter"]["id"], "amc-001")

    def test_alarm_history_keeps_active_and_cleared_records(self) -> None:
        with TemporaryDirectory() as tmp:
            config = _two_meter_config(Path(tmp), thresholds={"ua": {"max": 100.0}})
            controller = GuiRuntimeController(config, "serial")
            sender = _RecordingSender()
            controller.sender = sender  # type: ignore[assignment]
            controller._read_blocks = _read_blocks_from_mock_source  # type: ignore[method-assign]

            first = controller.poll_once()
            repeated = controller.poll_once()
            controller.config.thresholds["ua"]["max"] = 300.0
            for runtime in controller.meter_runtimes:
                runtime.processor.thresholds["ua"]["max"] = 300.0
            cleared = controller.poll_once()

            self.assertEqual(len(first.alarms), 2)
            self.assertEqual(len(repeated.alarms), 2)
            self.assertEqual(len(cleared.alarms), 4)
            self.assertEqual(sum(1 for alarm in cleared.alarms if alarm["state"] == "active"), 2)
            self.assertEqual(sum(1 for alarm in cleared.alarms if alarm["state"] == "cleared"), 2)


def _point(code: str, value: float, unit: str, timestamp: datetime) -> PointValue:
    return PointValue(
        code=code,
        name=code,
        value=value,
        raw_value=None,
        unit=unit,
        quality="good",
        source="test",
        timestamp=timestamp.isoformat(timespec="seconds"),
    )


def _two_meter_config(tmp_path: Path, thresholds: dict[str, dict[str, float]] | None = None):
    base = load_config(NEW_CONFIG)
    first = base.meters[0]
    second = replace(first, id="amc-002", name="AMC智能电表2", slave_id=9)
    return replace(
        base,
        mode="serial",
        meters=(first, second),
        meter=first.as_packet_meter(),
        cache=replace(base.cache, sqlite_path=tmp_path / "cache.db"),
        thresholds=thresholds or {},
    )


def _read_blocks_from_mock_source(runtime):
    return runtime.mock_source.read_all_blocks(), []


class _RecordingSender:
    def __init__(self) -> None:
        self.packets: list[dict[str, object]] = []

    def send_packet(self, packet: dict[str, object], path: str | None = None) -> SendResult:
        self.packets.append(packet)
        return SendResult(True, status_code=200)


if __name__ == "__main__":
    unittest.main()
