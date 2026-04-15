"""Voice agent.

LLMAgent that handles the player's voice conversation. Receives frames from
MainAgent via the bus, runs an LLM pipeline, and sends responses back.

Owns request ID tracking, deferred event batching, and task lifecycle.
Task management state is derived from child TaskAgent instances and the
framework's _task_groups dict. Implements the TaskStateProvider protocol
so EventRelay can query task state during event routing.
"""

from __future__ import annotations

import asyncio
from dataclasses import replace
import functools
import os
import re
import time
import uuid
from collections import deque
from typing import TYPE_CHECKING, Any, Callable, Dict, Optional, Tuple

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    FunctionCallResultProperties,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMMessagesAppendFrame,
    LLMRunFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.processors.frameworks.rtvi import RTVIProcessor, RTVIServerMessageFrame
from pipecat.services.llm_service import FunctionCallParams

from gradientbang.pipecat_server.frames import TaskActivityFrame
from gradientbang.pipecat_server.subagents.bus_messages import (
    BusGameEventMessage,
    BusSteerTaskMessage,
)
from gradientbang.pipecat_server.subagents.event_relay import EventRelay
from gradientbang.pipecat_server.subagents.task_agent import TaskAgent
from gradientbang.subagents.agents import LLMAgent, TaskStatus
from gradientbang.subagents.bus import (
    AgentBus,
    BusEndAgentMessage,
    BusTaskResponseMessage,
    BusTaskUpdateMessage,
)
from gradientbang.tools import VOICE_TOOLS
from gradientbang.utils.llm_factory import create_llm_service, get_voice_llm_config
from gradientbang.utils.supabase_client import AsyncGameClient
from gradientbang.utils.weave_tracing import traced

if TYPE_CHECKING:
    from pipecat.services.llm_service import LLMService

# ── Constants ─────────────────────────────────────────────────────────────

MAX_CORP_SHIP_TASKS = 3
MAX_PERSONAL_SHIP_TASKS = 1
REQUEST_ID_CACHE_TTL_SECONDS = 15 * 60
REQUEST_ID_CACHE_MAX_SIZE = 5000
TASK_RESPONSE_COOLDOWN_SECONDS = 1.5
TASK_RESPONSE_SPEECH_START_GRACE_SECONDS = 0.75

_UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)


# ── VoiceAgent ────────────────────────────────────────────────────────────


