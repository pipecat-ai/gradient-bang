"""Factory that picks the right :class:`EventAdapter` for an ``AsyncGameClient``.

Branches on the ``EVENT_TRANSPORT`` env var:
- ``pubsub`` (default): :class:`PubsubEventAdapter` — one direct Postgres
  scoped reader for all queues in the bot session. Requires ``PGMQ_URL`` and
  ``EDGE_API_TOKEN``; SQL verifies the token and actor scope before reading.
- ``polling``: :class:`PollingEventAdapter` — HTTP polling against the
  ``events_since`` edge function. Works without any per-character credential,
  suitable for environments where pubsub is unavailable.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from gradientbang.adapters.events.base import EventAdapter
from gradientbang.adapters.events.polling import PollingEventAdapter
from gradientbang.adapters.events.pubsub import PubsubEventAdapter

if TYPE_CHECKING:
    from gradientbang.utils.supabase_client import AsyncGameClient


_VALID_TRANSPORTS = {"polling", "pubsub"}


def make_event_adapter(client: "AsyncGameClient") -> EventAdapter:
    """Construct the event adapter for the given client based on env config."""
    transport = os.getenv("EVENT_TRANSPORT", "pubsub").strip().lower()
    if transport not in _VALID_TRANSPORTS:
        raise ValueError(
            f"unknown EVENT_TRANSPORT={transport!r}; "
            f"expected one of {sorted(_VALID_TRANSPORTS)}"
        )
    if transport == "pubsub":
        return PubsubEventAdapter(client)
    return PollingEventAdapter(client)


__all__ = ["make_event_adapter"]
