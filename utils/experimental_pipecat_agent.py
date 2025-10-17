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
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from dotenv import load_dotenv
from loguru import logger

from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import (
    FunctionCallResultProperties,
    EndFrame,
    LLMRunFrame,
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
            ("status.snapshot", True),
            ("status.update", True),
            ("sector.update", True),
            ("course.plot", True),
            ("path.region", True),
            ("movement.start", False),  # always followed by movement.complete
            ("movement.complete", False),  # always followed by map.knowledge
            ("map.knowledge", True),
            ("map.region", True),
            ("map.local", True),
            ("ports.list", True),
            ("character.moved", True),
            ("trade.executed", True),
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
                extra={"thinking_config": {"thinking_budget": self._thinking_budget}}
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
        should_queue = self._event_run_llm.get(event_name, True)
        if should_queue:
            if self._active_pipeline_task:
                await self._active_pipeline_task.queue_frames([LLMRunFrame()])
        else:
            pass

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
