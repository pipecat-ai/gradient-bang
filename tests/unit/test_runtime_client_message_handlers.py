import pytest

from pipecat.frames.frames import (
    InterruptionFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)

from gradientbang.runtime.client_message_handlers import ClientMessageHandler
from gradientbang.runtime.frames import UserTextInputFrame

pytestmark = pytest.mark.unit


class _Message:
    type = "user-text-input"
    data = {"text": "plot a course to Rigel"}


class _PipelineWorker:
    def __init__(self) -> None:
        self.queued_frames = []

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
