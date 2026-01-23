"""
Task agent that routes task execution through a Pipecat pipeline.

This implementation constructs a fresh Pipecat pipeline for each task.

## Async Tool Pattern (IMPORTANT FOR NEW TOOLS)

All tools in this agent use an async event-based pattern. This is critical because:

1. **Non-blocking execution**: The game world is live. Combat events, chat messages,
   and other events can arrive at any time. Blocking RPC calls would cause us to
   miss these events.

2. **Hallucination prevention**: If a tool returns data directly in the RPC response,
   the LLM only sees {"status": "Executed."} and will hallucinate the actual data.

### How it works:

1. Tool is called → returns {"status": "Executed."} immediately to the LLM
2. Server processes the request and emits an event (e.g., "trade.executed")
3. TaskAgent receives the event via WebSocket with the actual data
4. Event data is added to the LLM context
5. LLM inference proceeds with real data

### Adding a new tool:

1. Create the tool class in tools_schema.py
2. Have the Supabase edge function emit an event with results (see my_status as example)
3. Add the tool to ASYNC_TOOL_COMPLETIONS below: {"tool_name": "event.type"}
4. Add the event type to self._event_names in __init__

If you return data directly in the RPC response without emitting an event,
the LLM will hallucinate because it never sees the actual data.

For verbose logging set the Pipecat log level either in code or using an environment variable. For example:

```
LOGURU_LEVEL=DEBUG uv run bot
```
"""

from __future__ import annotations

import asyncio
import copy
import inspect
import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from dotenv import load_dotenv
from loguru import logger

from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import (
    EndFrame,
    FunctionCallInProgressFrame,
    FunctionCallResultProperties,
    FunctionCallsStartedFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMRunFrame,
    LLMTextFrame,
    LLMThoughtTextFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.google.llm import GoogleLLMService as PipecatGoogleLLMService
from pipecat.services.llm_service import FunctionCallParams, LLMService

from gradientbang.utils.api_client import AsyncGameClient
from gradientbang.utils.base_llm_agent import LLMConfig
from gradientbang.utils.weave_tracing import init_weave, traced

from gradientbang.utils.prompts import (
    TaskOutputType,
    create_task_instruction_user_message,
    create_task_system_message,
)
from gradientbang.utils.tools_schema import (
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
    WaitInIdleState,
    TaskFinished,
    EventQuery,
    PurchaseFighters,
    CreateCorporation,
    JoinCorporation,
    LeaveCorporation,
    KickCorporationMember,
    PurchaseShip,
    RenameShip,
    BankDeposit,
    BankWithdraw,
    TransferCredits,
    DumpCargo,
    CombatInitiate,
    CombatAction,
    CorporationInfo,
)


load_dotenv()

DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash-preview-09-2025"
# DEFAULT_GOOGLE_MODEL = "gemini-3-flash-preview"
DEFAULT_THINKING_BUDGET = 2048
DEFAULT_INCLUDE_THOUGHTS = True
EVENT_BATCH_INFERENCE_DELAY = 1.0
ASYNC_COMPLETION_TIMEOUT = 5.0  # Timeout for waiting for async tool completion events
MAX_NO_TOOL_NUDGES = 3  # Max times to nudge LLM when it responds without tool calls
NO_TOOL_WATCHDOG_DELAY = 5.0  # Seconds to wait for events before nudging LLM

# Tools that have async completion events - inference is deferred until the event arrives.
# See module docstring for full explanation of this pattern.
#
# IMPORTANT: When adding a new tool, you MUST:
#   1. Have the edge function emit an event (not return data in RPC response)
#   2. Add the mapping here: "tool_name": "event.type"
#   3. Add the event type to self._event_names in __init__
#
# Failure to do this will cause the LLM to hallucinate tool results.
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
    "send_message": "chat.message",
    "event_query": "event.query",  # verbose payload needs summarization for LLM
    "purchase_fighters": "fighter.purchase",
    "purchase_ship": "status.update",
    "rename_ship": "ship.renamed",
    "bank_deposit": "bank.transaction",
    "bank_withdraw": "bank.transaction",
    "transfer_credits": "credits.transfer",
    "dump_cargo": "salvage.created",
    "create_corporation": "corporation.created",
    "join_corporation": "corporation.member_joined",
    "leave_corporation": "corporation.member_left",
    "kick_corporation_member": "corporation.member_kicked",
    "combat_initiate": "combat.round_waiting",
    "combat_action": "combat.action_accepted",
}

