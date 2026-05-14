"""Local-dev HTTP wake provider for ``byoa --serve``.

Mirrors what wake_agent's Vercel-Sandbox dispatch does in production:
validates the wake payload, then starts a fresh BYOA process with the env
the edge function would have injected into a remote sandbox. The spawned
child is just ``uv run byoa`` (i.e. :mod:`gradientbang.byoa.app`).

This daemon only runs when the operator explicitly invokes ``byoa --serve``
on a workstation; it has no role in production. It loads ``.env.byoa`` and
falls back to ``.env.bot`` for LLM keys so dev iteration matches the bot's
environment. The harness itself only reads ``os.environ``.
"""

from __future__ import annotations

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

DEFAULT_ENV_FILE = ".env.byoa"


class ServeError(RuntimeError):
    """Raised for operator-facing setup errors before the daemon starts."""


# ── Env loading ───────────────────────────────────────────────────────────


def _load_env_files() -> Path:
    env_file = Path(DEFAULT_ENV_FILE)
    if env_file.exists():
        load_dotenv(env_file, override=False)
        logger.info(f"byoa.serve.env_loaded path={str(env_file)!r}")
    else:
        logger.info(
            f"byoa.serve.env_file_absent path={str(env_file)!r} — relying on shell env"
        )

    # Single-host dev convenience: when BYOA serve runs in the bot checkout,
    # fall back to .env.bot for TASK_LLM_* and LLM API keys.
    bot_env = Path(".env.bot")
    if bot_env.exists():
        load_dotenv(bot_env, override=False)
        logger.info(f"byoa.serve.bot_env_loaded path={str(bot_env)!r}")
    return env_file


def _require(env_key: str) -> str:
    value = (os.environ.get(env_key) or "").strip()
    if not value:
        raise ServeError(
            f"{env_key} is required for `byoa --serve`. "
            "Set it in .env.byoa (or .env.bot for shared LLM keys)."
        )
    return value


# ── Daemon ────────────────────────────────────────────────────────────────


class _WakeDaemon:
    """Wake provider for ``BYOA_WAKE_TARGET=http``.

    The edge function owns the wake contract; this daemon validates the
    shared edge API token and spawns a real ``uv run byoa`` process with
    the env values the edge function would inject into a remote sandbox.
    """

    def __init__(
        self,
        *,
        ship_id: str,
        character_id: str,
        wake_secret: str,
    ) -> None:
        self.ship_id = ship_id
        self.character_id = character_id
        self.wake_secret = wake_secret
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
        expected = f"Bearer {self.wake_secret}"
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
                    f"byoa.serve.duplicate task={task_id[:8]} pid={existing.pid}"
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
            # Spawn the harness directly; equivalent to `uv run byoa` once the
            # console script is installed, but works even when uv isn't on PATH.
            cmd = [sys.executable, "-m", "gradientbang.byoa.app"]
            proc = subprocess.Popen(cmd, env=env)
            self._processes[task_id] = proc

        logger.info(
            f"byoa.serve.spawned task={task_id[:8]} ship={self.ship_id[:8]} "
            f"channel_prefix={channel[:11]} pid={proc.pid}"
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
                f"byoa.serve.terminating task={task_id[:8]} pid={proc.pid}"
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
                    f"byoa.serve.killing task={task_id[:8]} pid={proc.pid}"
                )
                proc.kill()


# ── HTTP plumbing ─────────────────────────────────────────────────────────


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
            logger.debug(f"byoa.serve.http {fmt % args}")

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


# ── Entry point ───────────────────────────────────────────────────────────


def run_wake_daemon(*, host: str, port: int) -> None:
    """Serve the local HTTP wake provider until SIGINT/SIGTERM."""
    try:
        _load_env_files()
        from gradientbang.utils.logging_config import configure_logging

        configure_logging()
        ship_id = _require("BYOA_SHIP_ID")
        character_id = _require("BYOA_CHARACTER_ID")
        wake_secret = _require("BYOA_WAKE_SECRET")
    except ServeError as exc:
        print(f"byoa: {exc}", file=sys.stderr)
        sys.exit(1)

    daemon = _WakeDaemon(
        ship_id=ship_id,
        character_id=character_id,
        wake_secret=wake_secret,
    )
    server = ThreadingHTTPServer((host, port), _make_wake_handler(daemon))
    bound_host, bound_port = server.server_address[:2]

    from gradientbang.byoa.app import _log_startup_banner, _short

    _log_startup_banner(
        mode="serve (wake daemon)",
        fields=[
            ("ship_id", _short(ship_id)),
            ("character_id", _short(character_id)),
            ("wake_url", f"http://{bound_host}:{bound_port}/wake"),
            ("health_url", f"http://{bound_host}:{bound_port}/health"),
        ],
    )

    shutdown = threading.Event()

    def _request_shutdown(*_: Any) -> None:
        if not shutdown.is_set():
            logger.info("byoa.serve.shutdown.signal")
            shutdown.set()
            # Wake serve_forever from another thread.
            threading.Thread(target=server.shutdown, daemon=True).start()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _request_shutdown)
        except (ValueError, OSError):
            # Some restricted runtimes don't allow handler install; ignore.
            pass

    try:
        server.serve_forever()
    finally:
        server.server_close()
        daemon.terminate_children()
        logger.info("byoa.serve.stopped")
