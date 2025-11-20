"""Shared token usage logging helpers for Pipecat pipelines.

Provides a FrameProcessor that listens for MetricsFrame events and appends
LLM token usage records to a CSV session log.
"""

from __future__ import annotations

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
DEFAULT_LOG_PATH = Path("logs/token_usage.csv")


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


class TokenUsageCSVLogger:
    """Append-only CSV writer for token usage records."""

    def __init__(self, log_path: Optional[Path | str] = None):
        env_path = os.getenv(DEFAULT_LOG_ENV_VAR)
        candidate = Path(log_path) if log_path else Path(env_path) if env_path else DEFAULT_LOG_PATH
        self._path = candidate.expanduser()
        self._header_written = False
        self._ensure_logfile()

    @property
    def path(self) -> Path:
        return self._path

    def _ensure_logfile(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to create token usage log directory: %s", exc)
        if not self._path.exists() or self._path.stat().st_size == 0:
            self._write_header()
        else:
            self._header_written = True

    def _write_header(self) -> None:
        try:
            with self._path.open("a", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle)
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
            self._header_written = True
        except Exception as exc:  # noqa: BLE001
            logger.warning("Unable to write token usage log header: %s", exc)

    def log_usage(
        self,
        source: TokenSource,
        usage: LLMTokenUsage,
        timestamp: Optional[datetime] = None,
    ) -> None:
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
            with self._path.open("a", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(row)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to write token usage log row: %s", exc)


class TokenUsageMetricsProcessor(FrameProcessor):
    """Frame processor that logs LLM usage metrics to CSV."""

    def __init__(self, source: TokenSource, logger_instance: Optional[TokenUsageCSVLogger] = None):
        super().__init__()
        if source not in ("bot", "task"):
            raise ValueError("TokenUsageMetricsProcessor source must be 'bot' or 'task'")
        self._source = source
        self._logger = logger_instance or TokenUsageCSVLogger()

    async def process_frame(self, frame: Frame, direction: FrameDirection):  # type: ignore[override]
        await super().process_frame(frame, direction)

        if isinstance(frame, MetricsFrame) and frame.data:
            self.handle_metrics_frame(frame)

        await self.push_frame(frame, direction)

    def handle_metrics_frame(self, metrics_frame: MetricsFrame) -> None:
        for data in metrics_frame.data:
            if isinstance(data, LLMUsageMetricsData):
                usage = data.value
                self._logger.log_usage(self._source, usage)
