"""Factory that picks the subagent bus implementation at startup.

Branches on the ``SUBAGENT_BUS_TRANSPORT`` env var:

- ``local`` (default): :class:`AsyncQueueBus` — in-process ``asyncio.Queue``
  fan-out. Preserves pre-Phase-2 behavior bit-for-bit.
- ``pgmq``: distributed bus over PGMQ. Wired in a follow-up commit; today this
  branch raises :class:`NotImplementedError` so callers fail fast rather than
  silently degrading.

Mirrors :func:`gradientbang.adapters.events.factory.make_event_adapter`.
"""

from __future__ import annotations

import os

from gradientbang.adapters.bus.base import AgentBus
from gradientbang.adapters.bus.local import AsyncQueueBus

_VALID_TRANSPORTS = {"local", "pgmq"}


def make_subagent_bus() -> AgentBus:
    """Construct the subagent bus chosen by ``SUBAGENT_BUS_TRANSPORT``."""
    transport = os.getenv("SUBAGENT_BUS_TRANSPORT", "local").strip().lower()
    if transport not in _VALID_TRANSPORTS:
        raise ValueError(
            f"unknown SUBAGENT_BUS_TRANSPORT={transport!r}; "
            f"expected one of {sorted(_VALID_TRANSPORTS)}"
        )
    if transport == "pgmq":
        raise NotImplementedError(
            "SUBAGENT_BUS_TRANSPORT=pgmq is not wired up yet; "
            "use 'local' until Phase 2 (4/N) lands the PGMQ adapter"
        )
    return AsyncQueueBus()


__all__ = ["make_subagent_bus"]
