import asyncio
import base64
from types import SimpleNamespace

import pytest

from pipecat.frames.frames import (
    AggregationType,
    FunctionCallResultFrame,
    InputAudioRawFrame,
    InterimTranscriptionFrame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    LLMMessagesAppendFrame,
    LLMRunFrame,
    TranscriptionFrame,
    TTSTextFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMAssistantAggregator,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.openai.realtime import events
from pipecat.turns.user_start import ExternalUserTurnStartStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from gradientbang.pipecat_server.inference_gate import InferenceGateState
from gradientbang.pipecat_server.openai_realtime import (
    OPENAI_REALTIME_DEFAULT_MODEL,
    OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL,
    OPENAI_REALTIME_TRANSCRIPTION_FAILED_MARKER,
    GradientOpenAIRealtimeLLMService,
    RealtimeAudioLLMUserAggregator,
    RealtimeFunctionResultRelay,
    RealtimeMainContextRelay,
    RealtimeSemanticUserTurnStopStrategy,
    RealtimeVoiceAgentInferenceGate,
    build_realtime_session_properties,
    filter_openai_realtime_failed_marker_messages,
    realtime_voice_agent_echo_exclude_frames,
)
from gradientbang.subagents.agents.base_agent import _BusEdgeProcessor
from gradientbang.subagents.bus.bridge_processor import BusBridgeProcessor


class ImmediateBus:
    def __init__(self):
        self.subscribers = []

    async def subscribe(self, subscriber):
        self.subscribers.append(subscriber)

    async def unsubscribe(self, subscriber):
        self.subscribers.remove(subscriber)

    async def send(self, message):
        for subscriber in list(self.subscribers):
            await subscriber.on_bus_message(message)


class RecordingRealtimeService(GradientOpenAIRealtimeLLMService):
    def __init__(self, **kwargs):
        super().__init__(
            api_key="test",
            settings=GradientOpenAIRealtimeLLMService.Settings(
                model=OPENAI_REALTIME_DEFAULT_MODEL,
                session_properties=build_realtime_session_properties(
                    model=OPENAI_REALTIME_DEFAULT_MODEL,
                    transcription_model=OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL,
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

    async def stop_all_metrics(self, *args, **kwargs):
        pass


class RecordingRealtimeUserAggregator(RealtimeAudioLLMUserAggregator):
    def __init__(self, context: LLMContext):
        super().__init__(
            context,
            params=LLMUserAggregatorParams(
                user_turn_strategies=UserTurnStrategies(
                    start=[ExternalUserTurnStartStrategy()],
                    stop=[RealtimeSemanticUserTurnStopStrategy()],
                ),
                vad_analyzer=None,
            ),
        )
        self.pushed = []

    async def push_frame(self, frame, direction=FrameDirection.DOWNSTREAM):
        self.pushed.append((frame, direction))


def _event_types(service: RecordingRealtimeService) -> list[str]:
    return [event["type"] for event in service.events]


@pytest.mark.asyncio
async def test_default_realtime_session_uses_default_models_and_24khz(monkeypatch):
    monkeypatch.delenv("OPENAI_REALTIME_VAD_EAGERNESS", raising=False)
    sp = build_realtime_session_properties(
        model=OPENAI_REALTIME_DEFAULT_MODEL,
        transcription_model=OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL,
        voice="marin",
    )

    assert sp.model == "gpt-realtime-2"
    assert sp.audio.input.transcription.model == "gpt-realtime-translate"
    assert sp.audio.input.format.rate == 24000
    assert sp.audio.output.format.rate == 24000
    assert sp.audio.input.turn_detection.type == "semantic_vad"
    assert sp.audio.input.turn_detection.eagerness == "medium"
    assert sp.audio.input.turn_detection.create_response is False
    assert sp.audio.input.turn_detection.interrupt_response is True


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
async def test_append_mutates_local_context_before_shared_context_adoption():
    service = RecordingRealtimeService()
    message = {"role": "user", "content": "pre-adoption context"}

    await service.insert_messages_from_append(
        LLMMessagesAppendFrame(messages=[message], run_llm=False),
        source="main-pipeline",
    )

    assert service._context.get_messages() == [message]
    assert _event_types(service).count("conversation.item.create") == 1


@pytest.mark.asyncio
async def test_append_relay_skips_local_mutation_after_shared_context_adoption():
    service = RecordingRealtimeService()
    service._api_session_ready = True
    shared_context = LLMContext([{"role": "system", "content": "base"}])
    await service._handle_context(shared_context)

    main_message = {"role": "user", "content": "typed order: status report"}
    await service.insert_messages_from_append(
        LLMMessagesAppendFrame(messages=[main_message], run_llm=False),
        source="main-pipeline",
    )

    assert shared_context.get_messages() == [{"role": "system", "content": "base"}]
    assert _event_types(service).count("conversation.item.create") == 1

    shared_context.add_message(main_message)
    voice_message = {"role": "assistant", "content": "acknowledged"}
    await service.insert_messages_from_append(
        LLMMessagesAppendFrame(messages=[voice_message], run_llm=False),
        source="voice-agent",
    )

    assert shared_context.get_messages() == [
        {"role": "system", "content": "base"},
        main_message,
    ]
    assert _event_types(service).count("conversation.item.create") == 2


@pytest.mark.asyncio
async def test_semantic_speech_frames_carry_item_metadata_without_aliasing():
    service = RecordingRealtimeService()
    evt = events.InputAudioBufferSpeechStarted(
        event_id="evt-start",
        type="input_audio_buffer.speech_started",
        item_id="item-a",
        audio_start_ms=120,
    )

    await service._handle_evt_speech_started(evt)

    frames = [frame for frame, _ in service.pushed if isinstance(frame, UserStartedSpeakingFrame)]
    assert len(frames) == 2
    assert frames[0].metadata == {
        "openai_realtime_item_id": "item-a",
        "openai_realtime_audio_start_ms": 120,
    }
    assert frames[1].metadata == frames[0].metadata
    assert frames[1].metadata is not frames[0].metadata

    frames[0].metadata["mutated"] = True
    assert "mutated" not in frames[1].metadata
    assert any(isinstance(frame, InterruptionFrame) for frame, _ in service.pushed)


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
    assert all(frame.includes_inter_frame_spaces is False for frame in tts_frames)


@pytest.mark.asyncio
async def test_realtime_word_output_preserves_spaces_in_assistant_context():
    service = RecordingRealtimeService()
    context = LLMContext()
    aggregator = LLMAssistantAggregator(context)

    async def record_push_frame(frame, direction=FrameDirection.DOWNSTREAM):
        pass

    aggregator.push_frame = record_push_frame

    await service._push_output_transcript_text_frames("Azure Ha")
    await service._push_output_transcript_text_frames("uler, com")
    await service._push_output_transcript_text_frames("mander")
    await service._flush_realtime_output_transcript_buffer()

    await aggregator.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    for frame, _ in service.pushed:
        if isinstance(frame, TTSTextFrame):
            await aggregator.process_frame(frame, FrameDirection.DOWNSTREAM)
    await aggregator.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)

    assert context.get_messages() == [{"role": "assistant", "content": "Azure Hauler, commander"}]


@pytest.mark.asyncio
async def test_semantic_turn_detection_user_stop_does_not_manually_commit_or_create_response():
    service = RecordingRealtimeService()
    service._api_session_ready = True

    await service._handle_user_stopped_speaking(UserStoppedSpeakingFrame())

    assert _event_types(service) == []


@pytest.mark.asyncio
async def test_realtime_user_aggregator_inserts_late_transcript_before_assistant():
    context = LLMContext([{"role": "system", "content": "base"}])
    aggregator = RecordingRealtimeUserAggregator(context)

    start = UserStartedSpeakingFrame()
    start.metadata.update(
        {
            "openai_realtime_item_id": "item-a",
            "openai_realtime_audio_start_ms": 100,
        }
    )
    stop = UserStoppedSpeakingFrame()
    stop.metadata.update(
        {
            "openai_realtime_item_id": "item-a",
            "openai_realtime_audio_end_ms": 900,
        }
    )
    transcript = TranscriptionFrame(
        "open the bay doors",
        "",
        "2026-05-06T12:00:00Z",
        result=SimpleNamespace(item_id="item-a"),
        finalized=True,
    )

    await aggregator.process_frame(start, FrameDirection.DOWNSTREAM)
    context.add_message({"role": "assistant", "content": "Working on it."})
    await aggregator.process_frame(transcript, FrameDirection.DOWNSTREAM)
    await aggregator.process_frame(stop, FrameDirection.DOWNSTREAM)

    assert context.get_messages() == [
        {"role": "system", "content": "base"},
        {
            "role": "user",
            "content": "open the bay doors",
            "metadata": {
                "source": "openai_realtime_transcription",
                "item_id": "item-a",
                "openai_realtime_item_id": "item-a",
                "timestamp": "2026-05-06T12:00:00Z",
                "openai_realtime_audio_start_ms": 100,
                "openai_realtime_audio_end_ms": 900,
            },
        },
        {"role": "assistant", "content": "Working on it."},
    ]
    assert sum(isinstance(frame, LLMContextFrame) for frame, _ in aggregator.pushed) == 1


@pytest.mark.asyncio
async def test_realtime_user_aggregator_falls_back_when_item_id_anchor_missing():
    context = LLMContext([{"role": "system", "content": "base"}])
    aggregator = RecordingRealtimeUserAggregator(context)

    start = UserStartedSpeakingFrame()
    start.metadata["openai_realtime_item_id"] = "item-a"
    stop = UserStoppedSpeakingFrame()
    stop.metadata["openai_realtime_item_id"] = "item-b"
    transcript = TranscriptionFrame(
        "mismatched item",
        "",
        "2026-05-06T12:00:00Z",
        result=SimpleNamespace(item_id="item-b"),
        finalized=True,
    )

    await aggregator.process_frame(start, FrameDirection.DOWNSTREAM)
    await aggregator.process_frame(stop, FrameDirection.DOWNSTREAM)
    await aggregator.process_frame(transcript, FrameDirection.DOWNSTREAM)

    assert context.get_messages()[-1]["content"] == "mismatched item"
    assert context.get_messages()[-1]["metadata"]["openai_realtime_item_id"] == "item-b"


@pytest.mark.asyncio
async def test_realtime_user_aggregator_suppresses_empty_semantic_stop_event():
    context = LLMContext()
    aggregator = RecordingRealtimeUserAggregator(context)
    stopped_messages = []

    @aggregator.event_handler("on_user_turn_stopped")
    async def on_user_turn_stopped(aggregator, strategy, message):
        stopped_messages.append(message)

    await aggregator._maybe_emit_user_turn_stopped(RealtimeSemanticUserTurnStopStrategy())

    assert stopped_messages == []
    assert context.get_messages() == []


@pytest.mark.asyncio
async def test_realtime_user_aggregator_preserves_order_when_transcripts_arrive_out_of_order():
    context = LLMContext([{"role": "system", "content": "base"}])
    aggregator = RecordingRealtimeUserAggregator(context)

    start_a = UserStartedSpeakingFrame()
    start_a.metadata["openai_realtime_item_id"] = "item-a"
    stop_a = UserStoppedSpeakingFrame()
    stop_a.metadata["openai_realtime_item_id"] = "item-a"
    transcript_a = TranscriptionFrame(
        "first turn",
        "",
        "2026-05-06T12:00:00Z",
        result=SimpleNamespace(item_id="item-a"),
        finalized=True,
    )

    start_b = UserStartedSpeakingFrame()
    start_b.metadata["openai_realtime_item_id"] = "item-b"
    stop_b = UserStoppedSpeakingFrame()
    stop_b.metadata["openai_realtime_item_id"] = "item-b"
    transcript_b = TranscriptionFrame(
        "second turn",
        "",
        "2026-05-06T12:00:01Z",
        result=SimpleNamespace(item_id="item-b"),
        finalized=True,
    )

    await aggregator.process_frame(start_a, FrameDirection.DOWNSTREAM)
    await aggregator.process_frame(stop_a, FrameDirection.DOWNSTREAM)
    await aggregator.process_frame(start_b, FrameDirection.DOWNSTREAM)
    await aggregator.process_frame(stop_b, FrameDirection.DOWNSTREAM)
    await aggregator.process_frame(transcript_b, FrameDirection.DOWNSTREAM)
    await aggregator.process_frame(transcript_a, FrameDirection.DOWNSTREAM)

    assert [message["content"] for message in context.get_messages()] == [
        "base",
        "first turn",
        "second turn",
    ]


@pytest.mark.asyncio
async def test_realtime_transcription_deltas_emit_cumulative_interim_frames_and_clear_on_final():
    service = RecordingRealtimeService()

    for index, delta in enumerate([" Streaming", " transcription", "."]):
        await service._handle_evt_input_audio_transcription_delta(
            events.ConversationItemInputAudioTranscriptionDelta(
                event_id=f"evt-delta-{index}",
                type="conversation.item.input_audio_transcription.delta",
                item_id="item-audio",
                content_index=0,
                delta=delta,
            )
        )

    frames = [frame for frame, _ in service.pushed if isinstance(frame, InterimTranscriptionFrame)]
    assert [frame.text for frame in frames] == [
        " Streaming",
        " Streaming transcription",
        " Streaming transcription.",
    ]
    assert all(direction == FrameDirection.UPSTREAM for _, direction in service.pushed)
    assert frames[-1].metadata["openai_realtime_item_id"] == "item-audio"
    assert frames[-1].metadata["openai_realtime_content_index"] == 0
    assert service._gradient_input_transcript_buffers[("item-audio", 0)] == (
        " Streaming transcription."
    )

    await service.handle_evt_input_audio_transcription_completed(
        events.ConversationItemInputAudioTranscriptionCompleted(
            event_id="evt-completed",
            type="conversation.item.input_audio_transcription.completed",
            item_id="item-audio",
            content_index=0,
            transcript="Streaming transcription.",
        )
    )

    assert ("item-audio", 0) not in service._gradient_input_transcript_buffers
    final_frames = [frame for frame, _ in service.pushed if isinstance(frame, TranscriptionFrame)]
    assert final_frames[-1].text == "Streaming transcription."


@pytest.mark.asyncio
async def test_failed_realtime_transcription_pushes_deduped_synthetic_marker():
    service = RecordingRealtimeService()
    await service._handle_evt_input_audio_transcription_delta(
        events.ConversationItemInputAudioTranscriptionDelta(
            event_id="evt-delta",
            type="conversation.item.input_audio_transcription.delta",
            item_id="item-failed",
            content_index=0,
            delta="partial",
        )
    )
    evt = events.ConversationItemInputAudioTranscriptionFailed(
        event_id="evt-failed",
        type="conversation.item.input_audio_transcription.failed",
        item_id="item-failed",
        content_index=0,
        error=events.RealtimeError(type="server_error", code="failed", message="no transcript"),
    )

    await service.handle_evt_input_audio_transcription_failed(evt)
    await service.handle_evt_input_audio_transcription_failed(evt)

    frames = [frame for frame, _ in service.pushed if isinstance(frame, TranscriptionFrame)]
    interim_frames = [
        frame for frame, _ in service.pushed if isinstance(frame, InterimTranscriptionFrame)
    ]
    assert [frame.text for frame in interim_frames] == ["partial", ""]
    assert interim_frames[-1].metadata["openai_realtime_item_id"] == "item-failed"
    assert len(frames) == 1
    assert frames[0].text == OPENAI_REALTIME_TRANSCRIPTION_FAILED_MARKER
    assert frames[0].metadata["openai_realtime_item_id"] == "item-failed"
    assert frames[0].metadata["openai_realtime_transcription_failed"] is True
    assert frames[0].metadata["synthetic"] is True


def test_realtime_voice_agent_echo_exclude_keeps_semantic_frames_forwarded():
    excluded = realtime_voice_agent_echo_exclude_frames()

    assert InputAudioRawFrame in excluded
    assert UserStartedSpeakingFrame not in excluded
    assert UserStoppedSpeakingFrame not in excluded
    assert InterruptionFrame not in excluded


@pytest.mark.asyncio
async def test_semantic_control_frames_cross_voice_edge_to_main_bridge_once():
    bus = ImmediateBus()
    voice_agent = SimpleNamespace(name="voice", active=True)
    edge = _BusEdgeProcessor(
        bus=bus,
        agent=voice_agent,
        direction=FrameDirection.DOWNSTREAM,
        exclude_frames=realtime_voice_agent_echo_exclude_frames(),
    )
    bridge = BusBridgeProcessor(bus=bus, agent_name="main", target_agent="voice")
    await bus.subscribe(bridge)

    edge_local_frames = []
    bridge_frames = []

    async def noop():
        pass

    async def record_edge_push(frame, direction=FrameDirection.DOWNSTREAM):
        edge_local_frames.append((frame, direction))

    async def record_bridge_push(frame, direction=FrameDirection.DOWNSTREAM):
        bridge_frames.append((frame, direction))

    edge.push_frame = record_edge_push
    edge._start_interruption = noop
    edge.stop_all_metrics = noop
    bridge.push_frame = record_bridge_push

    frames = [UserStartedSpeakingFrame(), UserStoppedSpeakingFrame(), InterruptionFrame()]
    for frame in frames:
        await edge.process_frame(frame, FrameDirection.DOWNSTREAM)

    assert [frame for frame, _ in edge_local_frames] == frames
    assert [frame for frame, _ in bridge_frames] == frames
    assert [direction for _, direction in bridge_frames] == [FrameDirection.DOWNSTREAM] * 3


def test_failed_transcription_marker_messages_are_filtered_from_context_exports():
    messages = [
        {"role": "system", "content": "base"},
        {
            "role": "user",
            "content": OPENAI_REALTIME_TRANSCRIPTION_FAILED_MARKER,
            "metadata": {"openai_realtime_transcription_failed": True},
        },
        {"role": "user", "content": "real user text"},
    ]

    assert filter_openai_realtime_failed_marker_messages(messages) == [
        {"role": "system", "content": "base"},
        {"role": "user", "content": "real user text"},
    ]


@pytest.mark.asyncio
async def test_realtime_voice_gate_defers_inference_while_semantic_user_turn_active():
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

    append = LLMMessagesAppendFrame(
        messages=[{"role": "user", "content": '<event name="task.completed" />'}],
        run_llm=True,
    )

    await gate.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
    await gate.process_frame(append, FrameDirection.DOWNSTREAM)
    await asyncio.sleep(0)

    assert append.run_llm is False
    assert emitted_runs == 0

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
