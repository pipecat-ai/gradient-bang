"""PGMQ-backed :class:`AgentBus` builder.

Wraps upstream :class:`pipecat_subagents.bus.network.pgmq.PgmqBus`. We own
the :class:`PGMQueue` lifetime — upstream is explicit that ``PgmqBus.stop()``
does NOT close the queue's asyncpg pool — so the bus returned here is a thin
subclass that closes the pool on stop. This keeps bot shutdown clean.

The DSN comes from ``SUBAGENT_BUS_DATABASE_URL`` and is parsed into the
discrete kwargs upstream :class:`PGMQueue` expects. Prefer the session-mode
pooler (port 5432 in Supabase) per the upstream docstring; transaction-mode
pooling works but logs benign reset warnings.

``SUBAGENT_BUS_CHANNEL`` is required (no default). PgmqBus broadcasts on
publish to every peer queue sharing the channel prefix, so two bot processes
that fell through to a default channel against the same database would
silently receive each other's bus traffic — most dangerously the broadcast
``BusGameEventMessage`` and any message targeting a common name like
``player``. The factory refuses to start without an explicit value.
"""

from __future__ import annotations

import os
from typing import Optional
from urllib.parse import unquote, urlsplit

from loguru import logger
from pgmq.async_queue import PGMQueue
from pipecat_subagents.bus.network.pgmq import PgmqBus

from gradientbang.adapters.bus.serializer import BusJSONSerializer


def parse_database_url(dsn: str) -> dict[str, str]:
    """Parse a Postgres DSN into ``PGMQueue`` kwargs.

    Args:
        dsn: ``postgres://user:pass@host:port/database``.

    Returns:
        Dict with ``host`` / ``port`` / ``database`` / ``username`` / ``password``
        keys, suitable for ``PGMQueue(**parsed)``.

    Raises:
        ValueError: When the scheme is not ``postgres`` / ``postgresql``.
    """
    parts = urlsplit(dsn)
    if parts.scheme not in {"postgres", "postgresql"}:
        raise ValueError(
            f"SUBAGENT_BUS_DATABASE_URL scheme must be postgres/postgresql, "
            f"got {parts.scheme!r}"
        )
    return {
        "host": parts.hostname or "localhost",
        "port": str(parts.port or 5432),
        "database": (parts.path or "/").lstrip("/") or "postgres",
        "username": unquote(parts.username) if parts.username else "postgres",
        "password": unquote(parts.password) if parts.password else "postgres",
    }


class _OwnedPgmqBus(PgmqBus):
    """PgmqBus subclass that closes its asyncpg pool on stop.

    Upstream's docstring states the caller owns the ``PGMQueue`` client's
    lifetime. The factory constructs the queue, so it owns the cleanup.
    """

    async def stop(self) -> None:  # pragma: no cover - exercised via integration test
        await super().stop()
        pool = getattr(self._pgmq, "pool", None)
        if pool is not None:
            try:
                await pool.close()
            except Exception:
                logger.exception("pgmq.pool_close_failed")


async def build_pgmq_bus(
    *,
    database_url: Optional[str] = None,
    channel: Optional[str] = None,
) -> _OwnedPgmqBus:
    """Build a PGMQ-backed subagent bus.

    Args:
        database_url: Postgres DSN. Defaults to ``SUBAGENT_BUS_DATABASE_URL``.
        channel: PGMQ channel prefix. Defaults to ``SUBAGENT_BUS_CHANNEL``.
            Required — see module docstring for why there is no default.

    Returns:
        An initialized bus ready to be passed to ``AgentRunner(bus=...)``.

    Raises:
        RuntimeError: When the DSN or channel is missing.
        ValueError: When the DSN scheme is invalid.
    """
    dsn = (database_url or os.getenv("SUBAGENT_BUS_DATABASE_URL") or "").strip()
    if not dsn:
        raise RuntimeError(
            "SUBAGENT_BUS_TRANSPORT=pgmq requires SUBAGENT_BUS_DATABASE_URL"
        )

    # Strip before validating: a whitespace-only value would slip past a
    # truthiness check and PgmqBus's _sanitize_channel would convert it
    # into a shared "_____" channel — exactly the cross-talk failure mode
    # the required-channel rule exists to prevent.
    chan = (channel or os.getenv("SUBAGENT_BUS_CHANNEL") or "").strip()
    if not chan:
        raise RuntimeError(
            "SUBAGENT_BUS_TRANSPORT=pgmq requires SUBAGENT_BUS_CHANNEL "
            "(no default — set a per-deployment value so concurrent bots "
            "sharing the same database don't cross-talk through the bus)"
        )

    pgmq = PGMQueue(**parse_database_url(dsn))
    await pgmq.init()

    bus = _OwnedPgmqBus(pgmq=pgmq, channel=chan, serializer=BusJSONSerializer())
    logger.info(f"bus.pgmq_initialized channel={chan!r}")
    return bus


__all__ = ["build_pgmq_bus", "parse_database_url"]
