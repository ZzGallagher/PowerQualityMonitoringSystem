from __future__ import annotations

from datetime import datetime
from typing import Iterable

from .decoder import PointValue


class PacketFactory:
    def __init__(self, station: dict[str, str], gateway: dict[str, str], meter: dict[str, str]) -> None:
        self.station = station
        self.gateway = gateway
        self.meter = meter
        self._sequence = 0

    def realtime(self, points: Iterable[PointValue], timestamp: datetime) -> dict[str, object]:
        return self._base_packet("realtime", timestamp) | {"points": [point.as_dict() for point in points]}

    def statistics(self, stats: list[dict[str, object]], timestamp: datetime) -> dict[str, object]:
        return self._base_packet("statistics", timestamp) | {"statistics": stats}

    def alarm(self, alarms: list[dict[str, object]], timestamp: datetime) -> dict[str, object]:
        return self._base_packet("alarm", timestamp) | {"alarms": alarms}

    def event(self, events: list[dict[str, object]], timestamp: datetime) -> dict[str, object]:
        return self._base_packet("event", timestamp) | {"events": events}

    def heartbeat(self, timestamp: datetime, status: dict[str, object]) -> dict[str, object]:
        return self._base_packet("heartbeat", timestamp) | {"status": status}

    def comm_status(self, timestamp: datetime, status: str, detail: str) -> dict[str, object]:
        return self._base_packet("comm_status", timestamp) | {"communication": {"status": status, "detail": detail}}

    def _base_packet(self, packet_type: str, timestamp: datetime) -> dict[str, object]:
        self._sequence += 1
        return {
            "protocolVersion": "1.0",
            "packetType": packet_type,
            "sequence": self._sequence,
            "timestamp": timestamp.isoformat(timespec="seconds"),
            "station": self.station,
            "gateway": self.gateway,
            "meter": self.meter,
        }

