"""BYOA-flavored PGMQ bus adapter.

The BYOA process is not given the bot's privileged PGMQ DSN. It connects with
a restricted BYOA database role and every bus operation goes through
``byoa_bus_*`` SECURITY DEFINER wrappers. The wrappers validate the BYOA token,
ship id, and per-VoiceAgent session channel before touching PGMQ.

This keeps the runtime flow direct over PGMQ while making the database wrapper
layer the authorization boundary. Wake supplies ``BYOA_BUS_DATABASE_URL`` in
remote mode; local dev passes the same restricted DSN via ``--bus-database-url``.
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
from gradientbang.adapters.bus.serializer import BusJSONSerializer


class ByoaBusAuthorizationError(RuntimeError):
    """Raised when a token-gated BYOA bus wrapper rejects the operation."""


class _ByoaPgmqShim:
    """``PGMQueue``-shaped shim backed by token-gated SQL wrappers.

    Surface matches the subset of ``pgmq.async_queue.PGMQueue`` that upstream
    ``PgmqBus`` calls: create_queue, drop_queue, list_queues, send,
    read_with_poll, and delete.
    """

    def __init__(
        self,
        *,
        dsn: str,
        byoa_token: str,
        channel: str,
        ship_id: str,
        pool_size: int = 4,
    ) -> None:
        self._dsn = dsn
        self._token = byoa_token
        self._channel = channel
        self._ship_id = ship_id
        self._pool_size = pool_size
        self.pool: Optional[asyncpg.pool.Pool] = None

    async def init(self) -> None:
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

    def _require_pool(self) -> asyncpg.pool.Pool:
        if self.pool is None:
            raise RuntimeError("BYOA PGMQ shim was used before init()")
        return self.pool

    async def _execute(self, sql: str, *args) -> None:
        try:
            async with self._require_pool().acquire() as conn:
                await conn.execute(sql, *args)
        except asyncpg.PostgresError as exc:
            raise _wrap_auth_error(exc, self._channel, self._ship_id) from exc

    async def _fetch(self, sql: str, *args):
        try:
            async with self._require_pool().acquire() as conn:
                return await conn.fetch(sql, *args)
        except asyncpg.PostgresError as exc:
            raise _wrap_auth_error(exc, self._channel, self._ship_id) from exc

    async def _fetchval(self, sql: str, *args):
        try:
            async with self._require_pool().acquire() as conn:
                return await conn.fetchval(sql, *args)
        except asyncpg.PostgresError as exc:
            raise _wrap_auth_error(exc, self._channel, self._ship_id) from exc

    async def create_queue(
        self, queue: str, unlogged: bool = False, conn=None
    ) -> None:
        await self._execute(
            "SELECT public.byoa_bus_create_queue($1, $2, $3::uuid, $4)",
            self._token,
            self._channel,
            self._ship_id,
            queue,
        )

    async def drop_queue(
        self, queue: str, partitioned: bool = False, conn=None
    ) -> bool:
        await self._execute(
            "SELECT public.byoa_bus_drop_queue($1, $2, $3::uuid, $4)",
            self._token,
            self._channel,
            self._ship_id,
            queue,
        )
        return True

    async def list_queues(self, conn=None) -> List[str]:
        rows = await self._fetch(
            "SELECT public.byoa_bus_list_queues($1, $2, $3::uuid)",
            self._token,
            self._channel,
            self._ship_id,
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
        row = await self._fetchval(
            "SELECT public.byoa_bus_publish($1, $2, $3::uuid, $4, $5::jsonb)",
            self._token,
            self._channel,
            self._ship_id,
            queue,
            dumps(message).decode("utf-8"),
        )
        return int(row) if row is not None else 0

    async def read_with_poll(
        self,
        queue: str,
        vt: Optional[int] = None,
        qty: int = 1,
        max_poll_seconds: int = 5,
        poll_interval_ms: int = 100,
        conn=None,
    ) -> List[Message]:
        rows = await self._fetch(
            "SELECT msg_id, read_ct, enqueued_at, vt, message "
            "FROM public.byoa_bus_subscribe($1, $2, $3::uuid, $4, $5, $6, $7)",
            self._token,
            self._channel,
            self._ship_id,
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
        row = await self._fetchval(
            "SELECT public.byoa_bus_archive($1, $2, $3::uuid, $4, $5)",
            self._token,
            self._channel,
            self._ship_id,
            queue,
            msg_id,
        )
        return bool(row)


def _wrap_auth_error(
    exc: asyncpg.PostgresError,
    channel: str,
    ship_id: str,
) -> ByoaBusAuthorizationError:
    msg = (getattr(exc, "message", None) or str(exc)).strip()
    return ByoaBusAuthorizationError(
        f"BYOA bus wrapper rejected "
        f"(channel={channel!r}, ship={ship_id[:8]!r}): {msg}"
    )


async def build_byoa_pgmq_bus(
    *,
    database_url: Optional[str] = None,
    channel: str,
    ship_id: str,
    byoa_token: Optional[str] = None,
) -> _OwnedPgmqBus:
    """Build a BYOA subagent bus on the given session channel.

    ``database_url`` defaults to ``BYOA_BUS_DATABASE_URL`` only. BYOA never
    falls back to the bot-owned ``SUBAGENT_BUS_DATABASE_URL``.
    """
    dsn = (database_url or os.getenv("BYOA_BUS_DATABASE_URL") or "").strip()
    if not dsn:
        raise RuntimeError(
            "BYOA bus requires BYOA_BUS_DATABASE_URL "
            "(wake-injected) or --bus-database-url for local dev"
        )

    chan = (channel or "").strip()
    if not chan:
        raise RuntimeError(
            "BYOA bus requires an explicit session channel "
            "(from --channel / BYOA_CHANNEL / wake_agent)"
        )

    ship = (ship_id or "").strip()
    if not ship:
        raise RuntimeError("BYOA bus requires BYOA_SHIP_ID / explicit ship_id")

    token = (byoa_token or os.getenv("BYOA_TOKEN") or "").strip()
    if not token:
        raise RuntimeError("BYOA bus requires BYOA_TOKEN")

    shim = _ByoaPgmqShim(
        dsn=dsn,
        byoa_token=token,
        channel=chan,
        ship_id=ship,
    )
    await shim.init()

    bus = _OwnedPgmqBus(pgmq=shim, channel=chan, serializer=BusJSONSerializer())
    logger.info(f"bus.byoa_pgmq_initialized channel={chan!r}")
    return bus


__all__ = [
    "build_byoa_pgmq_bus",
    "ByoaBusAuthorizationError",
    "_ByoaPgmqShim",
]
