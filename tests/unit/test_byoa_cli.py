"""Tests for the ``uv run byoa`` CLI.

Covers the operator-facing surface: arg parsing, env-file resolution,
prompt-file validation (missing / empty / oversize), required-arg
plumbing, and the new claim-loop behaviour:

- Polling until a session is allocated, with shutdown short-circuit.
- Distinguishing 401 (token issue) and 403 (ship authz) as CliError.
- ``lifecycle_hint=single_task`` exits after one task; ``idle_loop``
  resumes polling.

The async ``run()`` path mocks the heavy late imports (TaskAgent,
build_byoa_pgmq_bus, AgentRunner, httpx.AsyncClient) so unit tests
don't pull in the full pipecat dependency graph or hit the network.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
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


class _FakeResponse:
    def __init__(self, *, status_code: int, json_body: dict | None = None) -> None:
        self.status_code = status_code
        self._json = json_body or {}
        self.text = ""

    def json(self) -> dict:
        return self._json


class _ScriptedClient:
    """``httpx.AsyncClient``-shaped mock that returns a scripted sequence
    of POST responses. Each ``post`` call consumes the next entry. Once
    exhausted, raises so tests can detect over-polling."""

    def __init__(self, responses: list) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, dict, dict]] = []

    async def __aenter__(self) -> "_ScriptedClient":
        return self

    async def __aexit__(self, *_) -> None:
        return None

    async def post(self, url: str, *, json: dict, headers: dict, timeout):
        self.calls.append((url, json, headers))
        if not self.responses:
            raise AssertionError("scripted client exhausted")
        resp = self.responses.pop(0)
        if isinstance(resp, Exception):
            raise resp
        return resp


@pytest.mark.unit
class TestCallClaim:
    async def test_200_returns_decoded_body(self):
        client = _ScriptedClient(
            [_FakeResponse(status_code=200, json_body={"channel": "chan_1"})]
        )
        body = await byoa_cli._call_claim(client, "https://x", "token", "ship-1")
        assert body == {"channel": "chan_1"}
        url, payload, headers = client.calls[0]
        assert url == "https://x"
        assert payload == {"ship_id": "ship-1"}
        assert headers["Authorization"] == "Bearer token"

    async def test_401_raises_cli_error(self):
        client = _ScriptedClient([_FakeResponse(status_code=401)])
        with pytest.raises(byoa_cli.CliError, match="401"):
            await byoa_cli._call_claim(client, "https://x", "token", "ship-1")

    async def test_403_raises_cli_error(self):
        client = _ScriptedClient([_FakeResponse(status_code=403)])
        with pytest.raises(byoa_cli.CliError, match="403"):
            await byoa_cli._call_claim(client, "https://x", "token", "ship-1")

    async def test_404_raises_cli_error(self):
        client = _ScriptedClient([_FakeResponse(status_code=404)])
        with pytest.raises(byoa_cli.CliError, match="404"):
            await byoa_cli._call_claim(client, "https://x", "token", "ship-1")

    async def test_5xx_returns_empty_for_retry(self):
        client = _ScriptedClient([_FakeResponse(status_code=503)])
        body = await byoa_cli._call_claim(client, "https://x", "token", "ship-1")
        assert body == {}

    async def test_network_error_returns_empty_for_retry(self):
        client = _ScriptedClient([httpx.HTTPError("boom")])
        body = await byoa_cli._call_claim(client, "https://x", "token", "ship-1")
        assert body == {}


@pytest.mark.unit
class TestWaitForSession:
    async def test_polls_until_channel_present(self):
        client = _ScriptedClient(
            [
                _FakeResponse(status_code=200, json_body={"channel": None}),
                _FakeResponse(status_code=200, json_body={"channel": None}),
                _FakeResponse(
                    status_code=200,
                    json_body={
                        "channel": "bot_chan_1",
                        "current_task_id": "task-1",
                        "lifecycle_hint": "idle_loop",
                    },
                ),
            ]
        )
        shutdown = asyncio.Event()
        session = await byoa_cli._wait_for_session(
            client, "https://x", "token", "ship-1", 0.01, shutdown
        )
        assert session is not None
        assert session["channel"] == "bot_chan_1"
        # All three calls consumed.
        assert len(client.calls) == 3

    async def test_shutdown_short_circuits_polling(self):
        client = _ScriptedClient([_FakeResponse(status_code=200, json_body={"channel": None})] * 100)
        shutdown = asyncio.Event()

        async def trigger_after_first() -> None:
            await asyncio.sleep(0.05)
            shutdown.set()

        trigger = asyncio.create_task(trigger_after_first())
        session = await byoa_cli._wait_for_session(
            client, "https://x", "token", "ship-1", 0.01, shutdown
        )
        await trigger
        assert session is None


@pytest.mark.unit
class TestRunLoop:
    async def _mocks_for_session(self, *, lifecycle_hint: str):
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

    async def test_single_task_lifecycle_exits_after_one_session(
        self, tmp_path, monkeypatch
    ):
        prompt_path = tmp_path / "prompt.md"
        prompt_path.write_text("hi")
        monkeypatch.setenv("BYOA_TOKEN", "tok")
        monkeypatch.setenv("BYOA_CLAIM_ENDPOINT_URL", "https://example/claim")
        monkeypatch.setenv("BYOA_POLL_INTERVAL_SECONDS", "0.01")

        client = _ScriptedClient(
            [
                _FakeResponse(
                    status_code=200,
                    json_body={
                        "channel": "bot_chan_1",
                        "current_task_id": "t1",
                        "lifecycle_hint": "single_task",
                    },
                )
            ]
        )

        (
            mock_runner,
            mock_runner_cls,
            mock_task_agent_cls,
            mock_build_bus,
        ) = await self._mocks_for_session(lifecycle_hint="single_task")

        with (
            patch("httpx.AsyncClient", return_value=client),
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
                    env_file=str(tmp_path / "absent.env"),
                )
            )

        assert exit_code == 0
        # Exactly one claim call, one session, then exit.
        assert len(client.calls) == 1
        mock_build_bus.assert_awaited_once()
        bus_kwargs = mock_build_bus.await_args.kwargs
        assert bus_kwargs["channel"] == "bot_chan_1"
        mock_runner_cls.assert_called_once_with(
            name="byoa_runner_ship-1", bus=mock_build_bus.return_value, handle_sigint=True
        )
        mock_runner.run.assert_awaited_once()
        # Bus must be stopped after the session completes.
        mock_build_bus.return_value.stop.assert_awaited_once()

    async def test_idle_loop_resumes_polling_after_task(self, tmp_path, monkeypatch):
        prompt_path = tmp_path / "prompt.md"
        prompt_path.write_text("hi")
        monkeypatch.setenv("BYOA_TOKEN", "tok")
        monkeypatch.setenv("BYOA_CLAIM_ENDPOINT_URL", "https://example/claim")
        monkeypatch.setenv("BYOA_POLL_INTERVAL_SECONDS", "0.01")

        # First claim: session allocated (idle_loop). Second claim: session
        # cleared, return null. After two more polls we'll trigger shutdown.
        client = _ScriptedClient(
            [
                _FakeResponse(
                    status_code=200,
                    json_body={
                        "channel": "bot_chan_1",
                        "current_task_id": "t1",
                        "lifecycle_hint": "idle_loop",
                    },
                ),
                _FakeResponse(status_code=200, json_body={"channel": None}),
                _FakeResponse(status_code=200, json_body={"channel": None}),
                _FakeResponse(status_code=200, json_body={"channel": None}),
                # If the run loop didn't stop, more responses are needed.
                _FakeResponse(status_code=200, json_body={"channel": None}),
                _FakeResponse(status_code=200, json_body={"channel": None}),
            ]
        )

        (
            mock_runner,
            mock_runner_cls,
            mock_task_agent_cls,
            mock_build_bus,
        ) = await self._mocks_for_session(lifecycle_hint="idle_loop")

        # Set shutdown after a brief delay so the second poll loop exits.
        async def shutdown_after():
            await asyncio.sleep(0.2)
            for s in asyncio.all_tasks():
                pass
            # Send SIGINT-equivalent: write to shutdown via the CLI's
            # internal event. We can't easily reach it from outside, so
            # we accept that the test will set a max iteration via the
            # scripted client running out.
            return

        with (
            patch("httpx.AsyncClient", return_value=client),
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
            # Race: run the loop with a timeout that will force it to
            # raise when the client exhausts (proving idle_loop kept
            # polling), and the run() function naturally bails when the
            # scripted client raises AssertionError.
            with pytest.raises(AssertionError, match="scripted client exhausted"):
                await byoa_cli.run(
                    _args(
                        prompt_file=str(prompt_path),
                        ship_id="ship-1",
                        character_id="char-1",
                        env_file=str(tmp_path / "absent.env"),
                    )
                )

        # The first claim returned a channel (session started); subsequent
        # polls returned null. The run loop continued polling = idle_loop
        # behavior is wired.
        mock_build_bus.assert_awaited_once()
        mock_runner.run.assert_awaited_once()
        mock_build_bus.return_value.stop.assert_awaited_once()
        # Several claim calls happened (1 session + several polls).
        assert len(client.calls) >= 2

    async def test_missing_token_raises_cli_error(self, tmp_path, monkeypatch):
        prompt_path = tmp_path / "prompt.md"
        prompt_path.write_text("hi")
        monkeypatch.delenv("BYOA_TOKEN", raising=False)
        monkeypatch.setenv("BYOA_CLAIM_ENDPOINT_URL", "https://example/claim")
        with pytest.raises(byoa_cli.CliError, match="BYOA_TOKEN"):
            await byoa_cli.run(
                _args(
                    prompt_file=str(prompt_path),
                    ship_id="ship-1",
                    character_id="char-1",
                    env_file=str(tmp_path / "absent.env"),
                )
            )

    async def test_missing_claim_url_raises_cli_error(self, tmp_path, monkeypatch):
        prompt_path = tmp_path / "prompt.md"
        prompt_path.write_text("hi")
        monkeypatch.setenv("BYOA_TOKEN", "tok")
        monkeypatch.delenv("BYOA_CLAIM_ENDPOINT_URL", raising=False)
        with pytest.raises(byoa_cli.CliError, match="BYOA_CLAIM_ENDPOINT_URL"):
            await byoa_cli.run(
                _args(
                    prompt_file=str(prompt_path),
                    ship_id="ship-1",
                    character_id="char-1",
                    env_file=str(tmp_path / "absent.env"),
                )
            )
