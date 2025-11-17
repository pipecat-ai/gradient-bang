"""
Experimental task agent that routes task execution through a Pipecat pipeline.

This implementation constructs a fresh Pipecat pipeline for each task.

For verbose logging set the Pipecat log level either in code or using an environment variable. For example:

```
LOGURU_LEVEL=DEBUG uv run npc/run_experimental_task.py khk-1 "Where am I?"
```
"""

from __future__ import annotations

import asyncio
import copy
import inspect
import json
import os
import time
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, List, Optional, Set, Tuple

from dotenv import load_dotenv
from loguru import logger
from google.genai import types as genai_types
from google.genai.types import Content, GenerateContentResponse

from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import (
    Frame,
    FunctionCallResultProperties,
    EndFrame,
    LLMFullResponseEndFrame,
    LLMMessagesAppendFrame,
    LLMRunFrame,
    LLMTextFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext, LLMSpecificMessage
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.google.llm import GoogleLLMService as PipecatGoogleLLMService
from pipecat.services.llm_service import FunctionCallParams, LLMService

from gradientbang.utils.api_client import AsyncGameClient
from gradientbang.utils.base_llm_agent import LLMConfig

from gradientbang.utils.tools_schema import (
    MyStatus,
    LeaderboardResources,
    PlotCourse,
    LocalMapRegion,
    ListKnownPorts,
    #    PathWithRegion, # Advanced version of plot_course -- disabled for now
    Move,
    Trade,
    PurchaseFighters,
    CreateCorporation,
    JoinCorporation,
    LeaveCorporation,
    KickCorporationMember,
    PurchaseShip,
    EventQuery,
    SalvageCollect,
    SendMessage,
    RechargeWarpPower,
    TransferWarpPower,
    TransferCredits,
    BankDeposit,
    BankWithdraw,
    DumpCargo,
    PlaceFighters,
    CollectFighters,
    CorporationInfo,
    TaskFinished,
    WaitInIdleState,
    CombatInitiate,
    CombatAction,
)
from gradientbang.utils.token_usage_logging import TokenUsageMetricsProcessor
from gradientbang.utils.prompts import GAME_DESCRIPTION, TASK_EXECUTION_INSTRUCTIONS


load_dotenv()


class TaskOutputType(Enum):
    """Types of output messages from the task agent."""

    STEP = "STEP"
    ACTION = "ACTION"
    EVENT = "EVENT"
    MESSAGE = "MESSAGE"
    ERROR = "ERROR"
    FINISHED = "FINISHED"

    def __str__(self):
        return self.value


def create_task_system_message() -> str:
    """Create the system prompt for the LLM.

    Returns:
        Complete system prompt including game description and instructions
    """
    return f"""{GAME_DESCRIPTION}

{TASK_EXECUTION_INSTRUCTIONS}
"""


def create_task_instruction_user_message(task: str) -> str:
    """Create a task-specific prompt for the LLM.

    Args:
        task: The task to be completed.

    Returns:
        Formatted prompt for the current decision point.

    Example:
        >>> create_npc_task_prompt("Move to sector 10", {"current_sector": 0})
        '# Agent Instructions\n...'
    """
    prompt_parts = [
        "# Agent Instructions",
        "",
        "You are an autonomous agent. Execute this task step by step. After each step, observe the results and react accordingly. Responses you generate from each inference call will be used only internally to complete the task. The only information that is returned to the user is the final result message that is passed to the `finished` tool call.",
        "",
        "When you have completed the task, call the `finished` tool with a message to be returned to the user who initiated the task.",
        "",
        "# Current time (UTC)",
        f"{datetime.now(timezone.utc).isoformat()}",
        "",
        "# Task Instructions",
        "",
        f"{task}",
        "",
    ]
    return "\n".join(prompt_parts)


DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash-preview-09-2025"
# DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash"
# DEFAULT_GOOGLE_MODEL = "gemini-2.5-pro-preview-06-05"
DEFAULT_THINKING_BUDGET = 2048
DEFAULT_INCLUDE_THOUGHTS = True
EVENT_BATCH_INFERENCE_DELAY = 1.0


class _GeminiThinkingModeContentFrame(Frame):
    def __init__(self, contents: List[Content]):
        super().__init__()
        self.contents = contents


class _GeminiThinkingModeTracker(FrameProcessor):
    def __init__(self, agent: "TaskAgent"):
        super().__init__()
        self._agent = agent

    async def process_frame(self, frame: Any, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMTextFrame):
            # We do not want the assistant aggregator to assemble the assistant messages. We're going to add
            # output chunks from Gemini directly to the context
            return

        if isinstance(frame, _GeminiThinkingModeContentFrame):
            self._agent._llm_inflight = False
            should_queue_inference = False
            wait_in_idle_state = False
            new_context = []
            output_message = ""
            for content in frame.contents:
                for part in content.parts or []:
                    if part.text:
                        if part.thought:
                            logger.debug(f"[THOUGHT]: {part.text}")
                        else:
                            output_message += part.text
                    elif part.function_call:
                        should_queue_inference = True
                        if part.function_call.name == "wait_in_idle_state":
                            wait_in_idle_state = True
                new_context.append(LLMSpecificMessage(llm="google", message=content))
            if output_message:
                self._agent._output(output_message, TaskOutputType.MESSAGE)
            if new_context:
                await self.push_frame(LLMMessagesAppendFrame(messages=new_context))

            if should_queue_inference:
                if wait_in_idle_state:
                    logger.debug(
                        "wait_in_idle_state function call detected; deferring inference until events/timeout"
                    )
                else:
                    # todo: should we schedule inference again here as if we got an event, with the 1s watchdog timer?
                    logger.debug(
                        "Tool function call detected; deferring inference until tool completion"
                    )
            else:
                logger.debug(
                    "No tool calls in _GeminiThinkingModeContentFrame. Scheduling follow-up inference."
                )
                self._agent._record_inference_reason("llm_continue")
                if not self._agent._llm_inflight:
                    self._agent._start_inference_watchdog()

        await self.push_frame(frame, direction)


PipelineToolExecutor = Callable[
    [Dict[str, Any]], Awaitable[Tuple[Optional[Dict[str, Any]], bool, Any]]
]
ToolEventCallback = Callable[[str, Any], Awaitable[None]]


class TaskAgent:
    """Task agent powered by a Pipecat pipeline."""

    def __init__(
        self,
        game_client: AsyncGameClient,
        character_id: str,
        *,
        output_callback: Optional[Callable[[str, Optional[str]], None]] = None,
        tool_call_event_callback: Optional[ToolEventCallback] = None,
        tools_list: Optional[List[Any]] = None,
        tool_executor: Optional[PipelineToolExecutor] = None,
        llm_service_factory: Optional[Callable[[], LLMService]] = None,
        thinking_budget: Optional[int] = None,
        idle_timeout_secs: Optional[float] = None,
    ):
        api_key = os.getenv("GOOGLE_API_KEY")
        if not api_key:
            raise ValueError(
                "Google API key must be provided in config or GOOGLE_API_KEY environment variable"
            )

        self.game_client = game_client
        self.character_id = character_id

        self.output_callback = output_callback
        self._tool_call_event_callback = tool_call_event_callback
        self._llm_service_factory = llm_service_factory or self._default_llm_service_factory
        self._thinking_budget = thinking_budget or DEFAULT_THINKING_BUDGET
        self._include_thoughts = DEFAULT_INCLUDE_THOUGHTS
        self._pipeline_idle_timeout_secs = idle_timeout_secs

        self.messages: List[Dict[str, Any]] = []
        self.tools: Dict[str, Callable[..., Awaitable[Any]]] = {}
        self._tools_schema: Optional[ToolsSchema] = None

        self.cancelled = False
        self.finished = False
        self.finished_message: Optional[str] = None
        self._active_pipeline_task: Optional[PipelineTask] = None
        self._step_counter: int = 0
        self._tool_call_in_progress: bool = False
        self._inference_reasons: List[str] = []
        self._inference_delay = EVENT_BATCH_INFERENCE_DELAY
        self._inference_watchdog_handle: Optional[asyncio.TimerHandle] = None
        self._llm_inflight: bool = False
        self._task_start_monotonic: Optional[float] = None
        self._context: Optional[LLMContext] = None
        self._last_logged_message_count: int = 0
        self._last_event_monotonic: float = time.perf_counter()
        self._idle_wait_event: Optional[asyncio.Event] = None
        self._idle_wait_active: bool = False
        self._idle_wait_interrupt_reason: Optional[str] = None

        self._synchronous_tools: Set[str] = set()

        tools = tools_list or [
            MyStatus,
            LeaderboardResources,
            PlotCourse,
            LocalMapRegion,
            ListKnownPorts,
            Move,
            Trade,
            PurchaseFighters,
            CreateCorporation,
            JoinCorporation,
            LeaveCorporation,
            KickCorporationMember,
            PurchaseShip,
            EventQuery,
            DumpCargo,
            SalvageCollect,
            SendMessage,
            RechargeWarpPower,
            TransferWarpPower,
            TransferCredits,
            BankDeposit,
            BankWithdraw,
            PlaceFighters,
            CollectFighters,
            CorporationInfo,
            CombatInitiate,
            CombatAction,
            WaitInIdleState,
            TaskFinished,
        ]
        self.set_tools(tools)
        self._synchronous_tools = {LeaderboardResources.schema().name}

        self._event_names = [
            "status.snapshot",
            "status.update",
            "sector.update",
            "course.plot",
            "path.region",
            "movement.start",
            "movement.complete",
            "map.knowledge",
            "map.region",
            "map.local",
            "ports.list",
            "character.moved",
            "trade.executed",
            "port.update",
            "fighter.purchase",
            "warp.purchase",
            "warp.transfer",
            "credits.transfer",
            "garrison.deployed",
            "garrison.collected",
            "garrison.mode_changed",
            "salvage.collected",
            "salvage.created",
            "bank.transaction",
            "combat.round_waiting",
            "combat.round_resolved",
            "combat.ended",
            "combat.action_accepted",
            "chat.message",
            "idle.complete",
            "event.query",
            "error",
        ]
        for event_name in self._event_names:
            self.game_client.on(event_name)(self._handle_event)

    def _default_llm_service_factory(self) -> LLMService:
        # todo: PR for Pipecat GoogleLLMService to add stop() and cancel() overrides
        class GoogleLLMService(PipecatGoogleLLMService):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self._captured_candidate_contents: List[Content] = []

            async def cancel(self, frame):
                await super().cancel(frame)
                try:
                    await self._client.aio.aclose()
                except Exception:  # noqa: BLE001
                    pass

            async def _stream_content(
                self, params_from_context
            ) -> AsyncIterator[GenerateContentResponse]:
                run_reason = None
                pending = getattr(self, "_agent_inference_reasons", None)
                if pending:
                    run_reason = pending[0]
                logger.debug(
                    "GoogleLLMService._stream_content invoked reason={} pending={}",
                    run_reason,
                    len(pending) if isinstance(pending, list) else -1,
                )
                try:
                    base_stream = await super()._stream_content(params_from_context)
                except Exception:
                    raise
                self._captured_candidate_contents.clear()

                async def _capturing_stream() -> AsyncIterator[GenerateContentResponse]:
                    async for chunk in base_stream:
                        candidates = getattr(chunk, "candidates", None)
                        candidate = candidates[0] if candidates else None
                        content = getattr(candidate, "content", None) if candidate else None
                        if content is not None:
                            # logger.info(f"!!! {content}")
                            self._captured_candidate_contents.append(content)

                        yield chunk

                return _capturing_stream()

            async def push_frame(
                self,
                frame,
                direction: FrameDirection = FrameDirection.DOWNSTREAM,
            ):
                if isinstance(frame, LLMFullResponseEndFrame):
                    if self._captured_candidate_contents:
                        contents_copy: List[Content] = [
                            content.model_copy(deep=True)
                            for content in self._captured_candidate_contents
                        ]
                        await super().push_frame(
                            _GeminiThinkingModeContentFrame(contents=contents_copy)
                        )
                        self._captured_candidate_contents.clear()
                    else:
                        logger.warning("LLMFullResponseEndFrame but no candidate contents")

                await super().push_frame(frame, direction)

            def _is_sanitized_function_message(self, message: Any) -> bool:
                if isinstance(message, LLMSpecificMessage):
                    return False
                if isinstance(message, dict):
                    parts = message.get("parts") or []
                    if parts and any(
                        isinstance(part, dict) and part.get("function_response") is not None
                        for part in parts
                    ):
                        return True
                    if message.get("role") == "tool":
                        return True
                return False

            @staticmethod
            def _is_sanitized_function_call_only(message: Any) -> bool:
                if not isinstance(message, dict):
                    return False
                parts = message.get("parts") or []
                if not parts:
                    tool_calls = message.get("tool_calls") or []
                    if tool_calls and all(
                        isinstance(call, dict)
                        and call.get("function")
                        and not message.get("content")
                        for call in tool_calls
                    ):
                        return True
                    return False
                return all(
                    isinstance(part, dict)
                    and part.get("function_call") is not None
                    and not part.get("function_response")
                    and not part.get("text")
                    for part in parts
                )

            def _find_previous_function_call_name(
                self, messages: List[Any], start_index: int
            ) -> Optional[str]:
                for cursor in range(start_index, -1, -1):
                    candidate = messages[cursor]
                    if isinstance(candidate, LLMSpecificMessage):
                        candidate_parts = getattr(candidate.message, "parts", None) or []
                        for part in reversed(candidate_parts):
                            function_call = getattr(part, "function_call", None)
                            if function_call and getattr(function_call, "name", None):
                                return getattr(function_call, "name")
                    elif isinstance(candidate, dict):
                        candidate_parts = candidate.get("parts") or []
                        for part in reversed(candidate_parts):
                            if not isinstance(part, dict):
                                continue
                            function_call = part.get("function_call")
                            if function_call:
                                name = function_call.get("name")
                                if name:
                                    return name
                        tool_calls = candidate.get("tool_calls") or []
                        for tool_call in reversed(tool_calls):
                            if not isinstance(tool_call, dict):
                                continue
                            function_payload = tool_call.get("function", {})
                            if not isinstance(function_payload, dict):
                                continue
                            name = function_payload.get("name")
                            if name:
                                return name
                return None

            def _create_function_response_message(
                self,
                name: Optional[str],
                response_payload: Any,
                extra_fields: Dict[str, Any],
            ) -> LLMSpecificMessage:
                resolved_name = name or "tool_call_result"
                part = genai_types.Part.from_function_response(
                    name=resolved_name,
                    response=response_payload if response_payload is not None else {},
                )
                for field in ("will_continue", "scheduling", "parts"):
                    value = extra_fields.get(field)
                    if value is not None:
                        try:
                            setattr(part.function_response, field, value)
                        except AttributeError:
                            pass
                content = Content(role="user", parts=[part])
                adapter = self.get_llm_adapter()
                llm_id = adapter.id_for_llm_specific_messages if adapter else "google"
                return LLMSpecificMessage(llm=llm_id, message=content)

            def _convert_function_response_message(
                self,
                raw_message: Dict[str, Any],
                preceding_messages: List[Any],
            ) -> LLMSpecificMessage:
                response_dict: Dict[str, Any] = {}
                response_payload: Any = {}
                name: Optional[str] = None

                parts = raw_message.get("parts") or []
                if parts:
                    first_part = parts[0]
                    if isinstance(first_part, dict):
                        response_dict = first_part.get("function_response", {}) or {}

                if response_dict:
                    response_payload = response_dict.get("response", {})
                    name = response_dict.get("name")
                else:
                    raw_content = raw_message.get("content")
                    if isinstance(raw_content, str):
                        try:
                            response_payload = json.loads(raw_content)
                        except json.JSONDecodeError:
                            response_payload = {"text": raw_content}
                    elif raw_content is not None:
                        response_payload = raw_content

                if not name:
                    name = self._find_previous_function_call_name(
                        preceding_messages, len(preceding_messages) - 1
                    )

                return self._create_function_response_message(
                    name,
                    response_payload,
                    response_dict,
                )

            def _remove_duplicate_function_call_messages(self, context: LLMContext) -> None:
                messages = context.get_messages()
                normalized_messages: List[Any] = []
                changed = False
                idx = 0

                while idx < len(messages):
                    message = messages[idx]

                    if self._is_sanitized_function_call_only(message):
                        changed = True
                        idx += 1
                        continue

                    next_index = idx + 1
                    if (
                        isinstance(message, LLMSpecificMessage)
                        and next_index < len(messages)
                        and self._is_sanitized_function_call_only(messages[next_index])
                    ):
                        normalized_messages.append(message)
                        changed = True
                        idx += 2
                        continue

                    if self._is_sanitized_function_message(message):
                        normalized_messages.append(
                            self._convert_function_response_message(message, normalized_messages)
                        )
                        changed = True
                        idx += 1
                        continue

                    normalized_messages.append(message)
                    idx += 1

                if changed:
                    context.set_messages(normalized_messages)

            async def _process_context(self, context: Any):
                if isinstance(context, LLMContext):
                    self._remove_duplicate_function_call_messages(context)
                result = await super()._process_context(context)
                return result

        service = GoogleLLMService(
            api_key=os.getenv("GOOGLE_API_KEY"),
            model=DEFAULT_GOOGLE_MODEL,
            run_in_parallel=False,
            params=GoogleLLMService.InputParams(
                extra={
                    "thinking_config": {
                        "thinking_budget": self._thinking_budget,
                        "include_thoughts": self._include_thoughts,
                    }
                }
            ),
        )

        setattr(service, "_agent_inference_reasons", self._inference_reasons)

        return service

    def set_tools(self, tools_list: List[Any]) -> None:
        tool_entries: List[Tuple[Any, Dict[str, Any]]] = []
        for entry in tools_list:
            if isinstance(entry, (tuple, list)):
                tool_class, init_kwargs = entry
            else:
                tool_class, init_kwargs = entry, {}
            tool_entries.append((tool_class, dict(init_kwargs)))

        self.tools.clear()
        standard_tools = []
        for tool_class, init_kwargs in tool_entries:
            init_args = {"game_client": self.game_client}
            init_args.update(init_kwargs)
            tool_instance = tool_class(**init_args)
            binder = getattr(tool_instance, "bind_agent", None)
            if callable(binder):
                binder(self)
            self.tools[tool_class.schema().name] = tool_instance
            standard_tools.append(tool_class.schema())

        self._tools_schema = ToolsSchema(standard_tools=standard_tools)

    def add_message(self, message: Dict[str, Any]) -> None:
        msg = {k: v for k, v in message.items() if k != "token_usage"}
        self.messages.append(msg)

    def clear_messages(self) -> None:
        self.messages = []

    def cancel(self) -> None:
        self.cancelled = True
        self._output(self._timestamped_text("Execution cancelled"), TaskOutputType.FINISHED)

    def reset_cancellation(self) -> None:
        self.cancelled = False

    async def _handle_event(self, event: Dict[str, Any]) -> None:
        event_name = event.get("event_name")
        if self._idle_wait_event is not None and not self._idle_wait_event.is_set():
            self._idle_wait_interrupt_reason = event_name or "unknown"
            self._idle_wait_event.set()
        summary = event.get("summary")
        response_data = summary or event.get("payload")
        serialized_payload = self._serialize_output(response_data)
        if event_name:
            event_text = f"{event_name}: {serialized_payload}"
        else:
            event_text = serialized_payload
        self._output(event_text, TaskOutputType.EVENT)
        self._last_event_monotonic = time.perf_counter()
        event_message = {
            "role": "user",
            "content": f"<event name={event_name}>\n{response_data}\n</event>",
        }
        if getattr(self, "_context", None) is not None:
            self._context.add_message(event_message)
        else:
            self.add_message(event_message)

        if event_name == "error" and os.getenv("STOP_ON_ERROR_EVENT"):
            self._log_error_event(event)
            self.cancelled = True
            try:
                if self._active_pipeline_task:
                    await self._active_pipeline_task.cancel()
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"Failed to cancel pipeline task after error event: {exc}")
            raise RuntimeError(f"Encountered error event: {event}")

        if event_name == "error":
            error_payload = summary if summary is not None else event.get("payload")
            error_message = self._serialize_output(error_payload)
            error_text = self._timestamped_text(error_message)
            self._output(error_text, TaskOutputType.ERROR)

        reason = event_name or "unknown"
        self._record_inference_reason(reason)
        if self._tool_call_in_progress and not self._idle_wait_active:
            logger.debug(
                "Recorded event during tool call; delaying inference reason={}",
                reason,
            )
            return
        if not self._llm_inflight:
            self._start_inference_watchdog()

    def _log_error_event(self, event: Dict[str, Any]) -> None:
        log_path = Path(os.getenv("ERROR_EVENT_LOG", "logs/error_events.jsonl"))
        log_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": event,
        }
        try:
            with log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"Failed to write error event log: {exc}")

    async def wait_in_idle_state(self, seconds: int = 60) -> Dict[str, Any]:
        """Remain idle while still processing incoming events for up to `seconds`."""

        try:
            duration = int(seconds)
        except (TypeError, ValueError):
            duration = 60
        duration = max(1, min(60, duration))

        anchor = self._last_event_monotonic
        start = time.perf_counter()
        wait_event = asyncio.Event()
        self._idle_wait_event = wait_event
        self._idle_wait_active = True
        self._idle_wait_interrupt_reason = None

        interrupted = False
        try:
            await asyncio.wait_for(wait_event.wait(), timeout=duration)
            interrupted = True
        except asyncio.TimeoutError:
            interrupted = False
        finally:
            self._idle_wait_event = None
            self._idle_wait_active = False

        elapsed = time.perf_counter() - start
        events_received = interrupted or (self._last_event_monotonic != anchor)
        interrupt_reason = self._idle_wait_interrupt_reason
        self._idle_wait_interrupt_reason = None

        result: Dict[str, Any] = {
            "requested_seconds": duration,
            "waited_seconds": elapsed,
            "events_received": events_received,
            "emitted_idle_event": False,
        }
        if interrupt_reason:
            result["interrupt_reason"] = interrupt_reason

        if events_received:
            return result

        summary = {
            "message": f"No events received for {elapsed:.1f} seconds.",
            "waited_seconds": round(elapsed, 2),
            "requested_seconds": duration,
            "last_event_age": round(time.perf_counter() - anchor, 2),
        }
        synthetic_event = {
            "event_name": "idle.complete",
            "summary": summary,
        }
        # Temporarily mark as waiting so the synthetic event schedules inference.
        self._idle_wait_active = True
        await self._handle_event(synthetic_event)
        self._idle_wait_active = False
        result["emitted_idle_event"] = True
        result["idle_event_summary"] = summary
        return result

    async def run_task(
        self,
        task: str,
        max_iterations: int = 100,
    ) -> bool:
        self.reset_cancellation()
        self.finished = False
        self.finished_message = None
        self.clear_messages()
        self._step_counter = 0
        self._inference_reasons.clear()
        self._cancel_inference_watchdog()
        self._tool_call_in_progress = False
        self._llm_inflight = False
        self._task_start_monotonic = time.perf_counter()
        _ = max_iterations  # retained for API compatibility; pipeline controls turns

        self.add_message({"role": "system", "content": create_task_system_message()})
        self.add_message({"role": "user", "content": create_task_instruction_user_message(task)})

        context = self._create_context()
        runner_task = self._setup_pipeline(context)
        self._context = context
        self._last_logged_message_count = len(context.get_messages())

        # Kick off the first inference turn even if no events arrive immediately.
        self._record_inference_reason("task_start")
        await self._schedule_pending_inference()

        try:
            await self.game_client.resume_event_delivery()

            success = False
            while not self._active_pipeline_task.has_finished():
                if self.cancelled:
                    self._output(
                        self._timestamped_text("Task cancelled"),
                        TaskOutputType.FINISHED,
                    )
                    return False
                try:
                    await asyncio.sleep(1)
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    self._emit_error_and_finish(
                        f"Pipeline error: {error}", exception_detail=str(error)
                    )
                    return False

                if self.finished:
                    success = True
                    break
        finally:
            if self._active_pipeline_task:
                await self._active_pipeline_task.cancel()
            await runner_task
            self._active_pipeline_task = None
            self._cancel_inference_watchdog()
            self._inference_reasons.clear()
            return success

    def _create_context(self) -> LLMContext:
        context_messages = copy.deepcopy(self.messages)
        tools = self._tools_schema if self._tools_schema else ToolsSchema([])
        return LLMContext(messages=context_messages, tools=tools)

    def _setup_pipeline(self, context: LLMContext) -> Tuple[PipelineTask,]:
        llm_service = self._llm_service_factory()
        llm_service.register_function(None, self._handle_function_call)

        aggregator_pair = LLMContextAggregatorPair(context)
        state_tracker = _GeminiThinkingModeTracker(self)
        usage_metrics = TokenUsageMetricsProcessor(source="task")
        pipeline = Pipeline(
            [
                aggregator_pair.user(),
                llm_service,
                usage_metrics,
                state_tracker,
                aggregator_pair.assistant(),
            ]
        )
        pipeline_task_kwargs: Dict[str, Any] = {}
        if self._pipeline_idle_timeout_secs is not None:
            pipeline_task_kwargs["idle_timeout_secs"] = self._pipeline_idle_timeout_secs

        pipeline_task = PipelineTask(
            pipeline,
            params=PipelineParams(
                allow_interruptions=False,
                enable_metrics=True,
                enable_usage_metrics=True,
            ),
            **pipeline_task_kwargs,
        )

        pipeline_runner = PipelineRunner(handle_sigint=False, handle_sigterm=False)
        runner_task = asyncio.create_task(pipeline_runner.run(pipeline_task))

        self._active_pipeline_task = pipeline_task
        return runner_task

    def _emit_step(self, label: Optional[str] = "") -> None:
        self._step_counter += 1
        elapsed_ms = self._elapsed_ms()
        label_suffix = f": {label}" if label else ""
        step_text = f"{self._step_counter} - {elapsed_ms} ms elapsed{label_suffix}"
        self._output(step_text, TaskOutputType.STEP)

    def _elapsed_ms(self) -> int:
        if self._task_start_monotonic is None:
            return 0
        return int((time.perf_counter() - self._task_start_monotonic) * 1000)

    def _timestamped_text(self, message: str) -> str:
        elapsed_ms = self._elapsed_ms()
        return f"{elapsed_ms} ms elapsed - {message}"

    @staticmethod
    def _serialize_output(data: Any) -> str:
        if isinstance(data, str):
            return data
        try:
            return json.dumps(data, ensure_ascii=False)
        except (TypeError, ValueError):
            return str(data)

    @staticmethod
    def _extract_text_from_message(message: Dict[str, Any]) -> str:
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            text_parts = []
            for part in content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "text" and isinstance(part.get("text"), str):
                    text_parts.append(part["text"])
            if text_parts:
                return "".join(text_parts)

        parts = message.get("parts")
        if isinstance(parts, list):
            text_parts = []
            for part in parts:
                if isinstance(part, dict):
                    text_value = part.get("text")
                    if isinstance(text_value, str):
                        text_parts.append(text_value)
                else:
                    text_value = getattr(part, "text", None)
                    if isinstance(text_value, str):
                        text_parts.append(text_value)
            if text_parts:
                return "".join(text_parts)

        text = message.get("text")
        if isinstance(text, str):
            return text

        return ""

    def _emit_error_and_finish(
        self, error_message: str, *, exception_detail: Optional[str] = None
    ) -> None:
        self._output(self._timestamped_text(error_message), TaskOutputType.ERROR)
        detail = exception_detail if exception_detail is not None else error_message
        finished_payload = f"Task stopped because of an error: {detail}"
        self._output(self._timestamped_text(finished_payload), TaskOutputType.FINISHED)

    async def _handle_function_call(self, params: FunctionCallParams) -> None:
        tool_name = params.function_name
        tool_call_id = params.tool_call_id
        arguments = params.arguments or {}

        if tool_name == "finished":
            self.finished = True
            self.finished_message = arguments.get("message", "Done")
            finished_text = self._timestamped_text(self.finished_message)
            self._output(finished_text, TaskOutputType.FINISHED)
            await params.llm.push_frame(EndFrame())
            return

        self._emit_step()
        action_text = f"{tool_name}({json.dumps(arguments)})"
        self._output(action_text, TaskOutputType.ACTION)

        if self._tool_call_event_callback:
            await self._tool_call_event_callback(tool_name, arguments)

        is_synchronous_tool = tool_name in self._synchronous_tools

        if not is_synchronous_tool:
            # put a tool call result into the context saying we sent the request
            tool_result = {"status": "Executed."}
            properties = FunctionCallResultProperties(run_llm=False)
            await params.result_callback(tool_result, properties=properties)

        tool = self.tools.get(tool_name)
        if not tool:
            error_text = self._timestamped_text(f"Unknown tool: {tool_name}")
            self._output(error_text, TaskOutputType.ERROR)
            logger.debug("TOOL_RESULT unknown tool={} arguments={}", tool_name, arguments)
            await self._on_tool_call_completed(tool_name, {"error": f"Unknown tool: {tool_name}"})
            return

        result_payload: Any = None
        error_message: Optional[Dict[str, Any]] = None
        error_payload: Optional[Any] = None
        try:
            self._tool_call_in_progress = True
            result = tool(**arguments)
            if inspect.isawaitable(result):
                result = await result
            result_payload = result
        except Exception as exc:
            error_payload = {"error": f"{exc}"}
            error_message = self._format_tool_message(tool_call_id, error_payload)
        finally:
            self._tool_call_in_progress = False

        if error_message is not None:
            logger.debug(
                "TOOL_RESULT error tool={} arguments={} payload={}",
                tool_name,
                arguments,
                error_message,
            )
            await self._on_tool_call_completed(tool_name, error_payload)
            return

        if is_synchronous_tool:
            callback_payload = {"result": result_payload}
            sync_properties = FunctionCallResultProperties(run_llm=True)
            formatted_message = self._format_tool_message(tool_call_id, result_payload)
            if getattr(self, "_context", None) is not None:
                self._context.add_message(formatted_message)
            else:
                self.add_message(formatted_message)
            try:
                await params.result_callback(callback_payload, properties=sync_properties)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Failed to deliver synchronous tool result tool={} error={}",
                    tool_name,
                    exc,
                )
            serialized_response = self._serialize_output(result_payload)
            if serialized_response:
                if len(serialized_response) > 500:
                    serialized_response = serialized_response[:500] + "..."
                message_text = self._timestamped_text(
                    f"{tool_name} response: {serialized_response}"
                )
                self._output(message_text, TaskOutputType.MESSAGE)

        logger.debug(
            "TOOL_RESULT tool={} arguments={} result={}",
            tool_name,
            arguments,
            result_payload,
        )
        await self._on_tool_call_completed(tool_name, result_payload)

    def _format_tool_message(self, tool_call_id: str, result: Any) -> Dict[str, Any]:
        if isinstance(result, str):
            content = result
        elif isinstance(result, dict):
            summary = result.get("summary")
            if summary and isinstance(summary, str) and summary.strip():
                payload = {"summary": summary.strip()}
            else:
                payload = {"result": result}
            content = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        else:
            payload = {"result": result}
            content = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        return {"role": "tool", "tool_call_id": tool_call_id, "content": content}

    def _payload_from_tool_message(self, tool_message: Dict[str, Any]) -> Dict[str, Any]:
        content = tool_message.get("content")
        if not content:
            return {"result": {}}
        if isinstance(content, str):
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                return {"result": content}
        return {"result": content}

    def _output(self, text: str, message_type: Optional[TaskOutputType] = None) -> None:
        if not self._active_pipeline_task:
            return

        type_value = message_type.value if message_type else None
        if type_value:
            logger.info("[{}] {}", type_value, text)
        else:
            logger.info("{}", text)

        if self.output_callback:
            logger.info("output_callback payload type={} text={}", type_value, text)
            try:
                self.output_callback(text, type_value)
            except Exception:  # noqa: BLE001
                logger.exception("output_callback failed type={} text={}", type_value, text)

    def _record_inference_reason(self, reason: str) -> None:
        if reason in self._inference_reasons:
            return
        self._inference_reasons.append(reason)
        if len(self._inference_reasons) > 50:
            self._inference_reasons = self._inference_reasons[-50:]

    def _start_inference_watchdog(self) -> None:
        if self._inference_watchdog_handle is not None:
            return
        if self._llm_inflight:
            return
        if not self._active_pipeline_task or self._active_pipeline_task.has_finished():
            return
        loop = asyncio.get_running_loop()
        self._inference_watchdog_handle = loop.call_later(
            self._inference_delay, self._inference_watchdog_fire
        )
        logger.debug(
            "Inference watchdog armed delay={:.2f}s pending={}",
            self._inference_delay,
            list(self._inference_reasons),
        )

    def _cancel_inference_watchdog(self) -> None:
        if self._inference_watchdog_handle:
            self._inference_watchdog_handle.cancel()
            self._inference_watchdog_handle = None

    def _inference_watchdog_fire(self) -> None:
        self._inference_watchdog_handle = None

        async def _run() -> None:
            try:
                await self._schedule_pending_inference()
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"Inference watchdog scheduling failed: {exc}")

        try:
            asyncio.get_running_loop().create_task(_run())
        except RuntimeError as exc:
            logger.warning(f"Failed to schedule watchdog task: {exc}")

    async def _request_inference(self, reason: str) -> None:
        normalized_reason = reason or "unspecified"
        self._record_inference_reason(normalized_reason)
        if self._llm_inflight:
            logger.debug(
                "LLM inflight; queued inference reason={} pending={}",
                normalized_reason,
                self._inference_reasons,
            )
            return
        await self._schedule_pending_inference()

    async def _schedule_pending_inference(self) -> None:
        if self._llm_inflight:
            return
        if not self._inference_reasons:
            return
        if not self._active_pipeline_task or self._active_pipeline_task.has_finished():
            logger.debug(
                "Skipping inference run; pipeline inactive reasons={}",
                self._inference_reasons,
            )
            return

        reasons_snapshot = list(self._inference_reasons)
        self._inference_reasons.clear()

        self._cancel_inference_watchdog()

        logger.debug("Queueing LLM run reasons={}", reasons_snapshot)
        self._llm_inflight = True
        try:
            await self._active_pipeline_task.queue_frames([LLMRunFrame()])
        except Exception:
            self._llm_inflight = False
            # restore reasons so they can be retried after error handling
            self._inference_reasons = reasons_snapshot + self._inference_reasons
            raise

    async def _on_tool_call_completed(
        self, tool_name: Optional[str] = None, result_payload: Any = None
    ) -> None:
        try:
            if tool_name:
                reason = f"tool({tool_name})"
                if result_payload is not None:
                    serialized = self._serialize_output(result_payload)
                    if serialized:
                        if len(serialized) > 200:
                            serialized = serialized[:200] + "..."
                        reason = f"{reason}:{serialized}"
                self._record_inference_reason(reason)
            elif not self._inference_reasons:
                self._record_inference_reason("tool_result")
            await self._schedule_pending_inference()
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"Failed to continue inference after tool result: {exc}")

    async def _queue_pending_run_now(self) -> None:
        if self._llm_inflight:
            logger.debug("LLM inflight; not queuing inference.")
            return
        await self._schedule_pending_inference()
