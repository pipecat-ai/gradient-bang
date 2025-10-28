"""Structured event logging for Gradient Bang server events."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any, Iterable

from loguru import logger

MAX_QUERY_RESULTS = 1024


def _json_default(value: Any) -> Any:
    """Fallback serializer for objects that json cannot handle."""
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, set):
        return sorted(value)
    if hasattr(value, "__dict__"):
        return value.__dict__
    return str(value)


@dataclass(slots=True)
class EventRecord:
    """Serializable representation of an emitted or received event."""

    timestamp: str
    direction: str
    event: str
    payload: dict[str, Any]
    sender: str | None
    receiver: str | None
    sector: int | None
    meta: dict[str, Any] | None

    def to_json(self) -> str:
        """Serialize record to a JSON string."""
        try:
            return json.dumps(asdict(self), separators=(",", ":"), default=_json_default)
        except TypeError as exc:  # pragma: no cover - defensive guard
            logger.warning("Failed to serialize event log record: %s", exc)
            serialized = {
                "timestamp": self.timestamp,
                "direction": self.direction,
                "event": self.event,
                "sender": self.sender,
                "receiver": self.receiver,
                "sector": self.sector,
                "meta": self.meta,
                "payload": str(self.payload),
            }
            return json.dumps(serialized, separators=(",", ":"))


class EventLogger:
    """Append-only JSON Lines logger for game events."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, record: EventRecord) -> None:
        """Append a record to the log file."""
        line = record.to_json()
        with self._path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
            handle.flush()  # Ensure it's written immediately

    def query(
        self,
        start: datetime,
        end: datetime,
        *,
        character_id: str | None = None,
        sector: int | None = None,
    ) -> list[dict[str, Any]]:
        """Return log entries within a time window, optionally filtered."""
        if not self._path.exists():
            return []

        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)

        results: list[dict[str, Any]] = []
        with self._path.open("r", encoding="utf-8") as handle:
            for raw in handle:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    entry = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning("Skipping malformed event log line: %s", raw)
                    continue

                timestamp_str = entry.get("timestamp")
                if not isinstance(timestamp_str, str):
                    continue
                try:
                    timestamp = datetime.fromisoformat(timestamp_str)
                except ValueError:
                    continue

                if timestamp.tzinfo is None:
                    timestamp = timestamp.replace(tzinfo=timezone.utc)

                if timestamp < start or timestamp > end:
                    continue

                if character_id:
                    sender = entry.get("sender")
                    receiver = entry.get("receiver")
                    if sender != character_id and receiver != character_id:
                        continue

                if sector is not None and entry.get("sector") != sector:
                    continue

                results.append(entry)
                if len(results) >= MAX_QUERY_RESULTS:
                    break

        return results

    def tail(self, limit: int) -> Iterable[dict[str, Any]]:
        """Return the last ``limit`` records from the log."""
        if limit <= 0 or not self._path.exists():
            return []

        with self._path.open("r", encoding="utf-8") as handle:
            lines = handle.readlines()[-limit:]

        tail_records: list[dict[str, Any]] = []
        for raw in lines:
            raw = raw.strip()
            if not raw:
                continue
            try:
                tail_records.append(json.loads(raw))
            except json.JSONDecodeError:
                logger.warning("Skipping malformed event log line in tail: %s", raw)
        return tail_records
