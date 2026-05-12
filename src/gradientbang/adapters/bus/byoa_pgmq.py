"""BYOA-flavored PGMQ bus adapter.

Wraps upstream :class:`pipecat_subagents.bus.network.pgmq.PgmqBus` with a
``PGMQueue``-shaped shim that routes every pgmq call through the
SECURITY DEFINER wrappers in the ``20260515000000_byoa_bus_wrappers.sql``
migration. Every wrapped call carries the operator's HS256 BYOA token,
which the SQL side validates via ``verify_byoa_token`` before doing
anything. The result:

- A BYOA agent can only subscribe to / archive from queues it created
  (queues bound to its token's character_id in ``byoa_owned_queues``).
- Cross-character read attempts return zero rows (silent on the wire so
  we don't leak queue existence to a probing operator).
- Publish always rewrites the bus envelope's ``source`` to
  ``byoa_<character_id>`` regardless of caller input, so a buggy or
  malicious CLI can't impersonate the bot or another character.

The DSN authenticates a Postgres role and gets us a connection; the
HS256 token is the per-character authorization layer on top. Mirrors
the 0.4.1 bot pattern (admin DSN + per-character internal token +
SECURITY DEFINER ``subscribe_my_events`` / ``archive_my_events``).
"""

from __future__ import annotations

import os
from datetime import datetime
from typing import List, Optional

import asyncpg
from loguru import logger
from orjson import dumps, loads
from pgmq.messages import Message

from gradientbang.adapters.bus.pgmq import _OwnedPgmqBus, parse_database_url


class _ByoaPgmqShim:
    """``PGMQueue``-shaped shim that routes every operation through
    the token-gated ``byoa_bus_*`` SECURITY DEFINER wrappers.

    Surface matches the subset of ``pgmq.async_queue.PGMQueue`` that
    upstream ``PgmqBus`` actually calls (create_queue, drop_queue,
    list_queues, send, read_with_poll, delete). The HS256 token is
    threaded through every call from this class; the BYOA agent never
    touches it directly.

    Owns its asyncpg pool; ``_OwnedPgmqBus.stop()`` closes it via the
    same ``self._pgmq.pool`` attribute that the unwrapped path uses.
    """

    def __init__(
        self,
        *,
        dsn: str,
        byoa_token: str,
        pool_size: int = 4,
    ) -> None:
        self._dsn = dsn
        self._token = byoa_token
        self._pool_size = pool_size
        self.pool: Optional[asyncpg.pool.Pool] = None

    async def init(self) -> None:
        """Create the asyncpg pool. Idempotent."""
        if self.pool is not None:
            return
        kwargs = parse_database_url(self._dsn)
        self.pool = await asyncpg.create_pool(
            user=kwargs["username"],
            password=kwargs["password"],
            database=kwargs["database"],
            host=kwargs["host"],
            port=int(kwargs["port"]),
            min_size=1,
            max_size=self._pool_size,
        )

    async def create_queue(
        self, queue: str, unlogged: bool = False, conn=None
    ) -> None:
        async with self.pool.acquire() as c:
            await c.execute(
                "SELECT public.byoa_bus_create_queue($1, $2)",
                self._token,
                queue,
            )

    async def drop_queue(
        self, queue: str, partitioned: bool = False, conn=None
    ) -> bool:
        async with self.pool.acquire() as c:
            await c.execute(
                "SELECT public.byoa_bus_drop_queue($1, $2)",
                self._token,
                queue,
            )
        return True

    async def list_queues(self, conn=None) -> List[str]:
        async with self.pool.acquire() as c:
            rows = await c.fetch(
                "SELECT public.byoa_bus_list_queues($1)",
                self._token,
            )
        return [row[0] for row in rows]

    async def send(
        self,
        queue: str,
        message: dict,
        delay: int = 0,
        tz: Optional[datetime] = None,
        conn=None,
    ) -> int:
        # delay/tz aren't supported through the wrapper today; upstream
        # PgmqBus.publish doesn't use them either. Keep the kwargs in the
        # signature so a future upstream change doesn't break ours.
        async with self.pool.acquire() as c:
            row = await c.fetchrow(
                "SELECT public.byoa_bus_publish($1, $2, $3::jsonb)",
                self._token,
                queue,
                dumps(message).decode("utf-8"),
            )
        return int(row[0]) if row and row[0] is not None else 0

    async def read_with_poll(
        self,
        queue: str,
        vt: Optional[int] = None,
        qty: int = 1,
        max_poll_seconds: int = 5,
        poll_interval_ms: int = 100,
        conn=None,
    ) -> List[Message]:
        # poll_interval_ms isn't piped through to the wrapper; pgmq's
        # default of 100ms is fine and we don't expect to tune it
        # per-operator. The wrapper hard-codes it to pgmq's default.
        async with self.pool.acquire() as c:
            rows = await c.fetch(
                "SELECT msg_id, read_ct, enqueued_at, vt, message "
                "FROM public.byoa_bus_subscribe($1, $2, $3, $4, $5)",
                self._token,
                queue,
                vt if vt is not None else 30,
                qty,
                max_poll_seconds,
            )
        return [
            Message(
                msg_id=row[0],
                read_ct=row[1],
                enqueued_at=row[2],
                vt=row[3],
                message=loads(row[4]) if isinstance(row[4], (bytes, str)) else row[4],
            )
            for row in rows
        ]

    async def delete(self, queue: str, msg_id: int, conn=None) -> bool:
        async with self.pool.acquire() as c:
            row = await c.fetchrow(
                "SELECT public.byoa_bus_archive($1, $2, $3)",
                self._token,
                queue,
                msg_id,
            )
        return bool(row[0]) if row else False


