import asyncio
import base64

import pytest

from pipecat.frames.frames import (
    AggregationType,
    FunctionCallResultFrame,
    InputAudioRawFrame,
    LLMTextFrame,
    LLMMessagesAppendFrame,
    LLMRunFrame,
    TTSTextFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection

from gradientbang.pipecat_server.inference_gate import InferenceGateState
from gradientbang.pipecat_server.openai_realtime import (
    GradientOpenAIRealtimeLLMService,
    RealtimeFunctionResultRelay,
    RealtimeMainContextRelay,
    RealtimeVoiceAgentInferenceGate,
    build_realtime_session_properties,
)


class RecordingRealtimeService(GradientOpenAIRealtimeLLMService):
    def __init__(self, **kwargs):
        super().__init__(
            api_key="test",
            settings=GradientOpenAIRealtimeLLMService.Settings(
                model="gpt-realtime-1.5",
                session_properties=build_realtime_session_properties(
                    model="gpt-realtime-1.5",
                    transcription_model="gpt-4o-transcribe",
                    voice="marin",
                ),
            ),
            **kwargs,
        )
        self.events = []
        self.pushed = []

    async def send_client_event(self, event):
        self.events.append(event.model_dump(exclude_none=True))

    async def push_frame(self, frame, direction=FrameDirection.DOWNSTREAM):
        self.pushed.append((frame, direction))

    async def start_processing_metrics(self, *args, **kwargs):
        pass

    async def start_ttfb_metrics(self, *args, **kwargs):
        pass


def _event_types(service: RecordingRealtimeService) -> list[str]:
    return [event["type"] for event in service.events]


@pytest.mark.asyncio
async def test_default_realtime_session_uses_gpt_realtime_15_and_24khz():
    sp = build_realtime_session_properties(
        model="gpt-realtime-1.5",
        transcription_model="gpt-4o-transcribe",
        voice="marin",
    )

    assert sp.model == "gpt-realtime-1.5"
    assert sp.audio.input.format.rate == 24000
    assert sp.audio.output.format.rate == 24000
    assert sp.audio.input.turn_detection is False


@pytest.mark.asyncio
async def test_realtime_service_resamples_local_16khz_audio_to_24khz():
    service = RecordingRealtimeService()

    audio_20ms_16khz = b"\x00\x00" * 320
    await service._send_user_audio(
        InputAudioRawFrame(
            audio=audio_20ms_16khz,
            sample_rate=16000,
            num_channels=1,
        )
    )

    assert _event_types(service) == ["input_audio_buffer.append"]
    payload = base64.b64decode(service.events[0]["audio"])
    assert len(payload) > len(audio_20ms_16khz)
    assert len(payload) % 2 == 0


@pytest.mark.asyncio
async def test_activation_append_initializes_context_without_first_context_response():
    service = RecordingRealtimeService()
    service._api_session_ready = True

    frame = LLMMessagesAppendFrame(
        messages=[
            {"role": "system", "content": "You are the ship AI."},
            {"role": "user", "content": "<start_of_session />"},
        ],
        run_llm=False,
    )
    await service.insert_messages_from_append(frame, source="activation")

    await service._handle_context(LLMContext([{"role": "user", "content": "hello"}]))

    assert "conversation.item.create" in _event_types(service)
    assert "response.create" not in _event_types(service)


@pytest.mark.asyncio
async def test_main_context_relay_inserts_typed_text_before_user_aggregator_consumes_it():
    service = RecordingRealtimeService()
    service._api_session_ready = True
    relay = RealtimeMainContextRelay(lambda: service)

    frame = LLMMessagesAppendFrame(
        messages=[{"role": "user", "content": "typed order: status report"}],
        run_llm=True,
    )
    await relay.process_frame(frame, FrameDirection.DOWNSTREAM)

    event_types = _event_types(service)
    assert event_types.count("conversation.item.create") == 1
    assert event_types.count("response.create") == 1


@pytest.mark.asyncio
async def test_function_result_run_llm_false_sends_output_without_response():
    service = RecordingRealtimeService()
    service._api_session_ready = True
    service.realtime_call_ids.add("call_123")
    relay = RealtimeFunctionResultRelay(lambda: service)

    frame = FunctionCallResultFrame(
        function_name="my_status",
        tool_call_id="call_123",
        arguments={},
        result={"ok": True},
        run_llm=False,
    )
    await relay.process_frame(frame, FrameDirection.DOWNSTREAM)

    assert _event_types(service) == ["conversation.item.create"]
    item = service.events[0]["item"]
    assert item["type"] == "function_call_output"
    assert item["call_id"] == "call_123"


@pytest.mark.asyncio
async def test_function_result_after_post_gate_uses_effective_run_llm_true():
    service = RecordingRealtimeService()
    service._api_session_ready = True
    service.realtime_call_ids.add("call_456")
    relay = RealtimeFunctionResultRelay(lambda: service)

    frame = FunctionCallResultFrame(
        function_name="my_status",
        tool_call_id="call_456",
        arguments={},
        result={"ok": True},
        run_llm=True,
    )
    await relay.process_frame(frame, FrameDirection.DOWNSTREAM)

    assert _event_types(service).count("conversation.item.create") == 1
    assert _event_types(service).count("response.create") == 1


@pytest.mark.asyncio
async def test_realtime_audio_transcript_deltas_emit_non_final_word_output():
    service = RecordingRealtimeService()

    await service._push_output_transcript_text_frames("Azure Ha")
    await service._push_output_transcript_text_frames("uler, com")
    await service._push_output_transcript_text_frames("mander")
    await service._flush_realtime_output_transcript_buffer()

    llm_texts = [frame.text for frame, _ in service.pushed if isinstance(frame, LLMTextFrame)]
    tts_frames = [frame for frame, _ in service.pushed if isinstance(frame, TTSTextFrame)]

    assert llm_texts == ["Azure Ha", "uler, com", "mander"]
    assert [frame.text for frame in tts_frames] == ["Azure", "Hauler,", "commander"]
    assert all(frame.aggregated_by == AggregationType.WORD for frame in tts_frames)


@pytest.mark.asyncio
async def test_realtime_voice_gate_preserves_pending_inference_after_vad_false_start():
    emitted_runs = 0
    state = InferenceGateState(cooldown_seconds=0)

    async def emit_run():
        nonlocal emitted_runs
        emitted_runs += 1

    tasks = []

    def create_task(coro):
        task = asyncio.create_task(coro)
        tasks.append(task)
        return task

    state.attach_emitter(emit_run, create_task)
    gate = RealtimeVoiceAgentInferenceGate(state)

    start = VADUserStartedSpeakingFrame(start_secs=0.1)
    stop = VADUserStoppedSpeakingFrame(stop_secs=0.4)
    append = LLMMessagesAppendFrame(
        messages=[{"role": "user", "content": '<event name="task.completed" />'}],
        run_llm=True,
    )

    await gate.process_frame(start, FrameDirection.DOWNSTREAM)
    await gate.process_frame(append, FrameDirection.DOWNSTREAM)
    assert append.run_llm is False

    await gate.process_frame(stop, FrameDirection.DOWNSTREAM)
    await asyncio.sleep(0)

    assert emitted_runs == 1

    for task in tasks:
        if not task.done():
            task.cancel()


@pytest.mark.asyncio
async def test_realtime_voice_gate_clears_pending_on_logical_user_stop():
    emitted_runs = 0
    state = InferenceGateState(cooldown_seconds=0)

    async def emit_run():
        nonlocal emitted_runs
        emitted_runs += 1

    tasks = []

    def create_task(coro):
        task = asyncio.create_task(coro)
        tasks.append(task)
        return task

    state.attach_emitter(emit_run, create_task)
    gate = RealtimeVoiceAgentInferenceGate(state)

    await gate.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
    append = LLMMessagesAppendFrame(
        messages=[{"role": "user", "content": '<event name="task.completed" />'}],
        run_llm=True,
    )
    await gate.process_frame(append, FrameDirection.DOWNSTREAM)
    assert append.run_llm is False

    await gate.process_frame(UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
    await asyncio.sleep(0)

    assert emitted_runs == 0

    run = LLMRunFrame()
    await gate.process_frame(run, FrameDirection.DOWNSTREAM)
    assert emitted_runs == 0

    for task in tasks:
        if not task.done():
            task.cancel()
