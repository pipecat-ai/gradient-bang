"""Event-delivery adapters for ``AsyncGameClient``.

The client picks an :class:`EventAdapter` via :func:`make_event_adapter`.
``PollingEventAdapter`` uses ``events_since``; ``PubsubEventAdapter`` reads one
temporary session pgmq queue through Postgres.
"""

from gradientbang.adapters.events.base import EventAdapter
from gradientbang.adapters.events.factory import make_event_adapter
from gradientbang.adapters.events.polling import PollingEventAdapter
from gradientbang.adapters.events.pubsub import PubsubEventAdapter

__all__ = [
    "EventAdapter",
    "PollingEventAdapter",
    "PubsubEventAdapter",
    "make_event_adapter",
]
