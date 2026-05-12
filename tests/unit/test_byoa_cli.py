"""Tests for the ``uv run byoa`` CLI.

Covers the operator-facing surface: arg parsing, env-file resolution,
prompt-file validation (missing / empty / oversize), required-arg plumbing,
explicit channel resolution, and restricted bus-DSN resolution.

The async ``run()`` path mocks the heavy late imports (TaskAgent,
build_byoa_pgmq_bus, AgentRunner) so unit tests don't pull in the full
pipecat dependency graph or hit the network.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from gradientbang.byoa import cli as byoa_cli


def _args(**overrides):
    base = dict(
        command=None,
        prompt_file=None,
        ship_id=None,
        character_id=None,
        channel=None,
        bus_database_url=None,
        env_file=None,
        host="127.0.0.1",
        port=8765,
    )
    base.update(overrides)
    return type("Args", (), base)()


@pytest.mark.unit
class TestPromptValidation:
    def test_missing_file_raises_cli_error(self, tmp_path):
        with pytest.raises(byoa_cli.CliError, match="not found"):
            byoa_cli._load_prompt(tmp_path / "missing.md")

    def test_empty_file_raises_cli_error(self, tmp_path):
        path = tmp_path / "empty.md"
        path.write_text("")
        with pytest.raises(byoa_cli.CliError, match="empty"):
            byoa_cli._load_prompt(path)

    def test_oversize_file_raises_with_size_hint(self, tmp_path):
        path = tmp_path / "huge.md"
        path.write_bytes(b"x" * (byoa_cli.PROMPT_MAX_BYTES + 1))
        with pytest.raises(byoa_cli.CliError, match="8192-byte cap"):
            byoa_cli._load_prompt(path)

    def test_happy_path_returns_decoded_contents(self, tmp_path):
        path = tmp_path / "ok.md"
        path.write_text("Trade aggressively.\n")
        assert byoa_cli._load_prompt(path) == "Trade aggressively.\n"


@pytest.mark.unit
class TestRequiredArgFallbacks:
    def test_cli_arg_wins_over_env(self, monkeypatch):
        monkeypatch.setenv("BYOA_SHIP_ID", "from-env")
        assert byoa_cli._require("from-cli", "BYOA_SHIP_ID", "--ship-id") == "from-cli"

    def test_env_used_when_cli_missing(self, monkeypatch):
        monkeypatch.setenv("BYOA_SHIP_ID", "from-env")
        assert byoa_cli._require(None, "BYOA_SHIP_ID", "--ship-id") == "from-env"

    def test_missing_raises_with_flag_and_env_hint(self, monkeypatch):
        monkeypatch.delenv("BYOA_SHIP_ID", raising=False)
        with pytest.raises(byoa_cli.CliError) as excinfo:
            byoa_cli._require(None, "BYOA_SHIP_ID", "--ship-id")
        assert "--ship-id" in str(excinfo.value)
        assert "BYOA_SHIP_ID" in str(excinfo.value)


@pytest.mark.unit
class TestBusInputResolution:
    def test_channel_cli_arg_wins_over_env(self, monkeypatch):
        monkeypatch.setenv("BYOA_CHANNEL", "from_env")
        assert byoa_cli._resolve_channel("from_cli") == "from_cli"

    def test_channel_env_used_when_arg_missing(self, monkeypatch):
        monkeypatch.setenv("BYOA_CHANNEL", "from_env")
        assert byoa_cli._resolve_channel(None) == "from_env"

    def test_missing_channel_raises(self, monkeypatch):
        monkeypatch.delenv("BYOA_CHANNEL", raising=False)
        with pytest.raises(byoa_cli.CliError, match="--channel"):
            byoa_cli._resolve_channel(None)

    def test_wake_injected_bus_database_url_wins(self):
        assert (
            byoa_cli._resolve_bus_database_url("postgres://dev", "postgres://wake")
            == "postgres://wake"
        )

    def test_cli_bus_database_url_used_for_dev(self):
        assert (
            byoa_cli._resolve_bus_database_url("postgres://dev", None)
            == "postgres://dev"
        )

    def test_missing_bus_database_url_raises(self):
        with pytest.raises(byoa_cli.CliError, match="--bus-database-url"):
            byoa_cli._resolve_bus_database_url(None, None)


@pytest.mark.unit
class TestParserModes:
    def test_legacy_invocation_is_normalized_to_run(self):
        args = byoa_cli._parse_args(["--prompt-file", "./prompt.md"])
        assert args.command == "run"
        assert args.prompt_file == "./prompt.md"

    def test_run_subcommand(self):
        args = byoa_cli._parse_args(["run", "--prompt-file", "./prompt.md"])
        assert args.command == "run"
        assert args.prompt_file == "./prompt.md"

    def test_serve_subcommand_defaults(self):
        args = byoa_cli._parse_args(["serve", "--prompt-file", "./prompt.md"])
        assert args.command == "serve"
        assert args.host == "127.0.0.1"
        assert args.port == 8765


@pytest.mark.unit
class TestWakeDaemon:
    def _daemon(self, tmp_path, monkeypatch):
        prompt_path = tmp_path / "prompt.md"
        prompt_path.write_text("hi")
        env_path = tmp_path / ".env.byoa"
        env_path.write_text("BYOA_TOKEN=tok\n")
        monkeypatch.setenv("BYOA_TOKEN", "tok")
        return byoa_cli._WakeDaemon(
            prompt_file=prompt_path,
            env_file=env_path,
            ship_id="00000000-0000-0000-0000-000000000001",
            character_id="00000000-0000-0000-0000-000000000002",
            edge_api_token="secret",
        )

    def _payload(self, **overrides):
        payload = {
            "request_id": "req-1",
            "ship_id": "00000000-0000-0000-0000-000000000001",
            "channel": "gb_dev_abc",
            "task_id": "00000000-0000-0000-0000-000000000003",
            "env": {
                "BYOA_CHANNEL": "gb_dev_abc",
                "BYOA_SHIP_ID": "00000000-0000-0000-0000-000000000001",
                "BYOA_BUS_DATABASE_URL": "postgres://byoa:secret@db/postgres",
            },
        }
        payload.update(overrides)
        return payload

    def test_wake_rejects_invalid_secret(self, tmp_path, monkeypatch):
        daemon = self._daemon(tmp_path, monkeypatch)
        status, body = daemon.handle_wake(
            authorization="Bearer wrong",
            payload=self._payload(),
        )
        assert status == 401
        assert body["error"] == "unauthorized"

    def test_wake_rejects_ship_mismatch(self, tmp_path, monkeypatch):
        daemon = self._daemon(tmp_path, monkeypatch)
        status, body = daemon.handle_wake(
            authorization="Bearer secret",
            payload=self._payload(ship_id="00000000-0000-0000-0000-000000000099"),
        )
        assert status == 403
        assert body["error"] == "ship_id_mismatch"

    def test_duplicate_wake_is_idempotent(self, tmp_path, monkeypatch):
        daemon = self._daemon(tmp_path, monkeypatch)
        proc = MagicMock()
        proc.pid = 123
        proc.poll.return_value = None
        daemon._processes["00000000-0000-0000-0000-000000000003"] = proc

        status, body = daemon.handle_wake(
            authorization="Bearer secret",
            payload=self._payload(),
        )

        assert status == 202
        assert body["duplicate"] is True
        assert body["pid"] == 123

    def test_successful_wake_spawns_child_with_runtime_env(self, tmp_path, monkeypatch):
        daemon = self._daemon(tmp_path, monkeypatch)
        proc = MagicMock()
        proc.pid = 456
        proc.poll.return_value = None

        with patch("gradientbang.byoa.cli.subprocess.Popen", return_value=proc) as popen:
            status, body = daemon.handle_wake(
                authorization="Bearer secret",
                payload=self._payload(),
            )

        assert status == 202
        assert body["duplicate"] is False
        assert body["pid"] == 456
        cmd = popen.call_args.args[0]
        env = popen.call_args.kwargs["env"]
        assert cmd[:3] == [byoa_cli.sys.executable, "-m", "gradientbang.byoa.cli"]
        assert "run" in cmd
        assert env["BYOA_CHANNEL"] == "gb_dev_abc"
        assert env["BYOA_SHIP_ID"] == "00000000-0000-0000-0000-000000000001"
        assert env["BYOA_BUS_DATABASE_URL"] == "postgres://byoa:secret@db/postgres"
        assert env["BYOA_TASK_ID"] == "00000000-0000-0000-0000-000000000003"


@pytest.mark.unit
class TestRunLoop:
    async def _mocks_for_session(self):
        """Build the patched dependencies for a single-session run."""
        mock_runner = MagicMock()
        mock_runner.add_agent = AsyncMock()
        mock_runner.run = AsyncMock()
        mock_runner_cls = MagicMock(return_value=mock_runner)

        mock_task_agent_cls = MagicMock(return_value="task-agent")
        fake_bus = MagicMock()
        fake_bus.stop = AsyncMock()
        mock_build_bus = AsyncMock(return_value=fake_bus)

        return mock_runner, mock_runner_cls, mock_task_agent_cls, mock_build_bus

    async def test_runs_on_explicit_channel_and_dev_bus_dsn(self, tmp_path, monkeypatch):
        prompt_path = tmp_path / "prompt.md"
        prompt_path.write_text("hi")
        monkeypatch.setenv("BYOA_TOKEN", "tok")

        (
            mock_runner,
            mock_runner_cls,
            mock_task_agent_cls,
            mock_build_bus,
        ) = await self._mocks_for_session()

        with (
            patch("pipecat_subagents.runner.AgentRunner", mock_runner_cls),
            patch(
                "gradientbang.pipecat_server.subagents.task_agent.TaskAgent",
                mock_task_agent_cls,
            ),
            patch(
                "gradientbang.adapters.bus.byoa_pgmq.build_byoa_pgmq_bus",
                mock_build_bus,
            ),
        ):
            exit_code = await byoa_cli.run(
                _args(
                    prompt_file=str(prompt_path),
                    ship_id="ship-1",
                    character_id="char-1",
                    channel="bot_chan_1",
                    bus_database_url="postgres://byoa:secret@db/postgres",
                    env_file=str(tmp_path / "absent.env"),
                )
            )

        assert exit_code == 0
        mock_build_bus.assert_awaited_once()
        bus_kwargs = mock_build_bus.await_args.kwargs
        assert bus_kwargs["channel"] == "bot_chan_1"
        assert bus_kwargs["ship_id"] == "ship-1"
        assert bus_kwargs["database_url"] == "postgres://byoa:secret@db/postgres"
        mock_runner_cls.assert_called_once_with(
            name="byoa_runner_ship-1", bus=mock_build_bus.return_value, handle_sigint=True
        )
        mock_runner.run.assert_awaited_once()
        # Bus must be stopped after the session completes.
        mock_build_bus.return_value.stop.assert_awaited_once()

    async def test_wake_injected_bus_dsn_wins_over_dev_flag(self, tmp_path, monkeypatch):
        prompt_path = tmp_path / "prompt.md"
        prompt_path.write_text("hi")
        monkeypatch.setenv("BYOA_TOKEN", "tok")
        monkeypatch.setenv("BYOA_BUS_DATABASE_URL", "postgres://wake:secret@db/db")

        (
            mock_runner,
            mock_runner_cls,
            mock_task_agent_cls,
            mock_build_bus,
        ) = await self._mocks_for_session()

        with (
            patch("pipecat_subagents.runner.AgentRunner", mock_runner_cls),
            patch(
                "gradientbang.pipecat_server.subagents.task_agent.TaskAgent",
                mock_task_agent_cls,
            ),
            patch(
                "gradientbang.adapters.bus.byoa_pgmq.build_byoa_pgmq_bus",
                mock_build_bus,
            ),
        ):
            exit_code = await byoa_cli.run(
                _args(
                    prompt_file=str(prompt_path),
                    ship_id="ship-1",
                    character_id="char-1",
                    channel="bot_chan_1",
                    bus_database_url="postgres://dev:secret@db/db",
                    env_file=str(tmp_path / "absent.env"),
                )
            )

        assert exit_code == 0
        mock_build_bus.assert_awaited_once()
        assert (
            mock_build_bus.await_args.kwargs["database_url"]
            == "postgres://wake:secret@db/db"
        )
        mock_runner.run.assert_awaited_once()
        mock_build_bus.return_value.stop.assert_awaited_once()

    async def test_missing_token_raises_cli_error(self, tmp_path, monkeypatch):
        prompt_path = tmp_path / "prompt.md"
        prompt_path.write_text("hi")
        monkeypatch.delenv("BYOA_TOKEN", raising=False)
        with pytest.raises(byoa_cli.CliError, match="BYOA_TOKEN"):
            await byoa_cli.run(
                _args(
                    prompt_file=str(prompt_path),
                    ship_id="ship-1",
                    character_id="char-1",
                    channel="bot_chan_1",
                    bus_database_url="postgres://byoa:secret@db/postgres",
                    env_file=str(tmp_path / "absent.env"),
                )
            )

    async def test_missing_bus_database_url_raises_cli_error(self, tmp_path, monkeypatch):
        prompt_path = tmp_path / "prompt.md"
        prompt_path.write_text("hi")
        monkeypatch.setenv("BYOA_TOKEN", "tok")
        monkeypatch.delenv("BYOA_BUS_DATABASE_URL", raising=False)
        with pytest.raises(byoa_cli.CliError, match="--bus-database-url"):
            await byoa_cli.run(
                _args(
                    prompt_file=str(prompt_path),
                    ship_id="ship-1",
                    character_id="char-1",
                    channel="bot_chan_1",
                    env_file=str(tmp_path / "absent.env"),
                )
            )
