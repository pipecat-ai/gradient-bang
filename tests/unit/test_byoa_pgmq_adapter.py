"""Unit tests for the BYOA-flavored PGMQ bus adapter.

Covers:

- ``_ByoaPgmqShim`` routes every pgmq-equivalent call through the
  ``byoa_bus_*`` SECURITY DEFINER wrappers, threading the HS256 BYOA
  token on every call.
- ``build_byoa_pgmq_bus`` requires DSN + channel + token (strips
  whitespace, fails fast on missing values).
- The factory's ``byoa_pgmq`` branch dispatches to ``build_byoa_pgmq_bus``.
- Round-trip of returned values: ``read_with_poll`` builds proper
  ``Message`` objects from the wrapper's row shape.
"""

from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from gradientbang.adapters.bus.byoa_pgmq import _ByoaPgmqShim, build_byoa_pgmq_bus
from gradientbang.adapters.bus.factory import make_subagent_bus


class _FakeConn:
    """asyncpg-pool-style connection mock with `execute` / `fetchrow` / `fetch`."""

    def __init__(self):
        self.execute = AsyncMock()
        self.fetch = AsyncMock(return_value=[])
        self.fetchrow = AsyncMock(return_value=None)


class _FakePool:
    """Acquire-context-manager stub."""

    def __init__(self):
        self.conn = _FakeConn()

    def acquire(self):
        pool = self

        class _Ctx:
            async def __aenter__(self):
                return pool.conn

            async def __aexit__(self, *_):
                return False

        return _Ctx()


def _shim_with_fake_pool(token: str = "tkn") -> tuple[_ByoaPgmqShim, _FakePool]:
    """Construct a shim with init() bypassed; injects a fake pool."""
    shim = _ByoaPgmqShim(dsn="postgres://u:p@h/db", byoa_token=token)
    fake = _FakePool()
    shim.pool = fake  # type: ignore[assignment]
    return shim, fake


@pytest.mark.unit
class TestShimRoutesThroughWrappers:
    async def test_create_queue_calls_wrapper_with_token(self):
        shim, pool = _shim_with_fake_pool("alice-token")
        await shim.create_queue("test_q")
        pool.conn.execute.assert_awaited_once()
        sql, *args = pool.conn.execute.await_args.args
        assert "byoa_bus_create_queue" in sql
        assert args == ["alice-token", "test_q"]

    async def test_drop_queue_calls_wrapper_with_token(self):
        shim, pool = _shim_with_fake_pool("alice-token")
        await shim.drop_queue("test_q")
        sql, *args = pool.conn.execute.await_args.args
        assert "byoa_bus_drop_queue" in sql
        assert args == ["alice-token", "test_q"]

    async def test_list_queues_calls_wrapper_and_returns_strings(self):
        shim, pool = _shim_with_fake_pool("alice-token")
        pool.conn.fetch.return_value = [("ch_1",), ("ch_2",)]
        result = await shim.list_queues()
        assert result == ["ch_1", "ch_2"]
        sql, *args = pool.conn.fetch.await_args.args
        assert "byoa_bus_list_queues" in sql
        assert args == ["alice-token"]

    async def test_send_calls_publish_with_serialized_jsonb(self):
        shim, pool = _shim_with_fake_pool("alice-token")
        pool.conn.fetchrow.return_value = (42,)
        msg_id = await shim.send("peer_queue", {"hello": "world"})
        assert msg_id == 42
        sql, *args = pool.conn.fetchrow.await_args.args
        assert "byoa_bus_publish" in sql
        # Args: (token, target_queue, json_str)
        assert args[0] == "alice-token"
        assert args[1] == "peer_queue"
        # Third arg is a JSON string of the message.
        assert '"hello":"world"' in args[2]

    async def test_read_with_poll_builds_Message_objects(self):
        from pgmq.messages import Message

        shim, pool = _shim_with_fake_pool("alice-token")
        now = datetime(2026, 5, 12, 12, 0, 0)
        # Wrapper returns rows of (msg_id, read_ct, enqueued_at, vt, message).
        # `message` may come back as a dict (asyncpg auto-decodes jsonb) or
        # as a string depending on the codec — the shim handles both.
        pool.conn.fetch.return_value = [
            (1, 0, now, now, {"k": "v"}),
            (2, 1, now, now, '{"k2": "v2"}'),
        ]
        result = await shim.read_with_poll("my_q", vt=20, qty=5, max_poll_seconds=3)
        sql, *args = pool.conn.fetch.await_args.args
        assert "byoa_bus_subscribe" in sql
        # Args: (token, queue, vt, qty, max_seconds)
        assert args == ["alice-token", "my_q", 20, 5, 3]

        assert len(result) == 2
        assert isinstance(result[0], Message)
        assert result[0].msg_id == 1
        assert result[0].message == {"k": "v"}
        # String fallback path also parsed.
        assert result[1].message == {"k2": "v2"}

    async def test_delete_calls_archive_wrapper(self):
        shim, pool = _shim_with_fake_pool("alice-token")
        pool.conn.fetchrow.return_value = (True,)
        ok = await shim.delete("my_q", 7)
        assert ok is True
        sql, *args = pool.conn.fetchrow.await_args.args
        assert "byoa_bus_archive" in sql
        assert args == ["alice-token", "my_q", 7]


