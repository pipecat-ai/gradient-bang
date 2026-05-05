"""Factory that picks the right :class:`EventAdapter` for an ``AsyncGameClient``.

Today the only adapter is :class:`PollingEventAdapter`, so this is a thin
constructor. The seam exists so the upcoming pubsub (pgmq) PR can add an
``EVENT_TRANSPORT`` env-var branch here without touching the client.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from gradientbang.adapters.events.base import EventAdapter
from gradientbang.adapters.events.polling import PollingEventAdapter

if TYPE_CHECKING:
    from gradientbang.utils.supabase_client import AsyncGameClient


def make_event_adapter(client: "AsyncGameClient") -> EventAdapter:
    """Construct the event adapter for the given client.

    Currently always returns a :class:`PollingEventAdapter`. The pubsub PR
    will read ``EVENT_TRANSPORT`` here and dispatch.
    """
    return PollingEventAdapter(client)


__all__ = ["make_event_adapter"]
