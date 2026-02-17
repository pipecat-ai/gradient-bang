"""Shared token usage logging helpers for Pipecat pipelines.

Provides a FrameProcessor that listens for MetricsFrame events and appends
LLM token usage records to a CSV session log.

Logging is opt-in: set the TOKEN_USAGE_LOG environment variable to a file path
to enable it. When unset, no file I/O occurs.
"""

from __future__ import annotations

import asyncio
import csv
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from loguru import logger
from pipecat.frames.frames import Frame, MetricsFrame
from pipecat.metrics.metrics import LLMTokenUsage, LLMUsageMetricsData
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

TokenSource = Literal["bot", "task"]

DEFAULT_LOG_ENV_VAR = "TOKEN_USAGE_LOG"


@dataclass
class TokenUsageRecord:
    """Normalized token usage record ready to be written to CSV."""

    timestamp: datetime
    source: TokenSource
    input_tokens: int
    cached_tokens: int
    thinking_tokens: int
    output_tokens: int

    @classmethod
    def from_usage(
        cls,
        source: TokenSource,
        usage: LLMTokenUsage,
        timestamp: Optional[datetime] = None,
    ) -> "TokenUsageRecord":
        ts = (timestamp or datetime.now(timezone.utc)).astimezone(timezone.utc)
        cached_tokens = usage.cache_read_input_tokens or 0
        thinking_tokens = usage.reasoning_tokens or 0
        return cls(
            timestamp=ts,
            source=source,
            input_tokens=usage.prompt_tokens,
            cached_tokens=cached_tokens,
            thinking_tokens=thinking_tokens,
            output_tokens=usage.completion_tokens,
        )


def _write_row_sync(path: Path, row: list[object], write_header: bool) -> bool:
    """Write a CSV row to disk. Runs in a thread via asyncio.to_thread()."""
    try:
        with path.open("a", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            if write_header:
                writer.writerow(
                    [
                        "timestamp",
                        "source",
                        "input_tokens",
                        "cached_tokens",
                        "thinking_tokens",
                        "output_tokens",
                    ]
                )
            writer.writerow(row)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to write token usage log row: {}", exc)
        return False
    return True


class TokenUsageCSVLogger:
    """Append-only CSV writer for token usage records.

    Only active when a log path is provided (via constructor or TOKEN_USAGE_LOG
    environment variable). All file I/O is offloaded to a thread pool via
    asyncio.to_thread() to avoid blocking the event loop.
    """

    def __init__(self, log_path: Optional[Path | str] = None):
        env_path = os.getenv(DEFAULT_LOG_ENV_VAR)
        if log_path:
            self._path: Optional[Path] = Path(log_path).expanduser()
        elif env_path:
            self._path = Path(env_path).expanduser()
        else:
            self._path = None

        self._header_written = False
        self._write_lock = asyncio.Lock()
        self._write_tasks: set[asyncio.Task[None]] = set()
        if self._path is not None:
            self._ensure_logdir()

    @property
    def enabled(self) -> bool:
        return self._path is not None

    @property
    def path(self) -> Optional[Path]:
        return self._path

    def _ensure_logdir(self) -> None:
        if self._path is None:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            if self._path.exists() and self._path.stat().st_size > 0:
                self._header_written = True
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to create token usage log directory: {}", exc)

    def _track_write_task(self, task: asyncio.Task[None]) -> None:
        self._write_tasks.add(task)
        task.add_done_callback(self._on_write_task_done)

    def _on_write_task_done(self, task: asyncio.Task[None]) -> None:
        self._write_tasks.discard(task)
        try:
            task.result()
        except asyncio.CancelledError:
            # Cancellation during shutdown is expected; no warning needed.
            return
        except Exception as exc:  # noqa: BLE001
            logger.warning("Token usage background write task failed: {}", exc)

    async def flush(self) -> None:
        """Wait for all scheduled background writes to complete."""
        while self._write_tasks:
            pending = tuple(self._write_tasks)
            await asyncio.gather(*pending, return_exceptions=True)

    async def _write_usage_row(self, row: list[object]) -> None:
        if self._path is None:
            return

        async with self._write_lock:
            write_header = not self._header_written
            wrote = await asyncio.to_thread(_write_row_sync, self._path, row, write_header)
            if wrote and write_header:
                self._header_written = True

    def log_usage(
        self,
        source: TokenSource,
        usage: LLMTokenUsage,
        timestamp: Optional[datetime] = None,
    ) -> None:
        if self._path is None:
            return

        record = TokenUsageRecord.from_usage(source, usage, timestamp)
        row = [
            record.timestamp.isoformat(),
            record.source,
            record.input_tokens,
            record.cached_tokens,
            record.thinking_tokens,
            record.output_tokens,
        ]

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError as exc:
            logger.warning("Failed to schedule token usage log write task: {}", exc)
            return

        coro = self._write_usage_row(row)
        try:
            task = loop.create_task(coro)
        except RuntimeError as exc:
            coro.close()
            logger.warning("Failed to schedule token usage log write task: {}", exc)
            return
        self._track_write_task(task)


class TokenUsageMetricsProcessor(FrameProcessor):
    """Frame processor that logs LLM usage metrics to CSV.

    Only performs I/O when TOKEN_USAGE_LOG is set. All writes are async
    (offloaded to a thread pool) to avoid blocking the pipeline event loop.
    """

    def __init__(self, source: TokenSource, logger_instance: Optional[TokenUsageCSVLogger] = None):
        super().__init__()
        if source not in ("bot", "task"):
            raise ValueError("TokenUsageMetricsProcessor source must be 'bot' or 'task'")
        self._source = source
        self._logger = logger_instance or TokenUsageCSVLogger()

    async def cleanup(self) -> None:
        await self._logger.flush()
        await super().cleanup()

    async def process_frame(self, frame: Frame, direction: FrameDirection):  # type: ignore[override]
        await super().process_frame(frame, direction)

        if isinstance(frame, MetricsFrame) and frame.data and self._logger.enabled:
            self._handle_metrics_frame(frame)

        await self.push_frame(frame, direction)

    def _handle_metrics_frame(self, metrics_frame: MetricsFrame) -> None:
        for data in metrics_frame.data:
            if isinstance(data, LLMUsageMetricsData):
                usage = data.value
                self._logger.log_usage(self._source, usage)
