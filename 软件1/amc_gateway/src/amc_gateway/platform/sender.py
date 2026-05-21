from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass

from amc_gateway.config import ReceiverConfig


@dataclass(frozen=True)
class SendResult:
    ok: bool
    status_code: int | None = None
    error: str = ""


class HttpPacketSender:
    def __init__(self, config: ReceiverConfig) -> None:
        self.config = config

    def send_packet(self, packet: dict[str, object], path: str | None = None) -> SendResult:
        if not self.config.base_url:
            return SendResult(False, error="receiver baseUrl is empty")

        target_path = path or self.config.ingest_path
        url = self.config.base_url.rstrip("/") + "/" + target_path.lstrip("/")
        body = json.dumps(packet, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.config.token:
            headers["Authorization"] = f"Bearer {self.config.token}"
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")

        try:
            with urllib.request.urlopen(request, timeout=self.config.timeout_seconds) as response:
                status = int(response.status)
                return SendResult(200 <= status < 300, status_code=status)
        except urllib.error.HTTPError as exc:
            return SendResult(False, status_code=exc.code, error=str(exc))
        except OSError as exc:
            return SendResult(False, error=str(exc))

