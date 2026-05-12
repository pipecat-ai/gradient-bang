"""Factory that picks the subagent bus implementation at startup.

Branches on the ``SUBAGENT_BUS_TRANSPORT`` env var:

- ``local`` (default): :class:`AsyncQueueBus` — in-process ``asyncio.Queue``
  fan-out. Preserves pre-Phase-2 behavior bit-for-bit.
- ``pgmq``: distributed bus over PGMQ. Requires ``SUBAGENT_BUS_DATABASE_URL``;
  honors optional ``SUBAGENT_BUS_CHANNEL`` for queue-name isolation between
  deployments or test runs sharing a Postgres instance.

Mirrors :func:`gradientbang.adapters.events.factory.make_event_adapter`. Async
because the PGMQ branch must ``await pgmq.init()`` before the bus can publish;
the local branch incurs only a trivial coroutine hop.
"""

from __future__ import annotations

import os

from gradientbang.adapters.bus.base import AgentBus
from gradientbang.adapters.bus.local import AsyncQueueBus

_VALID_TRANSPORTS = {"local", "pgmq"}


async def make_subagent_bus() -> AgentBus:
    """Construct the subagent bus chosen by ``SUBAGENT_BUS_TRANSPORT``."""
    transport = os.getenv("SUBAGENT_BUS_TRANSPORT", "local").strip().lower()
    if transport not in _VALID_TRANSPORTS:
        raise ValueError(
            f"unknown SUBAGENT_BUS_TRANSPORT={transport!r}; "
            f"expected one of {sorted(_VALID_TRANSPORTS)}"
        )
    if transport == "pgmq":
        # Lazy import so unit tests of the local branch don't pull in
        # pgmq/asyncpg.
        from gradientbang.adapters.bus.pgmq import build_pgmq_bus

        return await build_pgmq_bus()
    return AsyncQueueBus()


__all__ = ["make_subagent_bus"]
