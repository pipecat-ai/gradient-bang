"""Shared helpers for extracting and ordering game events.

Keep this module stdlib-only. It is imported by code paths that can run in the
slim BYOA runtime, so it must not depend on bot-only packages, Pipecat frame
classes, game clients, or runtime services.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Optional, TypeVar

T = TypeVar("T")


def extract_payload_event_context(payload: Any) -> Optional[Mapping[str, Any]]:
    """Return event context from a raw event payload mapping.

    Raw payloads prefer the internal ``__event_context`` key over the public
    ``event_context`` key, matching the existing relay payload helper.
    """

    if not isinstance(payload, Mapping):
        return None

    ctx = payload.get("__event_context") or payload.get("event_context")
    return ctx if isinstance(ctx, Mapping) else None


def extract_internal_payload_event_context(payload: Any) -> Optional[Mapping[str, Any]]:
    """Return the internal ``__event_context`` from a raw event payload."""

    if not isinstance(payload, Mapping):
        return None

    ctx = payload.get("__event_context")
    return ctx if isinstance(ctx, Mapping) else None


def extract_event_context(value: Any) -> Optional[Mapping[str, Any]]:
    """Return event context from a game event envelope.

    Event envelopes prefer top-level ``event_context`` and then fall back to
    payload metadata, matching the existing EventRelay and TaskAgent helpers.
    """

    if not isinstance(value, Mapping):
        return None

    ctx = value.get("event_context")
    if isinstance(ctx, Mapping):
        return ctx

    ctx = extract_payload_event_context(value.get("payload"))
    if isinstance(ctx, Mapping):
        return ctx

    return None


def extract_event_id_from_context(
    ctx: Any,
    *,
    parse_strings: bool = True,
) -> Optional[int]:
    """Return ``ctx.event_id`` as an int when available."""

    if not isinstance(ctx, Mapping):
        return None

    event_id = ctx.get("event_id")
    if isinstance(event_id, int):
        return event_id
    if parse_strings and isinstance(event_id, str) and event_id.isdigit():
        return int(event_id)
    return None


def extract_event_id(value: Any, *, parse_strings: bool = True) -> Optional[int]:
    """Return ``event_context.event_id`` from a game event envelope."""

    return extract_event_id_from_context(
        extract_event_context(value),
        parse_strings=parse_strings,
    )


def extract_payload_event_id(payload: Any, *, parse_strings: bool = True) -> Optional[int]:
    """Return ``event_context.event_id`` from a raw event payload mapping."""

    return extract_event_id_from_context(
        extract_payload_event_context(payload),
        parse_strings=parse_strings,
    )


def extract_internal_payload_event_id(
    payload: Any,
    *,
    parse_strings: bool = True,
) -> Optional[int]:
    """Return ``__event_context.event_id`` from a raw event payload mapping."""

    return extract_event_id_from_context(
        extract_internal_payload_event_context(payload),
        parse_strings=parse_strings,
    )


def sort_by_event_id_preserving_no_id_positions(
    items: Sequence[T],
    *,
    event_of: Optional[Callable[[T], Any]] = None,
    event_id_of: Optional[Callable[[T], Optional[int]]] = None,
) -> list[T]:
    """Sort ID-bearing items while leaving no-ID items in their original slots.

    This matches the EventRelay and TaskAgent queue behavior: events with an
    ``event_id`` are ordered relative to each other, while events without an
    ID keep their arrival positions in the batch.
    """

    if event_id_of is None:
        if event_of is None:
            raise ValueError("event_of or event_id_of is required")

        def event_id_of(item: T) -> Optional[int]:
            return extract_event_id(event_of(item))

    extracted = [(idx, item, event_id_of(item)) for idx, item in enumerate(items)]
    ided = [(idx, item, event_id) for idx, item, event_id in extracted if event_id is not None]
    ided.sort(key=lambda entry: (entry[2], entry[0]))

    ordered: list[Optional[T]] = [None] * len(items)
    for idx, item, event_id in extracted:
        if event_id is None:
            ordered[idx] = item

    free_slots = [idx for idx, item in enumerate(ordered) if item is None]
    for slot, (_idx, item, _event_id) in zip(free_slots, ided):
        ordered[slot] = item

    return [item for item in ordered if item is not None]


def sort_by_event_id_id_first(
    items: Sequence[T],
    *,
    event_of: Optional[Callable[[T], Any]] = None,
    event_id_of: Optional[Callable[[T], Optional[int]]] = None,
) -> list[T]:
    """Sort ID-bearing items before no-ID items, preserving stable order.

    This matches the Pubsub transport behavior: messages with an ``event_id``
    are emitted first in event-id order; messages without an ID follow in their
    original relative order.
    """

    if event_id_of is None:
        if event_of is None:
            raise ValueError("event_of or event_id_of is required")

        def event_id_of(item: T) -> Optional[int]:
            return extract_event_id(event_of(item))

    extracted = [(idx, item, event_id_of(item)) for idx, item in enumerate(items)]
    extracted.sort(
        key=lambda entry: (
            1 if entry[2] is None else 0,
            entry[2] or 0,
            entry[0],
        )
    )
    return [item for _idx, item, _event_id in extracted]


def record_recent_event_id(
    recent_ids: deque[int],
    value: Any,
    *,
    max_size: int,
    event_id_of: Optional[Callable[[Any], Optional[int]]] = None,
) -> bool:
    """Record an event ID and return whether the event should be processed.

    Returns ``False`` when ``value`` has an event ID that is already present in
    ``recent_ids``. Events without IDs are always accepted.
    """

    event_id = event_id_of(value) if event_id_of is not None else extract_event_id(value)
    if event_id is None:
        return True
    if event_id in recent_ids:
        return False

    recent_ids.append(event_id)
    while len(recent_ids) > max_size:
        recent_ids.popleft()
    return True
