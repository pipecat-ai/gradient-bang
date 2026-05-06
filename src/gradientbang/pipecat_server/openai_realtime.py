"""OpenAI Realtime integration helpers for the voice agent pipeline."""

from __future__ import annotations

import base64
import hashlib
import json
import time
from typing import Any, Callable, Optional

import numpy as np
from loguru import logger
from av import AudioFrame, AudioResampler

from pipecat.audio.turn.base_turn_analyzer import BaseTurnAnalyzer, EndOfTurnState
from pipecat.frames.frames import (
    AggregationType,
    BotStoppedSpeakingFrame,
    CancelFrame,
    EndFrame,
    Frame,
    FunctionCallResultFrame,
    InputAudioRawFrame,
    InterimTranscriptionFrame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMMessagesAppendFrame,
    LLMRunFrame,
    LLMSetToolsFrame,
    LLMTextFrame,
    MetricsFrame,
    SpeechControlParamsFrame,
    StartFrame,
    TextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    TTSSpeakFrame,
    TTSTextFrame,
    TTSUpdateSettingsFrame,
    UserSpeakingFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.parallel_pipeline import ParallelPipeline
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMUserAggregator,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.llm_service import FunctionCallFromLLM, LLMService
from pipecat.services.openai.realtime import events
from pipecat.services.openai.realtime.llm import (
    CurrentAudioResponse,
    OpenAIRealtimeLLMService,
)
from pipecat.transcriptions.language import Language
from pipecat.turns.types import ProcessFrameResult
from pipecat.turns.user_stop.base_user_turn_stop_strategy import BaseUserTurnStopStrategy
from pipecat.utils.time import time_now_iso8601

from gradientbang.pipecat_server.inference_gate import (
    InferenceGateState,
    PreLLMInferenceGate,
)

OPENAI_REALTIME_SAMPLE_RATE = 24000
OPENAI_REALTIME_LOCAL_INPUT_SAMPLE_RATE = 16000

_REALTIME_OUTPUT_ATTR = "_gradientbang_openai_realtime_output"


def is_realtime_output_frame(frame: Frame) -> bool:
    """Return whether a frame was emitted by the Realtime service wrapper."""
    return bool(getattr(frame, _REALTIME_OUTPUT_ATTR, False))


def mark_realtime_output_frame(frame: Frame) -> Frame:
    """Mark a frame as Realtime-originated for downstream routing."""
    setattr(frame, _REALTIME_OUTPUT_ATTR, True)
    return frame


def effective_run_llm(frame: FunctionCallResultFrame) -> bool:
    """Return the post-gate run_llm value for a function-call result frame."""
    if frame.properties and frame.properties.run_llm is not None:
        return bool(frame.properties.run_llm)
    if frame.run_llm is not None:
        return bool(frame.run_llm)
    return True


def _message_digest(message: Any) -> str:
    try:
        payload = json.dumps(message, sort_keys=True, ensure_ascii=False, default=str)
    except Exception:
        payload = repr(message)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                parts.append(str(item))
                continue
            if isinstance(item.get("text"), str):
                parts.append(item["text"])
            elif isinstance(item.get("content"), str):
                parts.append(item["content"])
        return " ".join(part for part in parts if part)
    if content is None:
        return ""
    try:
        return json.dumps(content, ensure_ascii=False)
    except Exception:
        return str(content)


def _serialize_tool_output(result: Any) -> str:
    if isinstance(result, str):
        return result
    return json.dumps(result, ensure_ascii=False)


class RealtimeAudioOnlyS3TurnStopStrategy(BaseUserTurnStopStrategy):
    """Stop a user turn from S3/SmartTurn audio classification only."""

    def __init__(self, *, turn_analyzer: BaseTurnAnalyzer, **kwargs):
        super().__init__(**kwargs)
        self._turn_analyzer = turn_analyzer
        self._vad_user_speaking = False

    async def reset(self):
        await super().reset()
        self._vad_user_speaking = False

    async def cleanup(self):
        await super().cleanup()
        await self._turn_analyzer.cleanup()

    async def process_frame(self, frame: Frame) -> ProcessFrameResult:
        await super().process_frame(frame)

        if isinstance(frame, StartFrame):
            await self._start(frame)
        elif isinstance(frame, VADUserStartedSpeakingFrame):
            self._turn_analyzer.update_vad_start_secs(frame.start_secs)
            self._vad_user_speaking = True
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            self._vad_user_speaking = False
            await self._analyze_end_of_turn()
        elif isinstance(frame, InputAudioRawFrame):
            self._turn_analyzer.append_audio(frame.audio, self._vad_user_speaking)

        return ProcessFrameResult.CONTINUE

    async def _start(self, frame: StartFrame):
        self._turn_analyzer.set_sample_rate(frame.audio_in_sample_rate)
        await self.broadcast_frame(SpeechControlParamsFrame, turn_params=self._turn_analyzer.params)

    async def _analyze_end_of_turn(self):
        state, result = await self._turn_analyzer.analyze_end_of_turn()
        if result:
            await self.push_frame(MetricsFrame(data=[result]))

        if state is EndOfTurnState.COMPLETE and result is not None:
            if getattr(result, "is_complete", True):
                await self.trigger_user_turn_stopped()


class RealtimeAudioLLMUserAggregator(LLMUserAggregator):
    """User aggregator variant that mirrors late Realtime transcripts.

    The logical user turn is stopped by local VAD/S3. OpenAI input
    transcription arrives after the audio buffer commit, so these frames must
    not enter the stock aggregation buffer for the next turn.
    """

    def __init__(
        self,
        context: LLMContext,
        *,
        params: Optional[LLMUserAggregatorParams] = None,
        **kwargs,
    ):
        super().__init__(context, params=params, **kwargs)
        self._seen_realtime_transcript_items: set[str] = set()

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        if isinstance(frame, InterimTranscriptionFrame):
            await FrameProcessor.process_frame(self, frame, direction)
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, TranscriptionFrame):
            await FrameProcessor.process_frame(self, frame, direction)
            await self._mirror_realtime_transcription(frame)
            await self.push_frame(frame, direction)
            return

        await super().process_frame(frame, direction)

    async def _mirror_realtime_transcription(self, frame: TranscriptionFrame) -> None:
        text = frame.text.strip()
        if not text:
            return
        result = frame.result
        item_id = getattr(result, "item_id", None)
        if item_id:
            if item_id in self._seen_realtime_transcript_items:
                return
            self._seen_realtime_transcript_items.add(item_id)
        self._context.add_message(
            {
                "role": "user",
                "content": text,
                "metadata": {
                    "source": "openai_realtime_transcription",
                    "item_id": item_id,
                    "timestamp": frame.timestamp,
                },
            }
        )


