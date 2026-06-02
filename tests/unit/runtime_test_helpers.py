"""Shared test helpers for the runtime Orchestrator."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from gradientbang.config import PLAYER_AGENT_NAME
from gradientbang.game.auth import Auth
from gradientbang.runtime.orchestrator import Orchestrator


class RuntimeWorker:
    """Small PipelineWorker stand-in for Orchestrator unit tests."""

    def __init__(self, name: str = PLAYER_AGENT_NAME) -> None:
        self.name = name
        self.active = True
        self._children = []
        self.job_groups = {}
        self.registry = object()
        self.handlers = {}
        self.queued_frames = []
        self.downstream_filters = []
        self.upstream_filters = []

    @property
    def children(self):
        return self._children

    def event_handler(self, event_name: str):
        def decorator(handler):
            self.handlers[event_name] = handler
            return handler

        return decorator

    def add_reached_downstream_filter(self, filters) -> None:
        self.downstream_filters.extend(filters)

    def add_reached_upstream_filter(self, filters) -> None:
        self.upstream_filters.extend(filters)

    async def queue_frame(self, frame, direction=None) -> None:
        self.queued_frames.append(frame)

    async def queue_frames(self, frames) -> None:
        self.queued_frames.extend(frames)

    async def send_bus_message(self, message) -> None:
        pass

    async def add_workers(self, *workers, watch: bool = True) -> None:
        self._children.extend(workers)

    async def watch_workers(self, *worker_names: str) -> None:
        pass

    async def cancel_job_group(self, job_id: str, *, reason: str | None = None) -> None:
        self.job_groups.pop(job_id, None)

    async def request_job_update(self, job_id: str, worker_name: str) -> None:
        pass

    def create_task(self, *args, **kwargs):
        return MagicMock()

    async def cancel_task(self, *args, **kwargs) -> None:
        pass


def make_orchestrator(
    *,
    game_client=None,
    character_id: str = "char-123",
    display_name: str = "Captain Test",
    rtvi=None,
    worker: RuntimeWorker | None = None,
) -> Orchestrator:
    """Build an attached Orchestrator with mocked runtime dependencies."""

    auth = Auth(character_id=character_id, access_token="token")
    auth.display_name = display_name
    orch = Orchestrator(
        auth=auth,
        session_id="session-id",
        local_api_url=None,
        rtvi=rtvi or MagicMock(push_frame=AsyncMock()),
    )
    orch.game_client = game_client or MagicMock()
    orch.attach(
        voice_worker=worker or RuntimeWorker(),
        voice_llm=MagicMock(),
        context=MagicMock(),
        transport=None,
    )
    return orch
