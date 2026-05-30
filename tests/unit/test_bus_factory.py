"""Tests for ``make_subagent_bus`` env-driven transport selection."""

from unittest.mock import AsyncMock, patch

import pytest

from gradientbang.runtime.bus_transport import AsyncQueueBus, make_subagent_bus
from gradientbang.runtime.bus_transport.pgmq import parse_database_url


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

    async def test_pgmq_branch_rejects_whitespace_only_dsn(self, monkeypatch):
        monkeypatch.setenv("SUBAGENT_BUS_TRANSPORT", "pgmq")
        monkeypatch.setenv("SUBAGENT_BUS_DATABASE_URL", "   ")
        with pytest.raises(RuntimeError, match="SUBAGENT_BUS_DATABASE_URL"):
            await make_subagent_bus()

    async def test_pgmq_branch_generates_fresh_channel_per_call(self, monkeypatch):
        # Each bot session gets a server-side opaque UUID-128 channel — same
        # process, two factory calls, two distinct channels.
        monkeypatch.setenv("SUBAGENT_BUS_TRANSPORT", "pgmq")
        monkeypatch.setenv(
            "SUBAGENT_BUS_DATABASE_URL",
            "postgres://user:pass@db.example:5432/postgres",
        )

        seen_channels = []

        async def _capture_build(*, database_url, channel, **_):
            seen_channels.append(channel)
            return object()

        with patch(
            "gradientbang.runtime.bus_transport.pgmq.build_pgmq_bus",
            new=AsyncMock(side_effect=_capture_build),
        ):
            await make_subagent_bus()
            await make_subagent_bus()

        assert len(seen_channels) == 2
        assert seen_channels[0] != seen_channels[1]
        for chan in seen_channels:
            # Shape that wake_agent's CHANNEL_PATTERN and the SQL validator
            # both accept: 'gb_' + 32 lowercase hex chars.
            assert chan.startswith("gb_")
            assert len(chan) == 3 + 32
            assert all(c in "0123456789abcdef" for c in chan[3:])

    async def test_pgmq_branch_publishes_channel_via_env(self, monkeypatch):
        # voice_agent.py and any other process-wide consumer reads the
        # session channel from SUBAGENT_BUS_SESSION_CHANNEL after the
        # factory runs.
        monkeypatch.setenv("SUBAGENT_BUS_TRANSPORT", "pgmq")
        monkeypatch.setenv(
            "SUBAGENT_BUS_DATABASE_URL",
            "postgres://user:pass@db.example:5432/postgres",
        )
        monkeypatch.delenv("SUBAGENT_BUS_SESSION_CHANNEL", raising=False)

        with patch(
            "gradientbang.runtime.bus_transport.pgmq.build_pgmq_bus",
            new=AsyncMock(return_value=object()),
        ):
            await make_subagent_bus()

        import os
        chan = os.environ.get("SUBAGENT_BUS_SESSION_CHANNEL", "")
        assert chan.startswith("gb_") and len(chan) == 3 + 32


@pytest.mark.unit
class TestParseDatabaseUrl:
    def test_full_dsn(self):
        assert parse_database_url(
            "postgresql://alice:s3cret@db.example:6543/gamedb"
        ) == {
            "host": "db.example",
            "port": 6543,
            "database": "gamedb",
            "user": "alice",
            "password": "s3cret",
        }

    def test_url_encoded_credentials_are_decoded(self):
        # Passwords with `@` or `:` must be url-encoded in the DSN.
        parsed = parse_database_url("postgres://u%40e:p%3Aw@host/db")
        assert parsed["user"] == "u@e"
        assert parsed["password"] == "p:w"

    def test_missing_port_defaults_to_5432(self):
        parsed = parse_database_url("postgres://u:p@host/db")
        assert parsed["port"] == 5432

    def test_invalid_scheme_rejected(self):
        with pytest.raises(ValueError, match="scheme"):
            parse_database_url("mysql://u:p@host/db")
