"""BYOA-flavored PGMQ bus builder.

Phase 3 (2/N) used a per-call SQL wrapper (`byoa_bus_*`) so every pgmq
operation was token-gated. That layer is gone now: operator isolation is
enforced at the channel layer by `wake_agent` allocating a per-VoiceAgent
channel and `byoa_session_claim` handing it to the operator's process.
The Python side becomes a thin factory:

  1. Call the SQL `byoa_bus_authorize(token, channel)` once at startup.
     This is the single authorization round-trip — it verifies the HS256
     BYOA token AND confirms a session is allocated on the requested
     channel for an authorized ship. Raises on any failure.
  2. Construct an unwrapped upstream :class:`PgmqBus` on that channel.
     Subsequent pgmq operations are raw service-role calls scoped to the
     channel's queue-name prefix — no per-call SQL wrapper hops.

This keeps the security boundary tight (the operator's reach is bounded
by the per-call channel they were authorized for) without paying the
wrapper tax on every message.
"""

from __future__ import annotations

import os
from typing import Optional

import asyncpg
from loguru import logger
from pgmq.async_queue import PGMQueue

from gradientbang.adapters.bus.pgmq import _OwnedPgmqBus, parse_database_url
from gradientbang.adapters.bus.serializer import BusJSONSerializer


class ByoaBusAuthorizationError(RuntimeError):
    """Raised when ``byoa_bus_authorize`` rejects the (token, channel) pair.

    Distinct from a transport-level RuntimeError so the CLI can render
    operator-actionable messages: ``invalid_token`` means rotate;
    ``channel_not_allocated`` means the bot hasn't woken the session yet
    (retry); ``channel_not_authorized`` means the operator's character is
    not allowed on the bound ship (fix `.env.byoa` BYOA_SHIP_ID).
    """


async def _authorize(
    dsn: str,
    byoa_token: str,
    channel: str,
) -> None:
    """Single round-trip to ``byoa_bus_authorize``.

    Opens a transient asyncpg connection (not via the bus pool) so the
    authorize check is independent of the long-lived pgmq pool's lifetime.
    Raises :class:`ByoaBusAuthorizationError` on any auth failure with the
    SQL error name attached for log triage.
    """
    kwargs = parse_database_url(dsn)
    conn = await asyncpg.connect(
        user=kwargs["username"],
        password=kwargs["password"],
        database=kwargs["database"],
        host=kwargs["host"],
        port=int(kwargs["port"]),
    )
    try:
        try:
            await conn.fetchval(
                "SELECT public.byoa_bus_authorize($1, $2)",
                byoa_token,
                channel,
            )
        except asyncpg.PostgresError as exc:
            # The wrapper raises with `USING ERRCODE = '42501'` (or 22023
            # for malformed channel). asyncpg surfaces those as message
            # text; we just forward the message so the CLI can render it.
            msg = (getattr(exc, "message", None) or str(exc)).strip()
            raise ByoaBusAuthorizationError(
                f"byoa_bus_authorize rejected (channel={channel!r}): {msg}"
            ) from exc
    finally:
        await conn.close()


async def build_byoa_pgmq_bus(
    *,
    database_url: Optional[str] = None,
    channel: str,
    byoa_token: Optional[str] = None,
) -> _OwnedPgmqBus:
    """Build a BYOA subagent bus on the given session channel.

    Args:
        database_url: Postgres DSN. Defaults to ``SUBAGENT_BUS_DATABASE_URL``.
        channel: Per-VoiceAgent session channel, obtained from the
            ``byoa_session_claim`` edge function. Required; no env-var
            fallback — the BYOA CLI plumbs it through explicitly from the
            claim response so a stale env value can never silently win.
        byoa_token: HS256 BYOA token. Defaults to ``BYOA_TOKEN``.

    Returns:
        ``_OwnedPgmqBus`` running on the authorized channel. ``stop()``
        closes the underlying asyncpg pool.

    Raises:
        RuntimeError: When DSN, channel, or token is missing.
        ValueError: When the DSN scheme is invalid.
        ByoaBusAuthorizationError: When the SQL authorize check rejects
            the (token, channel) pair.
    """
    dsn = (database_url or os.getenv("SUBAGENT_BUS_DATABASE_URL") or "").strip()
    if not dsn:
        raise RuntimeError("BYOA bus requires SUBAGENT_BUS_DATABASE_URL")

    chan = (channel or "").strip()
    if not chan:
        raise RuntimeError(
            "BYOA bus requires an explicit session channel "
            "(obtained from byoa_session_claim)"
        )

    token = (byoa_token or os.getenv("BYOA_TOKEN") or "").strip()
    if not token:
        raise RuntimeError(
            "BYOA bus requires BYOA_TOKEN (mint via byoa_token_mint; "
            "see the byoa-setup Claude skill)"
        )

    # One-shot authorization: server-side check that the token is bound
    # to a session for this channel. Cheap relative to the per-call wrapper
    # path it replaces (one connection + one fetchval).
    await _authorize(dsn, token, chan)

    pgmq = PGMQueue(**parse_database_url(dsn))
    await pgmq.init()

    bus = _OwnedPgmqBus(pgmq=pgmq, channel=chan, serializer=BusJSONSerializer())
    logger.info(f"bus.byoa_pgmq_initialized channel={chan!r}")
    return bus


__all__ = ["build_byoa_pgmq_bus", "ByoaBusAuthorizationError"]
