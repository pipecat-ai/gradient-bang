"""Factory that picks the subagent bus implementation at startup.

Branches on the ``SUBAGENT_BUS_TRANSPORT`` env var:

- ``local`` (default): :class:`AsyncQueueBus` — in-process ``asyncio.Queue``
  fan-out. Preserves pre-Phase-2 behavior bit-for-bit. Used by the bot.
- ``pgmq``: distributed bus over PGMQ with raw pgmq calls. Used by the bot
  when running against a remote bus. Requires ``SUBAGENT_BUS_DATABASE_URL``
  + ``SUBAGENT_BUS_CHANNEL``.

The BYOA CLI does not use this factory — it has a single transport (PGMQ
on a per-session channel obtained from ``byoa_session_claim``) and calls
:func:`gradientbang.adapters.bus.byoa_pgmq.build_byoa_pgmq_bus` directly
with the discovered channel.

Mirrors :func:`gradientbang.adapters.events.factory.make_event_adapter`. Async
because both PGMQ branches must ``await pgmq.init()`` before the bus can
publish; the local branch incurs only a trivial coroutine hop.
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