class VoiceAgent(LLMAgent):
    """Voice conversation agent for the player.

    Runs its own LLM pipeline (bridged to MainAgent's transport via the bus).
    Game tools use FunctionSchema from the shared tools module. Task management
    state is derived from child TaskAgent instances and the framework's
    _task_groups dict. Implements the TaskStateProvider protocol for EventRelay.
    """

    def __init__(
        self,
        name: str,
        *,
        bus: AgentBus,
        game_client: AsyncGameClient,
        character_id: str,
        rtvi_processor: RTVIProcessor,
        event_relay: Optional[EventRelay] = None,
    ):
        super().__init__(name, bus=bus, bridged=(), active=False)
        self.__game_client = game_client
        self.__character_id = character_id
        self._rtvi = rtvi_processor
        self._event_relay = event_relay

        # ── Task timeout ──
        _timeout = float(os.getenv("TASK_AGENT_TIMEOUT", 0))
        self._task_agent_timeout: float | None = _timeout if _timeout > 0 else None

        # ── Transient: holds (framework_task_id, payload) between add_agent and on_agent_ready ──
        self._pending_tasks: Dict[str, Tuple[str, dict]] = {}  # agent_name -> (task_id, payload)

        # ── Request ID tracking ──
        self._voice_agent_request_ids: Dict[str, float] = {}
        self._voice_agent_request_queue: deque[tuple[str, float]] = deque()

        # ── Coalesced context injection ──
        self._inject_run_pending: bool = False
        self._inject_run_task: Optional[asyncio.Task] = None

        # ── LLM response lifecycle ──
        self._llm_response_inflight: bool = False

        # ── Bot speaking state (for task response cooldown) ──
        self._bot_speaking: bool = False
        self._bot_stopped_speaking_at: float = 0.0

        # ── Assistant response lifecycle ──
        self._assistant_cycle_active: bool = False
        self._assistant_cycle_idle_event: asyncio.Event = asyncio.Event()
        self._assistant_cycle_idle_event.set()
        self._speech_start_grace_task: Optional[asyncio.Task] = None
        self._start_task_lock: asyncio.Lock = asyncio.Lock()
        self._locked_ships: set[str] = set()  # character_ids with an active task
        # Tracks task.finished messages received from the bus that are
        # waiting for on_task_response to deliver task.completed (after the
        # cycle-idle wait + cooldown). While > 0, on_idle_report skips firing
        # so the model doesn't narrate a premature "task is done" status and
        # then re-acknowledge when task.completed actually lands.
        self._task_completion_pending: int = 0

    # ── Lifecycle ───────────────────────────────────────────────────────

    async def on_activated(self, args: Optional[dict]) -> None:
        """Activate the LLM agent, then poke EventRelay to deliver any
        onboarding/session.start event that was deferred while we were inactive
        (e.g. during the scripted tutorial)."""
        await super().on_activated(args)
        if self._event_relay is not None:
            await self._event_relay._maybe_inject_onboarding()

    async def on_ready(self) -> None:
        """Register frame watchers for LLM response and bot speaking lifecycle."""
        await super().on_ready()
        self.pipeline_task.add_reached_downstream_filter(
            (LLMFullResponseStartFrame, LLMFullResponseEndFrame)
        )
        self.pipeline_task.add_reached_upstream_filter(
            (BotStartedSpeakingFrame, BotStoppedSpeakingFrame)
        )

        @self.pipeline_task.event_handler("on_frame_reached_downstream")
        async def _on_llm_response_lifecycle(task, frame):
            if isinstance(frame, LLMFullResponseStartFrame):
                self._handle_llm_response_started()
            elif isinstance(frame, LLMFullResponseEndFrame):
                self._handle_llm_response_ended()

        @self.pipeline_task.event_handler("on_frame_reached_upstream")
        async def _on_bot_speaking_lifecycle(task, frame):
            if isinstance(frame, BotStartedSpeakingFrame):
                self._handle_bot_started_speaking()
            elif isinstance(frame, BotStoppedSpeakingFrame):
                self._handle_bot_stopped_speaking()

    def _cancel_speech_start_grace_task(self) -> None:
        task = self._speech_start_grace_task
        if task and not task.done():
            task.cancel()
        self._speech_start_grace_task = None

    def _mark_assistant_cycle_active(self) -> None:
        self._assistant_cycle_active = True
        self._assistant_cycle_idle_event.clear()

    def _mark_assistant_cycle_idle(self) -> None:
        self._assistant_cycle_active = False
        self._assistant_cycle_idle_event.set()

    def _begin_assistant_response_cycle(self) -> None:
        self._cancel_speech_start_grace_task()
        self._mark_assistant_cycle_active()

    def _handle_llm_response_started(self) -> None:
        self._llm_response_inflight = True
        self._begin_assistant_response_cycle()

    def _handle_llm_response_ended(self) -> None:
        self._llm_response_inflight = False
        if self._bot_speaking:
            return
        self._start_speech_start_grace_timer()

    def _handle_bot_started_speaking(self) -> None:
        self._bot_speaking = True
        self._begin_assistant_response_cycle()

    def _handle_bot_stopped_speaking(self) -> None:
        self._bot_speaking = False
        self._cancel_speech_start_grace_task()
        self._bot_stopped_speaking_at = time.monotonic()
        self._mark_assistant_cycle_idle()

    def _start_speech_start_grace_timer(self) -> None:
        self._cancel_speech_start_grace_task()
        if TASK_RESPONSE_SPEECH_START_GRACE_SECONDS <= 0:
            self._mark_assistant_cycle_idle()
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            self._mark_assistant_cycle_idle()
            return
        self._speech_start_grace_task = loop.create_task(self._speech_start_grace_waiter())

    async def _speech_start_grace_waiter(self) -> None:
        try:
            await asyncio.sleep(TASK_RESPONSE_SPEECH_START_GRACE_SECONDS)
            if not self._bot_speaking and not self._llm_response_inflight:
                logger.debug(
                    "VoiceAgent: speech-start grace expired after {:.2f}s; marking assistant idle",
                    TASK_RESPONSE_SPEECH_START_GRACE_SECONDS,
                )
                self._mark_assistant_cycle_idle()
        except asyncio.CancelledError:
            return
        finally:
            if asyncio.current_task() is self._speech_start_grace_task:
                self._speech_start_grace_task = None

    @staticmethod
    def _task_mentions_session(task_desc: str) -> bool:
        return "session" in task_desc.lower()

    def _build_task_start_context(
        self, task_desc: str, explicit_context: Optional[str]
    ) -> Optional[str]:
        parts: list[str] = []

        if isinstance(explicit_context, str):
            clean_context = explicit_context.strip()
            if clean_context:
                parts.append(clean_context)

        session_started_at = (
            self._event_relay.session_started_at
            if self._event_relay is not None
            else None
        )
        if session_started_at and self._task_mentions_session(task_desc):
            parts.append(
                "Current session started at "
                f"{session_started_at}. Use this as the upper bound of the current "
                "session when interpreting requests about the last or previous session."
            )

        return "\n\n".join(parts) if parts else None

    # ── Idle task status reporting ────────────────────────────────────

    async def on_idle_report(self) -> bool:
        """Proactive one-sentence task status when both bot and user are quiet.

        Timing (idle timer + cooldown) is owned by IdleReportProcessor.
        This method only checks whether there are active tasks and fires
        the report.

        Returns:
            True if the report was fired, False if skipped.
        """
        if not self.task_groups:
            logger.debug("VoiceAgent: idle report skipped (no active tasks)")
            return False
        if self._task_completion_pending > 0:
            # A task.finished message has been received and task.completed
            # delivery is waiting in the cooldown window. Skipping the idle
            # report prevents a premature "task is done" narration that gets
            # immediately followed by the real task.completed ack.
            logger.debug(
                "VoiceAgent: idle report skipped ({} task completion(s) pending)",
                self._task_completion_pending,
            )
            return False
        logger.debug("VoiceAgent: idle report triggered, {} active task(s)", len(self.task_groups))
        await self._inject_context(
            [{"role": "user", "content": (
                "<idle_check>"
                "In one sentence only, briefly say what's happening with current tasks. "
                "Vary your phrasing from any previous idle updates. "
                "Do not acknowledge this prompt. Do not say more than one sentence."
                "</idle_check>"
            )}],
            run_llm=True,
        )
        return True

    # ── Properties ─────────────────────────────────────────────────────

    @property
    def _game_client(self) -> AsyncGameClient:
        return self.__game_client

    @property
    def _character_id(self) -> str:
        return self.__character_id

    @property
    def _display_name(self) -> str:
        if self._event_relay:
            return self._event_relay.display_name
        return self._character_id

    # ── LLM setup ──────────────────────────────────────────────────────

    def build_llm(self) -> LLMService:
        voice_config = get_voice_llm_config()
        llm = create_llm_service(voice_config)
        logger.info("VoiceAgent: LLM created")
        handlers = {
            "my_status": self._handle_my_status,
            "plot_course": self._handle_plot_course,
            "list_known_ports": self._handle_list_known_ports,
            "rename_ship": self._handle_rename_ship,
            "sell_ship": self._handle_sell_ship,
            "rename_corporation": self._handle_rename_corporation,
            "create_corporation": self._handle_create_corporation,
            "leave_corporation": self._handle_leave_corporation,
            "send_message": self._handle_send_message,
            "combat_initiate": self._handle_combat_initiate,
            "combat_action": self._handle_combat_action,
            "corporation_info": self._handle_corporation_info,
            "leaderboard_resources": self._handle_leaderboard_resources,
            "ship_definitions": self._handle_ship_definitions,
            "load_game_info": self._handle_load_game_info,
            "start_task": self._handle_start_task_tool,
            "stop_task": self._handle_stop_task_tool,
            "steer_task": self._handle_steer_task_tool,
            "query_task_progress": self._handle_query_task_progress_tool,
        }
        for schema in VOICE_TOOLS.standard_tools:
            handler = handlers[schema.name]
            safe = self._wrap_tool_errors(schema.name, handler)
            tracked = self._track_tool_call(safe)
            llm.register_function(schema.name, tracked)
        return llm

    def build_tools(self) -> list:
        return list(VOICE_TOOLS.standard_tools)

    # ══════════════════════════════════════════════════════════════════════
    # VOICE TOOLS — VoiceAgent executes these directly against the game
    # server. Request IDs are cached so EventRelay can link async game
    # events back to the tool call that caused them.
    # ══════════════════════════════════════════════════════════════════════

    # ── TaskStateProvider protocol ─────────────────────────────────────
    # EventRelay calls these to query task state during event routing.

    def is_recent_request_id(self, request_id: str) -> bool:
        if not isinstance(request_id, str) or not request_id.strip():
            return False
        self._prune_request_ids()
        return request_id in self._voice_agent_request_ids

    # ── Deferred frame processing ────────────────────────────────────

    async def process_deferred_tool_frames(
        self, frames: list[tuple[Frame, FrameDirection]]
    ) -> list[tuple[Frame, FrameDirection]]:
        # Deferred event-driven tool results still need one follow-up inference
        # once the real data is in context. Coalesce multiple deferred triggers
        # into a single run to avoid the duplicate-output regressions this path
        # was originally added to prevent. Task completions still bypass deferral
        # entirely via super().queue_frame().
        needs_inference = False
        for f, d in frames:
            if isinstance(f, LLMMessagesAppendFrame) and f.run_llm:
                needs_inference = True
                f.run_llm = False
        if needs_inference:
            frames.append((LLMRunFrame(), FrameDirection.DOWNSTREAM))
        return frames

    async def _inject_context(self, messages: list[dict], *, run_llm: bool = True) -> None:
        """Append context and coalesce a single follow-up LLM run when needed."""
        frame = LLMMessagesAppendFrame(messages=messages, run_llm=run_llm)

        if self.tool_call_active:
            await self.queue_frame(frame)
            return

        if run_llm:
            frame.run_llm = False
            await super().queue_frame(frame)
            if not self._inject_run_pending:
                self._inject_run_pending = True
                self._inject_run_task = self.create_asyncio_task(
                    self._emit_coalesced_run(), "inject_coalesced_run"
                )
            return

        await super().queue_frame(frame)

    async def _emit_coalesced_run(self) -> None:
        """Send a single LLMRunFrame after yielding to accumulate same-tick injections."""
        try:
            await asyncio.sleep(0)
            await super().queue_frame(LLMRunFrame())
        except asyncio.CancelledError:
            return
        finally:
            self._inject_run_pending = False
            self._inject_run_task = None

    # ── Request ID tracking ────────────────────────────────────────────

    def _prune_request_ids(self, now: Optional[float] = None) -> None:
        if now is None:
            now = time.monotonic()
        cutoff = now - REQUEST_ID_CACHE_TTL_SECONDS
        while self._voice_agent_request_queue:
            req_id, ts = self._voice_agent_request_queue[0]
            current = self._voice_agent_request_ids.get(req_id)
            if current is not None and current != ts:
                self._voice_agent_request_queue.popleft()
                continue
            if len(self._voice_agent_request_ids) > REQUEST_ID_CACHE_MAX_SIZE or ts < cutoff:
                self._voice_agent_request_queue.popleft()
                if current == ts:
                    self._voice_agent_request_ids.pop(req_id, None)
                continue
            break

    def track_request_id(self, request_id: Optional[str]) -> None:
        if not isinstance(request_id, str):
            return
        cleaned = request_id.strip()
        if not cleaned:
            return
        now = time.monotonic()
        self._voice_agent_request_ids[cleaned] = now
        self._voice_agent_request_queue.append((cleaned, now))
        self._prune_request_ids(now)

    def _track_request_id_from_result(self, result: dict) -> None:
        req_id = result.get("request_id") if isinstance(result, dict) else None
        if req_id:
            self.track_request_id(req_id)

    async def _queue_task_completion_event(self, event_xml: str) -> None:
        await super().queue_frame(
            LLMMessagesAppendFrame(messages=[{"role": "user", "content": event_xml}], run_llm=True)
        )

    def _has_active_player_task(self) -> bool:
        return self._character_id in self._locked_ships

    def _should_suppress_my_status_error(self, exc: Exception) -> bool:
        message = str(exc).lower()
        return "hyperspace" in message and self._has_active_player_task()

    async def _finish_event_tool_with_error(
        self, params: FunctionCallParams, exc: Exception, *, run_llm: bool
    ) -> None:
        if run_llm:
            self._begin_assistant_response_cycle()
        await params.result_callback(
            {"error": str(exc)},
            properties=FunctionCallResultProperties(run_llm=run_llm),
        )

    def _wrap_tool_errors(self, tool_name: str, handler: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(handler)
        async def wrapped(params: FunctionCallParams, *args, **kwargs):
            result_callback_called = False
            original_result_callback = params.result_callback

            async def tracked_result_callback(*cb_args, **cb_kwargs):
                nonlocal result_callback_called
                result_callback_called = True
                return await original_result_callback(*cb_args, **cb_kwargs)

            wrapped_params = replace(params, result_callback=tracked_result_callback)

            try:
                return await handler(wrapped_params, *args, **kwargs)
            except Exception as exc:
                logger.exception("VoiceAgent: tool '{}' failed", tool_name)
                if result_callback_called:
                    return None
                self._begin_assistant_response_cycle()
                try:
                    await original_result_callback(
                        {"error": str(exc)},
                        properties=FunctionCallResultProperties(run_llm=True),
                    )
                except Exception:
                    logger.exception(
                        "VoiceAgent: failed to resolve tool '{}' after exception",
                        tool_name,
                    )
                return None

        return wrapped

    # ── Event-generating tools ─────────────────────────────────────────
    # Return ack with run_llm=False. Real data arrives via game event.
    # On error, call result_callback with the error so the spinner clears.

    async def _handle_my_status(self, params: FunctionCallParams):
        try:
            result = await self._game_client.my_status(character_id=self._character_id)
            self._track_request_id_from_result(result)
            await params.result_callback(
                {"status": "Executed."},
                properties=FunctionCallResultProperties(run_llm=False),
            )
        except Exception as exc:
            await self._finish_event_tool_with_error(
                params,
                exc,
                run_llm=not self._should_suppress_my_status_error(exc),
            )

    async def _handle_plot_course(self, params: FunctionCallParams):
        args = params.arguments
        try:
            result = await self._game_client.plot_course(
                to_sector=args["to_sector"],
                character_id=self._character_id,
                from_sector=args.get("from_sector"),
            )
            self._track_request_id_from_result(result)
            await params.result_callback(
                {"status": "Executed."},
                properties=FunctionCallResultProperties(run_llm=False),
            )
        except Exception as exc:
            await self._finish_event_tool_with_error(params, exc, run_llm=True)

    async def _handle_rename_ship(self, params: FunctionCallParams):
        args = params.arguments
        try:
            result = await self._game_client.rename_ship(
                ship_name=args["ship_name"],
                ship_id=args.get("ship_id"),
                character_id=self._character_id,
            )
            self._track_request_id_from_result(result)
            await params.result_callback(
                {"status": "Executed."},
                properties=FunctionCallResultProperties(run_llm=False),
            )
        except Exception as exc:
            await self._finish_event_tool_with_error(params, exc, run_llm=True)

    async def _handle_sell_ship(self, params: FunctionCallParams):
        args = params.arguments
        if self._has_active_player_task():
            self._begin_assistant_response_cycle()
            await params.result_callback(
                {"error": "Cannot sell a ship while a task is running. Stop the task first."},
                properties=FunctionCallResultProperties(run_llm=True),
            )
            return
        try:
            result = await self._game_client.sell_ship(
                ship_id=args["ship_id"],
                character_id=self._character_id,
            )
            self._track_request_id_from_result(result)
            self._begin_assistant_response_cycle()
            await params.result_callback(
                {
                    "success": True,
                    "trade_in_value": result.get("trade_in_value"),
                    "credits_after": result.get("credits_after"),
                },
                properties=FunctionCallResultProperties(run_llm=True),
            )
        except Exception as exc:
            await self._finish_event_tool_with_error(params, exc, run_llm=True)

    async def _handle_rename_corporation(self, params: FunctionCallParams):
        args = params.arguments
        try:
            result = await self._game_client.rename_corporation(
                name=args["name"],
                character_id=self._character_id,
            )
            self._track_request_id_from_result(result)
            self._begin_assistant_response_cycle()
            await params.result_callback(
                {"success": True},
                properties=FunctionCallResultProperties(run_llm=True),
            )
        except Exception as exc:
            await self._finish_event_tool_with_error(params, exc, run_llm=True)

    async def _handle_create_corporation(self, params: FunctionCallParams):
        args = params.arguments
        try:
            result = await self._game_client.create_corporation(
                name=args["name"],
                character_id=self._character_id,
            )
            self._track_request_id_from_result(result)
            self._begin_assistant_response_cycle()
            await params.result_callback(
                {"success": True},
                properties=FunctionCallResultProperties(run_llm=True),
            )
        except Exception as exc:
            await self._finish_event_tool_with_error(params, exc, run_llm=True)

    async def _handle_leave_corporation(self, params: FunctionCallParams):
        try:
            result = await self._game_client.leave_corporation(
                character_id=self._character_id,
            )
            self._track_request_id_from_result(result)
            self._begin_assistant_response_cycle()
            await params.result_callback(
                {"success": True},
                properties=FunctionCallResultProperties(run_llm=True),
            )
        except Exception as exc:
            await self._finish_event_tool_with_error(params, exc, run_llm=True)

    # ── Fire-and-forget tools ──────────────────────────────────────────

    async def _handle_send_message(self, params: FunctionCallParams):
        args = params.arguments
        try:
            result = await self._game_client.send_message(
                content=args["content"],
                msg_type=args.get("msg_type", "broadcast"),
                to_name=args.get("to_player"),
                to_ship_id=args.get("to_ship_id"),
                to_ship_name=args.get("to_ship_name"),
                character_id=self._character_id,
            )
            self._track_request_id_from_result(result)
            self._begin_assistant_response_cycle()
            await params.result_callback(
                {"status": "Executed."},
                properties=FunctionCallResultProperties(run_llm=True),
            )
        except Exception as exc:
            await self._finish_event_tool_with_error(params, exc, run_llm=True)

    async def _handle_combat_initiate(self, params: FunctionCallParams):
        args = params.arguments
        try:
            result = await self._game_client.combat_initiate(
                character_id=self._character_id,
                target_id=args.get("target_id"),
                target_type=args.get("target_type", "character"),
            )
            self._track_request_id_from_result(result)
            await params.result_callback(
                {"status": "Executed."},
                properties=FunctionCallResultProperties(run_llm=False),
            )
        except Exception as exc:
            await self._finish_event_tool_with_error(params, exc, run_llm=True)

    async def _handle_combat_action(self, params: FunctionCallParams):
        args = params.arguments
        try:
            result = await self._game_client.combat_action(
                combat_id=args["combat_id"],
                action=str(args["action"]).lower(),
                commit=args.get("commit", 0),
                target_id=args.get("target_id"),
                to_sector=args.get("to_sector"),
                round_number=args.get("round_number"),
                character_id=self._character_id,
            )
            self._track_request_id_from_result(result)
            await params.result_callback(
                {"status": "Executed."},
                properties=FunctionCallResultProperties(run_llm=False),
            )
        except Exception as exc:
            await self._finish_event_tool_with_error(params, exc, run_llm=True)

    # ── Direct-response tools ──────────────────────────────────────────

    async def _handle_corporation_info(self, params: FunctionCallParams):
        from gradientbang.utils.formatting import summarize_corporation_info

        args = params.arguments
        if args.get("list_all"):
            result = await self._game_client._request("corporation_list", {})
        else:
            result = await self._game_client._request(
                "my_corporation", {"character_id": self._character_id}
            )
        summary = summarize_corporation_info(result)
        self._begin_assistant_response_cycle()
        await params.result_callback({"summary": summary})

    async def _handle_leaderboard_resources(self, params: FunctionCallParams):
        from gradientbang.utils.formatting import summarize_leaderboard

        args = params.arguments
        result = await self._game_client.leaderboard_resources(
            character_id=self._character_id,
            force_refresh=args.get("force_refresh", False),
        )
        summary = summarize_leaderboard(result, player_id=self._character_id)
        self._begin_assistant_response_cycle()
        if not summary:
            await params.result_callback(
                {
                    "error": "Leaderboard data is unavailable or too large to summarize safely."
                }
            )
            return
        await params.result_callback({"summary": summary})

    async def _handle_ship_definitions(self, params: FunctionCallParams):
        from gradientbang.utils.formatting import summarize_ship_definitions

        result = await self._game_client.get_ship_definitions(
            include_description=True
        )
        definitions = result.get("definitions", result)
        summary = summarize_ship_definitions(definitions)
        self._begin_assistant_response_cycle()
        await params.result_callback({"summary": summary})

    async def _handle_list_known_ports(self, params: FunctionCallParams):
        # Direct-response tool: the edge function returns the full payload
        # inline, so we format it and hand it straight to the LLM. The matching
        # ports.list event is dropped from voice context in event_relay.py
        # (AppendRule.NEVER) to avoid duplicating the data.
        from gradientbang.utils.summary_formatters import list_known_ports_summary

        args = params.arguments
        kwargs = {}
        for key in ("from_sector", "max_hops", "port_type", "commodity", "trade_type", "mega"):
            if args.get(key) is not None:
                kwargs[key] = args[key]

        result = await self._game_client.list_known_ports(
            character_id=self._character_id, **kwargs
        )
        summary = list_known_ports_summary(result)
        self._begin_assistant_response_cycle()
        await params.result_callback({"summary": summary})

    async def _handle_load_game_info(self, params: FunctionCallParams):
        from gradientbang.utils.prompt_loader import AVAILABLE_TOPICS, load_fragment

        topic = str(params.arguments.get("topic", "")).strip()
        if topic not in AVAILABLE_TOPICS:
            self._begin_assistant_response_cycle()
            await params.result_callback(
                {
                    "success": False,
                    "error": f"Unknown topic: {topic}. Available: {', '.join(AVAILABLE_TOPICS)}",
                }
            )
            return
        try:
            content = load_fragment(topic)
            self._begin_assistant_response_cycle()
            await params.result_callback({"success": True, "topic": topic, "content": content})
        except FileNotFoundError as exc:
            self._begin_assistant_response_cycle()
            await params.result_callback({"success": False, "error": str(exc)})

    # ══════════════════════════════════════════════════════════════════════
    # TASK SUBAGENT MANAGEMENT — VoiceAgent spawns TaskAgent children and
    # manages their lifecycle via the bus protocol. These tools control
    # subagents, they don't call the game server directly.
    # ══════════════════════════════════════════════════════════════════════

    # ── Game event distribution ─────────────────────────────────────────

    async def broadcast_game_event(
        self, event: Dict[str, Any], *, voice_agent_originated: bool = False
    ) -> None:
        """Broadcast a game event to the bus for TaskAgent children."""
        await self.send_message(
            BusGameEventMessage(
                source=self.name, event=event, voice_agent_originated=voice_agent_originated
            )
        )

        event_name = event.get("event_name")

        # Cancel player ship tasks when the player enters combat.
        # Corp ship tasks continue running — they're independent.
        if event_name == "combat.round_waiting":
            payload = event.get("payload")
            if isinstance(payload, dict) and self._is_player_combat_participant(payload):
                await self._cancel_player_tasks_for_combat()

        # Client-initiated task cancel: convert game event into bus-level cancel.
        elif event_name == "task.cancel":
            payload = event.get("payload")
            if isinstance(payload, dict):
                game_task_id = payload.get("task_id")
                if game_task_id:
                    await self._cancel_task_by_game_id(game_task_id)

    def _is_player_combat_participant(self, payload: dict) -> bool:
        """Check if our character is listed in the combat participants."""
        participants = payload.get("participants")
        if isinstance(participants, list):
            for p in participants:
                if isinstance(p, dict) and p.get("id") == self._character_id:
                    return True
        return False

    async def _cancel_player_tasks_for_combat(self) -> None:
        """Cancel all active player ship tasks (not corp ship tasks)."""
        player_task_agents = {
            c.name for c in self.children if isinstance(c, TaskAgent) and not c._is_corp_ship
        }
        if not player_task_agents:
            return
        for tid, group in list(self._task_groups.items()):
            if group.agent_names & player_task_agents:
                try:
                    await self.cancel_task(tid, reason="Combat started")
                    logger.info(f"Cancelled player task group {tid} for combat")
                except Exception as e:
                    logger.error(f"Failed to cancel task group {tid} for combat: {e}")

    async def _cancel_task_by_game_id(self, game_task_id: str) -> None:
        """Cancel a task identified by its game-level task_id."""
        child = next(
            (
                c
                for c in self.children
                if isinstance(c, TaskAgent) and c._active_task_id == game_task_id
            ),
            None,
        )
        if not child:
            return
        for tid, group in list(self._task_groups.items()):
            if child.name in group.agent_names:
                try:
                    await self.cancel_task(tid, reason="Cancelled by client")
                    logger.info(
                        f"Cancelled task {tid} (game_task_id={game_task_id[:8]}) via client cancel"
                    )
                except Exception as e:
                    logger.error(f"Failed to cancel task {tid} via client cancel: {e}")
                return

    def is_our_task(self, task_id: str) -> bool:
        """Check if a task_id belongs to one of our active task groups."""
        return task_id in self._task_groups

    # ── Child agent helpers ───────────────────────────────────────────

    def _find_task_agent_by_task_id(
        self, task_id: str
    ) -> Optional[Tuple[str, TaskAgent]]:
        """Resolve an active task to (framework_task_id, TaskAgent child).

        Accepts the framework/game task UUID — full form or any unique
        prefix (the LLM commonly receives the 8-char prefix in events such
        as ``task.completed task_id="ff3fa419"``). Returns ``None`` if no
        active task group matches.
        """
        cleaned = task_id.strip()
        if not cleaned:
            return None

        matches = [
            (tid, group)
            for tid, group in self._task_groups.items()
            if tid == cleaned or tid.startswith(cleaned)
        ]
        if not matches:
            return None
        # Prefer exact match over prefix match.
        matches.sort(key=lambda kv: 0 if kv[0] == cleaned else 1)
        framework_task_id, group = matches[0]
        for name in group.agent_names:
            child = next(
                (c for c in self.children if isinstance(c, TaskAgent) and c.name == name),
                None,
            )
            if child:
                return framework_task_id, child
        return None

    def _count_active_corp_tasks(self) -> int:
        return sum(1 for c in self.children if isinstance(c, TaskAgent) and c._is_corp_ship)

    def active_tasks_summary(self) -> str:
        """One-line summary of current task slot usage for LLM context."""
        personal = 1 if self._has_active_player_task() else 0
        corp = self._count_active_corp_tasks()
        return (
            f"Active tasks: {personal}/{MAX_PERSONAL_SHIP_TASKS} personal, "
            f"{corp}/{MAX_CORP_SHIP_TASKS} corp."
        )

    def _update_polling_scope(self) -> None:
        """Derive corp ship IDs from children and update game_client polling."""
        ship_ids = sorted(
            {c._character_id for c in self.children if isinstance(c, TaskAgent) and c._is_corp_ship}
        )
        self._game_client.set_event_polling_scope(
            character_ids=[self._character_id],
            corp_id=self._game_client.corporation_id,
            ship_ids=ship_ids,
        )

    def _get_task_type(self, ship_id: Optional[str]) -> str:
        if ship_id and ship_id != self._character_id:
            return "corp_ship"
        return "player_ship"

    @staticmethod
    def _is_valid_uuid(value: str) -> bool:
        return bool(_UUID_PATTERN.match(value))

    async def _resolve_ship_id_prefix(self, prefix: str) -> Optional[str]:
        if not isinstance(prefix, str):
            return None
        cleaned = prefix.strip().strip("[]").lower()
        if not cleaned:
            return None
        if self._is_valid_uuid(cleaned):
            return cleaned
        try:
            corp_result = await self._game_client._request(
                "my_corporation",
                {"character_id": self._character_id},
            )
        except Exception as exc:
            logger.error(f"Failed to resolve ship_id prefix: {exc}")
            return None
        corp = corp_result.get("corporation")
        if not isinstance(corp, dict):
            return None
        ships = corp.get("ships")
        if not isinstance(ships, list):
            return None
        matches = []
        for ship in ships:
            if not isinstance(ship, dict):
                continue
            ship_id = ship.get("ship_id")
            if isinstance(ship_id, str) and ship_id.lower().startswith(cleaned):
                matches.append(ship_id)
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise ValueError(
                f"Ambiguous ship_id prefix '{cleaned}' matches {len(matches)} ships. "
                "Use a longer prefix."
            )
        return None

    async def _is_corp_ship_id(self, ship_id: str) -> bool:
        """Check if a ship_id belongs to a corporation ship (not the player's personal ship)."""
        try:
            corp_result = await self._game_client._request(
                "my_corporation",
                {"character_id": self._character_id},
            )
        except Exception as exc:
            logger.error(f"Failed to check corp ship: {exc}")
            # Default to treating as corp ship if we can't verify
            return True
        corp = corp_result.get("corporation")
        if not isinstance(corp, dict):
            return False
        ships = corp.get("ships")
        if not isinstance(ships, list):
            return False
        return any(isinstance(s, dict) and s.get("ship_id") == ship_id for s in ships)

    # ── Agent lifecycle ────────────────────────────────────────────────

    async def on_agent_ready(self, data) -> None:
        await super().on_agent_ready(data)
        pending = self._pending_tasks.pop(data.agent_name, None)
        if pending:
            framework_task_id, payload = pending
            await self.request_task(
                data.agent_name,
                payload=payload,
                task_id=framework_task_id,
                timeout=self._task_agent_timeout,
            )
            self._update_polling_scope()
            logger.info("VoiceAgent: task agent '{}' ready, dispatched task", data.agent_name)

    # ── Bus task protocol ─────────────────────────────────────────────

    async def on_task_update(self, message: BusTaskUpdateMessage) -> None:
        await super().on_task_update(message)
        update = message.update
        if not update:
            return
        update_type = update.get("type")

        if update_type == "progress_report":
            summary = update.get("summary", "No update available.")
            event_xml = (
                f'<event name="task.progress" task_id="{message.task_id[:8]}">\n{summary}\n</event>'
            )
            await self.queue_frame(
                LLMMessagesAppendFrame(
                    messages=[{"role": "user", "content": event_xml}], run_llm=True
                )
            )
        elif update_type == "output":
            text = update.get("text", "")
            message_type = update.get("message_type")
            # Get task_type from the child agent
            child = next(
                (c for c in self.children if isinstance(c, TaskAgent) and c.name == message.source),
                None,
            )
            task_type = "corp_ship" if child and child._is_corp_ship else "player_ship"
            await self._task_output_handler(text, message_type, message.task_id, task_type)

    async def on_task_response(self, message: BusTaskResponseMessage) -> None:
        await super().on_task_response(message)

        agent_name = message.source
        child = next(
            (c for c in self.children if isinstance(c, TaskAgent) and c.name == agent_name), None
        )
        task_type = "corp_ship" if child and child._is_corp_ship else "player_ship"
        is_corp = child._is_corp_ship if child else False

        if message.status == TaskStatus.COMPLETED:
            await self._task_output_handler(
                "Task completed successfully", "complete", message.task_id, task_type
            )
            status_label = "completed"
        elif message.status == TaskStatus.CANCELLED:
            await self._task_output_handler(
                "Task was cancelled", "cancelled", message.task_id, task_type
            )
            status_label = "cancelled"
        else:
            fail_msg = (message.response or {}).get("message", "Task failed")
            await self._task_output_handler(fail_msg, "failed", message.task_id, task_type)
            status_label = "failed"

        # Notify the LLM so it can inform the user (use response.message for detail)
        llm_msg = (message.response or {}).get("message", f"Task {status_label}")
        event_xml = (
            f'<event name="task.{status_label}" task_id="{message.task_id[:8]}" '
            f'task_type="{task_type}">\n{llm_msg}\n</event>'
        )

        # Wait for the full response cycle (tool call → LLM response → bot speech)
        # before delivering task completion. Uses super().queue_frame() to bypass
        # LLMAgent's defer_tool_frames mechanism which would coalesce the task
        # completion into the tool result's inference.
        # While we're waiting for the cycle + cooldown, on_idle_report must
        # not fire — otherwise the model narrates a premature "task is done"
        # status and then re-acknowledges when task.completed actually lands.
        self._task_completion_pending += 1
        try:
            while self.tool_call_active:
                await asyncio.sleep(0.05)

            if self._assistant_cycle_active:
                logger.debug("VoiceAgent: waiting for assistant response cycle to go idle")
            await self._assistant_cycle_idle_event.wait()

            elapsed = time.monotonic() - self._bot_stopped_speaking_at
            remaining = TASK_RESPONSE_COOLDOWN_SECONDS - elapsed
            if remaining > 0:
                logger.debug(
                    "VoiceAgent: cooling down {:.2f}s before task response inference",
                    remaining,
                )
                await asyncio.sleep(remaining)

            await self._queue_task_completion_event(event_xml)
        finally:
            self._task_completion_pending -= 1

        # Release ship lock (both player and corp)
        ship_character_id = child._character_id if child else None
        if ship_character_id:
            self._locked_ships.discard(ship_character_id)

        # Corp ship agents: end pipeline, remove from children, close client.
        # Player agents: keep alive for reuse — pipeline stays running.
        if child and child._is_corp_ship:
            try:
                await self.send_message(
                    BusEndAgentMessage(source=self.name, target=agent_name, reason="task complete")
                )
            except Exception as e:
                logger.error(f"Failed to end task agent '{agent_name}': {e}")
            self._children = [c for c in self._children if c.name != agent_name]
            if child._game_client != self._game_client:
                try:
                    await child._game_client.close()
                except Exception as e:
                    logger.error(f"Failed to close task game client: {e}")

        self._update_polling_scope()

    # ── Task output handling ───────────────────────────────────────────

    async def _task_output_handler(
        self,
        text: str,
        message_type: Optional[str] = None,
        task_id: Optional[str] = None,
        task_type: str = "player_ship",
    ) -> None:
        await self._rtvi.push_frame(
            RTVIServerMessageFrame(
                data={
                    "frame_type": "event",
                    "event": "task_output",
                    "task_id": task_id,
                    "task_type": task_type,
                    "payload": {
                        "text": text,
                        "task_message_type": message_type,
                    },
                }
            )
        )
        await self._rtvi.push_frame(
            TaskActivityFrame(task_id=task_id or "", activity_type="output")
        )

    # ── Task tool handlers ────────────────────────────────────────────

    @traced
    async def _handle_start_task(self, params: FunctionCallParams) -> dict:
        async with self._start_task_lock:
            task_game_client = None
            agent_name = None
            target_character_id = None
            try:
                task_desc = params.arguments.get("task_description", "")
                explicit_context = params.arguments.get("context")
                ship_id = params.arguments.get("ship_id")

                if isinstance(ship_id, str):
                    ship_id = ship_id.strip().strip("[]")

                if ship_id and not self._is_valid_uuid(ship_id):
                    try:
                        resolved = await self._resolve_ship_id_prefix(ship_id)
                    except ValueError as exc:
                        return {"success": False, "error": str(exc)}
                    if not resolved:
                        return {"success": False, "error": f"Unknown ship_id '{ship_id}'."}
                    ship_id = resolved

                # If ship_id is the player's character_id, or resolves to their
                # personal ship rather than a corp ship, treat as a player task.
                if ship_id:
                    if ship_id == self._character_id:
                        ship_id = None
                    elif not await self._is_corp_ship_id(ship_id):
                        logger.info(
                            f"ship_id {ship_id[:8]} is not a corp ship, treating as player task"
                        )
                        ship_id = None

                target_character_id = ship_id if ship_id else self._character_id

                # If this ship already has an active task, route the new
                # instruction into the existing steering path instead of
                # starting a fresh task. This preserves in-flight progress
                # (navigation, trade, combat) and reuses the BusSteerTaskMessage
                # primitive the `steer_task` tool uses.
                if target_character_id in self._locked_ships:
                    active_child = next(
                        (
                            c for c in self.children
                            if isinstance(c, TaskAgent)
                            and c._character_id == target_character_id
                            and c._active_task_id
                        ),
                        None,
                    )
                    active_task_id = None
                    if active_child is not None:
                        active_task_id = next(
                            (
                                tid for tid, group in self._task_groups.items()
                                if active_child.name in group.agent_names
                            ),
                            None,
                        )
                    if active_child is not None and active_task_id is not None:
                        steer_text = task_desc
                        if isinstance(explicit_context, str) and explicit_context.strip():
                            steer_text = f"{task_desc}\n\nContext: {explicit_context.strip()}"
                        return await self._steer_existing_task(
                            active_task_id,
                            active_child,
                            steer_text,
                            summary="Task already running; steered with new instructions.",
                        )
                    # Lock is held but we can't resolve the child (race between
                    # lock release and task_group cleanup). Surface the old
                    # error rather than silently swallowing the request.
                    return {
                        "success": False,
                        "error": f"Ship {target_character_id[:8]}... already has a task running. Stop it first.",
                    }

                # Corp ship limit
                if ship_id:
                    corp_count = self._count_active_corp_tasks()
                    if corp_count >= MAX_CORP_SHIP_TASKS:
                        return {
                            "success": False,
                            "error": f"Cannot start more than {MAX_CORP_SHIP_TASKS} corp ship tasks.",
                        }

                task_type = self._get_task_type(ship_id)
                task_metadata = {
                    "actor_character_id": self._character_id,
                    "actor_character_name": self._display_name,
                    "task_scope": task_type,
                    "ship_id": ship_id if ship_id else None,
                    "actor_ship_id": (
                        self._event_relay.actor_ship_id if self._event_relay else None
                    ),
                }
                task_context = self._build_task_start_context(task_desc, explicit_context)
                payload = {"task_description": task_desc, "task_metadata": task_metadata}
                if task_context:
                    payload["context"] = task_context

                # Player tasks: reuse existing idle agent if available.
                # The agent stays in _children with a running pipeline between
                # tasks; request_task() triggers on_task_request which resets
                # all state and starts fresh.
                if not ship_id:
                    existing = next(
                        (c for c in self.children
                         if isinstance(c, TaskAgent) and not c._is_corp_ship
                         and not c._active_task_id),
                        None,
                    )
                    if existing:
                        self._locked_ships.add(target_character_id)
                        framework_task_id = await self.request_task(
                            existing.name, payload=payload, timeout=self._task_agent_timeout
                        )
                        self._update_polling_scope()
                        return {
                            "success": True,
                            "message": "Task started",
                            "task_id": framework_task_id,
                            "task_type": task_type,
                        }

                if ship_id:
                    task_game_client = AsyncGameClient(
                        base_url=self._game_client.base_url,
                        character_id=target_character_id,
                        actor_character_id=self._character_id,
                        entity_type="corporation_ship",
                        transport="supabase",
                        enable_event_polling=False,
                    )
                else:
                    task_game_client = self._game_client

                # Pre-generate the framework task UUID so we can return it to
                # the LLM immediately. The bus name `task_xxxxxx` is purely
                # internal routing; the framework UUID is the only identifier
                # the LLM (and event_relay) ever sees.
                framework_task_id = str(uuid.uuid4())
                agent_name = f"task_{uuid.uuid4().hex[:6]}"
                task_agent = TaskAgent(
                    agent_name,
                    bus=self._bus,
                    game_client=task_game_client,
                    character_id=target_character_id,
                    is_corp_ship=bool(ship_id),
                    task_metadata=task_metadata,
                    tag_outbound_rpcs_with_task_id=bool(ship_id),
                )

                # Lock ship BEFORE add_agent — if add_agent partially fails
                # (child in _children but pipeline not started), the ship stays
                # locked so no second agent can be added for it.
                self._pending_tasks[agent_name] = (framework_task_id, payload)
                self._locked_ships.add(target_character_id)
                try:
                    await self.add_agent(task_agent)
                except Exception:
                    self._locked_ships.discard(target_character_id)
                    self._pending_tasks.pop(agent_name, None)
                    self._children = [c for c in self._children if c.name != agent_name]
                    try:
                        await self.send_message(
                            BusEndAgentMessage(source=self.name, target=agent_name, reason="startup failed")
                        )
                    except Exception:
                        pass
                    raise

                return {
                    "success": True,
                    "message": "Task started",
                    "task_id": framework_task_id,
                    "task_type": task_type,
                }
            except Exception as e:
                logger.error(f"start_task failed: {e}")
                if task_game_client and task_game_client != self._game_client:
                    await task_game_client.close()
                if target_character_id:
                    self._locked_ships.discard(target_character_id)
                if agent_name:
                    self._pending_tasks.pop(agent_name, None)
                    self._children = [c for c in self._children if c.name != agent_name]
                return {"success": False, "error": str(e)}

    @traced
    async def _handle_stop_task(self, params: FunctionCallParams) -> dict:
        try:
            task_id_arg = params.arguments.get("task_id")

            if task_id_arg:
                resolved = self._find_task_agent_by_task_id(str(task_id_arg).strip())
                if not resolved:
                    return {"success": False, "error": f"Task {task_id_arg} not found"}
                framework_task_id, child = resolved
            else:
                # Default: find player ship task
                child = next(
                    (c for c in self.children if isinstance(c, TaskAgent) and not c._is_corp_ship),
                    None,
                )
                if not child:
                    return {"success": False, "error": "No player ship task is currently running"}
                framework_task_id = next(
                    (tid for tid, group in self._task_groups.items() if child.name in group.agent_names),
                    None,
                )
                if framework_task_id is None:
                    return {"success": False, "error": "No active task group for player ship"}

            # Release the ship lock synchronously so a follow-up start_task in
            # the same turn can proceed. on_task_response releases the lock
            # too, but it blocks on `tool_call_active` which is held by *this*
            # tool call — so the async release can't land until we return.
            # `.discard()` is idempotent, so the later release is a no-op.
            self._locked_ships.discard(child._character_id)

            await self.cancel_task(framework_task_id, reason="Cancelled by user")
            return {"success": True, "message": "Task cancelled", "task_id": framework_task_id}
        except Exception as e:
            logger.error(f"stop_task failed: {e}")
            return {"success": False, "error": str(e)}

    async def _steer_existing_task(
        self,
        framework_task_id: str,
        child: TaskAgent,
        text: str,
        *,
        summary: str = "Steering instruction sent.",
    ) -> dict:
        """Send a BusSteerTaskMessage to an active TaskAgent.

        Shared by `_handle_steer_task` and the busy-ship path in
        `_handle_start_task` so the routing stays in one place.
        """
        steering_text = text.strip()
        if not steering_text:
            return {"success": False, "error": "Empty steering instruction"}
        if not steering_text.lower().startswith("steering instruction:"):
            steering_text = f"Steering instruction: {steering_text}"

        await self.send_message(
            BusSteerTaskMessage(
                source=self.name,
                target=child.name,
                task_id=framework_task_id,
                text=steering_text,
            )
        )
        task_type_value = "corp_ship" if child._is_corp_ship else "player_ship"
        # Also push a STEERING-typed task_output frame so the client can
        # flash the task status badge and append a log entry recording the
        # steering instruction.
        await self._task_output_handler(
            steering_text,
            message_type="STEERING",
            task_id=framework_task_id,
            task_type=task_type_value,
        )
        return {
            "success": True,
            "summary": summary,
            "task_id": framework_task_id,
            "task_type": task_type_value,
            "steered": True,
        }

    @traced
    async def _handle_steer_task(self, params: FunctionCallParams) -> dict:
        task_id = params.arguments.get("task_id")
        message = params.arguments.get("message")

        if not isinstance(task_id, str) or not task_id.strip():
            return {"success": False, "error": "task_id is required"}
        if not isinstance(message, str) or not message.strip():
            return {"success": False, "error": "message is required"}

        resolved = self._find_task_agent_by_task_id(task_id.strip())
        if not resolved:
            return {"success": False, "error": f"Task {task_id} not found"}
        framework_task_id, child = resolved

        return await self._steer_existing_task(framework_task_id, child, message)

    @traced
    async def _handle_query_task_progress(self, params: FunctionCallParams) -> dict:
        arguments = params.arguments if isinstance(params.arguments, dict) else {}
        task_id_arg = arguments.get("task_id")

        if task_id_arg:
            resolved = self._find_task_agent_by_task_id(str(task_id_arg).strip())
            if not resolved:
                return {"success": False, "error": f"Task {task_id_arg} not found"}
            framework_task_id, child = resolved
        else:
            child = next(
                (c for c in self.children if isinstance(c, TaskAgent) and not c._is_corp_ship),
                None,
            )
            if not child:
                return {"success": False, "error": "No active task found."}
            framework_task_id = next(
                (tid for tid, group in self._task_groups.items() if child.name in group.agent_names),
                None,
            )
            if framework_task_id is None:
                return {"success": False, "error": f"Task {child.name} not found in active groups"}

        await self.request_task_update(framework_task_id, child.name)
        return {
            "success": True,
            "summary": "Checking task progress now.",
            "task_id": framework_task_id,
            "async": True,
        }

    # ── Task cleanup ───────────────────────────────────────────────────

    async def close_tasks(self) -> None:
        """Cancel all active tasks and end all task agent pipelines."""
        for task_id in list(self._task_groups.keys()):
            try:
                await self.cancel_task(task_id, reason="Disconnected")
            except Exception as e:
                logger.error(f"Failed to cancel task: {e}")
        # End any remaining task agent pipelines (including idle player agent)
        for child in list(self._children):
            if isinstance(child, TaskAgent):
                try:
                    await self.send_message(
                        BusEndAgentMessage(source=self.name, target=child.name, reason="Disconnected")
                    )
                except Exception as e:
                    logger.error(f"Failed to end task agent '{child.name}': {e}")
        self._children = [c for c in self._children if not isinstance(c, TaskAgent)]
        self._locked_ships.clear()

    # ── Task management tool wrappers ─────────────────────────────────

    async def _handle_start_task_tool(self, params: FunctionCallParams):
        # Busy-ship handling is now inside `_handle_start_task`, which routes
        # the request into the steering path instead of rejecting.
        result = await self._handle_start_task(params)
        await params.result_callback(
            {"result": result},
            properties=FunctionCallResultProperties(run_llm=False),
        )
        if result.get("success"):
            task_id = str(result.get("task_id", "")).strip()
            task_type = str(result.get("task_type", "player_ship")).strip() or "player_ship"
            steered = bool(result.get("steered"))
            summary = (
                str(result.get("message") or result.get("summary") or "Task started").strip()
                or "Task started"
            )

            event_name = "task.steered" if steered else "task.started"
            attrs = [f'name="{event_name}"']
            if task_id:
                attrs.append(f'task_id="{task_id}"')
            attrs.append(f'task_type="{task_type}"')
            event_xml = f"<event {' '.join(attrs)}>\n{summary}\n</event>"
            # For a genuinely new task, trigger inference so the model can
            # announce the newly-started task. For a steered (busy-ship) path,
            # suppress inference — the model already narrated the steer in the
            # same turn as the tool call; a fresh inference here would produce
            # a duplicate ack. Keep the event in context either way.
            await self._inject_context(
                [{"role": "user", "content": event_xml}],
                run_llm=not steered,
            )

    async def _handle_stop_task_tool(self, params: FunctionCallParams):
        result = await self._handle_stop_task(params)
        if result.get("success"):
            await params.result_callback(
                {"result": result},
                properties=FunctionCallResultProperties(run_llm=False),
            )
        else:
            await params.result_callback({"result": result})

    async def _handle_steer_task_tool(self, params: FunctionCallParams):
        result = await self._handle_steer_task(params)
        if isinstance(result, dict) and result.get("success") is False:
            self._begin_assistant_response_cycle()
            await params.result_callback(
                {"error": result.get("error", "Request failed.")},
                properties=FunctionCallResultProperties(run_llm=True),
            )
        else:
            # Suppress post-tool inference so we don't get a second,
            # rephrased ack. The model already narrated the steer in the
            # same turn as the tool call (per the Critical Rule); a fresh
            # inference driven by the tool result just produces a duplicate.
            # Mirrors the pattern used by _handle_stop_task_tool and the
            # guard comments in event_relay.py for task.finish / quest.step.
            summary = result.get("summary") if isinstance(result, dict) else None
            payload = {"summary": summary or "steer_task completed."}
            if isinstance(result, dict) and result.get("task_id"):
                payload["task_id"] = result["task_id"]
            await params.result_callback(
                payload,
                properties=FunctionCallResultProperties(run_llm=False),
            )

    async def _handle_query_task_progress_tool(self, params: FunctionCallParams):
        result = await self._handle_query_task_progress(params)
        if isinstance(result, dict) and result.get("success") is False:
            self._begin_assistant_response_cycle()
            await params.result_callback(
                {"error": result.get("error", "Request failed.")},
                properties=FunctionCallResultProperties(run_llm=True),
            )
        else:
            summary = result.get("summary") if isinstance(result, dict) else None
            payload = {"summary": summary or "query_task_progress completed."}
            if isinstance(result, dict) and result.get("task_id"):
                payload["task_id"] = result["task_id"]
            self._begin_assistant_response_cycle()
            await params.result_callback(
                payload, properties=FunctionCallResultProperties(run_llm=True)
            )
