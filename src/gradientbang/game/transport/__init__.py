"""Event-delivery transports for ``AsyncGameClient``.

The client picks an :class:`EventAdapter` via :func:`make_event_adapter`.
``PollingEventAdapter`` uses ``events_since``; ``PubsubEventAdapter`` reads one
temporary session pgmq queue through Postgres.
"""

from gradientbang.game.transport.base import EventAdapter
from gradientbang.game.transport.factory import make_event_adapter
from gradientbang.game.transport.polling import PollingEventAdapter
from gradientbang.game.transport.pubsub import PubsubEventAdapter

__all__ = [
    "EventAdapter",
    "PollingEventAdapter",
    "PubsubEventAdapter",
    "make_event_adapter",
]
