from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from gradientbang.config import PLAYER_AGENT_NAME
from gradientbang.game.auth import Auth
from gradientbang.runtime.orchestrator import Orchestrator

pytestmark = pytest.mark.unit


class _VoiceWorker:
    def __init__(self, name: str = PLAYER_AGENT_NAME) -> None:
        self.name = name
        self.active = True
        self.children = ["child"]
        self.job_groups = {"job-id": "group"}
        self.registry = object()
        self.handlers = {}
        self.calls = []
        self.queued_frames = []

    def event_handler(self, event_name: str):
        def decorator(handler):
            self.handlers[event_name] = handler
            return handler

        return decorator

    async def send_bus_message(self, message) -> None:
        self.calls.append(("send_bus_message", message))

    async def add_worker(self, worker) -> None:
        self.calls.append(("add_worker", worker))

    async def watch_worker(self, worker_name: str) -> None:
        self.calls.append(("watch_worker", worker_name))

    async def cancel_job_group(self, job_id: str, *, reason: str | None = None) -> None:
        self.calls.append(("cancel_job_group", job_id, reason))

    async def request_job_update(self, job_id: str, worker_name: str) -> None:
        self.calls.append(("request_job_update", job_id, worker_name))

    def create_task(self, *args, **kwargs):
        self.calls.append(("create_task", args, kwargs))
        return "created-task"

    async def cancel_task(self, *args, **kwargs) -> None:
        self.calls.append(("cancel_task", args, kwargs))

    async def queue_frames(self, frames) -> None:
        self.queued_frames.extend(frames)


def _orchestrator() -> Orchestrator:
    auth = Auth(character_id="character-id", access_token="token")
    auth.display_name = "Captain Test"
    orch = Orchestrator(
        auth=auth,
        session_id="session-id",
        local_api_url=None,
        rtvi=None,
    )
    orch.game_client = object()
    return orch


def test_attach_requires_player_worker_name() -> None:
    orch = _orchestrator()

    with pytest.raises(ValueError, match="voice_worker must be named 'player'"):
        orch.attach(voice_worker=_VoiceWorker("main"), context=object(), transport=None)


def test_attach_installs_worker_event_bridge() -> None:
    orch = _orchestrator()
    worker = _VoiceWorker()

    orch.attach(voice_worker=worker, context=object(), transport=None)

    assert orch.name == PLAYER_AGENT_NAME
    assert orch.voice_worker is worker
    assert set(worker.handlers) == {
        "on_worker_ready",
        "on_worker_failed",
        "on_job_update",
        "on_job_response",
        "on_bus_message",
    }


@pytest.mark.asyncio
async def test_worker_event_bridge_routes_to_orchestrator_handlers() -> None:
    orch = _orchestrator()
    worker = _VoiceWorker()
    orch.attach(voice_worker=worker, context=object(), transport=None)
    orch.on_worker_ready = AsyncMock()

    data = SimpleNamespace(worker_name="task_123")
    await worker.handlers["on_worker_ready"](worker, data)

    orch.on_worker_ready.assert_awaited_once_with(data)


@pytest.mark.asyncio
async def test_worker_host_facade_delegates_to_voice_worker() -> None:
    orch = _orchestrator()
    worker = _VoiceWorker()
    orch.attach(voice_worker=worker, context=object(), transport=None)

    assert orch.active is True
    assert orch.children == ["child"]
    assert orch.job_groups == {"job-id": "group"}
    assert orch.registry is worker.registry

    await orch.send_bus_message("message")
    await orch.add_worker("worker")
    await orch.watch_worker("task_123")
    await orch.cancel_job_group("job-id", reason="done")
    await orch.request_job_update("job-id", "task_123")
    assert orch.create_task("coro", name="task-name") == "created-task"
    await orch.cancel_task("created-task", timeout=2)
    await orch.queue_frame("frame")

    assert worker.calls == [
        ("send_bus_message", "message"),
        ("add_worker", "worker"),
        ("watch_worker", "task_123"),
        ("cancel_job_group", "job-id", "done"),
        ("request_job_update", "job-id", "task_123"),
        ("create_task", ("coro",), {"name": "task-name"}),
        ("cancel_task", ("created-task",), {"timeout": 2}),
    ]
    assert worker.queued_frames == ["frame"]


@pytest.mark.asyncio
async def test_worker_host_facade_requires_attached_worker() -> None:
    orch = _orchestrator()

    with pytest.raises(RuntimeError, match="voice worker is not attached"):
        _ = orch.children
    with pytest.raises(RuntimeError, match="voice worker is not attached"):
        orch.create_task("coro")
    with pytest.raises(RuntimeError, match="voice worker is not attached"):
        await orch.send_bus_message("message")
