"""Factory that picks the subagent bus implementation at startup.

Branches on the ``SUBAGENT_BUS_TRANSPORT`` env var:

- ``local`` (default): :class:`AsyncQueueBus` — in-process ``asyncio.Queue``
  fan-out. Preserves pre-Phase-2 behavior bit-for-bit. Used by the bot.
- ``pgmq``: distributed bus over PGMQ with raw pgmq calls. Used by the bot
  when running against a remote bus. Requires ``SUBAGENT_BUS_DATABASE_URL``
  + ``SUBAGENT_BUS_CHANNEL``.

The BYOA CLI does not use this factory — it has a single transport (PGMQ
on a player/session channel passed by wake or ``--channel``) and calls
:func:`gradientbang.adapters.bus.byoa_pgmq.build_byoa_pgmq_bus` directly
with the discovered channel.

Mirrors :func:`gradientbang.adapters.events.factory.make_event_adapter`. Async
because both PGMQ branches must ``await pgmq.init()`` before the bus can
publish; the local branch incurs only a trivial coroutine hop.
"""

from __future__ import annotations

import os
import re

from gradientbang.adapters.bus.base import AgentBus
from gradientbang.adapters.bus.local import AsyncQueueBus

_VALID_TRANSPORTS = {"local", "pgmq"}
_CHANNEL_MAX_LEN = 30


def _session_channel(base: str, session_id: str) -> str:
    """Derive a PGMQ channel for this voice-agent session.

    ``SUBAGENT_BUS_CHANNEL`` is a namespace/prefix, not the final shared
    channel. The final channel must stay within the wake_agent validator's
    30-character identifier limit.
    """
    safe_base = re.sub(r"[^A-Za-z0-9_]", "_", base.strip()) or "gb"
    if not re.match(r"^[A-Za-z_]", safe_base):
        safe_base = f"gb_{safe_base}"
    suffix = re.sub(r"[^A-Za-z0-9_]", "_", session_id.strip())[:10]
    if not suffix:
        suffix = "session"
    max_base_len = _CHANNEL_MAX_LEN - len(suffix) - 1
    return f"{safe_base[:max_base_len]}_{suffix}"


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

        base_channel = os.getenv("SUBAGENT_BUS_CHANNEL", "").strip()
        session_id = os.getenv("BOT_INSTANCE_ID", "").strip()
        channel = _session_channel(base_channel, session_id) if base_channel and session_id else None
        if channel:
            os.environ["SUBAGENT_BUS_SESSION_CHANNEL"] = channel
        return await build_pgmq_bus(channel=channel)
    return AsyncQueueBus()


__all__ = ["make_subagent_bus"]