# Events from sync tools that should NOT be added to LLM context.
# The tool result already contains the data; the event still flows to
# callbacks (e.g., VoiceTaskManager) but shouldn't duplicate in context.
#
# NOTE: event_query intentionally stays in ASYNC_TOOL_COMPLETIONS above.
# The raw payload contains verbose per-event data that hurts LLM instruction
# following. The summarized event (via event_query_summary) is more appropriate.
# VoiceTaskManager has a separate condensed summary in _get_voice_summary().
SYNC_TOOL_EVENTS = {
    "local_map_region": "map.region",
    "plot_course": "course.plot",
}


class _ResponseStateTracker(FrameProcessor):
    """Tracks response state and controls inference scheduling.

    This processor monitors standard Pipecat frames to determine when to schedule
    the next inference based on response content.
    """

    def __init__(self, agent: "TaskAgent"):
        super().__init__()
        self._agent = agent
        self._reset_state()

    def _reset_state(self):
        """Reset tracking state for a new response."""
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
            logger.debug(f"[THOUGHT]: {frame.text[:100]}...")

        elif isinstance(frame, FunctionCallsStartedFrame):
            # Track function calls early - this frame arrives before LLMFullResponseEndFrame
            self._has_function_calls = True

        elif isinstance(frame, FunctionCallInProgressFrame):
            # Also track this for completeness
            self._has_function_calls = True

        elif isinstance(frame, LLMFullResponseEndFrame):
            self._agent._llm_inflight = False
            await self._handle_response_end()

        await self.push_frame(frame, direction)

    async def _handle_response_end(self):
        """Handle end of LLM response - output text and control inference."""
        # Output accumulated text to callback
        if self._accumulated_text:
            self._agent._output(self._accumulated_text, TaskOutputType.MESSAGE)

        # Queue inference if function calls were made
        if self._has_function_calls:
            await self._agent._queue_pending_run_now()
        else:
            # LLM responded without tool calls - prompt it to continue or finish
            logger.debug("No tool calls in response. Prompting LLM to continue or finish.")
            await self._agent._handle_no_tool_response()


PipelineToolExecutor = Callable[
    [Dict[str, Any]], Awaitable[Tuple[Optional[Dict[str, Any]], bool, Any]]
]
ToolEventCallback = Callable[[str, Any], Awaitable[None]]


