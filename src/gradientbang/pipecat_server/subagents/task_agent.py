"""Background task worker agent.

TaskAgent is an LLMAgent that receives work via the bus task
protocol, executes it autonomously using game tools, and reports results back
via send_task_update/send_task_response.

## Async Tool Pattern

All game tools use an async event-based pattern:
1. Tool is called, returns {"status": "Executed."} immediately
2. Server processes the request and emits a game event
3. TaskAgent receives the event via WebSocket with actual data
4. Event data is added to the LLM context
5. LLM inference proceeds with real data

Tools listed in ASYNC_TOOL_COMPLETIONS defer inference until the completion
event arrives (or times out). This prevents the LLM from hallucinating results.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from loguru import logger
from pipecat.frames.frames import (
    FunctionCallInProgressFrame,
    FunctionCallResultProperties,
    FunctionCallsStartedFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMRunFrame,
    LLMTextFrame,
    LLMThoughtTextFrame,
)
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.llm_service import FunctionCallParams

from gradientbang.subagents.agents import LLMAgent
from gradientbang.subagents.bus import (
    AgentBus,
    BusMessage,
    BusTaskCancelMessage,
    BusTaskRequestMessage,
    BusTaskUpdateRequestMessage,
    TaskStatus,
)

from gradientbang.pipecat_server.subagents.bus_messages import BusGameEventMessage, BusSteerTaskMessage
from gradientbang.tools import GAME_METHOD_ALIASES, TASK_TOOLS
from gradientbang.utils.llm_factory import create_llm_service, get_task_agent_llm_config
from gradientbang.utils.weave_tracing import traced
from gradientbang.utils.prompt_loader import (
    AVAILABLE_TOPICS,
    TaskOutputType,
    build_task_agent_prompt,
    build_task_progress_prompt,
    create_task_instruction_user_message,
    load_fragment,
)
from gradientbang.utils.supabase_client import AsyncGameClient

# ── Constants ─────────────────────────────────────────────────────────────

EVENT_BATCH_INFERENCE_DELAY = 1.0
ASYNC_COMPLETION_TIMEOUT = 5.0
MAX_NO_TOOL_NUDGES = 3
MAX_CONSECUTIVE_ERRORS = 3
NO_TOOL_WATCHDOG_DELAY = 5.0

# Tools restricted to player ships only (corp ships cannot use these).
PLAYER_ONLY_TOOLS = frozenset({
    "create_corporation", "join_corporation", "leave_corporation",
    "kick_corporation_member", "sell_ship", "bank_withdraw",
})

# Tools that have async completion events. Inference is deferred until
# the event arrives.
ASYNC_TOOL_COMPLETIONS = {
    "move": "movement.complete",
    "path_with_region": "path.region",
    "my_status": "status.snapshot",
    "list_known_ports": "ports.list",
    "trade": "trade.executed",
    "recharge_warp_power": "warp.purchase",
    "transfer_warp_power": "warp.transfer",
    "salvage_collect": "salvage.collected",
    "place_fighters": "garrison.deployed",
    "collect_fighters": "garrison.collected",
    "event_query": "event.query",
    "purchase_fighters": "fighter.purchase",
    "purchase_ship": "status.update",
    "sell_ship": "status.update",
    "bank_deposit": "bank.transaction",
    "bank_withdraw": "bank.transaction",
    "transfer_credits": "credits.transfer",
    "dump_cargo": "salvage.created",
    "create_corporation": "corporation.created",
    "join_corporation": "corporation.member_joined",
    "leave_corporation": "corporation.member_left",
    "kick_corporation_member": "corporation.member_kicked",
}

# Sync tools whose events should NOT be added to LLM context (data already
# in the tool result).
SYNC_TOOL_EVENTS = {
    "local_map_region": "map.region",
    "plot_course": "course.plot",
}


# ── _ResponseStateTracker ─────────────────────────────────────────────────


class _ResponseStateTracker(FrameProcessor):
    """Monitors LLM response frames to control inference scheduling."""

    def __init__(self, agent: TaskAgent):
        super().__init__()
        self._agent = agent
        self._has_function_calls = False
        self._has_text_output = False
        self._accumulated_text = ""

    def _reset_state(self):
        self._has_function_calls = False
        self._has_text_output = False
        self._accumulated_text = ""

    async def process_frame(self, frame: Any, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMFullResponseStartFrame):
            self._reset_state()
        elif isinstance(frame, LLMTextFrame):
            self._has_text_output = True
            self._accumulated_text += frame.text
        elif isinstance(frame, LLMThoughtTextFrame):
            self._has_text_output = True
            self._accumulated_text += frame.text
        elif isinstance(frame, (FunctionCallsStartedFrame, FunctionCallInProgressFrame)):
            self._has_function_calls = True
        elif isinstance(frame, LLMFullResponseEndFrame):
            self._agent._llm_inflight = False
            await self._handle_response_end()

        await self.push_frame(frame, direction)

    async def _handle_response_end(self):
        if self._accumulated_text:
            self._agent._output(self._accumulated_text, TaskOutputType.MESSAGE)

        if self._agent._task_finished or self._agent._cancelled:
            return

        if not self._has_function_calls:
            await self._agent._handle_no_tool_response()


# ── TaskAgent ─────────────────────────────────────────────────────────────


class TaskAgent(LLMAgent):
    """Background task worker with its own LLM pipeline.

    Runs as LLMAgent (not bridged). Receives tasks from a parent (typically
    VoiceAgent) via the bus task protocol, executes them autonomously using
    game tools, and reports progress/completion back.
    """

    def __init__(
        self,
        name: str,
        *,
        bus: AgentBus,
        game_client: AsyncGameClient,
        character_id: str,
        is_corp_ship: bool = False,
        task_metadata: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(name, bus=bus, active=False)
        self._game_client = game_client
        self._character_id = character_id
        self._is_corp_ship = is_corp_ship
        self._task_metadata = task_metadata or {}
        self._tool_schemas: Dict[str, Any] = {t.name: t for t in self.build_tools()}

        # ── Task state ──
        self._active_task_id: Optional[str] = None
        self._task_description: Optional[str] = None
        self._task_finished = False
        self._cancelled = False
        self._task_finished_message: Optional[str] = None
        self._task_finished_status: str = "completed"
        self._finish_emitted: bool = False
        self._task_start_monotonic: Optional[float] = None
        self._step_counter: int = 0

        # ── Inference state ──
        self._llm_inflight: bool = False
        self._tool_call_in_progress: bool = False
        self._inference_reasons: List[str] = []
        self._inference_watchdog_handle: Optional[asyncio.TimerHandle] = None
        self._awaiting_completion_event: Optional[str] = None
        self._completion_event_timeout: Optional[asyncio.TimerHandle] = None
        self._no_tool_nudge_count: int = 0
        self._no_tool_watchdog_handle: Optional[asyncio.TimerHandle] = None
        self._consecutive_error_count: int = 0
        self._idle_wait_event: Optional[asyncio.Event] = None
        self._skip_context_events: Dict[str, int] = {}

        # ── Task log ──
        self._task_log: List[str] = []

        # ── Pipeline refs (set in build_pipeline) ──
        self._llm_context: Optional[LLMContext] = None

    # ── LLM setup ─────────────────────────────────────────────────────

    def build_llm(self):
        config = get_task_agent_llm_config()
        return create_llm_service(config)

    def build_tools(self) -> list:
        tools = list(TASK_TOOLS.standard_tools)
        if self._is_corp_ship:
            tools = [t for t in tools if t.name not in PLAYER_ONLY_TOOLS]
        return tools

    def create_llm(self):
        llm = self.build_llm()
        llm.register_function(None, self._handle_function_call)
        return llm

    async def build_pipeline(self) -> Pipeline:
        self._llm = self.create_llm()
        self._llm_context = LLMContext(messages=[], tools=ToolsSchema(self.build_tools()))
        aggregators = LLMContextAggregatorPair(self._llm_context)
        state_tracker = _ResponseStateTracker(self)
        return Pipeline(
            [
                aggregators.user(),
                self._llm,
                state_tracker,
                aggregators.assistant(),
            ]
        )

    # ── Bus protocol ──────────────────────────────────────────────────

    @traced
    async def on_task_request(self, message: BusTaskRequestMessage) -> None:
        await super().on_task_request(message)
        self._reset_task_state()

        task_id = message.task_id
        payload = message.payload
        self._active_task_id = task_id
        self._task_description = (payload or {}).get("task_description", "")
        self._task_metadata = (payload or {}).get("task_metadata", self._task_metadata)
        self._task_start_monotonic = time.perf_counter()

        logger.info(f"TaskAgent '{self.name}': received task {task_id[:8]}")

        # Tag game client for event correlation
        self._game_client.current_task_id = task_id

        # Emit task.start game event
        try:
            await self._game_client.task_lifecycle(
                task_id=task_id,
                event_type="start",
                task_description=self._task_description,
                task_metadata=self._task_metadata,
            )
        except Exception as exc:
            logger.warning(f"TaskAgent '{self.name}': failed to emit task.start: {exc}")

        # Build initial context
        messages = [
            {"role": "system", "content": build_task_agent_prompt()},
            {"role": "user", "content": create_task_instruction_user_message(self._task_description)},
        ]
        self._llm_context.set_messages(messages)

        # Trigger first inference
        await self.queue_frame(LLMRunFrame())
        self._llm_inflight = True

    async def on_task_cancelled(self, message: BusTaskCancelMessage) -> None:
        self._cancelled = True
        self._task_finished_status = "cancelled"
        task_id = message.task_id
        reason = message.reason
        logger.info(f"TaskAgent '{self.name}': task {task_id[:8]} cancelled: {reason}")

        self._quench_inference_state()
        cancelled_text = self._timestamped_text("Execution cancelled")
        self._task_log.append(cancelled_text)
        logger.bind(task_output_type=TaskOutputType.FINISHED.value).info("{}", cancelled_text)
        await self._send_task_output(cancelled_text, TaskOutputType.FINISHED)

        if self._active_task_id and not self._finish_emitted:
            try:
                await self._game_client.task_lifecycle(
                    task_id=self._active_task_id,
                    event_type="finish",
                    task_summary="Cancelled by user",
                    task_status="cancelled",
                    task_metadata=self._task_metadata,
                )
                self._finish_emitted = True
            except Exception as exc:
                logger.warning(f"TaskAgent '{self.name}': failed to emit task.finish (cancel): {exc}")

        self._game_client.current_task_id = None
        await super().on_task_cancelled(message)

    async def on_task_update_requested(self, message: BusTaskUpdateRequestMessage) -> None:
        await super().on_task_update_requested(message)
        log_lines = self.get_task_log()
        if not log_lines:
            await self.send_task_update({"type": "progress_report", "summary": "No activity yet."})
            return

        try:
            system_prompt = build_task_progress_prompt(log_lines)
            prompt = "Give a concise status update on this task."
            context = LLMContext(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt},
                ],
                tools=ToolsSchema([]),
            )
            llm_service = self.build_llm()
            summary = await llm_service.run_inference(context)
            await self.send_task_update(
                {"type": "progress_report", "summary": (summary or "").strip() or "No summary available."}
            )
        except Exception as exc:
            logger.warning(f"TaskAgent '{self.name}': progress query failed: {exc}")
            await self.send_task_update({"type": "progress_report", "summary": f"Error: {exc}"})

    async def on_bus_message(self, message: BusMessage) -> None:
        await super().on_bus_message(message)
        if isinstance(message, BusGameEventMessage):
            if self._active_task_id:
                await self._handle_bus_game_event(message.event)
        elif isinstance(message, BusSteerTaskMessage):
            if self._active_task_id and message.task_id == self._active_task_id:
                await self._inject_steering(message.text)

    async def _handle_bus_game_event(self, event: Dict[str, Any]) -> None:
        """Filter and process a game event received from the bus."""
        event_task_id = self._extract_event_task_id(event)
        # Events tagged with our task_id
        if event_task_id and event_task_id == self._active_task_id:
            await self._handle_event(event)
            return
        # Events for our character (movement, status, etc.)
        payload = event.get("payload")
        if isinstance(payload, dict):
            player = payload.get("player")
            if isinstance(player, dict) and player.get("id") == self._character_id:
                await self._handle_event(event)
                return
        # Ambient events we always care about
        event_name = event.get("event_name")
        if event_name in {"error", "chat.message"}:
            await self._handle_event(event)

    async def _stop(self) -> None:
        self._cancel_timers()
        await super()._stop()

    # ── Task state management ─────────────────────────────────────────

    def _reset_task_state(self):
        self._archive_task_log()
        self._task_finished = False
        self._cancelled = False
        self._task_finished_message = None
        self._task_finished_status = "completed"
        self._finish_emitted = False
        self._consecutive_error_count = 0
        self._active_task_id = None
        self._task_description = None
        self._task_start_monotonic = None
        self._step_counter = 0
        self._no_tool_nudge_count = 0
        self._tool_call_in_progress = False
        self._llm_inflight = False
        self._awaiting_completion_event = None
        self._idle_wait_event = None
        self._skip_context_events.clear()
        self._inference_reasons.clear()
        self._cancel_timers()

    def _archive_task_log(self):
        self._task_log = []

    def get_task_log(self) -> List[str]:
        return list(self._task_log)

    # ── Event handling ────────────────────────────────────────────────

    @traced
    async def _handle_event(self, event: Dict[str, Any]) -> None:
        if not self._active_task_id:
            return

        event_name = event.get("event_name")
        event_task_id = self._extract_event_task_id(event)

        if event_task_id and event_task_id != self._active_task_id:
            return

        # Drop movement events for other characters
        if event_name in {"character.moved", "garrison.character_moved", "movement.start", "movement.complete"}:
            payload = event.get("payload")
            if isinstance(payload, dict):
                player = payload.get("player")
                if isinstance(player, dict):
                    moving_id = player.get("id")
                    if isinstance(moving_id, str) and moving_id != self._character_id:
                        return

        # task.finish is terminal
        if event_name == "task.finish":
            if not event_task_id:
                return
            event_status = self._extract_event_task_status(event)
            if event_status in {"pending", "started", "running", "in_progress"}:
                return

        summary = event.get("summary")
        response_data = summary or event.get("payload")
        serialized = self._serialize_output(response_data)
        event_text = f"{event_name}: {serialized}" if event_name else serialized
        self._output(event_text, TaskOutputType.EVENT)

        if self._idle_wait_event and not self._idle_wait_event.is_set():
            self._idle_wait_event.set()

        # Skip context addition for sync tool events
        if event_name:
            skip_count = self._skip_context_events.get(event_name, 0)
            if skip_count > 0:
                self._skip_context_events[event_name] = skip_count - 1
                if self._skip_context_events[event_name] == 0:
                    del self._skip_context_events[event_name]
                return

        # Add event to LLM context
        event_message = {
            "role": "user",
            "content": f"<event name={event_name}>\n{response_data}\n</event>",
        }
        if self._llm_context is not None:
            self._llm_context.add_message(event_message)

        # Handle error events
        if event_name == "error":
            self._consecutive_error_count += 1
            if self._consecutive_error_count >= MAX_CONSECUTIVE_ERRORS:
                await self._force_finish_on_errors(serialized)
                return
        elif event_name not in {"task.start", "task.finish"}:
            self._consecutive_error_count = 0

        # task.finish: close out
        if event_name == "task.finish":
            if not self._task_finished:
                self._task_finished = True
            if not self._task_finished_message and isinstance(response_data, str):
                self._task_finished_message = response_data.strip() or None
            self._quench_inference_state()
            await self._complete_task()
            return

        reason = event_name or "unknown"
        self._record_inference_reason(reason)

        # Handle completion event arrival
        if event_name == "error" and self._awaiting_completion_event:
            self._awaiting_completion_event = None
            self._cancel_completion_timeout()
            if not self._llm_inflight:
                asyncio.create_task(self._schedule_pending_inference())
            return

        if self._awaiting_completion_event and event_name == self._awaiting_completion_event:
            self._awaiting_completion_event = None
            self._cancel_completion_timeout()
            if not self._llm_inflight:
                asyncio.create_task(self._schedule_pending_inference())
            return

        if self._awaiting_completion_event:
            return

        if self._tool_call_in_progress:
            return

        if not self._llm_inflight:
            self._start_inference_watchdog()

    # ── Function call handler (catch-all) ─────────────────────────────

    @traced
    async def _handle_function_call(self, params: FunctionCallParams) -> None:
        tool_name = params.function_name
        arguments = params.arguments or {}

        # Corp ship restriction guard
        if self._is_corp_ship and tool_name in PLAYER_ONLY_TOOLS:
            await params.result_callback(
                {"error": f"Tool '{tool_name}' is not available for corporation ships."},
                properties=FunctionCallResultProperties(run_llm=False),
            )
            self._record_inference_reason(f"restricted({tool_name})")
            await self._schedule_pending_inference()
            return

        # Max iterations check
        if self._step_counter >= 100:
            await self._force_finish_max_iterations(params)
            return

        # Task finished tool
        if tool_name == "finished":
            await self._handle_finished_tool(params)
            return

        self._emit_step()
        self._no_tool_nudge_count = 0
        self._consecutive_error_count = 0
        if self._no_tool_watchdog_handle:
            self._no_tool_watchdog_handle.cancel()
            self._no_tool_watchdog_handle = None

        action_text = f"{tool_name}({json.dumps(arguments)})"
        self._output(action_text, TaskOutputType.ACTION)

        # Check for async completion event
        expected_completion_event = ASYNC_TOOL_COMPLETIONS.get(tool_name)
        is_async_tool = expected_completion_event is not None

        if is_async_tool:
            self._awaiting_completion_event = expected_completion_event
            loop = asyncio.get_event_loop()
            self._completion_event_timeout = loop.call_later(
                ASYNC_COMPLETION_TIMEOUT,
                lambda: asyncio.create_task(self._on_completion_event_timeout()),
            )

        # Pre-mark sync tool events for context skipping
        sync_event_to_skip: Optional[str] = None
        if tool_name in SYNC_TOOL_EVENTS:
            sync_event_to_skip = SYNC_TOOL_EVENTS[tool_name]
            self._skip_context_events[sync_event_to_skip] = (
                self._skip_context_events.get(sync_event_to_skip, 0) + 1
            )

        # Execute the tool
        error_payload: Optional[Any] = None
        result_payload: Any = None
        try:
            self._tool_call_in_progress = True
            handler = self._get_tool_handler(tool_name)
            if handler is None:
                raise ValueError(f"Unknown tool: {tool_name}")
            result = handler(arguments)
            if inspect.isawaitable(result):
                result = await result
            result_payload = result
        except Exception as exc:
            if is_async_tool:
                self._awaiting_completion_event = None
                self._cancel_completion_timeout()
            if sync_event_to_skip and sync_event_to_skip in self._skip_context_events:
                self._skip_context_events[sync_event_to_skip] -= 1
                if self._skip_context_events[sync_event_to_skip] <= 0:
                    del self._skip_context_events[sync_event_to_skip]
            error_payload = {"error": str(exc)}
        finally:
            self._tool_call_in_progress = False

        if error_payload is not None:
            await params.result_callback(
                error_payload, properties=FunctionCallResultProperties(run_llm=False)
            )
            await self._on_tool_call_completed(tool_name, error_payload)
            return

        await params.result_callback(
            result_payload, properties=FunctionCallResultProperties(run_llm=False)
        )
        await self._on_tool_call_completed(tool_name, result_payload)

    async def _handle_finished_tool(self, params: FunctionCallParams):
        args = params.arguments or {}
        self._task_finished = True
        self._task_finished_message = args.get("message", "Done")
        status = args.get("status", "completed")
        if status not in ("completed", "failed", "cancelled"):
            status = "completed"
        self._task_finished_status = status
        # Await the FINISHED update so it reaches the parent before send_task_response
        # clears _task_id. _output uses fire-and-forget which races and loses.
        finished_text = self._timestamped_text(self._task_finished_message)
        self._task_log.append(finished_text)
        logger.bind(task_output_type=TaskOutputType.FINISHED.value).info("{}", finished_text)
        await self._send_task_output(finished_text, TaskOutputType.FINISHED)
        self._quench_inference_state()

        await params.result_callback(
            {"status": status, "message": self._task_finished_message},
            properties=FunctionCallResultProperties(run_llm=False),
        )

        # Emit task.finish game event
        if self._active_task_id and not self._finish_emitted:
            try:
                await self._game_client.task_lifecycle(
                    task_id=self._active_task_id,
                    event_type="finish",
                    task_summary=self._task_finished_message,
                    task_status=status,
                    task_metadata=self._task_metadata,
                )
                self._finish_emitted = True
            except Exception as exc:
                logger.warning(f"TaskAgent '{self.name}': failed to emit task.finish: {exc}")

        await self._complete_task()

    async def _complete_task(self):
        self._game_client.current_task_id = None
        self._active_task_id = None  # Stop processing events
        _STATUS_MAP = {"completed": TaskStatus.COMPLETED, "cancelled": TaskStatus.CANCELLED}
        status = _STATUS_MAP.get(self._task_finished_status, TaskStatus.FAILED)
        try:
            await self.send_task_response(
                response={
                    "message": self._task_finished_message or "Task complete",
                    "status": self._task_finished_status,
                },
                status=status,
            )
        except RuntimeError:
            pass  # Already responded

    # ── Inference scheduling ──────────────────────────────────────────

    async def _on_tool_call_completed(self, tool_name: Optional[str], result_payload: Any) -> None:
        try:
            if tool_name:
                serialized = self._serialize_output(result_payload)
                if len(serialized) > 200:
                    serialized = serialized[:200] + "..."
                self._record_inference_reason(f"tool({tool_name}):{serialized}")
            elif not self._inference_reasons:
                self._record_inference_reason("tool_result")

            # For async tools, check whether the completion event has already
            # arrived (race: event came in during tool execution, recorded as
            # an inference reason by _handle_event, but _schedule_pending_inference
            # returned early because _tool_call_in_progress was True).
            expected_event = ASYNC_TOOL_COMPLETIONS.get(tool_name)
            if expected_event:
                already_received = any(expected_event in r for r in self._inference_reasons)
                if already_received:
                    # Event arrived during execution — clear the await and proceed.
                    if self._awaiting_completion_event == expected_event:
                        self._awaiting_completion_event = None
                        self._cancel_completion_timeout()
                elif self._awaiting_completion_event == expected_event:
                    return  # Still waiting — defer until event or timeout

            await self._schedule_pending_inference()
        except Exception as exc:
            logger.warning(f"TaskAgent: inference scheduling failed: {exc}")

    async def _schedule_pending_inference(self) -> None:
        if self._llm_inflight:
            return
        if self._task_finished or self._cancelled:
            self._inference_reasons.clear()
            return
        if self._tool_call_in_progress:
            return
        if self._awaiting_completion_event:
            return
        if not self._inference_reasons:
            return

        self._inference_reasons.clear()
        self._cancel_inference_watchdog()
        if self._no_tool_watchdog_handle:
            self._no_tool_watchdog_handle.cancel()
            self._no_tool_watchdog_handle = None

        self._llm_inflight = True
        try:
            await self.queue_frame(LLMRunFrame())
        except Exception:
            self._llm_inflight = False
            raise

    def _record_inference_reason(self, reason: str) -> None:
        if reason not in self._inference_reasons:
            self._inference_reasons.append(reason)
            if len(self._inference_reasons) > 50:
                self._inference_reasons = self._inference_reasons[-50:]

    def _start_inference_watchdog(self) -> None:
        if self._inference_watchdog_handle is not None:
            return
        if self._llm_inflight:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._inference_watchdog_handle = loop.call_later(
            EVENT_BATCH_INFERENCE_DELAY, self._inference_watchdog_fire
        )

    def _cancel_inference_watchdog(self) -> None:
        if self._inference_watchdog_handle:
            self._inference_watchdog_handle.cancel()
            self._inference_watchdog_handle = None

    def _inference_watchdog_fire(self) -> None:
        self._inference_watchdog_handle = None
        asyncio.create_task(self._schedule_pending_inference())

    async def _on_completion_event_timeout(self) -> None:
        if self._awaiting_completion_event:
            logger.warning(
                "TaskAgent '%s': timeout waiting for %s, proceeding",
                self.name,
                self._awaiting_completion_event,
            )
            self._awaiting_completion_event = None
            self._completion_event_timeout = None
            await self._schedule_pending_inference()

    def _cancel_completion_timeout(self):
        if self._completion_event_timeout:
            self._completion_event_timeout.cancel()
            self._completion_event_timeout = None

    async def _handle_no_tool_response(self) -> None:
        if self._task_finished or self._cancelled:
            return
        if self._no_tool_watchdog_handle is not None:
            return

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._no_tool_watchdog_handle = loop.call_later(
            NO_TOOL_WATCHDOG_DELAY, self._no_tool_watchdog_fire
        )

    def _no_tool_watchdog_fire(self) -> None:
        self._no_tool_watchdog_handle = None
        if self._task_finished or self._cancelled:
            return

        self._no_tool_nudge_count += 1

        if self._no_tool_nudge_count > MAX_NO_TOOL_NUDGES:
            self._task_finished = True
            self._task_finished_status = "failed"
            self._task_finished_message = "Task stopped: LLM failed to call required tools"
            self._output(self._timestamped_text(self._task_finished_message), TaskOutputType.FINISHED)

            if self._active_task_id and not self._finish_emitted:

                async def _emit():
                    try:
                        await self._game_client.task_lifecycle(
                            task_id=self._active_task_id,
                            event_type="finish",
                            task_summary=self._task_finished_message,
                            task_status="failed",
                            task_metadata=self._task_metadata,
                        )
                        self._finish_emitted = True
                    except Exception as exc:
                        logger.warning(f"TaskAgent: failed to emit task.finish: {exc}")

                asyncio.create_task(_emit())
            asyncio.create_task(self._complete_task())
            return

        nudge = {
            "role": "user",
            "content": (
                "You did not call any tools in your last response. "
                "If the task is complete, call the `finished` tool with a summary message. "
                "If more work is needed, call the appropriate tool to continue."
            ),
        }
        if self._llm_context is not None:
            self._llm_context.add_message(nudge)
        self._record_inference_reason("no_tool_nudge")
        asyncio.create_task(self._schedule_pending_inference())

    def _quench_inference_state(self) -> None:
        self._inference_reasons.clear()
        self._cancel_inference_watchdog()
        if self._no_tool_watchdog_handle:
            self._no_tool_watchdog_handle.cancel()
            self._no_tool_watchdog_handle = None
        self._cancel_completion_timeout()
        self._awaiting_completion_event = None

    async def _force_finish_on_errors(self, last_error: str) -> None:
        self._task_finished = True
        self._task_finished_status = "failed"
        self._task_finished_message = (
            f"Task stopped after {self._consecutive_error_count} consecutive errors. "
            f"Last error: {last_error}"
        )
        self._output(self._timestamped_text(self._task_finished_message), TaskOutputType.FINISHED)
        self._quench_inference_state()

        if self._active_task_id and not self._finish_emitted:
            try:
                await self._game_client.task_lifecycle(
                    task_id=self._active_task_id,
                    event_type="finish",
                    task_summary=self._task_finished_message,
                    task_status="failed",
                    task_metadata=self._task_metadata,
                )
                self._finish_emitted = True
            except Exception as exc:
                logger.warning(f"TaskAgent: failed to emit task.finish (errors): {exc}")

        await self._complete_task()

    async def _force_finish_max_iterations(self, params: FunctionCallParams) -> None:
        msg = "Task stopped after 100 steps (max_iterations limit)."
        self._task_finished = True
        self._task_finished_status = "failed"
        self._task_finished_message = msg
        self._output(self._timestamped_text(msg), TaskOutputType.FINISHED)
        self._quench_inference_state()
        await params.result_callback({"error": msg}, properties=FunctionCallResultProperties(run_llm=False))

        if self._active_task_id and not self._finish_emitted:
            try:
                await self._game_client.task_lifecycle(
                    task_id=self._active_task_id,
                    event_type="finish",
                    task_summary=msg,
                    task_status="failed",
                    task_metadata=self._task_metadata,
                )
                self._finish_emitted = True
            except Exception as exc:
                logger.warning(f"TaskAgent: failed to emit task.finish (iterations): {exc}")

        await self._complete_task()

    # ── Steering ──────────────────────────────────────────────────────

    async def _inject_steering(self, text: str) -> None:
        cleaned = text.strip()
        if not cleaned:
            return
        message = {"role": "user", "content": cleaned}
        if self._llm_context is not None:
            self._llm_context.add_message(message)
        self._output(cleaned, TaskOutputType.INPUT)
        self._record_inference_reason("steering")
        if not self._llm_inflight:
            await self._schedule_pending_inference()

    # ── Idle wait ─────────────────────────────────────────────────────

    async def _wait_in_idle_state(self, seconds: int = 60) -> Dict[str, Any]:
        seconds = max(1, min(60, int(seconds)))
        idle_event = asyncio.Event()
        self._idle_wait_event = idle_event
        start = time.monotonic()

        try:
            await asyncio.wait_for(idle_event.wait(), timeout=seconds)
            elapsed = time.monotonic() - start
            return {"status": "event_received", "elapsed_seconds": round(elapsed, 2)}
        except asyncio.TimeoutError:
            elapsed = time.monotonic() - start
            await self._handle_event(
                {
                    "event_name": "idle.complete",
                    "payload": {
                        "elapsed_seconds": round(elapsed, 2),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    },
                }
            )
            return {"status": "idle_complete", "elapsed_seconds": round(elapsed, 2)}
        finally:
            if self._idle_wait_event is idle_event:
                self._idle_wait_event = None

    # ── Utility ───────────────────────────────────────────────────────

    def _cancel_timers(self) -> None:
        self._cancel_inference_watchdog()
        self._cancel_completion_timeout()
        if self._no_tool_watchdog_handle:
            self._no_tool_watchdog_handle.cancel()
            self._no_tool_watchdog_handle = None

    async def _send_task_output(self, text: str, message_type: TaskOutputType) -> None:
        """Awaitable send of a task output update to the parent agent."""
        if self._task_id and self._task_requester:
            try:
                await self.send_task_update(
                    {"type": "output", "text": text, "message_type": message_type.value.lower()}
                )
            except RuntimeError:
                pass  # Task already completed

    def _output(self, text: str, message_type: Optional[TaskOutputType] = None) -> None:
        type_value = message_type.value if message_type else None
        if type_value:
            logger.bind(task_output_type=type_value).info("{}", text)
        else:
            logger.info("{}", text)
        self._task_log.append(text)

        # Send to parent (VoiceAgent) so it can forward to client.
        # Guard: only send if framework task is active (cleared after send_task_response).
        if type_value and self._task_id and self._task_requester:
            async def _send():
                try:
                    await self.send_task_update(
                        {"type": "output", "text": text, "message_type": type_value.lower()}
                    )
                except RuntimeError:
                    pass  # Task already completed

            try:
                asyncio.get_running_loop().create_task(_send())
            except RuntimeError:
                pass  # No event loop

    def _emit_step(self, label: Optional[str] = "") -> None:
        self._step_counter += 1
        label_suffix = f": {label}" if label else ""
        step_text = f"{self._step_counter} - {self._elapsed_ms()} ms elapsed{label_suffix}"
        self._output(step_text, TaskOutputType.STEP)

    def _elapsed_ms(self) -> int:
        if self._task_start_monotonic is None:
            return 0
        return int((time.perf_counter() - self._task_start_monotonic) * 1000)

    def _timestamped_text(self, message: str) -> str:
        return f"{self._elapsed_ms()} ms - {message}"

    @staticmethod
    def _serialize_output(data: Any) -> str:
        if isinstance(data, str):
            return data
        try:
            return json.dumps(data, ensure_ascii=False)
        except (TypeError, ValueError):
            return str(data)

    @staticmethod
    def _extract_event_task_id(event: Dict[str, Any]) -> Optional[str]:
        top = event.get("task_id")
        if isinstance(top, str) and top.strip():
            return top.strip()
        payload = event.get("payload")
        if isinstance(payload, dict):
            pid = payload.get("task_id") or payload.get("__task_id")
            if isinstance(pid, str) and pid.strip():
                return pid.strip()
        return None

    @staticmethod
    def _extract_event_task_status(event: Dict[str, Any]) -> Optional[str]:
        payload = event.get("payload")
        if not isinstance(payload, dict):
            return None
        status = payload.get("task_status") or payload.get("status")
        if isinstance(status, str) and status.strip():
            return status.strip().lower()
        return None

    # ── Tool handlers ─────────────────────────────────────────────────
    # Most tools are dispatched via _TOOL_DISPATCH below.
    # Special-case handlers that need custom logic are defined as methods.

    def _call_game(self, method: str, **kwargs) -> Any:
        fn = getattr(self._game_client, method)
        return fn(character_id=self._character_id, **kwargs)

    def _dispatch_tool(self, tool_name: str, args: dict) -> Any:
        """Dispatch a tool call using the schema to derive required/optional args."""
        schema = self._tool_schemas.get(tool_name)
        if schema is None:
            return None
        method = GAME_METHOD_ALIASES.get(tool_name, tool_name)
        required = schema.required or []
        optional = set(schema.properties or {}) - set(required)
        kwargs = {k: args[k] for k in required}
        for k in optional:
            if args.get(k) is not None:
                kwargs[k] = args[k]
        return self._call_game(method, **kwargs)

    def _get_tool_handler(self, tool_name: str) -> Optional[Callable]:
        # Check special-case handlers first, then schema-driven dispatch
        special = _SPECIAL_HANDLERS.get(tool_name)
        if special:
            return getattr(self, special, None)
        if tool_name in self._tool_schemas:
            return lambda args: self._dispatch_tool(tool_name, args)
        return None

    # ── Special-case tool handlers ─────────────────────────────────────

    async def _tool_join_corporation(self, args: dict) -> Any:
        corp_id = (args.get("corp_id") or "").strip()
        if not corp_id:
            corp_name = args.get("corp_name")
            if not corp_name:
                raise ValueError("join_corporation requires either corp_id or corp_name.")
            corps = await self._game_client.list_corporations()
            match_name = corp_name.strip().lower()
            for corp in corps:
                if str(corp.get("name", "")).strip().lower() == match_name:
                    corp_id = corp.get("corp_id", "")
                    break
            if not corp_id:
                raise ValueError(f"Corporation named '{corp_name}' not found.")
        return await self._game_client.join_corporation(
            corp_id=corp_id,
            invite_code=args["invite_code"],
            character_id=self._character_id,
        )

    async def _tool_corporation_info(self, args: dict) -> Any:
        if args.get("list_all"):
            result = await self._game_client._request("corporation.list", {})
        elif args.get("corp_id"):
            result = await self._game_client._request(
                "corporation.info",
                {"character_id": self._character_id, "corp_id": args["corp_id"]},
            )
        else:
            result = await self._game_client._request(
                "my_corporation", {"character_id": self._character_id}
            )
        return result

    async def _tool_ship_definitions(self, _args: dict) -> Any:
        result = await self._game_client.get_ship_definitions()
        return result.get("definitions", result)

    def _tool_dump_cargo(self, args: dict) -> Any:
        items = args.get("items", [])
        normalized = []
        for entry in items:
            if isinstance(entry, dict):
                units = entry.get("units")
                if isinstance(units, str) and units.isdigit():
                    entry = {**entry, "units": int(units)}
                normalized.append(entry)
        return self._call_game("dump_cargo", items=normalized)

    def _tool_sell_ship(self, args: dict) -> Any:
        return self._call_game("sell_ship", ship_id=args["ship_id"])

    def _tool_load_game_info(self, args: dict) -> Any:
        topic = str(args.get("topic", "")).strip()
        if topic not in AVAILABLE_TOPICS:
            return {"error": f"Unknown topic: {topic}. Available: {', '.join(AVAILABLE_TOPICS)}"}
        try:
            content = load_fragment(topic)
            return {"topic": topic, "content": content}
        except FileNotFoundError as exc:
            return {"error": str(exc)}

    async def _tool_wait_in_idle_state(self, args: dict) -> Any:
        seconds = args.get("seconds", 60)
        return await self._wait_in_idle_state(seconds)


# Tools with custom handler methods (not dispatched via schema)
_SPECIAL_HANDLERS: Dict[str, str] = {
    "join_corporation": "_tool_join_corporation",
    "corporation_info": "_tool_corporation_info",
    "ship_definitions": "_tool_ship_definitions",
    "sell_ship": "_tool_sell_ship",
    "dump_cargo": "_tool_dump_cargo",
    "load_game_info": "_tool_load_game_info",
    "wait_in_idle_state": "_tool_wait_in_idle_state",
}

