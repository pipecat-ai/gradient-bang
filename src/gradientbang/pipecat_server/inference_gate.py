import asyncio
import time
from dataclasses import replace
from typing import Awaitable, Callable, Optional

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    FunctionCallInProgressFrame,
    FunctionCallResultFrame,
    FunctionCallResultProperties,
    FunctionCallsStartedFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMMessagesAppendFrame,
    LLMMessagesUpdateFrame,
    LLMRunFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


class InferenceGateState:
    """Shared inference gating state across multiple processors."""

    def __init__(self, cooldown_seconds: float = 2.0, post_llm_grace_seconds: float = 0.0):
        self._cooldown_seconds = float(cooldown_seconds)
        self._post_llm_grace_seconds = float(post_llm_grace_seconds)
        self._bot_speaking = False
        self._user_speaking = False
        self._cooldown_until: Optional[float] = None
        self._llm_in_flight = False
        self._last_llm_end: Optional[float] = None
        self._pending = False
        self._pending_reason: Optional[str] = None
        self._pending_task: Optional[asyncio.Task] = None
        self._emit_run: Optional[Callable[[], Awaitable[None]]] = None
        self._task_factory: Optional[Callable[[Awaitable[None]], asyncio.Task]] = None
        self._lock = asyncio.Lock()
        self._bot_idle_event = asyncio.Event()
        self._bot_idle_event.set()
        self._user_idle_event = asyncio.Event()
        self._user_idle_event.set()
        self._llm_idle_event = asyncio.Event()
        self._llm_idle_event.set()

    def attach_emitter(
        self,
        emit_run: Callable[[], Awaitable[None]],
        task_factory: Callable[[Awaitable[None]], asyncio.Task],
    ) -> None:
        self._emit_run = emit_run
        self._task_factory = task_factory

    async def can_run_now(self) -> bool:
        async with self._lock:
            return self._can_run_now_locked()

    async def request_inference(self, reason: str) -> None:
        async with self._lock:
            self._pending = True
            self._pending_reason = reason
            self._ensure_pending_task_locked()

    async def update_bot_speaking(self, speaking: bool) -> None:
        async with self._lock:
            if self._bot_speaking == speaking:
                return
            self._bot_speaking = speaking
            if speaking:
                self._bot_idle_event.clear()
            else:
                self._bot_idle_event.set()
                if self._cooldown_seconds > 0:
                    self._cooldown_until = time.monotonic() + self._cooldown_seconds
                else:
                    self._cooldown_until = None
            if self._pending:
                self._ensure_pending_task_locked()

    async def update_user_speaking(self, speaking: bool) -> None:
        async with self._lock:
            if self._user_speaking == speaking:
                return
            self._user_speaking = speaking
            if speaking:
                self._user_idle_event.clear()
            else:
                self._user_idle_event.set()
                if self._pending:
                    self._pending = False
                    self._pending_reason = None
            if self._pending:
                self._ensure_pending_task_locked()

    async def update_llm_in_flight(self, in_flight: bool) -> None:
        async with self._lock:
            if self._llm_in_flight == in_flight:
                return
            self._llm_in_flight = in_flight
            if in_flight:
                self._llm_idle_event.clear()
            else:
                self._llm_idle_event.set()
                self._last_llm_end = time.monotonic()
            if self._pending:
                self._ensure_pending_task_locked()

    def _can_run_now_locked(self) -> bool:
        if self._bot_speaking:
            return False
        if self._user_speaking:
            return False
        if self._llm_in_flight:
            return False
        if self._cooldown_until is not None:
            if time.monotonic() < self._cooldown_until:
                return False
        return True

    def _ensure_pending_task_locked(self) -> None:
        if self._pending_task and not self._pending_task.done():
            return
        if not self._task_factory:
            logger.warning("InferenceGate: no task factory attached; cannot schedule inference.")
            return
        self._pending_task = self._task_factory(self._pending_runner())

    async def _pending_runner(self) -> None:
        while True:
            await self._bot_idle_event.wait()
            await self._user_idle_event.wait()
            await self._llm_idle_event.wait()

            async with self._lock:
                if not self._pending:
                    return
                cooldown_until = self._cooldown_until
                pending_reason = self._pending_reason
                last_llm_end = self._last_llm_end
                post_llm_grace_seconds = self._post_llm_grace_seconds

            if (
                pending_reason == "event"
                and post_llm_grace_seconds > 0
                and last_llm_end is not None
            ):
                grace_until = last_llm_end + post_llm_grace_seconds
                now = time.monotonic()
                if now < grace_until:
                    await asyncio.sleep(grace_until - now)
                    continue

            if cooldown_until is not None:
                delay = cooldown_until - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
                    continue

            async with self._lock:
                if not self._pending:
                    return
                if not self._can_run_now_locked():
                    continue
                self._pending = False
                reason = self._pending_reason
                self._pending_reason = None

            if self._emit_run is None:
                logger.warning("InferenceGate: no emitter attached; cannot run inference.")
                return

            logger.debug(f"InferenceGate: triggering deferred inference (reason={reason})")
            await self._emit_run()
            return