class TaskAgent:
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
        idle_timeout_secs: Optional[float] = None,
        task_metadata: Optional[Dict[str, Any]] = None,
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
        self._awaiting_completion_event: Optional[str] = None
        self._completion_event_timeout: Optional[asyncio.TimerHandle] = None
        self._task_start_monotonic: Optional[float] = None
        self._context: Optional[LLMContext] = None
        self._last_logged_message_count: int = 0
        self._idle_wait_event: Optional[asyncio.Event] = None
        self._no_tool_nudge_count: int = 0
        self._no_tool_watchdog_handle: Optional[asyncio.TimerHandle] = None
        self._task_id: Optional[str] = None
        self._task_description: Optional[str] = None
        self._task_metadata = task_metadata or {}
        self._finish_emitted: bool = False
        # Counter for events to skip (supports concurrent tool calls)
        self._skip_context_events: Dict[str, int] = {}

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
            EventQuery,
            PurchaseFighters,
            CreateCorporation,
            JoinCorporation,
            LeaveCorporation,
            KickCorporationMember,
            CorporationInfo,
            PurchaseShip,
            RenameShip,
            BankDeposit,
            BankWithdraw,
            TransferCredits,
            DumpCargo,
            CombatInitiate,
            CombatAction,
            (WaitInIdleState, {"agent": self}),
            TaskFinished,
        ]
        self.set_tools(tools)

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
            "warp.purchase",
            "warp.transfer",
            "garrison.deployed",
            "garrison.collected",
            "garrison.mode_changed",
            "salvage.collected",
            "combat.round_waiting",
            "combat.round_resolved",
            "combat.ended",
            "combat.action_accepted",
            "ship.destroyed",
            "ship.renamed",
            "chat.message",
            "event.query",
            "fighter.purchase",
            "bank.transaction",
            "credits.transfer",
            "salvage.created",
            "corporation.created",
            "corporation.member_joined",
            "corporation.member_left",
            "corporation.member_kicked",
            "corporation.ship_purchased",
            "ship.traded_in",
            "error",
        ]
        for event_name in self._event_names:
            self.game_client.on(event_name)(self._handle_event)

        # Initialize Weave tracing if available
        init_weave()

    def _default_llm_service_factory(self) -> LLMService:
        """Create the standard Pipecat GoogleLLMService with thinking enabled."""
        service = PipecatGoogleLLMService(
            api_key=self.config.api_key or "",
            model=self.config.model or DEFAULT_GOOGLE_MODEL,
            params=PipecatGoogleLLMService.InputParams(
                thinking=PipecatGoogleLLMService.ThinkingConfig(
                    thinking_budget=self._thinking_budget,
                    include_thoughts=self._include_thoughts,
                )
            ),
        )
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
        self._output(self._timestamped_text("Execution cancelled"), TaskOutputType.FINISHED)

    def reset_cancellation(self) -> None:
        self.cancelled = False

    @traced
    async def _handle_event(self, event: Dict[str, Any]) -> None:
        event_name = event.get("event_name")
        summary = event.get("summary")
        response_data = summary or event.get("payload")
        serialized_payload = self._serialize_output(response_data)
        if event_name:
            event_text = f"{event_name}: {serialized_payload}"
        else:
            event_text = serialized_payload
        self._output(event_text, TaskOutputType.EVENT)

        if self._idle_wait_event and not self._idle_wait_event.is_set():
            self._idle_wait_event.set()

        # Skip context addition for events from sync tools (data already in tool result)
        if event_name:
            skip_count = self._skip_context_events.get(event_name, 0)
            if skip_count > 0:
                self._skip_context_events[event_name] = skip_count - 1
                if self._skip_context_events[event_name] == 0:
                    del self._skip_context_events[event_name]
                logger.debug(
                    "Skipping context addition for sync tool event: {}",
                    event_name,
                )
                return  # Don't add to context, don't schedule inference

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

        if event_name == "error" and self._awaiting_completion_event:
            self._awaiting_completion_event = None
            if self._completion_event_timeout:
                self._completion_event_timeout.cancel()
                self._completion_event_timeout = None
            if not self._llm_inflight:
                asyncio.create_task(self._schedule_pending_inference())
            return

        # Check if this is the completion event we're waiting for
        if self._awaiting_completion_event and event_name == self._awaiting_completion_event:
            logger.debug(
                "Received awaited completion event: {}",
                event_name,
            )
            self._awaiting_completion_event = None
            if self._completion_event_timeout:
                self._completion_event_timeout.cancel()
                self._completion_event_timeout = None
            # Schedule inference immediately with all accumulated events
            if not self._llm_inflight:
                asyncio.create_task(self._schedule_pending_inference())
            return

        # If we're awaiting a completion event but this isn't it, just record and wait
        if self._awaiting_completion_event:
            logger.debug(
                "Recorded event while awaiting {}: {}",
                self._awaiting_completion_event,
                event_name,
            )
            return

        if self._tool_call_in_progress:
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

    async def wait_in_idle_state(self, seconds: Optional[int] = None) -> Dict[str, Any]:
        if seconds is None:
            seconds = 60
        try:
            seconds = int(seconds)
        except (TypeError, ValueError) as exc:
            raise ValueError("seconds must be an integer between 1 and 60") from exc
        if seconds < 1 or seconds > 60:
            raise ValueError("seconds must be between 1 and 60")

        idle_event = asyncio.Event()
        self._idle_wait_event = idle_event
        start = time.monotonic()

        try:
            await asyncio.wait_for(idle_event.wait(), timeout=seconds)
            elapsed = time.monotonic() - start
            return {
                "status": "event_received",
                "elapsed_seconds": round(elapsed, 2),
            }
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
            return {
                "status": "idle_complete",
                "elapsed_seconds": round(elapsed, 2),
            }
        finally:
            if self._idle_wait_event is idle_event:
                self._idle_wait_event = None

    @property
    def short_task_id(self) -> Optional[str]:
        """Return first 6 chars of task_id for display/filtering.

        This short ID format is used for:
        - Human-readable display in summaries
        - Prefix-based filtering in event_query
        - Correlation between VoiceTaskManager and TaskAgent
        """
        return self._task_id[:6] if self._task_id else None

    @traced
    async def run_task(
        self,
        task: str,
        initial_state: Optional[Dict[str, Any]] = None,
        max_iterations: int = 100,
        task_id: Optional[str] = None,
    ) -> bool:
        """Run a task to completion.

        Args:
            task: Natural language task description
            initial_state: Optional initial state (kept for API compatibility)
            max_iterations: Max iterations (kept for API compatibility; pipeline controls turns)
            task_id: Optional task ID (UUID string). If not provided, a new UUID is generated.
                    Callers like VoiceTaskManager can provide a pre-generated task_id to
                    enable correlation between the voice UI and the TaskAgent.

        Returns:
            True if task completed successfully, False otherwise
        """
        self.reset_cancellation()
        self.finished = False
        self.finished_message = None
        self.clear_messages()
        self._step_counter = 0
        self._no_tool_nudge_count = 0
        if self._no_tool_watchdog_handle:
            self._no_tool_watchdog_handle.cancel()
        self._no_tool_watchdog_handle = None
        self._inference_reasons.clear()
        self._cancel_inference_watchdog()
        self._tool_call_in_progress = False
        self._llm_inflight = False
        self._awaiting_completion_event = None
        if self._completion_event_timeout:
            self._completion_event_timeout.cancel()
        self._completion_event_timeout = None
        self._task_start_monotonic = time.perf_counter()
        # Use provided task_id or generate new one
        self._task_id = task_id or str(uuid.uuid4())
        self._task_description = task
        self._finish_emitted = False
        _ = max_iterations  # retained for API compatibility; pipeline controls turns

        # Set task_id on game_client so all API calls are tagged with this task
        self.game_client.current_task_id = self._task_id

        # Emit task.start event
        try:
            await self.game_client.task_lifecycle(
                task_id=self._task_id,
                event_type="start",
                task_description=task,
                task_metadata=self._task_metadata,
            )
        except Exception as exc:
            logger.warning(f"Failed to emit task.start event: {exc}")

        self.add_message({"role": "system", "content": create_task_system_message()})
        self.add_message({"role": "user", "content": create_task_instruction_user_message(task)})
        # Note: initial_state parameter kept for API compatibility but not used

        context = self._create_context()
        runner_task = self._setup_pipeline(context)
        self._context = context
        self._last_logged_message_count = len(context.get_messages())

        try:
            await self.game_client.resume_event_delivery()

            success = False
            while not self._active_pipeline_task.has_finished():
                if self.cancelled:
                    self._output(
                        self._timestamped_text("Task cancelled"),
                        TaskOutputType.FINISHED,
                    )
                    if self._task_id:
                        try:
                            await self.game_client.task_lifecycle(
                                task_id=self._task_id,
                                event_type="finish",
                                task_summary="Cancelled by user",
                                task_status="cancelled",
                                task_metadata=self._task_metadata,
                            )
                            self._finish_emitted = True
                        except Exception as exc:
                            logger.warning(
                                f"Failed to emit task.finish (cancelled): {exc}"
                            )
                    return False
                try:
                    await asyncio.sleep(1)
                except asyncio.CancelledError:
                    if self._task_id:
                        try:
                            await self.game_client.task_lifecycle(
                                task_id=self._task_id,
                                event_type="finish",
                                task_summary="Cancelled by user",
                                task_status="cancelled",
                                task_metadata=self._task_metadata,
                            )
                            self._finish_emitted = True
                        except Exception as exc:
                            logger.warning(
                                f"Failed to emit task.finish (cancelled): {exc}"
                            )
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
            if self.cancelled and self._task_id and not self._finish_emitted:
                try:
                    await self.game_client.task_lifecycle(
                        task_id=self._task_id,
                        event_type="finish",
                        task_summary="Cancelled by user",
                        task_status="cancelled",
                        task_metadata=self._task_metadata,
                    )
                    self._finish_emitted = True
                except Exception as exc:
                    logger.warning(
                        f"Failed to emit task.finish (cancelled): {exc}"
                    )
            # Clear task_id from game_client so subsequent calls aren't tagged
            self.game_client.current_task_id = None
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
        state_tracker = _ResponseStateTracker(self)
        pipeline = Pipeline(
            [
                aggregator_pair.user(),
                llm_service,
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
                # todo: add metrics
                enable_metrics=False,
                enable_usage_metrics=False,
            ),
            # Reset idle timeout on LLM activity frames, not speech frames (default).
            # This prevents false idle detection in text-based task agents.
            # Include function call frames because the LLM may respond with only
            # tool calls (no text), which wouldn't reset the idle timer otherwise.
            idle_timeout_frames=(
                LLMTextFrame,
                FunctionCallsStartedFrame,
                LLMFullResponseStartFrame,
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
        return f"{elapsed_ms} ms - {message}"

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

    @traced
    async def _handle_function_call(self, params: FunctionCallParams) -> None:
        tool_name = params.function_name
        tool_call_id = params.tool_call_id
        arguments = params.arguments or {}

        if tool_name == "finished":
            self.finished = True
            self.finished_message = arguments.get("message", "Done")
            finished_text = self._timestamped_text(self.finished_message)
            self._output(finished_text, TaskOutputType.FINISHED)

            # Emit task.finish event
            if self._task_id:
                try:
                    await self.game_client.task_lifecycle(
                        task_id=self._task_id,
                        event_type="finish",
                        task_summary=self.finished_message,
                        task_status="completed",
                        task_metadata=self._task_metadata,
                    )
                    self._finish_emitted = True
                except Exception as exc:
                    logger.warning(f"Failed to emit task.finish event: {exc}")

            await params.llm.push_frame(EndFrame())
            return

        self._emit_step()
        self._no_tool_nudge_count = 0  # Reset nudge counter on successful tool call
        if self._no_tool_watchdog_handle:
            self._no_tool_watchdog_handle.cancel()
            self._no_tool_watchdog_handle = None
        action_text = f"{tool_name}({json.dumps(arguments)})"
        self._output(action_text, TaskOutputType.ACTION)

        if self._tool_call_event_callback:
            await self._tool_call_event_callback(tool_name, arguments)

        tool = self.tools.get(tool_name)
        if not tool:
            # Put error result into context
            error_result = {"error": f"Unknown tool: {tool_name}"}
            properties = FunctionCallResultProperties(run_llm=False)
            await params.result_callback(error_result, properties=properties)
            error_text = self._timestamped_text(f"Unknown tool: {tool_name}")
            self._output(error_text, TaskOutputType.ERROR)
            logger.debug("TOOL_RESULT unknown tool={} arguments={}", tool_name, arguments)
            await self._on_tool_call_completed(tool_name, error_result)
            return

        # Check if this is an async tool that will deliver results via events
        expected_completion_event = ASYNC_TOOL_COMPLETIONS.get(tool_name)
        is_async_tool = expected_completion_event is not None

        if is_async_tool:
            # For async tools, put a placeholder result into context - actual data comes via events
            tool_result = {"status": "Executed."}
            properties = FunctionCallResultProperties(run_llm=False)
            await params.result_callback(tool_result, properties=properties)

            # Pre-set awaiting flag for async completion tools BEFORE any yield points.
            # This prevents race conditions where events arrive between tool completion
            # and _on_tool_call_completed setting the flag.
            self._awaiting_completion_event = expected_completion_event
            loop = asyncio.get_event_loop()
            self._completion_event_timeout = loop.call_later(
                ASYNC_COMPLETION_TIMEOUT,
                lambda: asyncio.create_task(self._on_completion_event_timeout()),
            )
            logger.debug(
                "Pre-set awaiting {} event for tool {} before execution",
                expected_completion_event,
                tool_name,
            )

        # For sync tools with events, pre-mark the event for skipping BEFORE execution
        # to prevent race condition where event arrives before tool call returns
        sync_event_to_skip: Optional[str] = None
        if tool_name in SYNC_TOOL_EVENTS:
            sync_event_to_skip = SYNC_TOOL_EVENTS[tool_name]
            self._skip_context_events[sync_event_to_skip] = (
                self._skip_context_events.get(sync_event_to_skip, 0) + 1
            )
            logger.debug(
                "Pre-marked {} event for context skip (tool={})",
                sync_event_to_skip,
                tool_name,
            )

        result_payload: Any = None
        error_payload: Optional[Any] = None
        try:
            self._tool_call_in_progress = True
            result = tool(**arguments)
            if inspect.isawaitable(result):
                result = await result
            result_payload = result
        except Exception as exc:
            # On error, clear the completion await since we'll handle error path
            if is_async_tool:
                self._awaiting_completion_event = None
                if self._completion_event_timeout:
                    self._completion_event_timeout.cancel()
                    self._completion_event_timeout = None
            # On error, also clear any sync tool event skip marker
            if sync_event_to_skip and sync_event_to_skip in self._skip_context_events:
                self._skip_context_events[sync_event_to_skip] -= 1
                if self._skip_context_events[sync_event_to_skip] <= 0:
                    del self._skip_context_events[sync_event_to_skip]
            error_payload = {"error": f"{exc}"}
        finally:
            self._tool_call_in_progress = False

        if error_payload is not None:
            if not is_async_tool:
                # For sync tools with errors, put error result into context
                properties = FunctionCallResultProperties(run_llm=False)
                await params.result_callback(error_payload, properties=properties)
            logger.debug(
                "TOOL_RESULT error tool={} arguments={} payload={}",
                tool_name,
                arguments,
                error_payload,
            )
            await self._on_tool_call_completed(tool_name, error_payload)
            return

        if not is_async_tool:
            # For sync tools, put actual result into context so LLM sees the data
            properties = FunctionCallResultProperties(run_llm=False)
            await params.result_callback(result_payload, properties=properties)

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
        # Cancel no-tool watchdog since inference is happening
        if self._no_tool_watchdog_handle:
            self._no_tool_watchdog_handle.cancel()
            self._no_tool_watchdog_handle = None

        # Reset nudge count - LLM gets a fresh chance to respond
        # (only reset if this inference was triggered by events, not by a nudge)
        if "no_tool_nudge" not in reasons_snapshot:
            self._no_tool_nudge_count = 0

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

            # Check if this tool has an expected async completion event.
            # Note: _awaiting_completion_event may already be set by _handle_function_call
            # to prevent race conditions. Only set up the await if not already configured.
            expected_event = ASYNC_TOOL_COMPLETIONS.get(tool_name)
            if expected_event:
                # Check if we already have the completion event in pending reasons
                already_received = any(expected_event in r for r in self._inference_reasons)
                if already_received:
                    # Completion event already arrived, clear any pre-set await state
                    if self._awaiting_completion_event == expected_event:
                        self._awaiting_completion_event = None
                        if self._completion_event_timeout:
                            self._completion_event_timeout.cancel()
                            self._completion_event_timeout = None
                elif self._awaiting_completion_event == expected_event:
                    # Already set up by _handle_function_call, just log and defer
                    logger.debug(
                        "Deferring inference until {} event arrives (tool={}, pre-configured)",
                        expected_event,
                        tool_name,
                    )
                    return  # Don't schedule inference yet
                elif not self._awaiting_completion_event:
                    # Not pre-configured, set it up now (fallback for tools not going through _handle_function_call)
                    self._awaiting_completion_event = expected_event
                    loop = asyncio.get_event_loop()
                    self._completion_event_timeout = loop.call_later(
                        ASYNC_COMPLETION_TIMEOUT,
                        lambda: asyncio.create_task(self._on_completion_event_timeout()),
                    )
                    logger.debug(
                        "Deferring inference until {} event arrives (tool={})",
                        expected_event,
                        tool_name,
                    )
                    return  # Don't schedule inference yet

            await self._schedule_pending_inference()
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"Failed to continue inference after tool result: {exc}")

    async def _on_completion_event_timeout(self) -> None:
        """Called if expected completion event doesn't arrive in time."""
        if self._awaiting_completion_event:
            logger.warning(
                "Timeout waiting for {} event, proceeding with inference",
                self._awaiting_completion_event,
            )
            self._awaiting_completion_event = None
            self._completion_event_timeout = None
            await self._schedule_pending_inference()

    async def _queue_pending_run_now(self) -> None:
        if self._llm_inflight:
            logger.debug("LLM inflight; not queuing inference.")
            return
        await self._schedule_pending_inference()

    async def _handle_no_tool_response(self) -> None:
        """Handle LLM response that had no tool calls.

        Starts a watchdog timer to wait for events before nudging the LLM.
        This allows events to accumulate in context before prompting for action.
        """
        if self.finished or self.cancelled:
            return
        if not self._active_pipeline_task or self._active_pipeline_task.has_finished():
            return

        # Don't start another watchdog if one is already running
        if self._no_tool_watchdog_handle is not None:
            return

        logger.debug(
            "No tool calls in response. Starting {:.1f}s watchdog for events.",
            NO_TOOL_WATCHDOG_DELAY,
        )
        loop = asyncio.get_running_loop()
        self._no_tool_watchdog_handle = loop.call_later(
            NO_TOOL_WATCHDOG_DELAY,
            self._no_tool_watchdog_fire,
        )

    def _no_tool_watchdog_fire(self) -> None:
        """Called when no-tool watchdog expires. Nudges the LLM to make a tool call."""
        self._no_tool_watchdog_handle = None

        if self.finished or self.cancelled:
            return
        if not self._active_pipeline_task or self._active_pipeline_task.has_finished():
            return

        self._no_tool_nudge_count += 1

        # If we've nudged too many times, force finish the task
        if self._no_tool_nudge_count > MAX_NO_TOOL_NUDGES:
            logger.warning(
                "LLM failed to call tools after {} nudges, forcing task completion",
                self._no_tool_nudge_count,
            )
            self.finished = True
            self.finished_message = "Task stopped: LLM failed to call required tools"
            finished_text = self._timestamped_text(self.finished_message)
            self._output(finished_text, TaskOutputType.FINISHED)
            asyncio.create_task(self._active_pipeline_task.queue_frames([EndFrame()]))
            return

        # Add a nudge message to the context
        nudge_message = {
            "role": "user",
            "content": (
                "You did not call any tools in your last response. "
                "If the task is complete, call the `finished` tool with a summary message. "
                "If more work is needed, call the appropriate tool to continue."
            ),
        }
        if self._context is not None:
            self._context.add_message(nudge_message)
        else:
            self.add_message(nudge_message)

        logger.debug(
            "No-tool watchdog fired. Added nudge message (attempt {}/{})",
            self._no_tool_nudge_count,
            MAX_NO_TOOL_NUDGES,
        )
        self._record_inference_reason("no_tool_nudge")

        # Schedule inference asynchronously
        async def _run_inference() -> None:
            try:
                await self._schedule_pending_inference()
            except Exception as exc:
                logger.warning(f"Failed to schedule inference after no-tool nudge: {exc}")

        asyncio.create_task(_run_inference())
