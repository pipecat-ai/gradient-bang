"""Subagent-bus adapters for ``AgentRunner``.

The bot picks an :class:`AgentBus` at startup via :func:`make_subagent_bus`,
which branches on ``SUBAGENT_BUS_TRANSPORT`` (``local`` or ``pgmq``).
"""

from gradientbang.adapters.bus.base import AgentBus
from gradientbang.adapters.bus.factory import make_subagent_bus
from gradientbang.adapters.bus.local import AsyncQueueBus

__all__ = [
    "AgentBus",
    "AsyncQueueBus",
    "make_subagent_bus",
]
