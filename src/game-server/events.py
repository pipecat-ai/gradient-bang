"""Runtime event dispatcher for Gradient Bang server."""

from __future__ import annotations

import asyncio
from typing import Iterable, Protocol, Sequence

from core.schemas.generated_events import ServerEventName


class EventSink(Protocol):
    """Protocol implemented by WebSocket connections that can receive events."""

    async def send_event(self, envelope: dict) -> None:
        ...

    def matches_characters(self, character_ids: Sequence[str]) -> bool:
        ...

    def matches_names(self, names: Sequence[str]) -> bool:
        ...


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
            tasks.append(asyncio.create_task(sink.send_event(envelope)))

        if tasks:
            for task in asyncio.as_completed(tasks):
                try:
                    await task
                except Exception:
                    # Errors from a sink should not crash the dispatcher.
                    continue


event_dispatcher = EventDispatcher()

__all__ = ["event_dispatcher", "EventDispatcher", "EventSink"]
