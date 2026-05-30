"""Scripted tutorial agent for new players.

WIP — the tutorial flow is currently bypassed for all sessions. This
module exposes the class shape so the rest of the bot can wire it up,
but the tutorial body itself is intentionally not implemented yet.
"""

from typing import Awaitable, Callable, Optional

from loguru import logger
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frameworks.rtvi import RTVIProcessor


class ScriptedAgent(PipelineWorker):
    """Stub tutorial worker — completes immediately when activated."""

    def __init__(
        self,
        name: str,
        *,
        rtvi_processor: RTVIProcessor,
        on_complete: Callable[[], Awaitable[None]],
    ):
        super().__init__(Pipeline([]), name=name, active=False, bridged=(), enable_rtvi=False)
        self._rtvi = rtvi_processor
        self._on_complete = on_complete

    async def on_activated(self, args: Optional[dict]) -> None:
        await super().on_activated(args)
        logger.warning("ScriptedAgent: stub activated, handing off immediately")
        await self._on_complete()
