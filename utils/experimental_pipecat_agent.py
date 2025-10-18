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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, List, Optional, Tuple

from dotenv import load_dotenv
from loguru import logger
from google.genai import types as genai_types
from google.genai.types import Content, GenerateContentResponse

from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import (
    FunctionCallResultProperties,
    EndFrame,
    LLMFullResponseEndFrame,
    LLMMessagesAppendFrame,
    LLMRunFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext, LLMSpecificMessage
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.google.llm import GoogleLLMService as PipecatGoogleLLMService
from pipecat.services.llm_service import FunctionCallParams, LLMService

from utils.api_client import AsyncGameClient
from utils.base_llm_agent import LLMConfig

from utils.task_agent import (
    TaskOutputType,
    create_initial_status_messages,
    create_task_instruction_user_message,
    create_task_system_message,
)
from utils.tools_schema import (
    MyStatus,
    PlotCourse,
    LocalMapRegion,
    ListKnownPorts,
    PathWithRegion,
    Move,
    Trade,
    SalvageCollect,
    SendMessage,
    RechargeWarpPower,
    TransferWarpPower,
    PlaceFighters,
    CollectFighters,
    TaskFinished,
)


load_dotenv()

DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash-preview-09-2025"
# DEFAULT_GOOGLE_MODEL = "gemini-2.5-pro-preview-06-05"
DEFAULT_THINKING_BUDGET = 2048
DEFAULT_INCLUDE_THOUGHTS = True
TURN_TIMEOUT_SECONDS = 30


PipelineToolExecutor = Callable[
    [Dict[str, Any]], Awaitable[Tuple[Optional[Dict[str, Any]], bool, Any]]
]
ToolEventCallback = Callable[[str, Any], Awaitable[None]]


class ExperimentalTaskAgent:
    """Task agent powered by a Pipecat pipeline."""

    def __init__(
        self,
        config: LLMConfig,
        game_client: AsyncGameClient,
        character_id: str,
        *,
        output_callback: Optional[Callable[[str, Optional[str]], None]] = None,
        tool_call_event_callback: Optional[ToolEventCallback] = None,
        tools_list: Optional[List[Any]] = None,
        tool_executor: Optional[PipelineToolExecutor] = None,
        llm_service_factory: Optional[Callable[[], LLMService]] = None,
        thinking_budget: Optional[int] = None,
    ):
        api_key = config.api_key or os.getenv("GOOGLE_API_KEY")
        if not api_key:
            raise ValueError(
                "Google API key must be provided in config or GOOGLE_API_KEY environment variable"
            )

        self.config = LLMConfig(
            api_key=api_key,
            model=config.model or DEFAULT_GOOGLE_MODEL,
        )
        self.game_client = game_client
        self.character_id = character_id

        self.output_callback = output_callback
        self._tool_call_event_callback = tool_call_event_callback
        self._llm_service_factory = (
            llm_service_factory or self._default_llm_service_factory
        )
        self._thinking_budget = thinking_budget or DEFAULT_THINKING_BUDGET
        self._include_thoughts = DEFAULT_INCLUDE_THOUGHTS

        self.messages: List[Dict[str, Any]] = []
        self.tools: Dict[str, Callable[..., Awaitable[Any]]] = {}
        self._tools_schema: Optional[ToolsSchema] = None

        self.cancelled = False
        self.finished = False
        self.finished_message: Optional[str] = None
        self._active_pipeline_task: Optional[PipelineTask] = None
        self._step_counter: int = 0
        self._watchdog_handle: Optional[asyncio.TimerHandle] = None
        self._watchdog_target: Optional[asyncio.Future] = None
        self._watchdog_triggered: bool = False
        self._pending_run_reasons: List[str] = []
        self._llm_inflight: bool = False
        self._deferred_task: Optional[asyncio.Task] = None

        tools = tools_list or [
            MyStatus,
            PlotCourse,
            LocalMapRegion,
            ListKnownPorts,
            PathWithRegion,
            Move,
            Trade,
            SalvageCollect,
            SendMessage,
            RechargeWarpPower,
            TransferWarpPower,
            PlaceFighters,
            CollectFighters,
            TaskFinished,
        ]
        self.set_tools(tools)

        self._event_specs = [
            (
                "status.snapshot",
                True,
            ),  # todo: add a new event for a status.something that should always trigger an update, but is not a join event
            ("status.update", False),
            ("sector.update", False),
            ("course.plot", True),
            ("path.region", True),
            ("movement.start", False),  # always followed by movement.complete
            ("movement.complete", False),  # always followed by map.knowledge
            ("map.knowledge", True),
            ("map.region", True),
            ("map.local", True),
            ("ports.list", True),
            ("character.moved", True),
            ("trade.executed", False),
            ("port.update", True),
            ("warp.purchase", True),
            ("warp.transfer", True),
            ("garrison.deployed", True),
            ("garrison.collected", True),
            ("garrison.mode_changed", True),
            ("salvage.collected", True),
            ("combat.round_waiting", True),
            ("combat.round_resolved", True),
            ("combat.ended", True),
            ("combat.action_accepted", True),
            ("chat.message", True),
            ("error", True),
        ]
        self._event_run_llm = {name: run_llm for name, run_llm in self._event_specs}
        for event_name, _ in self._event_specs:
            self.game_client.on(event_name)(self._handle_event)

    def _default_llm_service_factory(self) -> LLMService:
        # todo: PR for Pipecat GoogleLLMService to add stop() and cancel() overrides
        class GoogleLLMService(PipecatGoogleLLMService):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self._captured_candidate_contents: Dict[int, Content] = {}

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
                pending = getattr(self, "_agent_pending_run_reasons", None)
                if pending is not None:
                    try:
                        run_reason = pending.pop(0)
                    except IndexError:
                        run_reason = "<empty>"
                agent_owner = getattr(self, "_agent_owner", None)
                if agent_owner is not None:
                    agent_owner._llm_inflight = True
                logger.debug(
                    "GoogleLLMService._stream_content invoked reason={} pending_after={}",
                    run_reason,
                    len(pending) if isinstance(pending, list) else -1,
                )
                try:
                    base_stream = await super()._stream_content(params_from_context)
                except Exception:
                    if agent_owner is not None:
                        agent_owner._llm_inflight = False
                        await agent_owner._queue_pending_run_now()
                    raise
                self._captured_candidate_contents.clear()

                async def _capturing_stream() -> AsyncIterator[GenerateContentResponse]:
                    try:
                        async for chunk in base_stream:
                            candidates = getattr(chunk, "candidates", None)
                            candidate = candidates[0] if candidates else None
                            content = (
                                getattr(candidate, "content", None)
                                if candidate
                                else None
                            )
                            if content is not None:
                                try:
                                    content_copy = content.model_copy(deep=True)  # type: ignore[attr-defined]
                                except AttributeError:
                                    content_copy = copy.deepcopy(content)
                                self._captured_candidate_contents[0] = content_copy

                            yield chunk
                    finally:
                        if agent_owner is not None:
                            agent_owner._llm_inflight = False
                            await agent_owner._queue_pending_run_now()

                return _capturing_stream()

            async def push_frame(
                self,
                frame,
                direction: FrameDirection = FrameDirection.DOWNSTREAM,
            ):
                if (
                    isinstance(frame, LLMFullResponseEndFrame)
                    and self._captured_candidate_contents
                ):
                    adapter = self.get_llm_adapter()
                    llm_id = (
                        adapter.id_for_llm_specific_messages if adapter else "google"
                    )
                    messages = [
                        LLMSpecificMessage(llm=llm_id, message=content)
                        for idx, content in sorted(
                            self._captured_candidate_contents.items()
                        )
                    ]
                    append_frame = LLMMessagesAppendFrame(
                        messages=messages, run_llm=False
                    )
                    await super().push_frame(append_frame, direction)
                    self._captured_candidate_contents.clear()

                if isinstance(frame, LLMMessagesAppendFrame):
                    should_skip = True
                    for message in frame.messages:
                        if not isinstance(message, dict):
                            should_skip = False
                            break
                        parts = message.get("parts") or []
                        if not parts or not all(
                            isinstance(part, dict)
                            and part.get("function_call") is not None
                            and not part.get("thought")
                            and not part.get("text")
                            for part in parts
                        ):
                            should_skip = False
                            break
                    if should_skip:
                        return

                await super().push_frame(frame, direction)

            def _is_sanitized_function_message(self, message: Any) -> bool:
                if isinstance(message, LLMSpecificMessage):
                    return False
                if isinstance(message, dict):
                    parts = message.get("parts") or []
                    if parts and any(
                        isinstance(part, dict)
                        and part.get("function_response") is not None
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
                        candidate_parts = (
                            getattr(candidate.message, "parts", None) or []
                        )
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

            def _remove_duplicate_function_call_messages(
                self, context: LLMContext
            ) -> None:
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
                            self._convert_function_response_message(
                                message, normalized_messages
                            )
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
                if isinstance(context, LLMContext):
                    self._remove_duplicate_function_call_messages(context)
                return result

        service = GoogleLLMService(
            api_key=self.config.api_key or "",
            model=self.config.model or DEFAULT_GOOGLE_MODEL,
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

        setattr(service, "_agent_pending_run_reasons", self._pending_run_reasons)
        setattr(service, "_agent_owner", self)

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
        self._output("Execution cancelled", TaskOutputType.FINISHED)

    def reset_cancellation(self) -> None:
        self.cancelled = False

    async def _handle_event(self, event: Dict[str, Any]) -> None:
        event_name = event.get("event_name")
        summary = event.get("summary")
        response_data = summary or event.get("payload")
        logger.info(f"Event {event_name}: {response_data}")
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
                logger.warning(
                    f"Failed to cancel pipeline task after error event: {exc}"
                )
            raise RuntimeError(f"Encountered error event: {event}")

        should_queue = self._event_run_llm.get(event_name, True)
        if should_queue:
            reason = event_name or "unknown"
            if self._llm_inflight:
                logger.debug(
                    "Deferring LLM run due to event=%s (inference active)", reason
                )
                self._pending_run_reasons = [reason]
                self._ensure_deferred_run()
            else:
                self._cancel_deferred_run()
                self._pending_run_reasons.append(reason)
                if self._active_pipeline_task and not self._active_pipeline_task.has_finished():
                    logger.debug("Queueing LLM run due to event=%s", reason)
                    await self._active_pipeline_task.queue_frames([LLMRunFrame()])

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

    async def run_task(
        self,
        task: str,
        initial_state: Optional[Dict[str, Any]] = None,
        max_iterations: int = 100,
    ) -> bool:
        self.reset_cancellation()
        self.finished = False
        self.finished_message = None
        self.clear_messages()
        self._step_counter = 0
        self._pending_run_reasons.clear()
        self._cancel_deferred_run()
        self._llm_inflight = False
        _ = max_iterations  # retained for API compatibility; pipeline controls turns

        self.add_message({"role": "system", "content": create_task_system_message()})
        self.add_message(
            {"role": "user", "content": create_task_instruction_user_message(task)}
        )
        if initial_state:
            # todo: format initial state as summary
            for message in create_initial_status_messages(initial_state):
                self.add_message(message)

        context = self._create_context()
        runner_task = self._setup_pipeline(context)
        self._context = context

        try:
            self._refresh_watchdog()
            await self.game_client.resume_event_delivery()

            success = False
            while not self._active_pipeline_task.has_finished():
                if self.cancelled:
                    self._output("Task cancelled", TaskOutputType.FINISHED)
                    return False
                try:
                    await asyncio.sleep(1)
                except asyncio.CancelledError:
                    if self._watchdog_triggered:
                        self._output(
                            "Pipeline error: Turn timed out", TaskOutputType.ERROR
                        )
                        return False
                    raise
                except Exception as error:
                    self._output(f"Pipeline error: {error}", TaskOutputType.ERROR)
                    return False
                finally:
                    self._clear_watchdog_target()

                if self.finished:
                    success = True
                    break
        finally:
            if self._active_pipeline_task:
                await self._active_pipeline_task.cancel()
            await runner_task
            self._active_pipeline_task = None
            self._stop_watchdog()
            self._cancel_deferred_run()
            self._pending_run_reasons.clear()
            return success

    def _create_context(self) -> LLMContext:
        context_messages = copy.deepcopy(self.messages)
        tools = self._tools_schema if self._tools_schema else ToolsSchema([])
        return LLMContext(messages=context_messages, tools=tools)

    def _setup_pipeline(self, context: LLMContext) -> Tuple[PipelineTask,]:
        llm_service = self._llm_service_factory()
        llm_service.register_function(None, self._handle_function_call)

        aggregator_pair = LLMContextAggregatorPair(context)
        pipeline = Pipeline(
            [aggregator_pair.user(), llm_service, aggregator_pair.assistant()]
        )
        pipeline_task = PipelineTask(
            pipeline,
            params=PipelineParams(
                allow_interruptions=False,
                # todo: add metrics
                enable_metrics=False,
                enable_usage_metrics=False,
            ),
        )

        pipeline_runner = PipelineRunner(handle_sigint=False, handle_sigterm=False)
        runner_task = asyncio.create_task(pipeline_runner.run(pipeline_task))

        self._active_pipeline_task = pipeline_task
        return runner_task

    def _emit_step(self, label: Optional[str] = "") -> None:
        self._step_counter += 1
        self._output(
            f"{self._step_counter}{': ' if label else ''}{label}", TaskOutputType.STEP
        )
        self._refresh_watchdog()

    def _set_watchdog_target(self, future: asyncio.Future) -> None:
        self._current_turn_future = future
        self._watchdog_target = future
        self._refresh_watchdog()

    def _clear_watchdog_target(self) -> None:
        self._current_turn_future = None
        self._watchdog_target = None

    def _refresh_watchdog(self) -> None:
        loop = asyncio.get_running_loop()
        if self._watchdog_handle:
            self._watchdog_handle.cancel()
        self._watchdog_triggered = False
        self._watchdog_handle = loop.call_later(
            TURN_TIMEOUT_SECONDS, self._watchdog_timeout
        )

    def _stop_watchdog(self) -> None:
        if self._watchdog_handle:
            self._watchdog_handle.cancel()
            self._watchdog_handle = None
        self._watchdog_triggered = False
        self._watchdog_target = None
        self._current_turn_future = None

    def _watchdog_timeout(self) -> None:
        self._watchdog_handle = None
        target = self._watchdog_target
        if target and not target.done():
            self._watchdog_triggered = True
            logger.warning("Turn watchdog timed out; cancelling current turn future")
            target.cancel()

    def _extract_assistant_message(self, context: LLMContext) -> Dict[str, Any]:
        updated_messages = [
            self._normalize_message(msg) for msg in context.get_messages()
        ]
        assistant_message = next(
            (
                msg
                for msg in reversed(updated_messages)
                if msg.get("role") == "assistant"
            ),
            None,
        )

        if assistant_message is None:
            raise RuntimeError("Assistant did not respond")

        if assistant_message.get("tool_calls"):
            for call in assistant_message["tool_calls"]:
                fn = call.get("function", {})
                args = fn.get("arguments")
                if args is None:
                    fn["arguments"] = json.dumps({})
                elif not isinstance(args, str):
                    fn["arguments"] = json.dumps(args)

        content = assistant_message.get("content")
        if isinstance(content, list):
            text_parts = [
                part.get("text", "")
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            ]
            assistant_message["content"] = "".join(text_parts)
        elif content is None:
            assistant_message["content"] = ""

        return assistant_message

    async def _handle_function_call(self, params: FunctionCallParams) -> None:
        tool_name = params.function_name
        tool_call_id = params.tool_call_id
        arguments = params.arguments or {}

        self._refresh_watchdog()

        if tool_name == "finished":
            self.finished = True
            self.finished_message = arguments.get("message", "Done")
            self._output(self.finished_message, TaskOutputType.FINISHED)
            self._log_gemini_invocation(params, arguments)
            await params.llm.push_frame(EndFrame())
            return

        self._emit_step()
        self._output(f"{tool_name}({json.dumps(arguments)})", TaskOutputType.TOOL_CALL)

        if self._tool_call_event_callback:
            await self._tool_call_event_callback(tool_name, arguments)

        # put a tool call result into the context saying we sent the request
        tool_result = {"status": "Executed."}
        properties = FunctionCallResultProperties(run_llm=False)
        await params.result_callback(tool_result, properties=properties)

        tool = self.tools.get(tool_name)
        message = "MESSAGE PLACEHOLDER"
        if not tool:
            message = self._format_tool_message(
                tool_call_id, {"error": f"Unknown tool: {tool_name}"}
            )
            self._output(message, TaskOutputType.TOOL_RESULT)
            return

        try:
            result = tool(**arguments)
            if inspect.isawaitable(result):
                result = await result
        except Exception as exc:
            message = self._format_tool_message(tool_call_id, {"error": f"{exc}"})
            self._output(message, TaskOutputType.TOOL_RESULT)
            return

        self._output(
            f"{tool_name}({json.dumps(arguments)}) -> {json.dumps(result)}",
            TaskOutputType.TOOL_RESULT,
        )

    def _format_tool_message(self, tool_call_id: str, result: Any) -> Dict[str, Any]:
        if isinstance(result, str):
            content = result
        elif isinstance(result, dict):
            summary = result.get("summary")
            if summary and isinstance(summary, str) and summary.strip():
                self._output(summary.strip(), TaskOutputType.TOOL_RESULT)
                payload = {"summary": summary.strip()}
            else:
                self._output(result, TaskOutputType.TOOL_RESULT)
                payload = {"result": result}
            content = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        else:
            self._output(result, TaskOutputType.TOOL_RESULT)
            payload = {"result": result}
            content = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        return {"role": "tool", "tool_call_id": tool_call_id, "content": content}

    def _payload_from_tool_message(
        self, tool_message: Dict[str, Any]
    ) -> Dict[str, Any]:
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
        if message_type:
            logger.info(f"[{message_type.value}] {text}")
        else:
            logger.info(text)

        if self.output_callback:
            self.output_callback(text, message_type.value if message_type else None)

    def _log_gemini_invocation(
        self,
        params: FunctionCallParams,
        arguments: Dict[str, Any],
    ) -> None:
        log_path = os.getenv("GEMINI_LOG_FILE")
        if not log_path:
            return

        context = getattr(params, "context", None)
        if not isinstance(context, LLMContext):
            return

        llm_service = getattr(params, "llm", None)
        get_adapter = (
            getattr(llm_service, "get_llm_adapter", None) if llm_service else None
        )
        if not callable(get_adapter):
            return

        try:
            adapter = get_adapter()
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"Failed to obtain LLM adapter for logging: {exc}")
            return

        if adapter is None:
            return

        try:
            invocation_params = adapter.get_llm_invocation_params(context)
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"Failed to capture Gemini invocation params: {exc}")
            return

        if invocation_params is None:
            return

        payload = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "finished_arguments": arguments,
            "invocation": invocation_params,
        }

        sanitized_payload = self._sanitize_for_json(payload)

        try:
            target_path = Path(log_path).expanduser()
            target_path.parent.mkdir(parents=True, exist_ok=True)
            with target_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(sanitized_payload, ensure_ascii=False))
                handle.write("\n")
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"Failed to write Gemini log file '{log_path}': {exc}")

    @staticmethod
    def _sanitize_for_json(value: Any) -> Any:
        if isinstance(value, (str, int, float, bool)) or value is None:
            return value
        if isinstance(value, dict):
            return {
                str(k): ExperimentalTaskAgent._sanitize_for_json(v)
                for k, v in value.items()
            }
        if isinstance(value, (list, tuple, set)):
            return [ExperimentalTaskAgent._sanitize_for_json(item) for item in value]
        for attr_name in ("model_dump", "to_dict"):
            attr = getattr(value, attr_name, None)
            if callable(attr):
                try:
                    return ExperimentalTaskAgent._sanitize_for_json(attr())
                except Exception:  # noqa: BLE001
                    pass
        if hasattr(value, "__dict__"):
            data = {
                key: ExperimentalTaskAgent._sanitize_for_json(val)
                for key, val in vars(value).items()
                if not key.startswith("_")
            }
            if data:
                return data
        return str(value)

    def _log_message(self, message: Dict[str, Any]) -> None:
        try:
            if message["role"] == "system":
                self._output(f"SYSTEM_MSG: {message['content'][:200]}...")
            elif message["role"] == "user":
                self._output(f"USER_MSG: {message.get('content', '')}")
            elif message["role"] == "assistant":
                if message.get("content"):
                    self._output(f"ASSISTANT_MSG: {message['content']}")
                if "tool_calls" in message:
                    for tool_call in message["tool_calls"]:
                        args = tool_call["function"]["arguments"]
                        if not isinstance(args, str):
                            args = json.dumps(args)
                        self._output(
                            f"TOOL_CALL [{tool_call['id']}]: {tool_call['function']['name']}: {args}"
                        )
            elif message["role"] == "tool":
                self._output(
                    f"TOOL_RESULT [{message['tool_call_id']}]: {message['content']}"
                )
        except Exception:
            self._output(f"GENERIC_LOG: {message}")

    def _normalize_message(self, message: Any) -> Dict[str, Any]:
        if isinstance(message, dict):
            return message
        if hasattr(message, "to_json_dict"):
            return message.to_json_dict()
        if hasattr(message, "model_dump"):
            return message.model_dump()
        raise TypeError(f"Unsupported message type: {type(message)}")

    def _cancel_deferred_run(self) -> None:
        if self._deferred_task and not self._deferred_task.done():
            self._deferred_task.cancel()
        self._deferred_task = None

    def _ensure_deferred_run(self) -> None:
        self._cancel_deferred_run()
        loop = asyncio.get_running_loop()
        self._deferred_task = loop.create_task(self._deferred_run())

    async def _deferred_run(self) -> None:
        try:
            await asyncio.sleep(15)
            if not self._pending_run_reasons:
                return
            if self._llm_inflight:
                self._deferred_task = asyncio.create_task(self._deferred_run())
                return
            if (
                self._active_pipeline_task
                and not self._active_pipeline_task.has_finished()
            ):
                logger.debug(
                    "Timer queueing LLM run due to event=%s",
                    self._pending_run_reasons[0],
                )
                await self._active_pipeline_task.queue_frames([LLMRunFrame()])
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.warning(f"Deferred LLM scheduling failed: {exc}")
        finally:
            if self._deferred_task is asyncio.current_task():
                self._deferred_task = None

    async def _queue_pending_run_now(self) -> None:
        self._cancel_deferred_run()
        if self._llm_inflight:
            return
        if not self._pending_run_reasons:
            return
        if not self._active_pipeline_task or self._active_pipeline_task.has_finished():
            return
        logger.debug(
            "Queueing deferred LLM run reason=%s",
            self._pending_run_reasons[0],
        )
        await self._active_pipeline_task.queue_frames([LLMRunFrame()])