@pytest.mark.unit
class TestBuildByoaPgmqBus:
    async def test_requires_database_url(self, monkeypatch):
        monkeypatch.delenv("SUBAGENT_BUS_DATABASE_URL", raising=False)
        monkeypatch.setenv("SUBAGENT_BUS_CHANNEL", "gb")
        monkeypatch.setenv("BYOA_TOKEN", "tk")
        with pytest.raises(RuntimeError, match="SUBAGENT_BUS_DATABASE_URL"):
            await build_byoa_pgmq_bus()

    async def test_requires_channel(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_DATABASE_URL", "postgres://u:p@h/db")
        monkeypatch.delenv("SUBAGENT_BUS_CHANNEL", raising=False)
        monkeypatch.setenv("BYOA_TOKEN", "tk")
        with pytest.raises(RuntimeError, match="SUBAGENT_BUS_CHANNEL"):
            await build_byoa_pgmq_bus()

    async def test_requires_byoa_token(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_DATABASE_URL", "postgres://u:p@h/db")
        monkeypatch.setenv("SUBAGENT_BUS_CHANNEL", "gb")
        monkeypatch.delenv("BYOA_TOKEN", raising=False)
        with pytest.raises(RuntimeError, match="BYOA_TOKEN"):
            await build_byoa_pgmq_bus()

    async def test_whitespace_only_token_rejected(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_DATABASE_URL", "postgres://u:p@h/db")
        monkeypatch.setenv("SUBAGENT_BUS_CHANNEL", "gb")
        monkeypatch.setenv("BYOA_TOKEN", "   ")
        with pytest.raises(RuntimeError, match="BYOA_TOKEN"):
            await build_byoa_pgmq_bus()

    async def test_builds_bus_with_shim(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_DATABASE_URL", "postgres://u:p@h/db")
        monkeypatch.setenv("SUBAGENT_BUS_CHANNEL", "gb_test")
        monkeypatch.setenv("BYOA_TOKEN", "real-token")
        fake_shim = MagicMock()
        fake_shim.init = AsyncMock()
        fake_bus = object()
        with (
            patch(
                "gradientbang.adapters.bus.byoa_pgmq._ByoaPgmqShim",
                return_value=fake_shim,
            ) as shim_ctor,
            patch(
                "gradientbang.adapters.bus.byoa_pgmq._OwnedPgmqBus",
                return_value=fake_bus,
            ) as bus_ctor,
        ):
            bus = await build_byoa_pgmq_bus()
        assert bus is fake_bus
        shim_ctor.assert_called_once_with(
            dsn="postgres://u:p@h/db",
            byoa_token="real-token",
        )
        fake_shim.init.assert_awaited_once()
        bus_ctor.assert_called_once_with(pgmq=fake_shim, channel="gb_test")


@pytest.mark.unit
class TestFactoryByoaPgmqBranch:
    async def test_factory_dispatches_to_byoa_pgmq(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_TRANSPORT", "byoa_pgmq")
        monkeypatch.setenv("SUBAGENT_BUS_DATABASE_URL", "postgres://u:p@h/db")
        monkeypatch.setenv("SUBAGENT_BUS_CHANNEL", "gb")
        monkeypatch.setenv("BYOA_TOKEN", "tk")
        sentinel = object()
        with patch(
            "gradientbang.adapters.bus.byoa_pgmq.build_byoa_pgmq_bus",
            new=AsyncMock(return_value=sentinel),
        ) as mock_builder:
            bus = await make_subagent_bus()
        assert bus is sentinel
        mock_builder.assert_awaited_once_with()
