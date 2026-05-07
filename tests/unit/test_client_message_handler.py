import asyncio
from types import SimpleNamespace

import pytest

from pipecat.frames.frames import (
    InterruptionFrame,
    LLMMessagesAppendFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)

from gradientbang.pipecat_server.client_message_handler import ClientMessageHandler
from gradientbang.pipecat_server.frames import UserTextInputFrame


class RecordingPipelineTask:
    def __init__(self):
        self.frames = []

    async def queue_frame(self, frame):
        self.frames.append(frame)

    async def queue_frames(self, frames):
        self.frames.extend(frames)


class RecordingRTVI:
    def __init__(self):
        self.transport_messages = []

    async def push_transport_message(self, model, exclude_none=True):
        self.transport_messages.append(model.model_dump(exclude_none=exclude_none))


def _handler(*, realtime: bool, task: RecordingPipelineTask, rtvi: RecordingRTVI):
    return ClientMessageHandler(
        game_client=SimpleNamespace(),
        character_id="char-test",
        rtvi=rtvi,
        transport=SimpleNamespace(),
        main_agent=SimpleNamespace(_pipeline_task=task),
        tts=None,
        say_text_restore_voice={},
        user_mute_state={"muted": False},
        user_unmuted_event=asyncio.Event(),
        openai_realtime_mode=realtime,
    )


@pytest.mark.asyncio
async def test_realtime_text_input_emits_rtvi_user_transcript_and_llm_append():
    task = RecordingPipelineTask()
    rtvi = RecordingRTVI()
    handler = _handler(realtime=True, task=task, rtvi=rtvi)

    await handler._handle_user_text_input("user-text-input", {"text": "status report"})

    assert [message["type"] for message in rtvi.transport_messages] == [
        "user-started-speaking",
        "user-transcription",
        "user-stopped-speaking",
    ]
    transcript = rtvi.transport_messages[1]["data"]
    assert transcript["text"] == "status report"
    assert transcript["user_id"] == "player"
    assert transcript["final"] is True

    assert isinstance(task.frames[0], UserTextInputFrame)
    assert isinstance(task.frames[1], InterruptionFrame)
    append = task.frames[2]
    assert isinstance(append, LLMMessagesAppendFrame)
    assert append.messages == [{"role": "user", "content": "status report"}]
    assert append.run_llm is True


@pytest.mark.asyncio
async def test_non_realtime_text_input_uses_pipeline_transcription_frames():
    task = RecordingPipelineTask()
    rtvi = RecordingRTVI()
    handler = _handler(realtime=False, task=task, rtvi=rtvi)

    await handler._handle_user_text_input("user-text-input", {"text": "status report"})

    assert rtvi.transport_messages == []
    assert isinstance(task.frames[0], UserTextInputFrame)
    assert isinstance(task.frames[1], InterruptionFrame)
    assert isinstance(task.frames[2], UserStartedSpeakingFrame)
    assert isinstance(task.frames[3], TranscriptionFrame)
    assert task.frames[3].text == "status report"
    assert isinstance(task.frames[4], UserStoppedSpeakingFrame)
