"""Runtime event dispatcher for Gradient Bang server."""

from __future__ import annotations

import asyncio
import logging
import traceback
from typing import Protocol, Sequence


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


class EventDispatcher:
    """Dispatches server events to registered sinks with optional filtering."""

    def __init__(self) -> None:
        self._sinks: set[EventSink] = set()
        self._lock = asyncio.Lock()

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
        coros = []
        async with self._lock:
            sinks_snapshot = list(self._sinks)
        for sink in sinks_snapshot:
            # If character_filter specified, check if this sink matches any character
            if character_filter_list is not None:
                if not any(sink.match_character(cid) for cid in character_filter_list):
                    continue
            logger.debug(
                "Dispatch event=%s to connection=%s",
                event,
                getattr(sink, "connection_id", "<unknown>"),
            )
            coros.append(sink.send_event(envelope))

        logger.debug("Event %s queued for %s sink(s)", event, len(coros))
        if coros:
            logger.info(
                "DISPATCHER: Dispatching event=%s to %s sinks", event, len(coros)
            )
            # Use gather() with return_exceptions=True for cleaner exception handling
            results = await asyncio.gather(*coros, return_exceptions=True)

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
                elif isinstance(result, Exception):
                    # Errors from a sink should not crash the dispatcher
                    logger.exception(
                        "Error delivering event=%s to sink_index=%s: %s",
                        event,
                        i,
                        result,
                    )
                else:
                    success_count += 1

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


event_dispatcher = EventDispatcher()

__all__ = ["event_dispatcher", "EventDispatcher", "EventSink"]
