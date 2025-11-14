"""Runtime event dispatcher for Gradient Bang server."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from dataclasses import dataclass
from datetime import datetime, timezone
import logging
import traceback
from typing import Any, Protocol, Sequence

from server_logging.event_log import EventLogger, EventRecord


class EventSink(Protocol):
    """Protocol implemented by WebSocket connections that can receive events.

    Each EventSink represents a single character's connection.
    """

    async def send_event(self, envelope: dict) -> None:
        """Send an event to this connection."""
        ...

    def match_character(self, character_id: str) -> bool:
        """Check if this connection is for the given character."""
        ...


logger = logging.getLogger("gradient-bang.events")


def _maybe_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _infer_sector(payload: dict) -> int | None:
    if not isinstance(payload, dict):
        return None

    sector_field = payload.get("sector")
    if isinstance(sector_field, dict):
        for key in ("id", "sector_id"):
            candidate = _maybe_int(sector_field.get(key))
            if candidate is not None:
                return candidate
    else:
        candidate = _maybe_int(sector_field)
        if candidate is not None:
            return candidate

    for key in ("current_sector", "to_sector", "from_sector", "sector_id"):
        candidate = _maybe_int(payload.get(key))
        if candidate is not None:
            return candidate

    movement = payload.get("movement")
    if isinstance(movement, dict):
        for key in ("to_sector", "from_sector"):
            candidate = _maybe_int(movement.get(key))
            if candidate is not None:
                return candidate

    return None


def _infer_sender(payload: dict) -> str | None:
    if not isinstance(payload, dict):
        return None

    character_id = payload.get("character_id")
    if isinstance(character_id, str) and character_id:
        return character_id

    player = payload.get("player")
    if isinstance(player, dict):
        identifier = player.get("id") or player.get("character_id")
        if isinstance(identifier, str) and identifier:
            return identifier

    return None


def _infer_corporation(payload: dict, sender: str | None, world: Any) -> str | None:
    """Best-effort corporation inference using payload details and world state."""

    if not isinstance(payload, dict):
        return None

    corp_id = payload.get("corp_id") or payload.get("corporation_id")
    if isinstance(corp_id, str) and corp_id:
        return corp_id

    if world is None:
        return None

    character_to_corp = getattr(world, "character_to_corp", None)
    if sender and isinstance(character_to_corp, dict):
        corp_id = character_to_corp.get(sender)
        if isinstance(corp_id, str) and corp_id:
            return corp_id

    ship_id = payload.get("ship_id")
    if ship_id and hasattr(world, "ships_manager"):
        try:
            ship = world.ships_manager.get_ship(ship_id)
        except Exception:  # pragma: no cover - defensive guard
            ship = None
        if isinstance(ship, dict):
            if ship.get("owner_type") == "corporation":
                owner_id = ship.get("owner_id")
                if isinstance(owner_id, str) and owner_id:
                    return owner_id

    garrison = payload.get("garrison")
    if isinstance(garrison, dict) and isinstance(character_to_corp, dict):
        owner_id = garrison.get("owner_id")
        if isinstance(owner_id, str) and owner_id:
            corp_id = character_to_corp.get(owner_id)
            if isinstance(corp_id, str) and corp_id:
                return corp_id

    return None


@dataclass(slots=True)
class EventLogContext:
    """Optional metadata describing an emitted event for logging."""

    sender: str | None = None
    sector: int | None = None
    corporation_id: str | None = None
    meta: dict | None = None
    payload_override: dict | None = None
    timestamp: datetime | None = None


class EventDispatcher:
    """Dispatches server events to registered sinks with optional filtering."""

    def __init__(self) -> None:
        self._sinks: set[EventSink] = set()
        self._lock = asyncio.Lock()
        self._event_logger: EventLogger | None = None
        self._world: Any | None = None

    def set_event_logger(self, event_logger: EventLogger | None) -> None:
        """Attach an EventLogger instance for structured logging."""
        self._event_logger = event_logger

    def set_world(self, world: Any) -> None:
        """Attach the world instance for corporation inference."""
        self._world = world

    async def register(self, sink: EventSink) -> None:
        async with self._lock:
            self._sinks.add(sink)

    async def unregister(self, sink: EventSink) -> None:
        async with self._lock:
            self._sinks.discard(sink)

    async def emit(
        self,
        event: str,
        payload: dict,
        *,
        character_filter: Sequence[str] | None = None,
        meta: dict | None = None,
        log_context: EventLogContext | None = None,
        log_event: bool = True,
    ) -> None:
        """Broadcast an event to all sinks that match the provided filters.

        Args:
            event: Event name (e.g., "status.update", "chat.message")
            payload: Event data
            character_filter: Only send to connections for these character IDs.
                If None, broadcast to all connections.
            meta: Optional metadata to include in event envelope
        """

        character_filter_list = (
            [c for c in character_filter if c] if character_filter is not None else None
        )

        envelope: dict = {
            "frame_type": "event",
            "event": event,
            "payload": payload,
        }
        if meta:
            envelope["meta"] = meta

        logger.debug(
            "Dispatching event=%s to character_filter=%s",
            event,
            character_filter_list,
        )

        # Collect coroutines for matching sinks
        coros: list[Awaitable[None]] = []
        receivers: list[str | None] = []
        async with self._lock:
            sinks_snapshot = list(self._sinks)
        for sink in sinks_snapshot:
            # If character_filter specified, check if this sink matches any character
            if character_filter_list is not None:
                if not any(sink.match_character(cid) for cid in character_filter_list):
                    continue
            receiver_id = getattr(sink, "character_id", None)
            logger.debug(
                "Dispatch event=%s to connection=%s",
                event,
                getattr(sink, "connection_id", "<unknown>"),
            )
            coros.append(sink.send_event(envelope))
            receivers.append(receiver_id)

        logger.debug("Event %s queued for %s sink(s)", event, len(coros))
        if coros:
            logger.info(
                "DISPATCHER: Dispatching event=%s to %s sinks", event, len(coros)
            )
            # Use gather() with return_exceptions=True for cleaner exception handling
            results = await asyncio.gather(*coros, return_exceptions=True)

            delivery_outcomes: list[dict | None] = []
            success_count = 0
            cancelled_count = 0
            for i, result in enumerate(results):
                if isinstance(result, asyncio.CancelledError):
                    cancelled_count += 1
                    logger.warning(
                        "WEBSOCKET: Send CANCELLED for event=%s sink_index=%s\nStack trace:\n%s",
                        event,
                        i,
                        "".join(traceback.format_stack()),
                    )
                    delivery_outcomes.append({"status": "cancelled"})
                elif isinstance(result, Exception):
                    # Errors from a sink should not crash the dispatcher
                    logger.exception(
                        "Error delivering event=%s to sink_index=%s: %s",
                        event,
                        i,
                        result,
                    )
                    delivery_outcomes.append(
                        {"status": "error", "error": repr(result)}
                    )
                else:
                    success_count += 1
                    delivery_outcomes.append({"status": "ok"})

            logger.info(
                "DISPATCHER: Completed event=%s (%s/%s sinks succeeded, %s cancelled)",
                event,
                success_count,
                len(results),
                cancelled_count,
            )

            # Re-raise CancelledError if any sink was cancelled (preserve original behavior)
            if cancelled_count > 0:
                raise asyncio.CancelledError(
                    f"{cancelled_count} sink(s) cancelled for event={event}"
                )

            if log_event:
                self._log_event_records(
                    event=event,
                    payload=payload,
                    meta=meta,
                    receivers=receivers,
                    outcomes=delivery_outcomes,
                    log_context=log_context,
                    character_filter=character_filter_list,
                )
        else:
            if log_event:
                self._log_event_records(
                    event=event,
                    payload=payload,
                    meta=meta,
                    receivers=[],
                    outcomes=[],
                    log_context=log_context,
                    character_filter=character_filter_list,
                )

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #

    def _log_event_records(
        self,
        *,
        event: str,
        payload: dict,
        meta: dict | None,
        receivers: list[str | None],
        outcomes: list[dict | None],
        log_context: EventLogContext | None,
        character_filter: Sequence[str] | None,
    ) -> None:
        """Write event records for dispatch and delivery."""
        if self._event_logger is None:
            return

        timestamp = (
            log_context.timestamp if log_context and log_context.timestamp else None
        )
        if timestamp is None:
            timestamp = datetime.now(timezone.utc)
        timestamp_str = timestamp.isoformat()

        sender = log_context.sender if log_context else None
        sector = log_context.sector if log_context else None
        payload_for_log = (
            log_context.payload_override
            if log_context and log_context.payload_override is not None
            else payload
        )

        if sender is None:
            inferred_sender = (
                _infer_sender(payload_for_log)
                if isinstance(payload_for_log, dict)
                else None
            )
            if inferred_sender:
                sender = inferred_sender
            elif character_filter and len(character_filter) == 1:
                sender = character_filter[0]

        if sector is None and isinstance(payload_for_log, dict):
            sector = _infer_sector(payload_for_log)

        combined_meta: dict | None = None
        if meta and log_context and log_context.meta:
            combined_meta = {**meta, **log_context.meta}
        elif log_context and log_context.meta:
            combined_meta = dict(log_context.meta)
        elif meta:
            combined_meta = dict(meta)

        corporation_id = log_context.corporation_id if log_context else None
        if corporation_id is None:
            corporation_id = _infer_corporation(payload_for_log, sender, self._world)

        try:
            sent_record = EventRecord(
                timestamp=timestamp_str,
                direction="sent",
                event=event,
                payload=payload_for_log,
                sender=sender,
                receiver=None,
                sector=sector,
                corporation_id=corporation_id,
                meta=combined_meta,
            )
            self._event_logger.append(sent_record)

            if receivers:
                for idx, receiver in enumerate(receivers):
                    delivery_meta = combined_meta.copy() if combined_meta else {}
                    if outcomes and idx < len(outcomes) and outcomes[idx]:
                        delivery_meta.update(outcomes[idx])  # type: ignore[arg-type]
                    record = EventRecord(
                        timestamp=timestamp_str,
                        direction="received",
                        event=event,
                        payload=payload_for_log,
                        sender=sender,
                        receiver=receiver,
                        sector=sector,
                        corporation_id=corporation_id,
                        meta=delivery_meta or None,
                    )
                    self._event_logger.append(record)
        except Exception:  # pragma: no cover - logging must not break dispatch
            logger.exception("Failed to append event log record for event=%s", event)


event_dispatcher = EventDispatcher()

__all__ = ["event_dispatcher", "EventDispatcher", "EventSink", "EventLogContext"]
