"""Unit tests for the BYOA wrapper-backed PGMQ bus builder."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import asyncpg
import pytest

from gradientbang.adapters.bus.byoa_pgmq import (
    ByoaBusAuthorizationError,
    _ByoaPgmqShim,
    build_byoa_pgmq_bus,
)


class _AcquireContext:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *_) -> None:
        return None


class _FakePool:
    def __init__(self, conn):
        self._conn = conn
        self.close = AsyncMock()

    def acquire(self):
        return _AcquireContext(self._conn)


@pytest.mark.unit
class TestBuildByoaPgmqBus:
    async def test_requires_database_url(self, monkeypatch):
        monkeypatch.delenv("BYOA_BUS_DATABASE_URL", raising=False)
        monkeypatch.setenv("BYOA_TOKEN", "tk")
        with pytest.raises(RuntimeError, match="BYOA_BUS_DATABASE_URL"):
            await build_byoa_pgmq_bus(channel="gb_test", ship_id="ship-1")

    async def test_does_not_fall_back_to_bot_bus_database_url(self, monkeypatch):
        monkeypatch.delenv("BYOA_BUS_DATABASE_URL", raising=False)
        monkeypatch.setenv("SUBAGENT_BUS_DATABASE_URL", "postgres://bot:bot@h/db")
        monkeypatch.setenv("BYOA_TOKEN", "tk")
        with pytest.raises(RuntimeError, match="BYOA_BUS_DATABASE_URL"):
            await build_byoa_pgmq_bus(channel="gb_test", ship_id="ship-1")

    async def test_requires_channel(self, monkeypatch):
        monkeypatch.setenv("BYOA_BUS_DATABASE_URL", "postgres://u:p@h/db")
        monkeypatch.setenv("BYOA_TOKEN", "tk")
        with pytest.raises(RuntimeError, match="session channel"):
            await build_byoa_pgmq_bus(channel="", ship_id="ship-1")

    async def test_requires_ship_id(self, monkeypatch):
        monkeypatch.setenv("BYOA_BUS_DATABASE_URL", "postgres://u:p@h/db")
        monkeypatch.setenv("BYOA_TOKEN", "tk")
        with pytest.raises(RuntimeError, match="BYOA_SHIP_ID"):
            await build_byoa_pgmq_bus(channel="gb_test", ship_id="")

    async def test_requires_byoa_token(self, monkeypatch):
        monkeypatch.setenv("BYOA_BUS_DATABASE_URL", "postgres://u:p@h/db")
        monkeypatch.delenv("BYOA_TOKEN", raising=False)
        with pytest.raises(RuntimeError, match="BYOA_TOKEN"):
            await build_byoa_pgmq_bus(channel="gb_test", ship_id="ship-1")

    async def test_builds_bus_with_wrapper_shim(self, monkeypatch):
        monkeypatch.setenv("BYOA_TOKEN", "real-token")
        fake_pool = MagicMock()
        fake_bus = object()
        with (
            patch(
                "gradientbang.adapters.bus.byoa_pgmq.asyncpg.create_pool",
                new=AsyncMock(return_value=fake_pool),
            ) as pool_ctor,
            patch(
                "gradientbang.adapters.bus.byoa_pgmq._OwnedPgmqBus",
                return_value=fake_bus,
            ) as bus_ctor,
        ):
            bus = await build_byoa_pgmq_bus(
                database_url="postgres://x:y@host/db",
                channel="explicit_chan",
                ship_id="00000000-0000-0000-0000-000000000001",
            )

        assert bus is fake_bus
        pool_ctor.assert_awaited_once()
        kwargs = bus_ctor.call_args.kwargs
        assert isinstance(kwargs["pgmq"], _ByoaPgmqShim)
        assert kwargs["channel"] == "explicit_chan"


@pytest.mark.unit
class TestByoaPgmqShim:
    async def test_create_queue_routes_through_wrapper(self):
        conn = MagicMock()
        conn.execute = AsyncMock()
        shim = _ByoaPgmqShim(
            dsn="postgres://u:p@h/db",
            byoa_token="tk",
            channel="gb_test",
            ship_id="00000000-0000-0000-0000-000000000001",
        )
        shim.pool = _FakePool(conn)

        await shim.create_queue("gb_test_abc")

        conn.execute.assert_awaited_once_with(
            "SELECT public.byoa_bus_create_queue($1, $2, $3::uuid, $4)",
            "tk",
            "gb_test",
            "00000000-0000-0000-0000-000000000001",
            "gb_test_abc",
        )

    async def test_list_queues_is_channel_and_ship_scoped(self):
        conn = MagicMock()
        conn.fetch = AsyncMock(return_value=[("gb_test_a",), ("gb_test_b",)])
        shim = _ByoaPgmqShim(
            dsn="postgres://u:p@h/db",
            byoa_token="tk",
            channel="gb_test",
            ship_id="00000000-0000-0000-0000-000000000001",
        )
        shim.pool = _FakePool(conn)

        assert await shim.list_queues() == ["gb_test_a", "gb_test_b"]
        conn.fetch.assert_awaited_once_with(
            "SELECT public.byoa_bus_list_queues($1, $2, $3::uuid)",
            "tk",
            "gb_test",
            "00000000-0000-0000-0000-000000000001",
        )

    async def test_publish_routes_through_wrapper(self):
        conn = MagicMock()
        conn.fetchval = AsyncMock(return_value=42)
        shim = _ByoaPgmqShim(
            dsn="postgres://u:p@h/db",
            byoa_token="tk",
            channel="gb_test",
            ship_id="00000000-0000-0000-0000-000000000001",
        )
        shim.pool = _FakePool(conn)

        result = await shim.send("gb_test_peer", {"__data__": {"source": "fake"}})

        assert result == 42
        sql, token, channel, ship_id, queue, payload = conn.fetchval.await_args.args
        assert sql == (
            "SELECT public.byoa_bus_publish($1, $2, $3::uuid, $4, $5::jsonb)"
        )
        assert (token, channel, ship_id, queue) == (
            "tk",
            "gb_test",
            "00000000-0000-0000-0000-000000000001",
            "gb_test_peer",
        )
        assert '"fake"' in payload

    async def test_sql_auth_failure_is_wrapped(self):
        conn = MagicMock()
        conn.fetch = AsyncMock(side_effect=asyncpg.PostgresError("invalid_token"))
        shim = _ByoaPgmqShim(
            dsn="postgres://u:p@h/db",
            byoa_token="tk",
            channel="gb_test",
            ship_id="00000000-0000-0000-0000-000000000001",
        )
        shim.pool = _FakePool(conn)

        with pytest.raises(ByoaBusAuthorizationError, match="invalid_token"):
            await shim.list_queues()