class PreLLMInferenceGate(FrameProcessor):
    """Gate event-triggered LLM runs before the user context aggregator."""

    def __init__(self, state: InferenceGateState):
        super().__init__()
        self._state = state

        async def _emit_run():
            await self.push_frame(LLMRunFrame(), FrameDirection.DOWNSTREAM)

        self._state.attach_emitter(_emit_run, self.create_task)

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, BotStartedSpeakingFrame):
            await self._state.update_bot_speaking(True)
        elif isinstance(frame, BotStoppedSpeakingFrame):
            await self._state.update_bot_speaking(False)
        elif isinstance(frame, UserStartedSpeakingFrame):
            await self._state.update_user_speaking(True)
        elif isinstance(frame, UserStoppedSpeakingFrame):
            await self._state.update_user_speaking(False)

        if isinstance(frame, LLMRunFrame) and direction == FrameDirection.DOWNSTREAM:
            if await self._state.can_run_now():
                await self.push_frame(frame, direction)
            else:
                await self._state.request_inference("llm_run")
            return

        if isinstance(frame, LLMMessagesAppendFrame) and direction == FrameDirection.DOWNSTREAM:
            if frame.run_llm and self._is_event_message(frame):
                if not await self._state.can_run_now():
                    frame.run_llm = False
                    await self._state.request_inference("event")
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMMessagesUpdateFrame) and direction == FrameDirection.DOWNSTREAM:
            await self.push_frame(frame, direction)
            return

        await self.push_frame(frame, direction)

    @staticmethod
    def _is_event_message(frame: LLMMessagesAppendFrame) -> bool:
        if not frame.messages:
            return False
        last = frame.messages[-1]
        if not isinstance(last, dict):
            return False
        if last.get("role") != "user":
            return False
        content = last.get("content")
        if not isinstance(content, str):
            return False
        return content.lstrip().startswith("<event")


class PostLLMInferenceGate(FrameProcessor):
    """Gate tool-triggered LLM runs before the assistant context aggregator."""

    def __init__(self, state: InferenceGateState):
        super().__init__()
        self._state = state
        self._function_calls_in_progress: set[str] = set()

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, BotStartedSpeakingFrame):
            await self._state.update_bot_speaking(True)
        elif isinstance(frame, BotStoppedSpeakingFrame):
            await self._state.update_bot_speaking(False)
        elif isinstance(frame, LLMFullResponseStartFrame):
            await self._state.update_llm_in_flight(True)
        elif isinstance(frame, LLMFullResponseEndFrame):
            await self._state.update_llm_in_flight(False)

        if isinstance(frame, FunctionCallsStartedFrame) and direction == FrameDirection.DOWNSTREAM:
            for call in frame.function_calls:
                self._function_calls_in_progress.add(call.tool_call_id)
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, FunctionCallInProgressFrame) and direction == FrameDirection.DOWNSTREAM:
            self._function_calls_in_progress.add(frame.tool_call_id)
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, FunctionCallResultFrame) and direction == FrameDirection.DOWNSTREAM:
            if frame.tool_call_id in self._function_calls_in_progress:
                self._function_calls_in_progress.discard(frame.tool_call_id)

            would_run_llm = self._should_run_llm_after_tool(frame)

            if would_run_llm and not await self._state.can_run_now():
                frame = self._disable_run_llm(frame)
                await self._state.request_inference("tool_result")

            await self.push_frame(frame, direction)
            return

        await self.push_frame(frame, direction)

    def _should_run_llm_after_tool(self, frame: FunctionCallResultFrame) -> bool:
        if not frame.result:
            return False
        if frame.properties and frame.properties.run_llm is not None:
            return bool(frame.properties.run_llm)
        if frame.run_llm is not None:
            return bool(frame.run_llm)
        return not bool(self._function_calls_in_progress)

    @staticmethod
    def _disable_run_llm(frame: FunctionCallResultFrame) -> FunctionCallResultFrame:
        properties = frame.properties
        if properties:
            if properties.run_llm is False:
                return frame
            frame.properties = replace(properties, run_llm=False)
        else:
            frame.run_llm = False
            frame.properties = FunctionCallResultProperties(run_llm=False)
        return frame