class GradientOpenAIRealtimeLLMService(OpenAIRealtimeLLMService):
    """Gradient Bang wrapper around Pipecat's OpenAI Realtime service."""

    def __init__(
        self,
        *,
        inference_gate_state: Optional[InferenceGateState] = None,
        sample_rate: int = OPENAI_REALTIME_SAMPLE_RATE,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._gradient_gate_state = inference_gate_state
        self._gradient_sample_rate = sample_rate
        self._gradient_response_active = False
        self._gradient_response_start_pushed = False
        self._gradient_sent_append_keys: set[tuple[int, int]] = set()
        self._gradient_seen_message_keys: set[tuple[int, str]] = set()
        self._gradient_sent_function_outputs: set[str] = set()
        self._gradient_realtime_call_ids: set[str] = set()
        self._gradient_latest_committed_audio_item_id: Optional[str] = None
        self._gradient_audio_resamplers: dict[int, AudioResampler] = {}
        self._gradient_output_transcript_buffer = ""

        self._context = LLMContext()
        self._llm_needs_conversation_setup = False

    @property
    def realtime_call_ids(self) -> set[str]:
        return self._gradient_realtime_call_ids

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await LLMService.process_frame(self, frame, direction)

        if isinstance(frame, (LLMContextFrame,)):
            await self._handle_context(frame.context)
            return

        if isinstance(frame, InputAudioRawFrame):
            if not self._audio_input_paused:
                await self._send_user_audio(frame)
            return

        if isinstance(frame, InterruptionFrame):
            await self._handle_interruption()
            self._gradient_response_active = False
            self._gradient_response_start_pushed = False
            return

        if isinstance(
            frame,
            (
                UserStartedSpeakingFrame,
                UserSpeakingFrame,
                VADUserStartedSpeakingFrame,
                VADUserStoppedSpeakingFrame,
            ),
        ):
            if isinstance(frame, UserStartedSpeakingFrame):
                await self._handle_user_started_speaking(frame)
            return

        if isinstance(frame, UserStoppedSpeakingFrame):
            await self._handle_user_stopped_speaking(frame)
            return

        if isinstance(frame, BotStoppedSpeakingFrame):
            await self._handle_bot_stopped_speaking()
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMMessagesAppendFrame):
            await self.insert_messages_from_append(frame, source="voice-agent")
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMRunFrame):
            await self.maybe_create_response("llm-run", frame)
            return

        if isinstance(frame, LLMSetToolsFrame):
            self._ensure_context().set_tools(frame.tools)
            await self._send_session_update()
            await self.push_frame(frame, direction)
            return

        await self.push_frame(frame, direction)

    async def push_frame(self, frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM):
        if isinstance(
            frame,
            (
                LLMFullResponseStartFrame,
                LLMFullResponseEndFrame,
                LLMTextFrame,
                TTSTextFrame,
                TTSStartedFrame,
                TTSAudioRawFrame,
                TTSStoppedFrame,
            ),
        ):
            mark_realtime_output_frame(frame)
        await super().push_frame(frame, direction)

    def _ensure_context(self) -> LLMContext:
        if self._context is None:
            self._context = LLMContext()
        return self._context

    async def _handle_context(self, context: LLMContext):
        self._context = context
        self._llm_needs_conversation_setup = False
        for message in context.get_messages():
            self._gradient_seen_message_keys.add((id(message), _message_digest(message)))
        await self._process_completed_function_calls(send_new_results=False)

    async def _handle_user_stopped_speaking(self, frame):
        turn_detection_disabled = (
            self._settings.session_properties.audio
            and self._settings.session_properties.audio.input
            and self._settings.session_properties.audio.input.turn_detection is False
        )
        if turn_detection_disabled:
            await self.send_client_event(events.InputAudioBufferCommitEvent())
            await self.maybe_create_response("user-stopped-speaking", frame, ignore_gate=True)

    async def insert_messages_from_append(
        self, frame: LLMMessagesAppendFrame, *, source: str
    ) -> list[str]:
        context = self._ensure_context()
        item_ids: list[str] = []

        for index, message in enumerate(frame.messages or []):
            append_key = (frame.id, index)
            if append_key in self._gradient_sent_append_keys:
                continue
            self._gradient_sent_append_keys.add(append_key)

            if not isinstance(message, dict):
                logger.debug(
                    f"Realtime: dropping unsupported append message from {source}: {message!r}"
                )
                continue

            self._gradient_seen_message_keys.add((id(message), _message_digest(message)))
            role = message.get("role")
            content = _message_text(message.get("content"))

            if role in ("system", "developer"):
                await self._append_instruction(content)
                context.add_message(dict(message))
                continue

            if role == "tool" or message.get("tool_call_id"):
                logger.debug("Realtime: tool message append ignored; tool relay owns outputs")
                context.add_message(dict(message))
                continue

            item = self._conversation_item_from_message(role, content)
            if item is None:
                logger.debug(f"Realtime: unsupported append role={role!r} from {source}")
                context.add_message(dict(message))
                continue

            self._messages_added_manually[item.id] = True
            await self.send_client_event(events.ConversationItemCreateEvent(item=item))
            item_ids.append(item.id)
            context.add_message(dict(message))

        if frame.run_llm:
            await self.maybe_create_response(f"{source}:messages-append", frame)
        return item_ids

    async def _append_instruction(self, instruction: str) -> None:
        instruction = instruction.strip()
        if not instruction:
            return
        existing = self._settings.system_instruction
        if existing:
            self._settings.system_instruction = f"{existing}\n\n{instruction}"
        else:
            self._settings.system_instruction = instruction
        if self._settings.session_properties:
            self._settings.session_properties.instructions = self._settings.system_instruction
        await self._send_session_update()

    def _conversation_item_from_message(
        self, role: Any, content: str
    ) -> Optional[events.ConversationItem]:
        if role not in ("user", "assistant"):
            return None
        content_type = "input_text" if role == "user" else "output_text"
        return events.ConversationItem(
            type="message",
            role=role,
            content=[events.ItemContent(type=content_type, text=content)],
        )

    async def maybe_create_response(
        self,
        source: str,
        frame: Optional[Frame] = None,
        *,
        ignore_gate: bool = False,
    ) -> bool:
        if not self._api_session_ready:
            logger.debug(
                f"Realtime: deferring response.create until session ready (source={source})"
            )
            self._run_llm_when_api_session_ready = True
            return False

        if self._gradient_response_active:
            logger.debug(f"Realtime: response already active; deferring trigger (source={source})")
            if self._gradient_gate_state:
                await self._gradient_gate_state.request_inference("llm_run")
            return False

        if self._gradient_gate_state and not ignore_gate:
            if not await self._gradient_gate_state.can_run_now():
                logger.debug(f"Realtime: shared gate blocked response.create (source={source})")
                await self._gradient_gate_state.request_inference("llm_run")
                return False

        logger.debug(f"Realtime: creating response (source={source}, frame={frame})")
        self._gradient_response_active = True
        self._gradient_response_start_pushed = True
        if self._gradient_gate_state:
            await self._gradient_gate_state.update_llm_in_flight(True)
        await self.push_frame(LLMFullResponseStartFrame())
        await self.start_processing_metrics()
        await self.start_ttfb_metrics()
        await self.send_client_event(
            events.ResponseCreateEvent(
                response=events.ResponseProperties(output_modalities=self._get_enabled_modalities())
            )
        )
        return True

    async def insert_function_call_output(
        self, frame: FunctionCallResultFrame, *, run_llm: bool, source: str
    ) -> bool:
        call_id = frame.tool_call_id
        if call_id not in self._gradient_realtime_call_ids:
            logger.debug(
                f"Realtime: ignoring non-Realtime function result call_id={call_id} source={source}"
            )
            return False
        if call_id in self._gradient_sent_function_outputs:
            logger.debug(f"Realtime: function output already sent call_id={call_id}")
            return False

        output = _serialize_tool_output(frame.result if frame.result else "COMPLETED")
        item = events.ConversationItem(
            type="function_call_output",
            call_id=call_id,
            output=output,
        )
        await self.send_client_event(events.ConversationItemCreateEvent(item=item))
        self._gradient_sent_function_outputs.add(call_id)
        self._completed_tool_calls.add(call_id)
        if run_llm:
            await self.maybe_create_response(f"{source}:function-result", frame)
        return True

    async def _send_tool_result(self, tool_call_id: str, result: str):
        if tool_call_id in self._gradient_sent_function_outputs:
            return
        if tool_call_id not in self._gradient_realtime_call_ids:
            logger.debug(f"Realtime: context sync skipped unknown tool_call_id={tool_call_id}")
            return
        item = events.ConversationItem(
            type="function_call_output",
            call_id=tool_call_id,
            output=_serialize_tool_output(result),
        )
        await self.send_client_event(events.ConversationItemCreateEvent(item=item))
        self._gradient_sent_function_outputs.add(tool_call_id)

    async def _send_user_audio(self, frame):
        if frame.num_channels != 1:
            logger.error(
                f"Realtime: dropping input audio with channels={frame.num_channels}; expected 1"
            )
            return
        audio = frame.audio
        if frame.sample_rate != self._gradient_sample_rate:
            audio = self._resample_input_audio(frame)
            if not audio:
                return
        payload = base64.b64encode(audio).decode("utf-8")
        await self.send_client_event(events.InputAudioBufferAppendEvent(audio=payload))

    def _resample_input_audio(self, frame: InputAudioRawFrame) -> bytes:
        resampler = self._gradient_audio_resamplers.get(frame.sample_rate)
        if resampler is None:
            resampler = AudioResampler("s16", "mono", self._gradient_sample_rate)
            self._gradient_audio_resamplers[frame.sample_rate] = resampler

        samples = np.frombuffer(frame.audio, dtype=np.int16)
        audio_frame = AudioFrame.from_ndarray(samples[None, :], layout="mono")
        audio_frame.sample_rate = frame.sample_rate
        output_frames = resampler.resample(audio_frame)
        chunks = [out.to_ndarray().astype(np.int16).tobytes() for out in output_frames]
        return b"".join(chunks)

    async def _ws_send(self, realtime_message):
        if self._disconnecting or not self._websocket:
            event_type = (
                realtime_message.get("type") if isinstance(realtime_message, dict) else None
            )
            logger.debug(
                f"Realtime: dropping client event because websocket is unavailable "
                f"(type={event_type}, disconnecting={self._disconnecting})"
            )
            return
        await super()._ws_send(realtime_message)

    async def _handle_evt_session_updated(self, evt):
        self._api_session_ready = True
        if self._run_llm_when_api_session_ready:
            self._run_llm_when_api_session_ready = False
            await self.maybe_create_response("session-ready")

    async def _handle_evt_conversation_item_added(self, evt):
        if evt.item.type == "function_call":
            if evt.item.call_id not in self._pending_function_calls:
                self._pending_function_calls[evt.item.call_id] = evt.item
            if evt.item.call_id:
                self._gradient_realtime_call_ids.add(evt.item.call_id)

        await self._call_event_handler("on_conversation_item_created", evt.item.id, evt.item)

        if self._messages_added_manually.get(evt.item.id):
            del self._messages_added_manually[evt.item.id]
            return

        if evt.item.role == "assistant":
            self._current_assistant_response = evt.item
            if not self._gradient_response_start_pushed:
                self._gradient_response_start_pushed = True
                await self.push_frame(LLMFullResponseStartFrame())

    async def _handle_evt_response_done(self, evt):
        try:
            await self._flush_realtime_output_transcript_buffer()
            await super()._handle_evt_response_done(evt)
        finally:
            self._gradient_response_active = False
            self._gradient_response_start_pushed = False
            if self._gradient_gate_state:
                await self._gradient_gate_state.update_llm_in_flight(False)

    async def _handle_interruption(self):
        self._gradient_output_transcript_buffer = ""
        await super()._handle_interruption()
        self._gradient_response_active = False
        self._gradient_response_start_pushed = False

    async def handle_evt_input_audio_transcription_completed(self, evt):
        await self._call_event_handler("on_conversation_item_updated", evt.item_id, None)
        frame = TranscriptionFrame(
            evt.transcript,
            "",
            time_now_iso8601(),
            result=evt,
            finalized=True,
        )
        await self.push_frame(frame, FrameDirection.UPSTREAM)
        await self._handle_user_transcription(evt.transcript, True, Language.EN)

    async def _handle_evt_input_audio_buffer_committed(self, evt):
        self._gradient_latest_committed_audio_item_id = evt.item_id
        logger.debug(f"Realtime: input audio buffer committed item_id={evt.item_id}")

    async def _handle_evt_function_call_arguments_done(self, evt):
        try:
            args = json.loads(evt.arguments)
            function_call_item = self._pending_function_calls.get(evt.call_id)
            if function_call_item:
                self._gradient_realtime_call_ids.add(evt.call_id)
                del self._pending_function_calls[evt.call_id]
                function_calls = [
                    FunctionCallFromLLM(
                        context=self._context,
                        tool_call_id=evt.call_id,
                        function_name=function_call_item.name,
                        arguments=args,
                    )
                ]
                await self.run_function_calls(function_calls)
                logger.debug(f"Realtime: processed function call {function_call_item.name}")
            else:
                logger.warning(
                    f"Realtime: no tracked function call found for call_id={evt.call_id}"
                )
        except Exception as exc:
            logger.error(f"Realtime: failed to process function call arguments: {exc}")

    async def _receive_task_handler(self):
        async for message in self._websocket:
            evt = events.parse_server_event(message)
            if evt.type == "session.created":
                await self._handle_evt_session_created(evt)
            elif evt.type == "session.updated":
                await self._handle_evt_session_updated(evt)
            elif evt.type == "input_audio_buffer.committed":
                await self._handle_evt_input_audio_buffer_committed(evt)
            elif evt.type == "response.output_audio.delta":
                await self._handle_evt_audio_delta(evt)
            elif evt.type == "response.output_audio.done":
                await self._handle_evt_audio_done(evt)
            elif evt.type == "conversation.item.added":
                await self._handle_evt_conversation_item_added(evt)
            elif evt.type == "conversation.item.done":
                await self._handle_evt_conversation_item_done(evt)
            elif evt.type == "conversation.item.input_audio_transcription.delta":
                await self._handle_evt_input_audio_transcription_delta(evt)
            elif evt.type == "conversation.item.input_audio_transcription.completed":
                await self.handle_evt_input_audio_transcription_completed(evt)
            elif evt.type == "conversation.item.input_audio_transcription.failed":
                logger.debug(f"Realtime: input audio transcription failed: {evt.error}")
            elif evt.type == "conversation.item.retrieved":
                await self._handle_conversation_item_retrieved(evt)
            elif evt.type == "response.done":
                await self._handle_evt_response_done(evt)
            elif evt.type == "input_audio_buffer.speech_started":
                await self._handle_evt_speech_started(evt)
            elif evt.type == "input_audio_buffer.speech_stopped":
                await self._handle_evt_speech_stopped(evt)
            elif evt.type == "response.output_text.delta":
                await self._handle_evt_text_delta(evt)
            elif evt.type == "response.output_audio_transcript.delta":
                await self._handle_evt_audio_transcript_delta(evt)
            elif evt.type == "response.output_audio_transcript.done":
                await self._handle_evt_audio_transcript_done(evt)
            elif evt.type == "response.function_call_arguments.done":
                await self._handle_evt_function_call_arguments_done(evt)
            elif evt.type == "error":
                if not await self._maybe_handle_evt_retrieve_conversation_item_error(evt):
                    if evt.error.code in (
                        "response_cancel_not_active",
                        "conversation_already_has_active_response",
                    ):
                        logger.debug(f"{self} {evt.error.message}")
                    else:
                        await self._handle_evt_error(evt)
                        return

    async def _handle_evt_audio_delta(self, evt):
        await self.stop_ttfb_metrics()
        if self._current_audio_response and self._current_audio_response.item_id != evt.item_id:
            logger.warning("Realtime: new audio item before previous BotStoppedSpeakingFrame")
            self._current_audio_response = None
        if not self._current_audio_response:
            self._current_audio_response = CurrentAudioResponse(
                item_id=evt.item_id,
                content_index=evt.content_index,
                start_time_ms=int(time.time() * 1000),
            )
            await self.push_frame(TTSStartedFrame())
        audio = base64.b64decode(evt.delta)
        self._current_audio_response.total_size += len(audio)
        await self.push_frame(
            TTSAudioRawFrame(audio=audio, sample_rate=self._gradient_sample_rate, num_channels=1)
        )

    async def _handle_evt_audio_done(self, evt):
        await self._flush_realtime_output_transcript_buffer()
        await super()._handle_evt_audio_done(evt)

    async def _handle_evt_audio_transcript_done(self, evt):
        await self._flush_realtime_output_transcript_buffer()

    async def _push_output_transcript_text_frames(self, text: str):
        llm_text_frame = LLMTextFrame(text)
        llm_text_frame.append_to_context = False
        await self.push_frame(llm_text_frame)
        await self._push_realtime_output_transcript_words(text)

    async def _push_realtime_output_transcript_words(self, text: str = "", *, flush: bool = False):
        if text:
            self._gradient_output_transcript_buffer += text

        buffer = self._gradient_output_transcript_buffer
        if not buffer:
            return

        if flush:
            complete_text = buffer
            self._gradient_output_transcript_buffer = ""
        elif buffer[-1].isspace():
            complete_text = buffer
            self._gradient_output_transcript_buffer = ""
        else:
            split_at = -1
            for index in range(len(buffer) - 1, -1, -1):
                if buffer[index].isspace():
                    split_at = index
                    break
            if split_at < 0:
                return
            complete_text = buffer[:split_at]
            self._gradient_output_transcript_buffer = buffer[split_at + 1 :]

        for word in complete_text.split():
            frame = TTSTextFrame(word, aggregated_by=AggregationType.WORD)
            frame.includes_inter_frame_spaces = True
            await self.push_frame(frame)

    async def _flush_realtime_output_transcript_buffer(self):
        await self._push_realtime_output_transcript_words(flush=True)


