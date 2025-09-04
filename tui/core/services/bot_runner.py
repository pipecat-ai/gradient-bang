from __future__ import annotations

import asyncio
import contextlib
import io
from types import ModuleType
from typing import Optional

from loguru import logger as _loguru
from pipecat.runner.types import RunnerArguments


class UILineBuffer(io.TextIOBase):
    def __init__(self, write_line):
        self._buf = ""
        self._write = write_line

    def writable(self) -> bool:  # type: ignore[override]
        return True

    def write(self, s: str) -> int:  # type: ignore[override]
        if not isinstance(s, str):
            s = str(s)
        self._buf += s
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            self._write(line)
        return len(s)

    def flush(self) -> None:  # type: ignore[override]
        if self._buf:
            self._write(self._buf)
            self._buf = ""


class BotRunner:
    """Run a bot module and route logs to a UI sink."""

    def __init__(self, bot_module: ModuleType, write_syslog_line) -> None:
        self._mod = bot_module
        self._write_syslog_line = write_syslog_line
        self._task: Optional[asyncio.Task] = None
        self._loguru_sink_id = None

    async def start(self, transport) -> None:
        if not hasattr(self._mod, "run_bot"):
            raise RuntimeError("Bot module does not define run_bot(transport, runner_args)")

        # Avoid double-start if called twice
        if self._task and not self._task.done():
            return

        runner_args = RunnerArguments()
        sink = UILineBuffer(self._safe_syslog_write)

        # Route loguru to syslog panel and remove default stderr sinks to avoid leaks
        try:
            try:
                _loguru.remove()  # drop existing sinks so logs don't leak to terminal
            except Exception:
                pass

            def _log_sink(m: str):
                try:
                    self._write_syslog_line(m.rstrip("\n"))
                except Exception:
                    pass

            self._loguru_sink_id = _log_sink and _loguru.add(_log_sink, level="DEBUG")  # type: ignore[attr-defined]
        except Exception:
            self._loguru_sink_id = None  # type: ignore[attr-defined]

        async def run():
            # Mirror tui.py: run the bot with stdout/stderr redirected into the UI syslog
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                await self._mod.run_bot(transport, runner_args)  # type: ignore[attr-defined]

        self._task = asyncio.create_task(run())

    async def stop(self) -> None:
        try:
            if self._task is None:
                _loguru.info("[bot] stop(): no task to cancel")
            elif self._task.done():
                _loguru.info("[bot] stop(): task already done")
            else:
                _loguru.info("[bot] stop(): cancelling run_bot task")
                self._task.cancel()
                try:
                    await asyncio.wait_for(self._task, timeout=10.0)
                    _loguru.info("[bot] stop(): task finished after cancel")
                except asyncio.CancelledError:
                    _loguru.info("[bot] stop(): task cancelled")
                except asyncio.TimeoutError:
                    _loguru.warning("[bot] stop(): cancel wait timed out; proceeding")
        finally:
            try:
                if self._loguru_sink_id is not None:
                    _loguru.remove(self._loguru_sink_id)  # type: ignore[attr-defined]
            except Exception:
                pass

    def _safe_syslog_write(self, line: str) -> None:
        try:
            self._write_syslog_line(line)
        except Exception:
            pass
