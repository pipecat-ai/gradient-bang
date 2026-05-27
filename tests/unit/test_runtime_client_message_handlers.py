import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from pipecat.frames.frames import (
    LLMMessagesAppendFrame,
)
from pipecat.processors.frameworks.rtvi import models as RTVI

from gradientbang.bot import AppResources
from gradientbang.runtime import client_message_handlers as client_message_handlers_module
from gradientbang.runtime.client_message_handlers import ClientMessageHandler
from gradientbang.runtime.frames import UserTextInputFrame
from gradientbang.runtime.subagents.task_agent import TaskAgent

pytestmark = pytest.mark.unit


class _Message:
    type = "user-text-input"
    data = {"text": "plot a course to Rigel"}


class _PipelineWorker:
    def __init__(
        self,
        children=None,
        app_resources=None,
    ) -> None:
        self.queued_frames = []
        self.children = children or []
        self.app_resources = app_resources

    async def queue_frame(self, frame):
        self.queued_frames.append(frame)

    async def queue_frames(self, frames):
        self.queued_frames.extend(frames)


def test_app_resources_event_defaults_to_muted() -> None:
    resources = AppResources()

    assert not resources.user_unmuted_event.is_set()


def test_app_resources_event_set_state_represents_unmuted() -> None:
    resources = AppResources()

    resources.user_unmuted_event.set()
    assert resources.user_unmuted_event.is_set()

    resources.user_unmuted_event.clear()
    assert not resources.user_unmuted_event.is_set()


@pytest.mark.asyncio
async def test_user_text_input_pushes_transcript_and_llm_append(monkeypatch) -> None:
    resources = AppResources()
    resources.user_unmuted_event.set()
    pipeline_worker = _PipelineWorker(app_resources=resources)
    rtvi = MagicMock(
        push_transport_message=AsyncMock(),
        interrupt_bot=AsyncMock(),
        push_frame=AsyncMock(),
    )

    async def fail_wait_for(awaitable, timeout):
        raise AssertionError("user text should not wait when already unmuted")

    monkeypatch.setattr(client_message_handlers_module.asyncio, "wait_for", fail_wait_for)
    handler = ClientMessageHandler(
        game_client=None,
        character_id="character-id",
        rtvi=rtvi,
        transport=None,
        pipeline_worker=pipeline_worker,
    )

    await handler.handle(_Message())

    assert [type(frame) for frame in pipeline_worker.queued_frames] == [
        UserTextInputFrame,
        LLMMessagesAppendFrame,
    ]
    assert pipeline_worker.queued_frames[0].text == "plot a course to Rigel"
    append_frame = pipeline_worker.queued_frames[1]
    assert append_frame.messages == [{"role": "user", "content": "plot a course to Rigel"}]
    assert append_frame.run_llm is True
    assert rtvi.push_transport_message.await_count == 3
    user_started_message = rtvi.push_transport_message.await_args_list[0].args[0]
    transcript_message = rtvi.push_transport_message.await_args_list[1].args[0]
    user_stopped_message = rtvi.push_transport_message.await_args_list[2].args[0]
    assert isinstance(user_started_message, RTVI.UserStartedSpeakingMessage)
    assert isinstance(transcript_message, RTVI.UserTranscriptionMessage)
    assert transcript_message.data.text == "plot a course to Rigel"
    assert transcript_message.data.user_id == "player"
    assert transcript_message.data.final is True
    assert isinstance(user_stopped_message, RTVI.UserStoppedSpeakingMessage)
    rtvi.interrupt_bot.assert_awaited_once()
    rtvi.push_frame.assert_not_awaited()


@pytest.mark.asyncio
async def test_user_text_input_waits_for_muted_input_to_unmute(monkeypatch) -> None:
    resources = AppResources()
    pipeline_worker = _PipelineWorker(app_resources=resources)
    real_wait_for = asyncio.wait_for
    wait_calls = []

    async def capture_wait_for(awaitable, timeout):
        wait_calls.append(timeout)
        resources.user_unmuted_event.set()
        return await real_wait_for(awaitable, timeout)

    monkeypatch.setattr(client_message_handlers_module.asyncio, "wait_for", capture_wait_for)
    handler = ClientMessageHandler(
        game_client=None,
        character_id="character-id",
        rtvi=MagicMock(
            push_transport_message=AsyncMock(),
            interrupt_bot=AsyncMock(),
            push_frame=AsyncMock(),
        ),
        transport=None,
        pipeline_worker=pipeline_worker,
    )

    await handler.handle(_Message())

    assert wait_calls == [0.5]
    assert [type(frame) for frame in pipeline_worker.queued_frames] == [
        UserTextInputFrame,
        LLMMessagesAppendFrame,
    ]
    assert resources.user_unmuted_event.is_set()


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