class RealtimeVoiceAgentInferenceGate(FrameProcessor):
    """Apply the shared inference gate to direct VoiceAgent Realtime triggers."""

    def __init__(self, state: InferenceGateState):
        super().__init__()
        self._state = state

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, VADUserStartedSpeakingFrame):
            await self._state.update_user_audio_active(True)
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            await self._state.update_user_audio_active(False)
        elif isinstance(frame, UserStartedSpeakingFrame):
            await self._state.update_user_turn_active(True)
        elif isinstance(frame, UserStoppedSpeakingFrame):
            await self._state.update_user_turn_active(False, clear_pending=True)

        if isinstance(frame, LLMMessagesAppendFrame) and direction == FrameDirection.DOWNSTREAM:
            if frame.run_llm and not await self._state.can_run_now():
                reason = "llm_run"
                if PreLLMInferenceGate._is_event_message(frame):
                    event_name = PreLLMInferenceGate._extract_event_name(frame)
                    reason = PreLLMInferenceGate._inference_reason_for_event(frame, event_name)
                frame.run_llm = False
                await self._state.request_inference(reason)
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMRunFrame) and direction == FrameDirection.DOWNSTREAM:
            if await self._state.can_run_now():
                await self.push_frame(frame, direction)
            else:
                await self._state.request_inference("llm_run")
            return

        await self.push_frame(frame, direction)


