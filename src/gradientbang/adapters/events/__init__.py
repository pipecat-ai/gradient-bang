"""Event-delivery adapters for ``AsyncGameClient``.

The client picks an :class:`EventAdapter` at construction time via
:func:`make_event_adapter`. ``PollingEventAdapter`` uses the historical
``events_since`` edge function, while ``PubsubEventAdapter`` reads scoped
pgmq queues directly through Postgres. See :mod:`.base` for the Protocol the
client relies on.
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
