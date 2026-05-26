"""PGMQ-backed :class:`WorkerBus` builder.

Wraps upstream :class:`pipecat.bus.network.pgmq.PgmqBus` with
:class:`IsolatedPgmqBackend` over an asyncpg pool. Every bus op goes through
the ``public.bus_*`` SECURITY DEFINER wrappers defined in
``20260512000000_byoa_infrastructure.sql``. Both the bot
(``service_role``) and BYOA operators (``byoa_bus_client``) connect through
the same wrapper surface and see each other's queues via the ``bus_peers``
registry.

The asyncpg pool is owned by this builder and closed on ``bus.stop()``.
"""

from __future__ import annotations

from urllib.parse import unquote, urlsplit

import asyncpg
from loguru import logger
from pipecat.bus.network.pgmq import PgmqBus
from pipecat.bus.network.pgmq_backends import IsolatedPgmqBackend

from gradientbang.runtime.bus_transport.serializer import BusJSONSerializer


def parse_database_url(dsn: str) -> dict[str, str]:
    """Parse a Postgres DSN into asyncpg pool kwargs."""
    parts = urlsplit(dsn)
    if parts.scheme not in {"postgres", "postgresql"}:
        raise ValueError(
            f"PGMQ bus DSN scheme must be postgres/postgresql, got {parts.scheme!r}"
        )
    return {
        "host": parts.hostname or "localhost",
        "port": int(parts.port or 5432),
        "database": (parts.path or "/").lstrip("/") or "postgres",
        "user": unquote(parts.username) if parts.username else "postgres",
        "password": unquote(parts.password) if parts.password else "postgres",
    }


class _OwnedPgmqBus(PgmqBus):
    """PgmqBus that owns and closes its asyncpg pool on stop."""

    def __init__(self, *, pool: asyncpg.pool.Pool, **kwargs) -> None:
        super().__init__(**kwargs)
        self._owned_pool = pool

    async def stop(self) -> None:  # pragma: no cover - exercised via integration
        await super().stop()
        try:
            await self._owned_pool.close()
        except Exception:
            logger.exception("pgmq.pool_close_failed")


async def build_pgmq_bus(
    *,
    database_url: str,
    channel: str,
    pool_size: int = 4,
) -> _OwnedPgmqBus:
    """Build a PGMQ-backed subagent bus on ``channel``.

    Args:
        database_url: Postgres DSN. The role must have EXECUTE on the
            ``public.bus_*`` wrappers.
        channel: Bus channel name. Treated as a capability — anyone holding
            the channel name on the same DB can join.
        pool_size: Max asyncpg pool size. Default 4.

    Returns:
        An initialized bus ready to pass to ``PipelineRunner(bus=...)``.
    """
    dsn = (database_url or "").strip()
    if not dsn:
        raise RuntimeError("build_pgmq_bus requires database_url")
    chan = (channel or "").strip()
    if not chan:
        raise RuntimeError("build_pgmq_bus requires channel")

    pool = await asyncpg.create_pool(
        **parse_database_url(dsn),
        min_size=1,
        max_size=pool_size,
    )
    backend = IsolatedPgmqBackend(pool=pool)
    bus = _OwnedPgmqBus(
        pool=pool,
        backend=backend,
        channel=chan,
        serializer=BusJSONSerializer(),
    )
    logger.info(f"bus.pgmq_initialized channel_prefix={chan[:11]}")
    return bus


__all__ = ["build_pgmq_bus", "parse_database_url"]