RealtimeServiceGetter = Callable[[], Optional[GradientOpenAIRealtimeLLMService]]


class RealtimeMainContextRelay(FrameProcessor):
    """Mirror main-pipeline context append/run frames before user aggregation."""

    def __init__(self, service_getter: RealtimeServiceGetter):
        super().__init__()
        self._service_getter = service_getter

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        service = self._service_getter()
        if service and direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, LLMMessagesAppendFrame):
                await service.insert_messages_from_append(frame, source="main-pipeline")
            elif isinstance(frame, LLMRunFrame):
                await service.maybe_create_response("main-pipeline:llm-run", frame)
        elif direction == FrameDirection.DOWNSTREAM and isinstance(
            frame, (LLMMessagesAppendFrame, LLMRunFrame)
        ):
            logger.debug(f"RealtimeMainContextRelay: service unavailable for {frame}")
        await self.push_frame(frame, direction)


class RealtimeFunctionResultRelay(FrameProcessor):
    """Send Realtime function_call_output items before assistant aggregation."""

    def __init__(self, service_getter: RealtimeServiceGetter):
        super().__init__()
        self._service_getter = service_getter

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, FunctionCallResultFrame) and direction == FrameDirection.DOWNSTREAM:
            service = self._service_getter()
            if service:
                await service.insert_function_call_output(
                    frame,
                    run_llm=effective_run_llm(frame),
                    source="main-branch",
                )
            else:
                logger.debug(f"RealtimeFunctionResultRelay: service unavailable for {frame}")
        await self.push_frame(frame, direction)


