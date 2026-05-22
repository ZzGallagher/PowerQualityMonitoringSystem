from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

try:
    from .init_database import connect, init_database
    from .packet_ingest import ingest_packet
except ImportError:
    from init_database import connect, init_database
    from packet_ingest import ingest_packet


DATABASE_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = DATABASE_DIR / "server_config.json"


@dataclass(frozen=True)
class ServerConfig:
    host: str
    port: int
    database_path: Path
    token: str
    max_body_bytes: int


class IngestServer(ThreadingHTTPServer):
    config: ServerConfig


class IngestRequestHandler(BaseHTTPRequestHandler):
    server: IngestServer

    def do_GET(self) -> None:
        if self.path_only == "/api/ingest/health":
            self._write_json(HTTPStatus.OK, {"ok": True, "service": "pq-ingest", "database": str(self.server.config.database_path)})
            return
        if self.path_only == "/api/topology":
            with connect(self.server.config.database_path) as conn:
                self._write_json(HTTPStatus.OK, _topology_payload(conn))
            return
        self._write_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        if self.path_only not in {"/api/ingest/packets", "/api/ingest/test"}:
            self._write_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
            return
        if not self._authorized():
            self._write_json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "unauthorized"})
            return

        try:
            packet = self._read_json_body()
            with connect(self.server.config.database_path) as conn:
                with conn:
                    packet_id = ingest_packet(conn, packet)
            self._write_json(HTTPStatus.OK, {"ok": True, "packetId": packet_id})
        except ValueError as exc:
            self._write_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
        except Exception as exc:
            self.log_error("ingest failed: %s", exc)
            self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "ingest failed"})

    @property
    def path_only(self) -> str:
        return self.path.split("?", 1)[0].rstrip("/") or "/"

    def _authorized(self) -> bool:
        token = self.server.config.token
        if not token:
            return True
        auth_header = self.headers.get("Authorization", "")
        x_token = self.headers.get("X-Access-Token", "")
        return auth_header == f"Bearer {token}" or x_token == token

    def _read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            raise ValueError("request body is empty")
        if length > self.server.config.max_body_bytes:
            raise ValueError("request body is too large")
        body = self.rfile.read(length)
        try:
            value = json.loads(body.decode("utf-8-sig"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid json: {exc}") from exc
        if not isinstance(value, dict):
            raise ValueError("packet body must be a JSON object")
        return value

    def _write_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(int(status))
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format % args}")


def _topology_payload(conn: Any) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT
            rv.meter_id,
            pm.circuit_id,
            pm.cabinet_id,
            rv.value AS switch_status,
            rv.quality,
            rv.sample_time
        FROM realtime_value rv
        JOIN point_mapping pm ON pm.id = rv.mapping_id
        WHERE rv.point_code = 'switch_status'
        ORDER BY rv.sample_time DESC, rv.received_at DESC
        """
    ).fetchall()
    switches_by_meter: dict[str, dict[str, Any]] = {}
    for row in rows:
        meter_id = str(row["meter_id"])
        if meter_id in switches_by_meter:
            continue
        raw_status = row["switch_status"]
        switch_status = None if raw_status is None else int(raw_status)
        switches_by_meter[meter_id] = {
            "meterId": meter_id,
            "circuitId": row["circuit_id"],
            "cabinetId": row["cabinet_id"],
            "switchStatus": switch_status,
            "quality": row["quality"],
            "sampleTime": row["sample_time"],
        }
    return {"ok": True, "switches": list(switches_by_meter.values())}


def load_server_config(config_path: Path) -> ServerConfig:
    raw = json.loads(config_path.read_text(encoding="utf-8-sig"))
    database_path = Path(str(raw.get("databasePath") or "data/pq_monitor.sqlite3"))
    if not database_path.is_absolute():
        database_path = (config_path.parent / database_path).resolve()
    return ServerConfig(
        host=str(raw.get("host") or "127.0.0.1"),
        port=int(raw.get("port") or 8000),
        database_path=database_path,
        token=str(raw.get("token") or ""),
        max_body_bytes=int(raw.get("maxBodyBytes") or 1048576),
    )


def run_server(config_path: Path = DEFAULT_CONFIG_PATH) -> None:
    config = load_server_config(config_path)
    init_database(config.database_path)
    server = IngestServer((config.host, config.port), IngestRequestHandler)
    server.config = config
    print(f"ingest server listening on http://{config.host}:{config.port}")
    print(f"database: {config.database_path}")
    server.serve_forever()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the lightweight software1 packet ingest server.")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH, help="Server config JSON path.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    run_server(args.config)


if __name__ == "__main__":
    main()
