"""Factory that picks the subagent bus implementation at startup.

Branches on the ``SUBAGENT_BUS_TRANSPORT`` env var:

- ``local`` (default): :class:`AsyncQueueBus` — in-process ``asyncio.Queue``
  fan-out. Used by the bot in single-process mode.
- ``pgmq``: distributed bus over PGMQ via the ``public.bus_*`` SECURITY
  DEFINER wrappers. Used by the bot when running against a remote bus.
  Requires ``SUBAGENT_BUS_DATABASE_URL``.

Per-bot session channels are server-allocated UUID-128 strings of shape
``gb_<32-hex>``, exposed to the rest of the process via
``SUBAGENT_BUS_SESSION_CHANNEL``. The BYOA harness uses the same builder
against a session channel handed to it by ``wake_agent`` over HTTPS.

Async because the PGMQ branch must initialize an asyncpg pool before the
bus can publish; the local branch incurs only a trivial coroutine hop.
"""

from __future__ import annotations

import os
import uuid

from gradientbang.runtime.bus_transport.base import AgentBus
from gradientbang.runtime.bus_transport.local import AsyncQueueBus

_VALID_TRANSPORTS = {"local", "pgmq"}


def _generate_session_channel() -> str:
    """Allocate a fresh UUID-128 bus channel for this bot session.

    Channels are bus capabilities — anyone holding the channel name can
    join. Generating 128 bits of entropy per session makes guessing the
    channel name infeasible. Wake_agent forwards this value to the BYOA
    sandbox over HTTPS; nothing else transports it in plaintext.
    """
    return f"gb_{uuid.uuid4().hex}"


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
        from gradientbang.runtime.bus_transport.pgmq import build_pgmq_bus

        dsn = (os.getenv("SUBAGENT_BUS_DATABASE_URL") or "").strip()
        if not dsn:
            raise RuntimeError(
                "SUBAGENT_BUS_TRANSPORT=pgmq requires SUBAGENT_BUS_DATABASE_URL"
            )
        channel = _generate_session_channel()
        os.environ["SUBAGENT_BUS_SESSION_CHANNEL"] = channel
        return await build_pgmq_bus(database_url=dsn, channel=channel)
    return AsyncQueueBus()


__all__ = ["make_subagent_bus"]