class _RealtimeBypassRoute(FrameProcessor):
    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, (TTSSpeakFrame, TTSUpdateSettingsFrame)):
            return
        await self.push_frame(frame, direction)


class _LocalTTSRoute(FrameProcessor):
    _LOCAL_TTS_FRAMES = (
        StartFrame,
        EndFrame,
        CancelFrame,
        InterruptionFrame,
        TTSSpeakFrame,
        TTSUpdateSettingsFrame,
    )

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, self._LOCAL_TTS_FRAMES):
            await self.push_frame(frame, direction)
            return
        if isinstance(frame, TextFrame) and not is_realtime_output_frame(frame):
            await self.push_frame(frame, direction)


def build_realtime_output_mux(tts: FrameProcessor) -> ParallelPipeline:
    """Build an output mux that routes explicit local TTS separately."""
    return ParallelPipeline([_RealtimeBypassRoute()], [_LocalTTSRoute(), tts])


def realtime_voice_agent_echo_exclude_frames() -> tuple[type[Frame], ...]:
    return (
        InputAudioRawFrame,
        UserStartedSpeakingFrame,
        UserStoppedSpeakingFrame,
        UserSpeakingFrame,
        VADUserStartedSpeakingFrame,
        VADUserStoppedSpeakingFrame,
        InterruptionFrame,
    )


def build_realtime_session_properties(
    *,
    model: str,
    transcription_model: str,
    voice: str,
) -> events.SessionProperties:
    return events.SessionProperties(
        model=model,
        output_modalities=["audio"],
        audio=events.AudioConfiguration(
            input=events.AudioInput(
                format=events.PCMAudioFormat(rate=OPENAI_REALTIME_SAMPLE_RATE),
                transcription=events.InputAudioTranscription(model=transcription_model),
                turn_detection=False,
            ),
            output=events.AudioOutput(
                format=events.PCMAudioFormat(rate=OPENAI_REALTIME_SAMPLE_RATE),
                voice=voice,
            ),
        ),
    )
