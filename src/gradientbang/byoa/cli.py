"""``uv run byoa`` entry point.

Runs a single BYOA TaskAgent against a single corp ship. The flow is:

1. Receive a player/session PGMQ channel from wake or ``--channel``.
2. Receive a restricted BYOA bus DSN from wake or ``--bus-database-url``.
3. Join the wrapper-backed PGMQ bus and run continuously. Presence and tasks
   travel over the bus.

Local dev can also run ``uv run byoa serve``. That starts a localhost wake
provider which the ``wake_agent`` edge function can call with ``WAKE_TARGET=http``.

Configuration is env-driven from ``./.env.byoa`` (loaded via python-dotenv
without overriding shell env). See ``env.byoa.example`` for the canonical
template and ``docs/setup-byoa.md`` for the operator quickstart.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv
from loguru import logger

PROMPT_MAX_BYTES = 8192
DEFAULT_ENV_FILE = ".env.byoa"
DEFAULT_WAKE_HOST = "127.0.0.1"
DEFAULT_WAKE_PORT = 8765


class CliError(Exception):
    """Raised for operator-facing configuration errors. The main()
    wrapper translates these into a clean stderr message + exit 1."""


def _load_prompt(path: Path) -> str:
    if not path.exists():
        raise CliError(f"prompt file not found: {path}")
    raw = path.read_bytes()
    if not raw.strip():
        raise CliError(f"prompt file is empty: {path}")
    if len(raw) > PROMPT_MAX_BYTES:
        raise CliError(
            f"prompt file exceeds {PROMPT_MAX_BYTES}-byte cap: "
            f"{path} is {len(raw)} bytes"
        )
    return raw.decode("utf-8")


def _resolve_env_file(arg: Optional[str]) -> Path:
    return Path(arg) if arg else Path(DEFAULT_ENV_FILE)


def _load_env_files(env_file_arg: Optional[str]) -> Path:
    env_file = _resolve_env_file(env_file_arg)
    if env_file.exists():
        load_dotenv(env_file, override=False)
        logger.info(f"byoa.cli.env_loaded path={str(env_file)!r}")
    else:
        logger.info(
            f"byoa.cli.env_file_absent path={str(env_file)!r} — relying on shell env"
        )

    # Single-host dev convenience: when BYOA runs in the bot's checkout,
    # fall back to .env.bot for TASK_LLM_* and LLM API keys.
    bot_env = Path(".env.bot")
    if bot_env.exists():
        load_dotenv(bot_env, override=False)
        logger.info(f"byoa.cli.bot_env_loaded path={str(bot_env)!r}")
    return env_file


def _require(arg_value: Optional[str], env_key: str, flag: str) -> str:
    if arg_value:
        return arg_value
    env_value = os.environ.get(env_key, "").strip()
    if env_value:
        return env_value
    raise CliError(f"{flag} is required (or set {env_key})")


def _resolve_channel(arg_value: Optional[str]) -> str:
    channel = (arg_value or os.environ.get("BYOA_CHANNEL", "")).strip()
    if not channel:
        raise CliError(
            "--channel is required in dev (or set BYOA_CHANNEL). "
            "In production wake_agent should pass the voice-session channel "
            "to the spawned BYOA process."
        )
    return channel


def _resolve_bus_database_url(
    arg_value: Optional[str],
    wake_env_value: Optional[str],
) -> str:
    """Resolve the restricted BYOA bus DSN.

    ``wake_env_value`` is captured before loading .env files. That makes
    production wake injection authoritative and prevents a local .env.byoa
    value from overriding it. Local dev uses the explicit CLI flag instead.
    """
    injected = (wake_env_value or "").strip()
    cli_value = (arg_value or "").strip()
    if injected:
        if cli_value and cli_value != injected:
            logger.warning(
                "byoa.cli.bus_database_url_ignored reason=wake_env_wins"
            )
        return injected
    if cli_value:
        return cli_value
    raise CliError(
        "--bus-database-url is required for local dev. In production, "
        "wake_agent must inject BYOA_BUS_DATABASE_URL into the spawned process."
    )


def _resolve_edge_api_token() -> str:
    token = os.environ.get("EDGE_API_TOKEN", "").strip()
    if not token:
        raise CliError(
            "EDGE_API_TOKEN is required for `byoa serve`. "
            "Set it in the shell or .env.bot so the local wake daemon can "
            "authenticate wake_agent calls."
        )
    return token


def _resolve_prompt_file(arg_value: Optional[str]) -> Path:
    prompt_file_raw = arg_value or os.environ.get("BYOA_PROMPT_FILE", "").strip()
    if not prompt_file_raw:
        raise CliError("--prompt-file is required (or set BYOA_PROMPT_FILE)")
    return Path(prompt_file_raw)


async def _run_one_session(
    *,
    session: dict[str, Any],
    runner_name: str,
    agent_name: str,
    ship_id: str,
    character_id: str,
    custom_prompt: str,
    config,  # ByoaAgentConfig
    bus_database_url: str,
) -> None:
    """Build the bus, run the TaskAgent until task finish, then tear down.

    Imports the heavy dependencies lazily so the CLI's arg-parse + config
    paths stay free of pipecat / asyncpg for fast unit tests.
    """
    from pipecat_subagents.runner import AgentRunner

    from gradientbang.adapters.bus.byoa_pgmq import build_byoa_pgmq_bus
    from gradientbang.pipecat_server.subagents.task_agent import TaskAgent

    channel = session["channel"]
    bus = await build_byoa_pgmq_bus(
        database_url=bus_database_url,
        channel=channel,
        ship_id=ship_id,
    )
    runner = AgentRunner(name=runner_name, bus=bus, handle_sigint=True)
    task_agent = TaskAgent(
        agent_name,
        bus=bus,
        # TaskAgent's character_id is the SHIP's pseudo-character (the
        # subject of every game tool call). The BYOA token bound to the
        # operator's real character is authorized to act on the ship via
        # corp membership + ship_byoa_configure ownership.
        character_id=ship_id,
        is_corp_ship=True,
        task_metadata={
            "actor_character_id": character_id,
            "task_scope": "byoa",
        },
        byoa_config=config,
        custom_prompt=custom_prompt,
    )
    await runner.add_agent(task_agent)
    logger.info(
        f"byoa.cli.session.starting agent={agent_name} channel={channel!r} "
        f"task={session.get('current_task_id', '<none>')!s}"
    )
    try:
        await runner.run()
    finally:
        try:
            await bus.stop()
        except Exception:
            logger.exception("byoa.cli.bus.stop_failed")


class _WakeDaemon:
    """Small local HTTP wake provider for ``WAKE_TARGET=http``.

    The edge function owns the wake contract. This daemon only validates the
    shared edge API token and starts a real BYOA runner process with the env values
    the edge function would inject into a remote sandbox.
    """

    def __init__(
        self,
        *,
        prompt_file: Path,
        env_file: Path,
        ship_id: str,
        character_id: str,
        edge_api_token: str,
    ) -> None:
        self.prompt_file = prompt_file
        self.env_file = env_file
        self.ship_id = ship_id
        self.character_id = character_id
        self.edge_api_token = edge_api_token
        self._lock = threading.Lock()
        self._processes: dict[str, subprocess.Popen[Any]] = {}

    def health(self) -> dict[str, Any]:
        with self._lock:
            active = {
                task_id: {
                    "pid": proc.pid,
                    "running": proc.poll() is None,
                    "returncode": proc.poll(),
                }
                for task_id, proc in self._processes.items()
            }
        return {
            "status": "ok",
            "ship_id": self.ship_id,
            "active": active,
        }

    def handle_wake(
        self,
        *,
        authorization: Optional[str],
        payload: dict[str, Any],
    ) -> tuple[int, dict[str, Any]]:
        expected = f"Bearer {self.edge_api_token}"
        if authorization != expected:
            return 401, {"success": False, "error": "unauthorized"}

        ship_id = str(payload.get("ship_id") or "")
        if ship_id != self.ship_id:
            return 403, {"success": False, "error": "ship_id_mismatch"}

        task_id = str(payload.get("task_id") or "")
        if not task_id:
            return 400, {"success": False, "error": "task_id_required"}

        env_payload = payload.get("env")
        if not isinstance(env_payload, dict):
            return 400, {"success": False, "error": "env_required"}

        channel = str(env_payload.get("BYOA_CHANNEL") or payload.get("channel") or "")
        env_ship_id = str(env_payload.get("BYOA_SHIP_ID") or "")
        bus_database_url = str(env_payload.get("BYOA_BUS_DATABASE_URL") or "")
        if not channel:
            return 400, {"success": False, "error": "BYOA_CHANNEL_required"}
        if env_ship_id != self.ship_id:
            return 400, {"success": False, "error": "BYOA_SHIP_ID_mismatch"}
        if not bus_database_url:
            return 400, {"success": False, "error": "BYOA_BUS_DATABASE_URL_required"}

        with self._lock:
            existing = self._processes.get(task_id)
            if existing is not None and existing.poll() is None:
                logger.info(
                    f"byoa.wake_daemon.duplicate task={task_id[:8]} "
                    f"pid={existing.pid}"
                )
                return 202, {
                    "success": True,
                    "status": "accepted",
                    "duplicate": True,
                    "pid": existing.pid,
                }
            if existing is not None and existing.poll() is not None:
                self._processes.pop(task_id, None)

            env = os.environ.copy()
            env.update(
                {
                    "BYOA_CHANNEL": channel,
                    "BYOA_SHIP_ID": self.ship_id,
                    "BYOA_CHARACTER_ID": self.character_id,
                    "BYOA_BUS_DATABASE_URL": bus_database_url,
                    "BYOA_TASK_ID": task_id,
                    "BYOA_WAKE_REQUEST_ID": str(payload.get("request_id") or ""),
                }
            )
            cmd = [
                sys.executable,
                "-m",
                "gradientbang.byoa.cli",
                "run",
                "--prompt-file",
                str(self.prompt_file),
                "--ship-id",
                self.ship_id,
                "--character-id",
                self.character_id,
                "--env-file",
                str(self.env_file),
            ]
            proc = subprocess.Popen(cmd, env=env)
            self._processes[task_id] = proc

        logger.info(
            f"byoa.wake_daemon.spawned task={task_id[:8]} "
            f"ship={self.ship_id[:8]} channel={channel!r} pid={proc.pid}"
        )
        return 202, {
            "success": True,
            "status": "accepted",
            "duplicate": False,
            "pid": proc.pid,
        }

    def terminate_children(self, *, timeout_seconds: float = 5.0) -> None:
        deadline = time.monotonic() + timeout_seconds
        with self._lock:
            processes = list(self._processes.items())
        for task_id, proc in processes:
            if proc.poll() is not None:
                continue
            logger.info(
                f"byoa.wake_daemon.terminating task={task_id[:8]} pid={proc.pid}"
            )
            proc.terminate()
        for task_id, proc in processes:
            if proc.poll() is not None:
                continue
            remaining = max(0.0, deadline - time.monotonic())
            try:
                proc.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                logger.warning(
                    f"byoa.wake_daemon.killing task={task_id[:8]} pid={proc.pid}"
                )
                proc.kill()


def _send_json(
    handler: BaseHTTPRequestHandler,
    status: int,
    payload: dict[str, Any],
) -> None:
    raw = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(raw)))
    handler.end_headers()
    handler.wfile.write(raw)


def _make_wake_handler(daemon: _WakeDaemon) -> type[BaseHTTPRequestHandler]:
    class WakeHandler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            logger.debug(f"byoa.wake_daemon.http {fmt % args}")

        def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
            if self.path != "/health":
                _send_json(self, 404, {"success": False, "error": "not_found"})
                return
            _send_json(self, 200, daemon.health())

        def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
            if self.path != "/wake":
                _send_json(self, 404, {"success": False, "error": "not_found"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length)
                payload = json.loads(raw.decode("utf-8")) if raw else {}
                if not isinstance(payload, dict):
                    raise ValueError("payload must be an object")
            except Exception as exc:
                _send_json(
                    self,
                    400,
                    {"success": False, "error": "invalid_json", "detail": str(exc)},
                )
                return
            status, body = daemon.handle_wake(
                authorization=self.headers.get("Authorization"),
                payload=payload,
            )
            _send_json(self, status, body)

    return WakeHandler


async def _run_agent(args: argparse.Namespace) -> int:
    """Run one BYOA agent session."""
    wake_injected_bus_database_url = os.environ.get("BYOA_BUS_DATABASE_URL")

    _load_env_files(args.env_file)

    prompt_file = _resolve_prompt_file(args.prompt_file)
    custom_prompt = _load_prompt(prompt_file)

    ship_id = _require(args.ship_id, "BYOA_SHIP_ID", "--ship-id")
    character_id = _require(
        args.character_id, "BYOA_CHARACTER_ID", "--character-id"
    )

    token = os.environ.get("BYOA_TOKEN", "").strip()
    if not token:
        raise CliError("BYOA_TOKEN is required")

    # Lazy imports so argparse / config-validation paths stay light.
    from gradientbang.byoa.config import ByoaAgentConfig

    config = ByoaAgentConfig.from_env()
    warn = config.validate_heartbeat_against_server()
    if warn:
        logger.warning(warn)

    channel = _resolve_channel(getattr(args, "channel", None))
    bus_database_url = _resolve_bus_database_url(
        getattr(args, "bus_database_url", None),
        wake_injected_bus_database_url,
    )

    agent_name = f"byoa_{ship_id}"
    runner_name = f"byoa_runner_{ship_id}"

    shutdown = asyncio.Event()

    def _request_shutdown(*_: Any) -> None:
        if not shutdown.is_set():
            logger.info("byoa.cli.shutdown.signal")
            shutdown.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _request_shutdown)
        except NotImplementedError:
            # Windows / restricted runtimes — fall through to default handler.
            signal.signal(sig, _request_shutdown)

    if shutdown.is_set():
        return 0
    await _run_one_session(
        session={"channel": channel},
        runner_name=runner_name,
        agent_name=agent_name,
        ship_id=ship_id,
        character_id=character_id,
        custom_prompt=custom_prompt,
        config=config,
        bus_database_url=bus_database_url,
    )

    return 0


async def _serve_wake_daemon(args: argparse.Namespace) -> int:
    """Serve the local HTTP wake provider."""
    env_file = _load_env_files(args.env_file)
    prompt_file = _resolve_prompt_file(args.prompt_file)
    # Validate up front so wake failures are about wake payload, not local setup.
    _load_prompt(prompt_file)
    ship_id = _require(args.ship_id, "BYOA_SHIP_ID", "--ship-id")
    character_id = _require(
        args.character_id, "BYOA_CHARACTER_ID", "--character-id"
    )
    if not os.environ.get("BYOA_TOKEN", "").strip():
        raise CliError("BYOA_TOKEN is required")
    edge_api_token = _resolve_edge_api_token()

    daemon = _WakeDaemon(
        prompt_file=prompt_file,
        env_file=env_file,
        ship_id=ship_id,
        character_id=character_id,
        edge_api_token=edge_api_token,
    )
    server = ThreadingHTTPServer(
        (args.host, args.port),
        _make_wake_handler(daemon),
    )
    host, port = server.server_address[:2]
    logger.info(
        f"byoa.wake_daemon.started url=http://{host}:{port}/wake "
        f"ship={ship_id[:8]}"
    )

    shutdown = asyncio.Event()

    def _request_shutdown(*_: Any) -> None:
        if not shutdown.is_set():
            logger.info("byoa.wake_daemon.shutdown.signal")
            shutdown.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _request_shutdown)
        except NotImplementedError:
            signal.signal(sig, _request_shutdown)

    serve_task = asyncio.create_task(asyncio.to_thread(server.serve_forever))
    try:
        await shutdown.wait()
    finally:
        server.shutdown()
        await serve_task
        server.server_close()
        daemon.terminate_children()
        logger.info("byoa.wake_daemon.stopped")
    return 0


async def run(args: argparse.Namespace) -> int:
    """Async entry point."""
    command = getattr(args, "command", None) or "run"
    if command == "serve":
        return await _serve_wake_daemon(args)
    return await _run_agent(args)


def _add_common_agent_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--prompt-file",
        default=None,
        help="Path to operator-supplied system prompt markdown "
        "(or set BYOA_PROMPT_FILE). Required.",
    )
    parser.add_argument(
        "--ship-id",
        default=None,
        help="Corp ship pseudo-character_id (or set BYOA_SHIP_ID). Required.",
    )
    parser.add_argument(
        "--character-id",
        default=None,
        help="Operator's character_id the BYOA token is bound to "
        "(or set BYOA_CHARACTER_ID). Required.",
    )
    parser.add_argument(
        "--channel",
        default=None,
        help="Voice-session PGMQ channel to join (or set BYOA_CHANNEL). "
        "In production wake_agent supplies this to the spawned process.",
    )
    parser.add_argument(
        "--bus-database-url",
        default=None,
        help="Restricted BYOA Postgres DSN for local dev only. In production "
        "wake_agent injects BYOA_BUS_DATABASE_URL and that value wins.",
    )
    parser.add_argument(
        "--env-file",
        default=None,
        help=f"Path to env file; defaults to ./{DEFAULT_ENV_FILE}. "
        "Shell env always wins over file values.",
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="byoa",
        description=(
            "Run a Bring-Your-Own-Agent task agent or local wake provider "
            "against a Gradient Bang corp ship."
        ),
    )
    subparsers = parser.add_subparsers(dest="command")

    run_parser = subparsers.add_parser(
        "run",
        help="Run one BYOA agent session. This is also the legacy default.",
        description=(
            "Join the voice-session bus channel supplied by wake_agent or "
            "--channel, emit presence, and wait for tasks."
        ),
    )
    _add_common_agent_args(run_parser)

    serve_parser = subparsers.add_parser(
        "serve",
        help="Serve the local HTTP wake provider for WAKE_TARGET=http.",
        description=(
            "Start a localhost wake endpoint that spawns BYOA run sessions "
            "when the wake_agent edge function calls it."
        ),
    )
    _add_common_agent_args(serve_parser)
    serve_parser.add_argument(
        "--host",
        default=DEFAULT_WAKE_HOST,
        help=f"Wake server host. Defaults to {DEFAULT_WAKE_HOST}.",
    )
    serve_parser.add_argument(
        "--port",
        default=DEFAULT_WAKE_PORT,
        type=int,
        help=f"Wake server port. Defaults to {DEFAULT_WAKE_PORT}.",
    )
    return parser


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    raw = list(sys.argv[1:] if argv is None else argv)
    command_names = {"run", "serve"}
    if raw and raw[0] not in command_names and raw[0] not in {"-h", "--help"}:
        raw.insert(0, "run")
    if not raw:
        raw = ["run"]
    return _build_parser().parse_args(raw)


def main() -> None:
    args = _parse_args()
    try:
        sys.exit(asyncio.run(run(args)))
    except CliError as exc:
        print(f"byoa: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
