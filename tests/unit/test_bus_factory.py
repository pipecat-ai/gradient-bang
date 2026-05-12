"""Tests for ``make_subagent_bus`` env-driven transport selection."""

from unittest.mock import AsyncMock, patch

import pytest

from gradientbang.adapters.bus import AsyncQueueBus, make_subagent_bus
from gradientbang.adapters.bus.pgmq import parse_database_url


@pytest.mark.unit
class TestMakeSubagentBus:
    async def test_unset_env_returns_local_bus(self, monkeypatch):
        monkeypatch.delenv("SUBAGENT_BUS_TRANSPORT", raising=False)
        assert isinstance(await make_subagent_bus(), AsyncQueueBus)

    async def test_explicit_local_returns_local_bus(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_TRANSPORT", "local")
        assert isinstance(await make_subagent_bus(), AsyncQueueBus)

    async def test_transport_value_is_case_insensitive_and_trimmed(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_TRANSPORT", "  LOCAL  ")
        assert isinstance(await make_subagent_bus(), AsyncQueueBus)

    async def test_invalid_transport_raises_with_helpful_message(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_TRANSPORT", "carrier-pigeon")
        with pytest.raises(ValueError, match="carrier-pigeon"):
            await make_subagent_bus()

    async def test_pgmq_branch_requires_database_url(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_TRANSPORT", "pgmq")
        monkeypatch.delenv("SUBAGENT_BUS_DATABASE_URL", raising=False)
        with pytest.raises(RuntimeError, match="SUBAGENT_BUS_DATABASE_URL"):
            await make_subagent_bus()

    async def test_pgmq_branch_requires_channel(self, monkeypatch):
        # A missing channel must fail loud — falling through to a shared
        # default in production would cross-talk bus traffic between
        # bots sharing a database (worst case: broadcast game events
        # bleeding into the wrong session).
        monkeypatch.setenv("SUBAGENT_BUS_TRANSPORT", "pgmq")
        monkeypatch.setenv(
            "SUBAGENT_BUS_DATABASE_URL",
            "postgres://u:p@host:5432/postgres",
        )
        monkeypatch.delenv("SUBAGENT_BUS_CHANNEL", raising=False)
        with pytest.raises(RuntimeError, match="SUBAGENT_BUS_CHANNEL"):
            await make_subagent_bus()

    async def test_pgmq_branch_rejects_whitespace_only_channel(self, monkeypatch):
        # Whitespace-only would slip past `not chan` and PgmqBus's
        # _sanitize_channel would map it to "_____" — exactly the shared
        # default the required-channel rule is supposed to prevent.
        monkeypatch.setenv("SUBAGENT_BUS_TRANSPORT", "pgmq")
        monkeypatch.setenv(
            "SUBAGENT_BUS_DATABASE_URL",
            "postgres://u:p@host:5432/postgres",
        )
        monkeypatch.setenv("SUBAGENT_BUS_CHANNEL", "   ")
        with pytest.raises(RuntimeError, match="SUBAGENT_BUS_CHANNEL"):
            await make_subagent_bus()

    async def test_pgmq_branch_rejects_whitespace_only_dsn(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_TRANSPORT", "pgmq")
        monkeypatch.setenv("SUBAGENT_BUS_DATABASE_URL", "   ")
        monkeypatch.setenv("SUBAGENT_BUS_CHANNEL", "gb_test")
        with pytest.raises(RuntimeError, match="SUBAGENT_BUS_DATABASE_URL"):
            await make_subagent_bus()

    async def test_pgmq_branch_builds_pgmq_bus(self, monkeypatch):
        # Mock the PGMQueue + PgmqBus so we don't need a real database.
        # We just want to prove the factory wires the env-driven config
        # (DSN + channel) into ``build_pgmq_bus``.
        monkeypatch.setenv("SUBAGENT_BUS_TRANSPORT", "pgmq")
        monkeypatch.setenv(
            "SUBAGENT_BUS_DATABASE_URL",
            "postgres://user:pass@db.example:5432/postgres",
        )
        monkeypatch.setenv("SUBAGENT_BUS_CHANNEL", "test_channel")

        fake_queue = AsyncMock()
        fake_bus_instance = object()
        with (
            patch(
                "gradientbang.adapters.bus.pgmq.PGMQueue",
                return_value=fake_queue,
            ) as queue_ctor,
            patch(
                "gradientbang.adapters.bus.pgmq._OwnedPgmqBus",
                return_value=fake_bus_instance,
            ) as bus_ctor,
        ):
            bus = await make_subagent_bus()

        assert bus is fake_bus_instance
        # Verify the DSN was parsed and forwarded correctly.
        queue_ctor.assert_called_once_with(
            host="db.example",
            port="5432",
            database="postgres",
            username="user",
            password="pass",
        )
        fake_queue.init.assert_awaited_once()
        # Channel from env propagated, plus the NotGiven-aware serializer.
        bus_ctor.assert_called_once()
        kwargs = bus_ctor.call_args.kwargs
        assert kwargs["pgmq"] is fake_queue
        assert kwargs["channel"] == "test_channel"
        from gradientbang.adapters.bus.serializer import BusJSONSerializer
        assert isinstance(kwargs["serializer"], BusJSONSerializer)


@pytest.mark.unit
class TestParseDatabaseUrl:
    def test_full_dsn(self):
        assert parse_database_url(
            "postgresql://alice:s3cret@db.example:6543/gamedb"
        ) == {
            "host": "db.example",
            "port": "6543",
            "database": "gamedb",
            "username": "alice",
            "password": "s3cret",
        }

    def test_url_encoded_credentials_are_decoded(self):
        # Passwords with `@` or `:` must be url-encoded in the DSN.
        parsed = parse_database_url("postgres://u%40e:p%3Aw@host/db")
        assert parsed["username"] == "u@e"
        assert parsed["password"] == "p:w"

    def test_missing_port_defaults_to_5432(self):
        parsed = parse_database_url("postgres://u:p@host/db")
        assert parsed["port"] == "5432"

    def test_invalid_scheme_rejected(self):
        with pytest.raises(ValueError, match="scheme"):
            parse_database_url("mysql://u:p@host/db")
