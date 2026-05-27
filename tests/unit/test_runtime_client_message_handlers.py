from unittest.mock import AsyncMock, MagicMock

import pytest

from pipecat.frames.frames import (
    InterruptionFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)

from gradientbang.runtime.client_message_handlers import ClientMessageHandler
from gradientbang.runtime.frames import UserTextInputFrame
from gradientbang.runtime.subagents.task_agent import TaskAgent

pytestmark = pytest.mark.unit


class _Message:
    type = "user-text-input"
    data = {"text": "plot a course to Rigel"}


class _PipelineWorker:
    def __init__(self, children=None) -> None:
        self.queued_frames = []
        self.children = children or []

    async def queue_frame(self, frame):
        self.queued_frames.append(frame)

    async def queue_frames(self, frames):
        self.queued_frames.extend(frames)


@pytest.mark.asyncio
async def test_user_text_input_queues_bypass_before_transcription_frames() -> None:
    pipeline_worker = _PipelineWorker()
    handler = ClientMessageHandler(
        game_client=None,
        character_id="character-id",
        rtvi=None,
        transport=None,
        pipeline_worker=pipeline_worker,
    )

    await handler.handle(_Message())

    assert [type(frame) for frame in pipeline_worker.queued_frames] == [
        UserTextInputFrame,
        InterruptionFrame,
        UserStartedSpeakingFrame,
        TranscriptionFrame,
        UserStoppedSpeakingFrame,
    ]
    assert pipeline_worker.queued_frames[0].text == "plot a course to Rigel"
    assert pipeline_worker.queued_frames[3].text == "plot a course to Rigel"


def test_deferred_client_message_handlers_are_not_registered() -> None:
    assert "skip-tutorial" not in ClientMessageHandler._HANDLERS
    assert "say-text" not in ClientMessageHandler._HANDLERS
    assert "say-text-dismiss" not in ClientMessageHandler._HANDLERS


@pytest.mark.asyncio
async def test_dump_task_context_uses_last_completed_in_memory_context(monkeypatch) -> None:
    from gradientbang.runtime import context_upload

    task_id = "framework-task-id"
    messages = [{"role": "user", "content": "completed task context"}]
    child = object.__new__(TaskAgent)
    child._name = "task_abc123"
    child._active_task_id = None
    child._last_completed_task_id = task_id
    child.get_context_dump = MagicMock(return_value=messages)

    download_task_context = AsyncMock(side_effect=AssertionError("S3 should not be used"))
    monkeypatch.setattr(context_upload, "download_task_context", download_task_context)

    rtvi = MagicMock(push_frame=AsyncMock())
    handler = ClientMessageHandler(
        game_client=None,
        character_id="character-id",
        rtvi=rtvi,
        transport=None,
        pipeline_worker=_PipelineWorker(children=[child]),
    )

    await handler._handle_dump_task_context("dump-task-context", {"task_id": task_id})

    download_task_context.assert_not_awaited()
    child.get_context_dump.assert_called_once()
    pushed = rtvi.push_frame.await_args.args[0]
    assert pushed.data["event"] == "debug.task-context"
    assert pushed.data["payload"]["task_id"] == task_id
    assert pushed.data["payload"]["message_count"] == 1
    assert "completed task context" in pushed.data["payload"]["formatted"]


@pytest.mark.asyncio
async def test_dump_task_context_still_falls_back_to_s3_without_local_match(monkeypatch) -> None:
    from gradientbang.runtime import context_upload

    task_id = "historical-task-id"
    messages = [{"role": "assistant", "content": "saved task context"}]
    download_task_context = AsyncMock(return_value=messages)
    monkeypatch.setattr(context_upload, "download_task_context", download_task_context)

    rtvi = MagicMock(push_frame=AsyncMock())
    handler = ClientMessageHandler(
        game_client=None,
        character_id="character-id",
        rtvi=rtvi,
        transport=None,
        pipeline_worker=_PipelineWorker(children=[]),
    )

    await handler._handle_dump_task_context("dump-task-context", {"task_id": task_id})

    download_task_context.assert_awaited_once_with(task_id, "character-id")
    pushed = rtvi.push_frame.await_args.args[0]
    assert pushed.data["event"] == "debug.task-context"
    assert pushed.data["payload"]["task_id"] == task_id
    assert pushed.data["payload"]["message_count"] == 1
    assert "saved task context" in pushed.data["payload"]["formatted"]
