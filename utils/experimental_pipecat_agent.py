"""
Experimental task agent that routes task execution through a Pipecat pipeline.

This implementation constructs a fresh Pipecat pipeline for each inference turn,
allowing us to share the same tools and context mechanics that the voice
systems use.
"""

from __future__ import annotations

import asyncio
import copy
import inspect
import json
import os
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from dotenv import load_dotenv
from loguru import logger

from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import (
    ErrorFrame,
    FunctionCallResultFrame,
    FunctionCallResultProperties,
    FunctionCallsStartedFrame,
    LLMFullResponseEndFrame,
    LLMTextFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
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
    CheckTrade,
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
TURN_TIMEOUT_SECONDS = 30


PipelineToolExecutor = Callable[
    [Dict[str, Any]], Awaitable[Tuple[Optional[Dict[str, Any]], bool, Any]]
]
ToolEventCallback = Callable[[str, Any], Awaitable[None]]


class TurnCoordinator:
    """Coordinates turn-level signaling for a long-lived Pipecat pipeline."""

    def __init__(
        self,
        pipeline_task: PipelineTask,
        *,
        text_logger: Optional[Callable[[str], None]] = None,
    ):
        self._task = pipeline_task
        self._text_logger = text_logger

        self._pipeline_started = asyncio.Event()
        self._turn_future: Optional[asyncio.Future[str]] = None
        self._assistant_chunks: List[str] = []
        self._last_activity: float = asyncio.get_running_loop().time()

        self._task.set_reached_downstream_filter(
            (
                LLMTextFrame,
                LLMFullResponseEndFrame,
                FunctionCallsStartedFrame,
                FunctionCallResultFrame,
                ErrorFrame,
            )
        )

        @self._task.event_handler("on_pipeline_started")
        async def _on_started(task, frame=None):  # pragma: no cover - wiring
            logger.debug("TurnCoordinator: pipeline started")
            self._pipeline_started.set()

        @self._task.event_handler("on_frame_reached_downstream")
        async def _on_downstream(task, frame):  # pragma: no cover - wiring
            if isinstance(frame, LLMTextFrame):
                if self._turn_future and not self._turn_future.done():
                    self._assistant_chunks.append(frame.text)
                    if self._text_logger:
                        self._text_logger(frame.text)
                    else:
                        logger.debug(f"TurnCoordinator: assistant chunk '{frame.text}'")
                    self._mark_activity()
            elif isinstance(frame, LLMFullResponseEndFrame):
                if self._turn_future and not self._turn_future.done():
                    text = "".join(self._assistant_chunks)
                    self._turn_future.set_result(text)
                self._mark_activity()
            elif isinstance(frame, ErrorFrame):
                if self._turn_future and not self._turn_future.done():
                    self._turn_future.set_exception(
                        RuntimeError(frame.error or "Pipeline error")
                    )
                logger.error(
                    f"TurnCoordinator: received ErrorFrame fatal={frame.fatal} error={frame.error}"
                )
                self._mark_activity()
            elif isinstance(frame, FunctionCallResultFrame):
                run_llm = frame.run_llm
                logger.debug(
                    f"TurnCoordinator: FunctionCallResultFrame name={frame.function_name} run_llm={run_llm}"
                )
                if not run_llm and self._turn_future and not self._turn_future.done():
                    text = "".join(self._assistant_chunks)
                    self._turn_future.set_result(text)
                self._mark_activity()

    async def wait_pipeline_started(self) -> None:
        await self._pipeline_started.wait()

    def begin_turn(self) -> None:
        if self._turn_future and not self._turn_future.done():
            raise RuntimeError("Previous turn still in progress")
        self._assistant_chunks = []
        loop = asyncio.get_running_loop()
        self._turn_future = loop.create_future()
        self._mark_activity()

    async def wait_for_turn(self) -> str:
        if self._turn_future is None:
            raise RuntimeError("Turn not started")
        try:
            return await self._turn_future
        finally:
            self._turn_future = None

    def finish_turn(self, text: str = "") -> None:
        if self._turn_future and not self._turn_future.done():
            self._turn_future.set_result(text)
        self._mark_activity()

    def _mark_activity(self) -> None:
        self._last_activity = asyncio.get_running_loop().time()

    @property
    def last_activity(self) -> float:
        return self._last_activity

    def note_activity(self) -> None:
        self._mark_activity()


class ExperimentalTaskAgent:
    """Task agent powered by a Pipecat pipeline."""

    def __init__(
        self,
        config: LLMConfig,
        game_client: AsyncGameClient,
        character_id: str,
        *,
        verbose_prompts: bool = False,
        output_callback: Optional[Callable[[str, Optional[str]], None]] = None,
        tool_call_event_callback: Optional[ToolEventCallback] = None,
        tool_result_event_callback: Optional[ToolEventCallback] = None,
        tools_list: Optional[List[Any]] = None,
        tool_executor: Optional[PipelineToolExecutor] = None,
        llm_service_factory: Optional[Callable[[], LLMService]] = None,
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

        self.verbose_prompts = verbose_prompts
        self.output_callback = output_callback
        self._tool_call_event_callback = tool_call_event_callback
        self._tool_result_event_callback = tool_result_event_callback
        self._tool_executor = tool_executor
        self._llm_service_factory = (
            llm_service_factory or self._default_llm_service_factory
        )

        self.messages: List[Dict[str, Any]] = []
        self.tools: Dict[str, Callable[..., Awaitable[Any]]] = {}
        self._tools_schema: Optional[ToolsSchema] = None

        self.cancelled = False
        self.finished = False
        self.finished_message: Optional[str] = None
        self._active_pipeline_task: Optional[PipelineTask] = None
        self._active_coordinator: Optional[TurnCoordinator] = None
        self._step_counter: int = 0
        self._current_turn_future: Optional[asyncio.Future] = None
        self._watchdog_handle: Optional[asyncio.TimerHandle] = None
        self._watchdog_target: Optional[asyncio.Future] = None
        self._watchdog_triggered: bool = False

        default_tools = tools_list or [
            MyStatus,
            PlotCourse,
            LocalMapRegion,
            ListKnownPorts,
            PathWithRegion,
            Move,
            CheckTrade,
            Trade,
            SalvageCollect,
            SendMessage,
            RechargeWarpPower,
            TransferWarpPower,
            PlaceFighters,
            CollectFighters,
            TaskFinished,
        ]
        self.set_tools(default_tools)

    def _default_llm_service_factory(self) -> LLMService:
        class GoogleLLMService(PipecatGoogleLLMService):
            async def stop(self, frame):
                await super().stop(frame)
                try:
                    await self._client.aio.aclose()
                except Exception:  # noqa: BLE001
                    pass

            async def cancel(self, frame):
                await super().cancel(frame)
                try:
                    await self._client.aio.aclose()
                except Exception:  # noqa: BLE001
                    pass

        return GoogleLLMService(
            api_key=self.config.api_key or "",
            model=self.config.model or DEFAULT_GOOGLE_MODEL,
            run_in_parallel=False,
            params=GoogleLLMService.InputParams(
                extra={"thinking_config": {"thinking_budget": 2048}}
            ),
        )

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
        if self.verbose_prompts:
            self._log_message(msg)

    def clear_messages(self) -> None:
        self.messages = []

    def cancel(self) -> None:
        self.cancelled = True
        self._output("Execution cancelled", TaskOutputType.FINISHED)

    def reset_cancellation(self) -> None:
        self.cancelled = False

    async def run_task(
        self,
        task: str,
        initial_state: Optional[Dict[str, Any]] = None,
        max_iterations: int = 50,
    ) -> bool:
        self.reset_cancellation()
        self.finished = False
        self.finished_message = None
        self.clear_messages()
        self._step_counter = 0
        _ = max_iterations  # retained for API compatibility; pipeline controls turns

        self.add_message({"role": "system", "content": create_task_system_message()})
        self.add_message(
            {"role": "user", "content": create_task_instruction_user_message(task)}
        )
        if initial_state:
            for message in create_initial_status_messages(initial_state):
                self.add_message(message)

        context = self._create_context()
        (
            aggregator_pair,
            coordinator,
            pipeline_task,
            runner_task,
            llm_service,
        ) = self._setup_pipeline(context, verbose=self.verbose_prompts)

        try:
            await coordinator.wait_pipeline_started()
            self._refresh_watchdog()

            turn_index = 0
            success = False
            while not pipeline_task.has_finished():
                if self.cancelled:
                    self._output("Task cancelled", TaskOutputType.FINISHED)
                    return False

                self._emit_step(f"turn index={turn_index}")
                turn_index += 1

                coordinator.begin_turn()
                self._active_coordinator = coordinator
                await aggregator_pair.user().push_context_frame(
                    FrameDirection.DOWNSTREAM
                )

                turn_future = asyncio.create_task(coordinator.wait_for_turn())
                self._set_watchdog_target(turn_future)
                try:
                    await turn_future
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
                    self._active_coordinator = None

                self.messages = [
                    self._normalize_message(msg) for msg in context.get_messages()
                ]
                assistant_message = self._extract_assistant_message(context)

                if self.verbose_prompts:
                    self._log_message(assistant_message)

                self._output("TURN_COMPLETE", TaskOutputType.MESSAGE)
                self._refresh_watchdog()

                if self.finished:
                    success = True
                    break

                tool_calls = assistant_message.get("tool_calls")
                if not tool_calls:
                    content = assistant_message.get("content", "")
                    if content.strip():
                        self._output(content, TaskOutputType.MESSAGE)
                    continue
            return success
        finally:
            if self._active_pipeline_task:
                await self._active_pipeline_task.cancel()
            await runner_task
            self._active_pipeline_task = None
            self._stop_watchdog()

    def _create_context(self) -> LLMContext:
        context_messages = copy.deepcopy(self.messages)
        tools = self._tools_schema if self._tools_schema else ToolsSchema([])
        return LLMContext(messages=context_messages, tools=tools)

    def _setup_pipeline(
        self,
        context: LLMContext,
        *,
        verbose: bool,
    ) -> Tuple[
        LLMContextAggregatorPair,
        TurnCoordinator,
        PipelineTask,
        asyncio.Task[None],
        LLMService,
    ]:
        llm_service = self._llm_service_factory()
        llm_service.register_function(None, self._handle_function_call)

        aggregator_pair = LLMContextAggregatorPair(context)
        pipeline = Pipeline(
            [aggregator_pair.user(), llm_service, aggregator_pair.assistant()]
        )
        pipeline_task = PipelineTask(
            pipeline,
            params=PipelineParams(
                allow_interruptions=True,
                enable_metrics=False,
                enable_usage_metrics=False,
            ),
        )

        coordinator = TurnCoordinator(
            pipeline_task,
            text_logger=(
                lambda text: self._output(
                    f"ASSISTANT_PART: {text}", TaskOutputType.MESSAGE
                )
                if verbose
                else None
            ),
        )

        pipeline_runner = PipelineRunner(handle_sigint=False, handle_sigterm=False)
        runner_task = asyncio.create_task(pipeline_runner.run(pipeline_task))

        self._active_pipeline_task = pipeline_task
        return aggregator_pair, coordinator, pipeline_task, runner_task, llm_service

    def _emit_step(self, label: str) -> None:
        self._step_counter += 1
        self._output(f"STEP {self._step_counter}: {label}", TaskOutputType.STEP)
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

        logger.debug(
            f"ExperimentalTaskAgent: handling function call name={tool_name} id={tool_call_id} args={arguments}"
        )

        self._refresh_watchdog()

        tool_call_dict = {
            "id": tool_call_id,
            "type": "function",
            "function": {"name": tool_name, "arguments": json.dumps(arguments)},
        }

        self._output(
            f"Executing {tool_name}({json.dumps(arguments)})", TaskOutputType.TOOL_CALL
        )

        if self._tool_call_event_callback:
            await self._tool_call_event_callback(tool_name, arguments)

        executor = self._tool_executor or self._default_tool_executor
        tool_message, should_continue, raw_result = await executor(tool_call_dict)
        should_continue = True if should_continue is None else bool(should_continue)
        logger.debug(
            f"ExperimentalTaskAgent: tool={tool_name} should_continue={should_continue}"
        )
        self._emit_step(f"tool name={tool_name} continue={should_continue}")
        if self._active_coordinator:
            self._active_coordinator.note_activity()

        payload: Dict[str, Any]
        if isinstance(raw_result, dict):
            payload = {"result": raw_result}
        elif tool_message is not None:
            payload = self._payload_from_tool_message(tool_message)
        else:
            payload = {"result": raw_result}

        if self._tool_result_event_callback:
            await self._tool_result_event_callback(tool_name, payload)

        properties = FunctionCallResultProperties(run_llm=should_continue)
        await params.result_callback(payload, properties=properties)

    async def _default_tool_executor(
        self, tool_call: Dict[str, Any]
    ) -> Tuple[Optional[Dict[str, Any]], bool, Any]:
        tool_name = tool_call["function"]["name"]
        tool_args = json.loads(tool_call["function"]["arguments"])

        logger.debug(
            f"ExperimentalTaskAgent: default tool executor running name={tool_name} args={tool_args}"
        )

        if tool_name == "finished":
            self.finished = True
            self.finished_message = tool_args.get("message", "Done")
            self._output(self.finished_message, TaskOutputType.FINISHED)
            logger.debug(
                f"ExperimentalTaskAgent: received finished tool message={self.finished_message}"
            )
            if self._active_coordinator:
                self._active_coordinator.finish_turn("")
            return (None, False, {"message": self.finished_message})

        tool = self.tools.get(tool_name)
        if not tool:
            message = self._format_tool_message(
                tool_call["id"], {"error": f"Unknown tool: {tool_name}"}
            )
            logger.debug(
                f"ExperimentalTaskAgent: tool {tool_name} missing; returning error payload"
            )
            return (message, False, {"error": f"Unknown tool: {tool_name}"})

        try:
            result = tool(**tool_args)
            if inspect.isawaitable(result):
                result = await result
            logger.debug(
                f"ExperimentalTaskAgent: tool {tool_name} succeeded result={result}"
            )
            message = self._format_tool_message(tool_call["id"], result)
            self._output(json.dumps(result), TaskOutputType.TOOL_RESULT)
            return (message, True, result)
        except Exception as exc:
            error_payload = {"error": str(exc)}
            logger.error(f"Tool {tool_name} failed: {exc}")
            message = self._format_tool_message(tool_call["id"], error_payload)
            self._output(json.dumps(error_payload), TaskOutputType.TOOL_RESULT)
            return (message, True, error_payload)

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
        if self.output_callback:
            self.output_callback(text, message_type.value if message_type else None)
        else:
            if message_type:
                logger.info(f"[{message_type.value}] {text}")
            else:
                logger.info(text)

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
