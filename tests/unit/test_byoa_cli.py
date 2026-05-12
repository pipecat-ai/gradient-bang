"""Tests for the ``uv run byoa`` CLI (Phase 3 4/N).

Covers the operator-facing surface: arg parsing, env-file resolution,
prompt-file validation (missing / empty / oversize), and the happy path
that constructs a TaskAgent with ``custom_prompt`` threaded.

The async ``run()`` is mocked at the import boundary (TaskAgent /
make_subagent_bus / AgentRunner) so unit tests don't pull in the full
pipecat dependency graph; the assertions verify wiring, not runtime
behaviour.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from gradientbang.byoa import cli as byoa_cli


def _args(**overrides):
    base = dict(
        prompt_file=None,
        ship_id=None,
        character_id=None,
        env_file=None,
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

    def test_whitespace_only_file_raises_cli_error(self, tmp_path):
        path = tmp_path / "blank.md"
        path.write_text("   \n\n\t  ")
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
class TestEnvFileResolution:
    def test_default_is_dot_env_dot_byoa(self):
        assert byoa_cli._resolve_env_file(None) == Path(".env.byoa")

    def test_override_used_when_set(self):
        assert byoa_cli._resolve_env_file("/tmp/x.env") == Path("/tmp/x.env")


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

    def test_whitespace_env_treated_as_missing(self, monkeypatch):
        monkeypatch.setenv("BYOA_SHIP_ID", "   ")
        with pytest.raises(byoa_cli.CliError):
            byoa_cli._require(None, "BYOA_SHIP_ID", "--ship-id")


@pytest.mark.unit
class TestRunHappyPath:
    async def test_constructs_taskagent_with_custom_prompt_and_starts_runner(
        self, tmp_path, monkeypatch
    ):
        # Required env (won't be touched once the late imports are mocked
        # below — TaskAgent + bus + runner never see real env).
        monkeypatch.setenv("BYOA_CHARACTER_ID", "char-operator-1")
        monkeypatch.setenv("BYOA_SHIP_ID", "ship-pseudo-1")

        prompt_path = tmp_path / "prompt.md"
        prompt_path.write_text("Always greet the user first.")

        # Mock the heavy imports the CLI does inside run() so we can run
        # in a unit-test context without pipecat / asyncpg.
        mock_runner = MagicMock()
        mock_runner.add_agent = AsyncMock()
        mock_runner.run = AsyncMock()
        mock_runner_cls = MagicMock(return_value=mock_runner)

        mock_task_agent_cls = MagicMock(return_value="task-agent-instance")
        mock_make_bus = AsyncMock(return_value="fake-bus")

        mock_config = MagicMock()
        mock_config.validate_heartbeat_against_server = MagicMock(return_value=None)
        mock_config_cls = MagicMock()
        mock_config_cls.from_env = MagicMock(return_value=mock_config)

        with (
            patch("pipecat_subagents.runner.AgentRunner", mock_runner_cls),
            patch(
                "gradientbang.pipecat_server.subagents.task_agent.TaskAgent",
                mock_task_agent_cls,
            ),
            patch("gradientbang.adapters.bus.make_subagent_bus", mock_make_bus),
            patch("gradientbang.byoa.config.ByoaAgentConfig", mock_config_cls),
        ):
            exit_code = await byoa_cli.run(
                _args(
                    prompt_file=str(prompt_path),
                    ship_id="ship-pseudo-1",
                    character_id="char-operator-1",
                    env_file=str(tmp_path / "nonexistent.env"),
                )
            )

        assert exit_code == 0
        mock_make_bus.assert_awaited_once()
        # TaskAgent was constructed with the documented bus identity +
        # custom prompt thread + corp-ship flag set + actor identity in
        # task_metadata.
        mock_task_agent_cls.assert_called_once()
        ctor_args = mock_task_agent_cls.call_args
        agent_name = ctor_args.args[0]
        assert agent_name == "byoa_ship-pseudo-1"
        assert ctor_args.kwargs["character_id"] == "ship-pseudo-1"
        assert ctor_args.kwargs["is_corp_ship"] is True
        assert ctor_args.kwargs["custom_prompt"] == "Always greet the user first."
        assert (
            ctor_args.kwargs["task_metadata"]["actor_character_id"]
            == "char-operator-1"
        )
        # Agent was registered with the runner and then runner.run() was
        # awaited.
        mock_runner.add_agent.assert_awaited_once_with("task-agent-instance")
        mock_runner.run.assert_awaited_once()

    async def test_missing_prompt_file_raises_cli_error(self, tmp_path, monkeypatch):
        monkeypatch.setenv("BYOA_CHARACTER_ID", "char-1")
        monkeypatch.setenv("BYOA_SHIP_ID", "ship-1")
        with pytest.raises(byoa_cli.CliError, match="not found"):
            await byoa_cli.run(
                _args(
                    prompt_file=str(tmp_path / "missing.md"),
                    ship_id="ship-1",
                    character_id="char-1",
                    env_file=str(tmp_path / "absent.env"),
                )
            )

    async def test_missing_required_arg_raises_cli_error(self, tmp_path, monkeypatch):
        monkeypatch.delenv("BYOA_SHIP_ID", raising=False)
        monkeypatch.delenv("BYOA_CHARACTER_ID", raising=False)
        prompt_path = tmp_path / "prompt.md"
        prompt_path.write_text("ok")
        with pytest.raises(byoa_cli.CliError, match="--ship-id"):
            await byoa_cli.run(
                _args(
                    prompt_file=str(prompt_path),
                    ship_id=None,
                    character_id="char-1",
                    env_file=str(tmp_path / "absent.env"),
                )
            )


@pytest.mark.unit
class TestEnvFileLoading:
    async def test_loads_dotenv_when_file_exists(self, tmp_path, monkeypatch):
        env_path = tmp_path / ".env.byoa"
        env_path.write_text(
            "BYOA_SHIP_ID=from-file\nBYOA_CHARACTER_ID=char-from-file\n"
        )
        # Ensure shell env doesn't shadow the file's values for this test.
        monkeypatch.delenv("BYOA_SHIP_ID", raising=False)
        monkeypatch.delenv("BYOA_CHARACTER_ID", raising=False)
        prompt_path = tmp_path / "prompt.md"
        prompt_path.write_text("hi")

        mock_runner = MagicMock(add_agent=AsyncMock(), run=AsyncMock())
        with (
            patch("pipecat_subagents.runner.AgentRunner", return_value=mock_runner),
            patch(
                "gradientbang.pipecat_server.subagents.task_agent.TaskAgent",
                return_value=object(),
            ) as mock_task_agent_cls,
            patch(
                "gradientbang.adapters.bus.make_subagent_bus",
                new=AsyncMock(return_value=object()),
            ),
            patch(
                "gradientbang.byoa.config.ByoaAgentConfig",
                MagicMock(from_env=MagicMock(return_value=MagicMock(
                    validate_heartbeat_against_server=MagicMock(return_value=None)
                ))),
            ),
        ):
            await byoa_cli.run(
                _args(
                    prompt_file=str(prompt_path),
                    ship_id=None,
                    character_id=None,
                    env_file=str(env_path),
                )
            )
        # The dotenv-loaded values were picked up.
        ctor = mock_task_agent_cls.call_args
        assert ctor.kwargs["character_id"] == "from-file"
        assert ctor.kwargs["task_metadata"]["actor_character_id"] == "char-from-file"

    async def test_shell_env_overrides_file(self, tmp_path, monkeypatch):
        env_path = tmp_path / ".env.byoa"
        env_path.write_text("BYOA_SHIP_ID=from-file\n")
        # Shell env value should win — standard dotenv behavior, important
        # for in-place rotation without rewriting the file.
        monkeypatch.setenv("BYOA_SHIP_ID", "from-shell")
        monkeypatch.setenv("BYOA_CHARACTER_ID", "char-shell")
        prompt_path = tmp_path / "prompt.md"
        prompt_path.write_text("hi")

        mock_runner = MagicMock(add_agent=AsyncMock(), run=AsyncMock())
        with (
            patch("pipecat_subagents.runner.AgentRunner", return_value=mock_runner),
            patch(
                "gradientbang.pipecat_server.subagents.task_agent.TaskAgent",
                return_value=object(),
            ) as mock_task_agent_cls,
            patch(
                "gradientbang.adapters.bus.make_subagent_bus",
                new=AsyncMock(return_value=object()),
            ),
            patch(
                "gradientbang.byoa.config.ByoaAgentConfig",
                MagicMock(from_env=MagicMock(return_value=MagicMock(
                    validate_heartbeat_against_server=MagicMock(return_value=None)
                ))),
            ),
        ):
            await byoa_cli.run(
                _args(
                    prompt_file=str(prompt_path),
                    ship_id=None,
                    character_id=None,
                    env_file=str(env_path),
                )
            )
        ctor = mock_task_agent_cls.call_args
        assert ctor.kwargs["character_id"] == "from-shell"
