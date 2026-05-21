from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable

from .config import AppConfig
from .core import quality
from .core.decoder import PointValue, decode_points
from .core.modbus import ModbusCrcError, ModbusError, ModbusParseError
from .core.packet import PacketFactory
from .core.point_table import PointTable, load_point_table
from .core.processing import DataProcessor
from .platform.cache import PacketCache
from .platform.mock_source import MockSource
from .platform.sender import HttpPacketSender
from .platform.serial_rtu import SerialRtuClient, SerialTimeoutError


@dataclass
class StatsWindow:
    values: dict[str, list[float]] = field(default_factory=dict)
    start_monotonic: float = field(default_factory=time.monotonic)

    def add(self, points: Iterable[PointValue]) -> None:
        for point in points:
            if point.quality not in {quality.GOOD, quality.SIMULATED}:
                continue
            if isinstance(point.value, (int, float)):
                self.values.setdefault(point.code, []).append(float(point.value))

    def due(self, window_seconds: float) -> bool:
        return time.monotonic() - self.start_monotonic >= window_seconds

    def flush(self) -> list[dict[str, object]]:
        stats: list[dict[str, object]] = []
        for code, values in sorted(self.values.items()):
            if not values:
                continue
            stats.append(
                {
                    "code": code,
                    "min": round(min(values), 6),
                    "max": round(max(values), 6),
                    "avg": round(sum(values) / len(values), 6),
                    "count": len(values),
                    "quality": quality.GOOD,
                }
            )
        self.values.clear()
        self.start_monotonic = time.monotonic()
        return stats


class GatewayService:
    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.table = load_point_table(config.point_table_path)
        self.cache = PacketCache(config.cache.sqlite_path, config.cache.max_packets)
        self.sender = HttpPacketSender(config.receiver)
        self.packet_factory = PacketFactory(config.station, config.gateway, config.meter)
        self.stats = StatsWindow()
        self.processor = DataProcessor(config.thresholds)
        self._online = True

    def read_once(self, mode: str | None = None) -> tuple[list[PointValue], dict[str, object], list[dict[str, object]]]:
        mode = (mode or self.config.mode).lower()
        timestamp = datetime.now().astimezone()
        if mode == "mock":
            source = MockSource(self.table)
            blocks = source.read_all_blocks()
            points = self._process_points(decode_points(self.table, blocks, timestamp, default_quality=quality.SIMULATED), timestamp)
            return points.points, self.packet_factory.realtime(points.points, timestamp), points.alarms

        blocks = self._read_serial_blocks(self.table)
        points = self._process_points(decode_points(self.table, blocks, timestamp, default_quality=quality.GOOD), timestamp)
        return points.points, self.packet_factory.realtime(points.points, timestamp), points.alarms

    def run_forever(self, mode: str | None = None) -> None:
        logging.info("AMC gateway started, mode=%s", mode or self.config.mode)
        while True:
            started = time.monotonic()
            try:
                points, realtime_packet, alarms = self.read_once(mode)
                now = datetime.now().astimezone()
                self._handle_comm_recovery(now)
                self.stats.add(points)
                self._send_or_cache(realtime_packet)
                if alarms:
                    self._send_or_cache(self.packet_factory.alarm(alarms, now))
                if self.stats.due(self.config.collection.statistics_window_seconds):
                    stats = self.stats.flush()
                    if stats:
                        self._send_or_cache(self.packet_factory.statistics(stats, now))
                self._drain_cache()
                logging.info("sample ok: points=%s cache=%s", len(points), self.cache.count())
            except KeyboardInterrupt:
                logging.info("AMC gateway stopped by user")
                raise
            except Exception as exc:
                now = datetime.now().astimezone()
                self._handle_comm_failure(now, exc)
                logging.exception("sample failed: %s", exc)
            elapsed = time.monotonic() - started
            time.sleep(max(0.1, self.config.collection.poll_interval_seconds - elapsed))

    def _read_serial_blocks(self, table: PointTable) -> dict[str, list[int]]:
        client = SerialRtuClient(self.config.serial)
        try:
            blocks: dict[str, list[int]] = {}
            for block in table.enabled_read_blocks:
                blocks[block.id] = client.read_holding_registers(block.start_address, block.quantity)
            return blocks
        finally:
            client.close()

    def _process_points(self, points: list[PointValue], timestamp: datetime):
        return self.processor.process(points, timestamp)

    def _send_or_cache(self, packet: dict[str, object]) -> None:
        result = self.sender.send_packet(packet)
        if result.ok:
            return
        self.cache.enqueue(packet)
        logging.warning("packet cached: type=%s error=%s", packet.get("packetType"), result.error)

    def _drain_cache(self) -> None:
        for packet_id, packet in self.cache.peek(limit=20):
            result = self.sender.send_packet(packet)
            if result.ok:
                self.cache.delete(packet_id)
            else:
                self.cache.mark_failed(packet_id, result.error)
                break

    def _handle_comm_failure(self, timestamp: datetime, exc: Exception) -> None:
        if isinstance(exc, SerialTimeoutError):
            status = quality.TIMEOUT
        elif isinstance(exc, ModbusCrcError):
            status = quality.CRC_ERROR
        elif isinstance(exc, (ModbusParseError, ModbusError)):
            status = quality.PARSE_ERROR
        else:
            status = "offline"
        if self._online:
            self._online = False
            packet = self.packet_factory.comm_status(timestamp, status, str(exc))
            self.cache.enqueue(packet)

    def _handle_comm_recovery(self, timestamp: datetime) -> None:
        if not self._online:
            self._online = True
            packet = self.packet_factory.comm_status(timestamp, "online", "communication recovered")
            self._send_or_cache(packet)


def packet_to_json(packet: dict[str, object]) -> str:
    return json.dumps(packet, ensure_ascii=False, indent=2)


