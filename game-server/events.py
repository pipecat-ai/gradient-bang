"""Runtime event dispatcher for Gradient Bang server."""

from __future__ import annotations

import asyncio
import logging
import traceback
from typing import Iterable, Protocol, Sequence

from schemas.generated_events import ServerEventName


class EventSink(Protocol):
    """Protocol implemented by WebSocket connections that can receive events."""

    async def send_event(self, envelope: dict) -> None:
        ...

    def matches_characters(self, character_ids: Sequence[str]) -> bool:
        ...

    def matches_names(self, names: Sequence[str]) -> bool:
        ...

    def matches_sectors(self, sectors: Sequence[int]) -> bool:
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
        event: ServerEventName,
        payload: dict,
        *,
        character_filter: Sequence[str] | None = None,
        name_filter: Sequence[str] | None = None,
        meta: dict | None = None,
        sector_filter: Sequence[int] | None = None,
    ) -> None:
        """Broadcast an event to all sinks that match the provided filters."""

        character_filter_list = (
            [c for c in character_filter if c]
            if character_filter is not None
            else None
        )
        name_filter_list = (
            [n for n in name_filter if n]
            if name_filter is not None
            else None
        )
        sector_filter_list = (
            [int(s) for s in sector_filter]
            if sector_filter is not None
            else None
        )

        envelope: dict = {
            "frame_type": "event",
            "event": event,
            "payload": payload,
            "gg-action": event,
        }
        if character_filter_list is not None:
            envelope["character_filter"] = list(character_filter_list)
        if meta:
            envelope["meta"] = meta

        logger.debug(
            "Dispatching event=%s to character_filter=%s name_filter=%s",
            event,
            character_filter_list,
            name_filter_list,
        )

        tasks: list[asyncio.Task[None]] = []
        async with self._lock:
            sinks_snapshot = list(self._sinks)
        for sink in sinks_snapshot:
            if (
                character_filter_list is not None
                and not sink.matches_characters(character_filter_list)
            ):
                continue
            if name_filter_list is not None and not sink.matches_names(name_filter_list):
                continue
            if (
                sector_filter_list is not None
                and not sink.matches_sectors(sector_filter_list)
            ):
                continue
            logger.debug(
                "Dispatch event=%s to connection=%s", event, getattr(sink, "connection_id", "<unknown>")
            )
            task = asyncio.create_task(sink.send_event(envelope))
            logger.debug("WEBSOCKET: Created send task=%s for event=%s", id(task), event)
            tasks.append(task)

        logger.debug("Event %s queued for %s sink(s)", event, len(tasks))
        if tasks:
            logger.info("DISPATCHER: Starting as_completed loop for event=%s with %s tasks", event, len(tasks))
            completed_count = 0
            for task in asyncio.as_completed(tasks):
                try:
                    logger.debug("DISPATCHER: Awaiting task from as_completed for event=%s", event)
                    await task
                    completed_count += 1
                    logger.debug(
                        "WEBSOCKET: Task %s completed for event=%s (completed=%s/%s)",
                        id(task), event, completed_count, len(tasks),
                    )
                except asyncio.CancelledError:
                    logger.warning(
                        "WEBSOCKET: Send task %s CANCELLED for event=%s\nStack trace:\n%s",
                        id(task),
                        event,
                        "".join(traceback.format_stack()),
                    )
                    raise
                except Exception:
                    # Errors from a sink should not crash the dispatcher.
                    logger.exception("Error delivering event=%s", event)
                    continue
            logger.info("DISPATCHER: Completed as_completed loop for event=%s (%s/%s tasks succeeded)",
                       event, completed_count, len(tasks))


event_dispatcher = EventDispatcher()

__all__ = ["event_dispatcher", "EventDispatcher", "EventSink"]
