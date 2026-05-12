"""Unit tests for the BYOA-flavored PGMQ bus builder.

Phase 3 (3/N) replaced the per-call SQL wrapper shim with a one-shot
``byoa_bus_authorize`` check and an otherwise-unwrapped upstream
``PgmqBus``. These tests cover:

- ``build_byoa_pgmq_bus`` requires DSN, channel, and token; rejects
  whitespace.
- The authorize step calls ``byoa_bus_authorize(token, channel)`` once
  via a transient asyncpg connection and forwards SQL errors as
  ``ByoaBusAuthorizationError``.
- On success the function constructs the upstream ``PGMQueue`` + an
  ``_OwnedPgmqBus`` on the provided channel.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import asyncpg
import pytest

from gradientbang.adapters.bus.byoa_pgmq import (
    ByoaBusAuthorizationError,
    build_byoa_pgmq_bus,
)


class _FakeConn:
    def __init__(self, fetchval_side_effect=None) -> None:
        self.fetchval = AsyncMock(side_effect=fetchval_side_effect)
        self.close = AsyncMock()


@pytest.mark.unit
class TestBuildByoaPgmqBus:
    async def test_requires_database_url(self, monkeypatch):
        monkeypatch.delenv("SUBAGENT_BUS_DATABASE_URL", raising=False)
        monkeypatch.setenv("BYOA_TOKEN", "tk")
        with pytest.raises(RuntimeError, match="SUBAGENT_BUS_DATABASE_URL"):
            await build_byoa_pgmq_bus(channel="gb_test")

    async def test_requires_channel(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_DATABASE_URL", "postgres://u:p@h/db")
        monkeypatch.setenv("BYOA_TOKEN", "tk")
        with pytest.raises(RuntimeError, match="session channel"):
            await build_byoa_pgmq_bus(channel="")

    async def test_requires_byoa_token(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_DATABASE_URL", "postgres://u:p@h/db")
        monkeypatch.delenv("BYOA_TOKEN", raising=False)
        with pytest.raises(RuntimeError, match="BYOA_TOKEN"):
            await build_byoa_pgmq_bus(channel="gb_test")

    async def test_whitespace_only_token_rejected(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_DATABASE_URL", "postgres://u:p@h/db")
        monkeypatch.setenv("BYOA_TOKEN", "   ")
        with pytest.raises(RuntimeError, match="BYOA_TOKEN"):
            await build_byoa_pgmq_bus(channel="gb_test")

    async def test_authorize_failure_raises_byoa_auth_error(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_DATABASE_URL", "postgres://u:p@h/db")
        monkeypatch.setenv("BYOA_TOKEN", "real-token")
        # asyncpg raises a Postgres error; we want the message surfaced.
        err = asyncpg.PostgresError("invalid_token")
        fake_conn = _FakeConn(fetchval_side_effect=err)
        with patch(
            "gradientbang.adapters.bus.byoa_pgmq.asyncpg.connect",
            new=AsyncMock(return_value=fake_conn),
        ):
            with pytest.raises(ByoaBusAuthorizationError, match="invalid_token"):
                await build_byoa_pgmq_bus(channel="gb_test")
        # Connection must close even when the authorize call raises.
        fake_conn.close.assert_awaited_once()

    async def test_builds_bus_after_authorize_success(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_DATABASE_URL", "postgres://u:p@h/db")
        monkeypatch.setenv("BYOA_TOKEN", "real-token")
        fake_conn = _FakeConn()
        fake_pgmq = MagicMock()
        fake_pgmq.init = AsyncMock()
        fake_bus = object()
        with (
            patch(
                "gradientbang.adapters.bus.byoa_pgmq.asyncpg.connect",
                new=AsyncMock(return_value=fake_conn),
            ),
            patch(
                "gradientbang.adapters.bus.byoa_pgmq.PGMQueue",
                return_value=fake_pgmq,
            ) as pgmq_ctor,
            patch(
                "gradientbang.adapters.bus.byoa_pgmq._OwnedPgmqBus",
                return_value=fake_bus,
            ) as bus_ctor,
        ):
            bus = await build_byoa_pgmq_bus(channel="gb_test")
        assert bus is fake_bus
        # Authorize call shape.
        fake_conn.fetchval.assert_awaited_once_with(
            "SELECT public.byoa_bus_authorize($1, $2)",
            "real-token",
            "gb_test",
        )
        fake_conn.close.assert_awaited_once()
        # Bus construction shape: PGMQueue + bus + NotGiven-aware serializer.
        pgmq_ctor.assert_called_once()
        fake_pgmq.init.assert_awaited_once()
        bus_ctor.assert_called_once()
        kwargs = bus_ctor.call_args.kwargs
        assert kwargs["pgmq"] is fake_pgmq
        assert kwargs["channel"] == "gb_test"
        from gradientbang.adapters.bus.serializer import BusJSONSerializer
        assert isinstance(kwargs["serializer"], BusJSONSerializer)

    async def test_explicit_args_win_over_env(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_DATABASE_URL", "postgres://env:env@env/env")
        monkeypatch.setenv("BYOA_TOKEN", "env-token")
        fake_conn = _FakeConn()
        fake_pgmq = MagicMock()
        fake_pgmq.init = AsyncMock()
        with (
            patch(
                "gradientbang.adapters.bus.byoa_pgmq.asyncpg.connect",
                new=AsyncMock(return_value=fake_conn),
            ),
            patch(
                "gradientbang.adapters.bus.byoa_pgmq.PGMQueue",
                return_value=fake_pgmq,
            ),
            patch("gradientbang.adapters.bus.byoa_pgmq._OwnedPgmqBus"),
        ):
            await build_byoa_pgmq_bus(
                database_url="postgres://x:y@host/db",
                channel="explicit_chan",
                byoa_token="explicit-token",
            )
        fake_conn.fetchval.assert_awaited_once_with(
            "SELECT public.byoa_bus_authorize($1, $2)",
            "explicit-token",
            "explicit_chan",
        )