async def build_byoa_pgmq_bus(
    *,
    database_url: Optional[str] = None,
    channel: Optional[str] = None,
    byoa_token: Optional[str] = None,
) -> _OwnedPgmqBus:
    """Build a BYOA-flavored PGMQ subagent bus.

    Args:
        database_url: Postgres DSN. Defaults to ``SUBAGENT_BUS_DATABASE_URL``.
        channel: PGMQ channel prefix. Defaults to ``SUBAGENT_BUS_CHANNEL``.
        byoa_token: HS256 BYOA token bound to a character_id (minted via
            ``byoa_token_mint``). Defaults to ``BYOA_TOKEN``.

    Returns:
        ``_OwnedPgmqBus`` wired to the BYOA shim. ``stop()`` closes the
        underlying asyncpg pool.

    Raises:
        RuntimeError: When any required input is missing or whitespace-only.
        ValueError: When the DSN scheme is invalid.
    """
    dsn = (database_url or os.getenv("SUBAGENT_BUS_DATABASE_URL") or "").strip()
    if not dsn:
        raise RuntimeError(
            "SUBAGENT_BUS_TRANSPORT=byoa_pgmq requires SUBAGENT_BUS_DATABASE_URL"
        )

    chan = (channel or os.getenv("SUBAGENT_BUS_CHANNEL") or "").strip()
    if not chan:
        raise RuntimeError(
            "SUBAGENT_BUS_TRANSPORT=byoa_pgmq requires SUBAGENT_BUS_CHANNEL "
            "(must match the bot's channel value)"
        )

    token = (byoa_token or os.getenv("BYOA_TOKEN") or "").strip()
    if not token:
        raise RuntimeError(
            "SUBAGENT_BUS_TRANSPORT=byoa_pgmq requires BYOA_TOKEN "
            "(mint via byoa_token_mint; see the byoa-setup Claude skill)"
        )

    shim = _ByoaPgmqShim(dsn=dsn, byoa_token=token)
    await shim.init()

    bus = _OwnedPgmqBus(pgmq=shim, channel=chan)
    logger.info(f"bus.byoa_pgmq_initialized channel={chan!r}")
    return bus


__all__ = ["build_byoa_pgmq_bus", "_ByoaPgmqShim"]
