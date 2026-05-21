from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Iterable


class PacketCache:
    def __init__(self, sqlite_path: Path, max_packets: int) -> None:
        self.sqlite_path = sqlite_path
        self.max_packets = max_packets
        self.sqlite_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def enqueue(self, packet: dict[str, object]) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO pending_packets(packet_type, body) VALUES(?, ?)",
                (str(packet.get("packetType", "")), json.dumps(packet, ensure_ascii=False)),
            )
            self._trim(conn)

    def peek(self, limit: int = 20) -> list[tuple[int, dict[str, object]]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, body FROM pending_packets ORDER BY id ASC LIMIT ?",
                (limit,),
            ).fetchall()
        return [(int(row[0]), json.loads(str(row[1]))) for row in rows]

    def delete(self, packet_id: int) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM pending_packets WHERE id = ?", (packet_id,))

    def mark_failed(self, packet_id: int, error: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE pending_packets SET attempts = attempts + 1, last_error = ? WHERE id = ?",
                (error[:500], packet_id),
            )

    def count(self) -> int:
        with self._connect() as conn:
            row = conn.execute("SELECT COUNT(*) FROM pending_packets").fetchone()
        return int(row[0])

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.sqlite_path)

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS pending_packets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    packet_type TEXT NOT NULL,
                    body TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT
                )
                """
            )

    def _trim(self, conn: sqlite3.Connection) -> None:
        if self.max_packets <= 0:
            return
        row = conn.execute("SELECT COUNT(*) FROM pending_packets").fetchone()
        overflow = int(row[0]) - self.max_packets
        if overflow <= 0:
            return
        ids: Iterable[int] = (
            int(row[0])
            for row in conn.execute(
                "SELECT id FROM pending_packets ORDER BY id ASC LIMIT ?",
                (overflow,),
            ).fetchall()
        )
        for packet_id in ids:
            conn.execute("DELETE FROM pending_packets WHERE id = ?", (packet_id,))

