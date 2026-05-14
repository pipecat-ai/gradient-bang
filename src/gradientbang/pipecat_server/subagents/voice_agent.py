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
from dataclasses import dataclass, replace
import functools
import inspect
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
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineTask
from pipecat.processors.filters.identity_filter import IdentityFilter
from pipecat.processors.frame_processor import FrameDirection
from pipecat.processors.frameworks.rtvi import RTVIProcessor, RTVIServerMessageFrame
from pipecat.services.llm_service import FunctionCallParams

from gradientbang.pipecat_server.frames import TaskActivityFrame
from gradientbang.pipecat_server.subagents.bus_correlation import PendingRequests
from gradientbang.pipecat_server.subagents.bus_messages import (
    BusAgentHelloRequest,
    BusAgentHelloResponse,
    BusByoaPresenceMessage,
    BusCombatStrategyRequest,
    BusCombatStrategyResponse,
    BusCorporationQueryRequest,
    BusCorporationQueryResponse,
    BusGameEventMessage,
    BusGameToolCallRequest,
    BusGameToolCallResponse,
    BusSteerTaskMessage,
    BusTaskFinishNotification,
)
from gradientbang.pipecat_server.subagents.event_relay import EventRelay
from gradientbang.pipecat_server.subagents.task_agent import TaskAgent
from pipecat_subagents.agents import LLMAgent, TaskStatus
from pipecat_subagents.agents.llm.llm_agent import PipelineFlushFrame
from pipecat_subagents.bus import (
    AgentBus,
    BusEndAgentMessage,
    BusMessage,
    BusTaskResponseMessage,
    BusTaskUpdateMessage,
)
from gradientbang.byoa import ByoaAgentConfig
from gradientbang.tools import VOICE_TOOLS
from gradientbang.utils.api_client import RPCError
from gradientbang.utils.formatting import looks_like_uuid
from gradientbang.utils.llm_factory import create_llm_service, get_voice_llm_config
from gradientbang.utils.supabase_client import (
    AsyncGameClient,
    per_call_identity,
    per_call_task_id,
)
from gradientbang.utils.weave_tracing import traced

if TYPE_CHECKING:
    from pipecat.services.llm_service import LLMService

# ── Constants ─────────────────────────────────────────────────────────────

MAX_CORP_SHIP_TASKS = 3
MAX_PERSONAL_SHIP_TASKS = 1
REQUEST_ID_CACHE_TTL_SECONDS = 15 * 60
REQUEST_ID_CACHE_MAX_SIZE = 5000
DEFERRED_UPDATE_COOLDOWN_SECONDS = 1.5
TASK_RESPONSE_SPEECH_START_GRACE_SECONDS = 0.75
DEFERRED_UPDATE_STALE_TURNS = 5
DEFERRED_UPDATE_SETTLE_SECONDS = 2.0
DEFERRED_UPDATE_MAX_SETTLE_SECONDS = 8.0
BYOA_PRESENCE_STALE_SECONDS = 25.0
BYOA_PRESENCE_SWEEP_SECONDS = 5.0

_UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)


def _env_truthy(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in ("1", "true", "yes", "on")


@dataclass
class _DeferredUpdate:
    xml: str
    ship_id: Optional[str] = None


@dataclass
class _ByoaPresence:
    ship_id: str
    online: bool
    status: str
    last_seen_at: Optional[str]
    last_seen_monotonic: float


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
        byoa_config: Optional[ByoaAgentConfig] = None,
    ):
        super().__init__(name, bus=bus, bridged=(), active=False)
        self.__game_client = game_client
        self.__character_id = character_id
        self._rtvi = rtvi_processor
        self._event_relay = event_relay
        self._byoa_config = byoa_config or ByoaAgentConfig.from_env()

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

        # ── Bot/user speaking state ──
        self._bot_speaking: bool = False
        self._bot_stopped_speaking_at: float = 0.0
        self._user_speaking: bool = False
        # True between UserStoppedSpeakingFrame and the next assistant cycle
        # going idle. Used to gate the deferred-update drain so a queued
        # task.completed can't squeeze in ahead of the bot's reply to the user.
        self._awaiting_bot_reply: bool = False

        # ── Assistant response lifecycle ──
        self._assistant_cycle_active: bool = False
        self._speech_start_grace_task: Optional[asyncio.Task] = None
        self._start_task_lock: asyncio.Lock = asyncio.Lock()
        # Maps ship/character_id of the held lock → framework_task_id. The
        # server-side mutex on ship_instances.current_task_id is authoritative
        # Per-bot in-memory authority on "ship is busy". Each entry maps
        # ship_character_id → framework_task_id for the active task on that
        # ship. The bot is the only authority; there is no DB-side persistent
        # lock. Entries are cleared on task finish/error/timeout, on BYOA
        # presence timeout (see _byoa_presence_sweep_loop), and on session
        # teardown (close_tasks).
        self._locked_ships: Dict[str, str] = {}
        # PendingRequests tracks outbound BusAgentHelloRequest correlation_ids;
        # the broker's hello-response handler resolves the awaiting future
        # when the targeted agent signals alive.
        self._hello_pending: PendingRequests = PendingRequests()

        # Per-ship watchdogs for the BYOA wake flow. Keyed by
        # target_character_id (the ship's pseudo-character_id for corp
        # ships). Each entry is an asyncio.Task that sleeps for
        # agent_wake_timeout_seconds; on expiry it clears the local ship
        # lock and cancels the task so a stuck wake doesn't leak.
        # Cancelled when the BYOA agent advertises ready (on_agent_ready)
        # or the task otherwise completes/cancels.
        self._pending_wakes: Dict[str, asyncio.Task] = {}
        # The actual per-session subagent-bus channel. The factory generates
        # a fresh UUID-128 channel per session and stores it in
        # SUBAGENT_BUS_SESSION_CHANNEL. Wake passes this value to the spawned
        # BYOA process over HTTPS; local dev does the same through the
        # generic HTTP wake provider (`uv run byoa serve`).
        self._byoa_bus_channel = os.getenv(
            "SUBAGENT_BUS_SESSION_CHANNEL", ""
        ).strip()
        if self._byoa_bus_channel:
            logger.info(
                f"byoa.session_channel channel_prefix={self._byoa_bus_channel[:11]}"
            )
        # Remote BYOA agents are not children in this process, so the broker
        # keeps its own active-task table for authorization and cleanup.
        # agent_name -> {task_id, character_id, actor_character_id, task_metadata}
        self._byoa_active_agents: Dict[str, Dict[str, Any]] = {}
        # Process presence for external BYOA runners. This is UI/task-start
        # liveness only; registry + hello remains authoritative for dispatch.
        self._byoa_presence: Dict[str, _ByoaPresence] = {}
        self._byoa_presence_sweep_task: Optional[asyncio.Task] = None
        self._byoa_known_ships: set[str] = set()

        # ── Deferred-update queue (task.completed batching, etc.) ──
        # Bounded drain task lifecycle: lazily spawned on first enqueue,
        # exits when the queue drains. While anything is pending or mid-flush,
        # on_idle_report skips so we don't narrate premature status updates.
        self._deferred_updates: list[_DeferredUpdate] = []
        self._deferred_first_enqueued_at: Optional[float] = None
        self._deferred_last_enqueued_at: Optional[float] = None
        self._deferred_user_stops: int = 0
        self._deferred_bot_stops: int = 0
        self._deferred_event: asyncio.Event = asyncio.Event()
        self._deferred_drain_task: Optional[asyncio.Task] = None
        self._deferred_flushing: bool = False

        # ── Pending confirmation for confirm_action tool ──
        self._pending_confirmation: Optional[Dict[str, Any]] = None

        # Set by bot.py once the main pipeline task is built.
        self._main_pipeline_task: Optional[PipelineTask] = None

    def attach_main_pipeline_task(self, task: PipelineTask) -> None:
        self._main_pipeline_task = task

    async def build_pipeline(self) -> Pipeline:
        # The voice LLM lives inline in the main pipeline; this agent owns a
        # no-op pipeline so its lifecycle (bus subscription, activation,
        # child supervision) still works.
        return Pipeline([IdentityFilter()])

    async def queue_frame(
        self, frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM
    ) -> None:
        # Mirrors LLMAgent.queue_frame's deferral, then routes to the main
        # pipeline task instead of this agent's no-op pipeline.
        if (
            self._defer_tool_frames
            and self._tool_call_inflight > 0
            and not self._closing
        ):
            self._deferred_frames.append((frame, direction))
            return
        if self._main_pipeline_task is not None:
            await self._main_pipeline_task.queue_frame(frame, direction)
            return
        await super().queue_frame(frame, direction)

    # ── Lifecycle ───────────────────────────────────────────────────────

    async def on_activated(self, args: Optional[dict]) -> None:
        """Activate the LLM agent. Initial messages (start_of_session,
        gathered state, onboarding/session.start trigger) are passed in
        via activation args by ``bot.py._join`` after ``session_init``
        finishes — no in-relay onboarding injection here."""
        await super().on_activated(args)

    async def on_ready(self) -> None:
        await super().on_ready()

    def install_main_pipeline_lifecycle_watchers(self, task: PipelineTask) -> None:
        # LLM and speaking frames flow through the main pipeline; install the
        # watchers that drive assistant-cycle / speaking state there.
        # PipelineFlushFrame round-trip mirrors LLMAgent.create_pipeline_task
        # so _flush_pipeline can use the main task as its barrier.
        task.add_reached_downstream_filter(
            (LLMFullResponseStartFrame, LLMFullResponseEndFrame, PipelineFlushFrame)
        )
        task.add_reached_upstream_filter(
            (
                BotStartedSpeakingFrame,
                BotStoppedSpeakingFrame,
                UserStartedSpeakingFrame,
                UserStoppedSpeakingFrame,
                PipelineFlushFrame,
            )
        )

        @task.event_handler("on_frame_reached_downstream")
        async def _on_llm_response_lifecycle(task, frame):
            if isinstance(frame, LLMFullResponseStartFrame):
                self._handle_llm_response_started()
            elif isinstance(frame, LLMFullResponseEndFrame):
                self._handle_llm_response_ended()
            elif isinstance(frame, PipelineFlushFrame):
                self._flush_done.set()

        @task.event_handler("on_frame_reached_upstream")
        async def _on_speaking_lifecycle(task, frame):
            if isinstance(frame, BotStartedSpeakingFrame):
                self._handle_bot_started_speaking()
            elif isinstance(frame, BotStoppedSpeakingFrame):
                self._handle_bot_stopped_speaking()
            elif isinstance(frame, UserStartedSpeakingFrame):
                self._handle_user_started_speaking()
            elif isinstance(frame, UserStoppedSpeakingFrame):
                self._handle_user_stopped_speaking()
            elif isinstance(frame, PipelineFlushFrame):
                await task.queue_frame(PipelineFlushFrame())

    def _cancel_speech_start_grace_task(self) -> None:
        task = self._speech_start_grace_task
        if task and not task.done():
            task.cancel()
        self._speech_start_grace_task = None

    def _mark_assistant_cycle_active(self) -> None:
        self._assistant_cycle_active = True

    def _mark_assistant_cycle_idle(self) -> None:
        self._assistant_cycle_active = False
        # Bot has finished its turn (or grace expired) — the user's last input
        # has now been answered, so the drain may proceed.
        was_replying_to_user = self._awaiting_bot_reply
        self._awaiting_bot_reply = False
        # If this cycle was a reply to user input, reset the settle window so
        # there's a fresh 2s beat after the user-bot turn before any queued
        # narration goes out. Without this, a flush can land just 1.5s
        # (cooldown) after the bot answers, which feels stacked.
        if was_replying_to_user and self._deferred_first_enqueued_at is not None:
            self._deferred_last_enqueued_at = time.monotonic()
        self._deferred_event.set()
        # Pending confirmation lifecycle: on the first idle after
        # creation, arm it so confirm_action can proceed. On the
        # second idle (user's turn passed without confirming), expire it.
        if self._pending_confirmation:
            if self._pending_confirmation.get("armed"):
                self._pending_confirmation = None
            else:
                self._pending_confirmation["armed"] = True

    def _begin_assistant_response_cycle(self) -> None:
        self._cancel_speech_start_grace_task()
        self._mark_assistant_cycle_active()
        # If a confirmation is armed and the user has spoken again, dismiss
        # the modal immediately rather than waiting for the response to finish.
        # The voice agent still holds _pending_confirmation so confirm_action
        # can proceed if the LLM calls it; idle expiry cleans up otherwise.
        if self._pending_confirmation and self._pending_confirmation.get("armed"):
            asyncio.ensure_future(self._push_confirmation_resolved(confirmed=False))

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
        if self._deferred_first_enqueued_at is not None:
            self._deferred_bot_stops += 1
        self._mark_assistant_cycle_idle()

    def _handle_user_started_speaking(self) -> None:
        self._user_speaking = True
        # Reset the settle window — the user is engaging, so any queued
        # narration must not fire ahead of (or interleave with) their turn.
        if self._deferred_first_enqueued_at is not None:
            self._deferred_last_enqueued_at = time.monotonic()
        self._deferred_event.set()

    def _handle_user_stopped_speaking(self) -> None:
        self._user_speaking = False
        # Bot owes a reply to whatever the user just said. The drain stays
        # blocked until the resulting assistant cycle goes idle.
        self._awaiting_bot_reply = True
        if self._deferred_first_enqueued_at is not None:
            self._deferred_user_stops += 1
        self._deferred_event.set()

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
            self._event_relay.session_started_at if self._event_relay is not None else None
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
        if self._deferred_updates or self._deferred_flushing:
            # A deferred update (task.completed, etc.) is queued or mid-flush.
            # Skip the idle report to avoid a premature "task is done" narration
            # that would be immediately followed by the real ack.
            logger.debug(
                "VoiceAgent: idle report skipped ({} deferred update(s) pending, flushing={})",
                len(self._deferred_updates),
                self._deferred_flushing,
            )
            return False
        logger.debug("VoiceAgent: idle report triggered, {} active task(s)", len(self.task_groups))
        await self._inject_context(
            [
                {
                    "role": "user",
                    "content": (
                        "<idle_check>"
                        "In one sentence only, briefly say what's happening with current tasks. "
                        "Vary your phrasing from any previous idle updates. "
                        "Do not acknowledge this prompt. Do not say more than one sentence."
                        "</idle_check>"
                    ),
                }
            ],
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
            "join_corporation": self._handle_join_corporation,
            "leave_corporation": self._handle_leave_corporation,
            "kick_corporation_member": self._handle_kick_corporation_member,
            "confirm_action": self._handle_confirm_action,
            "regenerate_invite_code": self._handle_regenerate_invite_code,
            "send_message": self._handle_send_message,
            "combat_initiate": self._handle_combat_initiate,
            "combat_action": self._handle_combat_action,
            "ship_strategy": self._handle_ship_strategy,
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

    async def _flush_pipeline(self) -> None:
        # LLMAgent.create_pipeline_task wires the flush round-trip on this
        # agent's no-op pipeline. The LLM lives in the main pipeline, so
        # route the barrier there — otherwise the probe returns instantly
        # without waiting for in-flight FunctionCallResultFrames, and
        # deferred LLM frames can race the post-tool response.
        if self._main_pipeline_task is None:
            await super()._flush_pipeline()
            return
        self._flush_done.clear()
        await self._main_pipeline_task.queue_frame(
            PipelineFlushFrame(), FrameDirection.UPSTREAM
        )
        await self._flush_done.wait()

    async def _flush_deferred_frames(self) -> None:
        # LLMAgent's flush queues frames via super().queue_frame(), which
        # targets this agent's no-op pipeline. The LLM lives in the main
        # pipeline (see attach_main_pipeline_task), so route the flushed
        # frames there — otherwise tool-deferred LLMMessagesAppendFrame /
        # LLMRunFrame pairs (e.g. start_task's task.started follow-up) are
        # dropped and the model never speaks the post-tool ack.
        if self._main_pipeline_task is None:
            await super()._flush_deferred_frames()
            return

        await self._flush_pipeline()
        frames = list(self._deferred_frames)
        self._deferred_frames.clear()
        for frame, direction in await self.process_deferred_tool_frames(frames):
            await self._main_pipeline_task.queue_frame(frame, direction)

    async def _inject_context(self, messages: list[dict], *, run_llm: bool = True) -> None:
        """Append context and coalesce a single follow-up LLM run when needed."""
        frame = LLMMessagesAppendFrame(messages=messages, run_llm=run_llm)

        if self.tool_call_active:
            await self.queue_frame(frame)
            return

        if run_llm:
            frame.run_llm = False
            await self.queue_frame(frame)
            if not self._inject_run_pending:
                self._inject_run_pending = True
                self._inject_run_task = self.create_asyncio_task(
                    self._emit_coalesced_run(), "inject_coalesced_run"
                )
            return

        await self.queue_frame(frame)

    async def _emit_coalesced_run(self) -> None:
        """Send a single LLMRunFrame after yielding to accumulate same-tick injections."""
        try:
            await asyncio.sleep(0)
            await self.queue_frame(LLMRunFrame())
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

    async def _push_confirmation_resolved(self, confirmed: bool) -> None:
        """Push an RTVI event to dismiss the client's confirmation modal."""
        await self._rtvi.push_frame(
            RTVIServerMessageFrame(
                {
                    "frame_type": "event",
                    "event": "confirmation.resolved",
                    "payload": {"confirmed": confirmed},
                }
            )
        )

    async def _queue_deferred_update_frame(self, event_xml: str) -> None:
        """Queue a deferred-update batch for inference, bypassing tool-call defer."""
        frame = LLMMessagesAppendFrame(
            messages=[{"role": "user", "content": event_xml}], run_llm=True
        )
        if self._main_pipeline_task is not None:
            await self._main_pipeline_task.queue_frame(frame, FrameDirection.DOWNSTREAM)
        else:
            await super().queue_frame(frame)

    # ── Deferred-update queue ──────────────────────────────────────────

    def _enqueue_deferred_update(self, event_xml: str, *, ship_id: Optional[str] = None) -> None:
        """Append an update to the deferred queue and ensure a drain task is running.

        The drain task is bounded by the queue contents — it exits as soon as
        the queue drains, so it is short-lived by construction.
        """
        now = time.monotonic()
        self._deferred_updates.append(_DeferredUpdate(xml=event_xml, ship_id=ship_id))
        if self._deferred_first_enqueued_at is None:
            self._deferred_first_enqueued_at = now
        self._deferred_last_enqueued_at = now
        if self._deferred_drain_task is None or self._deferred_drain_task.done():
            self._deferred_drain_task = self.create_asyncio_task(
                self._drain_deferred_updates(), "deferred_update_drain"
            )
        self._deferred_event.set()
        logger.debug(
            "VoiceAgent: deferred update enqueued (queue_size={}, ship_id={})",
            len(self._deferred_updates),
            ship_id,
        )

    async def _drain_deferred_updates(self) -> None:
        """Bounded drain coordinator. Exits when the queue is empty."""
        try:
            while self._deferred_updates:
                # 1. Stale check — silent fold-in once topic has moved on.
                if (
                    min(self._deferred_user_stops, self._deferred_bot_stops)
                    >= DEFERRED_UPDATE_STALE_TURNS
                ):
                    logger.debug(
                        "VoiceAgent: deferred update stale (user_stops={}, bot_stops={}); silent flush",
                        self._deferred_user_stops,
                        self._deferred_bot_stops,
                    )
                    await self._flush_deferred_updates(run_llm=False)
                    continue

                # 2. Hard gates — wait for a poke if any fail.
                #    `_awaiting_bot_reply` keeps the queue blocked between the
                #    user finishing a turn and the bot's reply going idle, so
                #    a pending narration can't front-load itself ahead of (or
                #    interleave with) the bot's response to the user.
                if (
                    self.tool_call_active
                    or self._assistant_cycle_active
                    or self._user_speaking
                    or self._awaiting_bot_reply
                ):
                    self._deferred_event.clear()
                    await self._deferred_event.wait()
                    continue

                # 3. Settle window — wait until no new entry has arrived for
                #    DEFERRED_UPDATE_SETTLE_SECONDS, capped by MAX from first enqueue.
                now = time.monotonic()
                settle_remaining = DEFERRED_UPDATE_SETTLE_SECONDS - (
                    now - (self._deferred_last_enqueued_at or now)
                )
                max_remaining = DEFERRED_UPDATE_MAX_SETTLE_SECONDS - (
                    now - (self._deferred_first_enqueued_at or now)
                )
                settle_wait = min(settle_remaining, max_remaining)
                if settle_wait > 0:
                    self._deferred_event.clear()
                    try:
                        await asyncio.wait_for(self._deferred_event.wait(), timeout=settle_wait)
                        continue  # state changed — re-evaluate from the top
                    except asyncio.TimeoutError:
                        pass  # settle elapsed, fall through to cooldown

                # 4. Cooldown — finish out the post-bot-speech buffer or wait for a poke.
                elapsed = time.monotonic() - self._bot_stopped_speaking_at
                cooldown_remaining = DEFERRED_UPDATE_COOLDOWN_SECONDS - elapsed
                if cooldown_remaining > 0:
                    self._deferred_event.clear()
                    try:
                        await asyncio.wait_for(
                            self._deferred_event.wait(), timeout=cooldown_remaining
                        )
                        continue  # state changed mid-cooldown — re-evaluate
                    except asyncio.TimeoutError:
                        pass  # cooldown expired, fall through to flush

                # 5. Pre-flush gate recheck — yield once so any in-flight
                #    UserStartedSpeakingFrame can land and flip the gates
                #    before we commit to flushing. Closes the race where a
                #    user starts speaking the same moment all gates passed.
                await asyncio.sleep(0)
                if (
                    self.tool_call_active
                    or self._assistant_cycle_active
                    or self._user_speaking
                    or self._awaiting_bot_reply
                ):
                    continue

                # 6. Flush with inference.
                await self._flush_deferred_updates(run_llm=True)
        except asyncio.CancelledError:
            raise
        finally:
            if asyncio.current_task() is self._deferred_drain_task:
                self._deferred_drain_task = None

    async def _flush_deferred_updates(self, *, run_llm: bool) -> None:
        """Drain the queue and emit one batched LLM message (or silent append)."""
        if not self._deferred_updates:
            return
        self._deferred_flushing = True
        try:
            items = self._deferred_updates
            self._deferred_updates = []
            self._deferred_first_enqueued_at = None
            self._deferred_last_enqueued_at = None
            self._deferred_user_stops = 0
            self._deferred_bot_stops = 0

            batched = "\n".join(u.xml for u in items)
            logger.debug(
                "VoiceAgent: flushing {} deferred update(s) (run_llm={})",
                len(items),
                run_llm,
            )
            if run_llm:
                await self._queue_deferred_update_frame(batched)
            else:
                await self._inject_context(
                    [{"role": "user", "content": batched}],
                    run_llm=False,
                )
        finally:
            self._deferred_flushing = False

    async def _silent_flush_for_ship(self, ship_id: str) -> None:
        """Drain just the matching ship's pending updates silently.

        Called when the user starts a new task on a ship that has pending
        completion entries — that's a strong signal the player has moved on,
        so we fold the previous completion into context without narrating.
        """
        if not ship_id or not self._deferred_updates:
            return
        matching = [u for u in self._deferred_updates if u.ship_id == ship_id]
        if not matching:
            return
        self._deferred_updates = [u for u in self._deferred_updates if u.ship_id != ship_id]
        if not self._deferred_updates:
            self._deferred_first_enqueued_at = None
            self._deferred_last_enqueued_at = None
            self._deferred_user_stops = 0
            self._deferred_bot_stops = 0
        batched = "\n".join(u.xml for u in matching)
        logger.debug(
            "VoiceAgent: silent flush for ship {} ({} entry/entries)",
            ship_id[:8],
            len(matching),
        )
        await self._inject_context(
            [{"role": "user", "content": batched}],
            run_llm=False,
        )
        self._deferred_event.set()

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
            self._begin_assistant_response_cycle()
            await params.result_callback(
                {"status": "Executed."},
                properties=FunctionCallResultProperties(run_llm=True),
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
        self._pending_confirmation = None
        try:
            result = await self._game_client.leave_corporation(
                character_id=self._character_id,
            )
            self._track_request_id_from_result(result)
        except Exception as exc:
            await self._finish_event_tool_with_error(params, exc, run_llm=True)
            return

        # Pending: store state for confirm_action, let the LLM relay
        # the warning verbally. The client modal also appears in parallel.
        if isinstance(result, dict) and result.get("pending"):
            self._pending_confirmation = {"action": "leave", "armed": False}
            self._begin_assistant_response_cycle()
            await params.result_callback(
                {
                    "status": "awaiting_confirmation",
                    "will_disband": bool(result.get("will_disband")),
                    "is_founder": bool(result.get("is_founder")),
                    "corp_name": result.get("corp_name"),
                    "member_count": result.get("member_count"),
                },
                properties=FunctionCallResultProperties(run_llm=True),
            )
            return

        self._begin_assistant_response_cycle()
        await params.result_callback(
            {"success": True},
            properties=FunctionCallResultProperties(run_llm=True),
        )

    async def _handle_regenerate_invite_code(self, params: FunctionCallParams):
        # Founder-only. The new code is also surfaced in the
        # CorporationDetailsDialog via the corp-scoped event; returning it
        # in the tool result lets the voice agent tell the founder the
        # new passphrase directly so they don't have to read the modal.
        try:
            result = await self._game_client.regenerate_invite_code(
                character_id=self._character_id,
            )
            self._track_request_id_from_result(result)
            new_code = result.get("new_invite_code") if isinstance(result, dict) else None
            self._begin_assistant_response_cycle()
            await params.result_callback(
                {
                    "success": True,
                    "new_invite_code": new_code,
                    "note": (
                        "Tell the founder the new invite code in one short "
                        "sentence (e.g. 'New code is <code>.'). Only the "
                        "founder can regenerate, so it is safe to read aloud."
                    ),
                },
                properties=FunctionCallResultProperties(run_llm=True),
            )
        except Exception as exc:
            await self._finish_event_tool_with_error(params, exc, run_llm=True)

    async def _handle_join_corporation(self, params: FunctionCallParams):
        # Voice-only tool. The LLM supplies corp_name + invite_code; we
        # resolve corp_name → corp_id here (LLM has no way to know corp_ids).
        # The `confirm` flag is NOT in the tool schema and is NEVER set
        # here — only confirm_action / client_message_handler passes it.
        self._pending_confirmation = None
        args = params.arguments
        corp_name = (args.get("corp_name") or "").strip()
        corp_id = (args.get("corp_id") or "").strip()
        invite_code = (args.get("invite_code") or "").strip()

        # Pre-flight: refuse to call the server if the LLM skipped a
        # required field (schema requires both, but an empty string would
        # still pass JSON schema validation). Surface the error back to the
        # LLM so it can ask the user.
        if not invite_code:
            await params.result_callback(
                {
                    "error": (
                        "invite_code is required. Ask the player for the "
                        "invite passphrase before calling this tool."
                    )
                },
                properties=FunctionCallResultProperties(run_llm=True),
            )
            return
        if not corp_id and not corp_name:
            await params.result_callback(
                {
                    "error": (
                        "corp_name or corp_id is required. Ask the player "
                        "which corporation they want to join."
                    )
                },
                properties=FunctionCallResultProperties(run_llm=True),
            )
            return

        # Resolve corp_name → corp_id.
        if not corp_id:
            try:
                corps = await self._game_client.list_corporations()
            except Exception as exc:
                await self._finish_event_tool_with_error(params, exc, run_llm=True)
                return
            match_name = corp_name.lower()
            for corp in corps:
                if str(corp.get("name", "")).strip().lower() == match_name:
                    corp_id = str(corp.get("corp_id", "")).strip()
                    break
            if not corp_id:
                await params.result_callback(
                    {
                        "error": (
                            f"No corporation named '{corp_name}' exists. "
                            "Ask the player to verify the name."
                        )
                    },
                    properties=FunctionCallResultProperties(run_llm=True),
                )
                return

        try:
            result = await self._game_client.join_corporation(
                corp_id=corp_id,
                invite_code=invite_code,
                character_id=self._character_id,
            )
            self._track_request_id_from_result(result)
        except Exception as exc:
            await self._finish_event_tool_with_error(params, exc, run_llm=True)
            return

        # Pending: store state for confirm_action, let the LLM relay
        # the warning verbally. The client modal also appears in parallel.
        if isinstance(result, dict) and result.get("pending"):
            self._pending_confirmation = {
                "action": "join",
                "corp_id": corp_id,
                "invite_code": invite_code,
                "armed": False,
            }
            self._begin_assistant_response_cycle()
            await params.result_callback(
                {
                    "status": "awaiting_confirmation",
                    "will_disband": bool(result.get("will_disband")),
                    "is_founder": bool(result.get("is_founder")),
                    "old_corp_name": result.get("old_corp_name"),
                    "new_corp_name": result.get("corp_name"),
                    "member_count": result.get("member_count"),
                },
                properties=FunctionCallResultProperties(run_llm=True),
            )
            return

        # Joined in a single round-trip (no pending). Narrate normally.
        self._begin_assistant_response_cycle()
        await params.result_callback(
            {
                "success": True,
                "corp_name": result.get("name") if isinstance(result, dict) else None,
            },
            properties=FunctionCallResultProperties(run_llm=True),
        )

    async def _handle_kick_corporation_member(self, params: FunctionCallParams):
        # Voice-only tool. The kick ALWAYS returns pending on the first
        # call (without `confirm`). The LLM relays the warning, then the
        # user confirms via confirm_action (voice) or the modal (UI).
        self._pending_confirmation = None
        args = params.arguments
        target_id = (args.get("target_id") or "").strip()
        if not target_id:
            await params.result_callback(
                {
                    "error": (
                        "target_id is required. Ask the player to identify which member to remove."
                    )
                },
                properties=FunctionCallResultProperties(run_llm=True),
            )
            return

        # LLMs see corporation member *names* via summarize_corporation_info,
        # not character_ids. If target_id doesn't already look like a UUID,
        # resolve it against the current corporation's member list — the
        # edge function's canonicalizeCharacterId() would otherwise v5-hash
        # a display name into a UUID that doesn't match any real character.
        if not looks_like_uuid(target_id):
            try:
                my_corp = await self._game_client._request(
                    "my_corporation", {"character_id": self._character_id}
                )
            except Exception as exc:
                await self._finish_event_tool_with_error(params, exc, run_llm=True)
                return
            corp = my_corp.get("corporation") if isinstance(my_corp, dict) else None
            members = (corp.get("members") if isinstance(corp, dict) else None) or []
            lowered = target_id.lower()
            resolved: Optional[str] = None
            for member in members:
                if not isinstance(member, dict):
                    continue
                name = str(member.get("name") or "").strip()
                if name and name.lower() == lowered:
                    resolved = str(member.get("character_id") or "").strip() or None
                    break
            if not resolved:
                await params.result_callback(
                    {
                        "error": (
                            f"No member named '{target_id}' in your corporation. "
                            "Ask the player to confirm the name."
                        )
                    },
                    properties=FunctionCallResultProperties(run_llm=True),
                )
                return
            target_id = resolved

        try:
            result = await self._game_client.kick_corporation_member(
                target_id=target_id,
                character_id=self._character_id,
            )
            self._track_request_id_from_result(result)
        except Exception as exc:
            await self._finish_event_tool_with_error(params, exc, run_llm=True)
            return

        if isinstance(result, dict) and result.get("pending"):
            self._pending_confirmation = {
                "action": "kick",
                "target_id": target_id,
                "armed": False,
            }
            self._begin_assistant_response_cycle()
            await params.result_callback(
                {
                    "status": "awaiting_confirmation",
                    "target_name": result.get("target_name"),
                },
                properties=FunctionCallResultProperties(run_llm=True),
            )
            return

        # Unexpected — kick without confirm should always return pending
        # from the edge function. Fall through to a normal response so the
        # LLM at least acknowledges completion.
        self._begin_assistant_response_cycle()
        await params.result_callback(
            {"success": True},
            properties=FunctionCallResultProperties(run_llm=True),
        )

    async def _handle_confirm_action(self, params: FunctionCallParams):
        pending = self._pending_confirmation
        if not pending:
            await params.result_callback(
                {"error": "No action is awaiting confirmation."},
                properties=FunctionCallResultProperties(run_llm=True),
            )
            return

        if not pending.get("armed"):
            # The LLM tried to chain confirm_action in the same turn
            # as the action that set the pending state. Reject it so
            # the user has a chance to respond first.
            await params.result_callback(
                {
                    "error": (
                        "The user has not confirmed yet. Wait for their "
                        "response before calling confirm_action."
                    )
                },
                properties=FunctionCallResultProperties(run_llm=True),
            )
            return

        action = pending.get("action")
        self._pending_confirmation = None

        try:
            if action == "leave":
                result = await self._game_client.leave_corporation(
                    character_id=self._character_id,
                    confirm=True,
                )
            elif action == "kick":
                result = await self._game_client.kick_corporation_member(
                    target_id=pending["target_id"],
                    character_id=self._character_id,
                    confirm=True,
                )
            elif action == "join":
                result = await self._game_client.join_corporation(
                    corp_id=pending["corp_id"],
                    invite_code=pending["invite_code"],
                    character_id=self._character_id,
                    confirm=True,
                )
            else:
                await params.result_callback(
                    {"error": f"Unknown pending action: {action}"},
                    properties=FunctionCallResultProperties(run_llm=True),
                )
                return

            self._track_request_id_from_result(result)
            self._begin_assistant_response_cycle()
            await self._push_confirmation_resolved(confirmed=True)
            await params.result_callback(
                {"success": True, "action": action},
                properties=FunctionCallResultProperties(run_llm=True),
            )
        except Exception as exc:
            await self._push_confirmation_resolved(confirmed=True)
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
            await params.result_callback(
                {"status": "Executed."},
                properties=FunctionCallResultProperties(run_llm=False),
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

    async def _handle_ship_strategy(self, params: FunctionCallParams):
        """Get or set a ship's combat strategy.

        GET mode (no template arg): returns the strategy inline so the voice
        agent can answer follow-up questions from it directly.

        SET mode (template arg present): acks with ``run_llm=False``. The
        server emits a ``ships.strategy_set`` event that the relay delivers
        with InferenceRule.ALWAYS — that event is what wakes the agent to
        confirm the change verbally.
        """
        args = params.arguments
        ship_id = args.get("ship_id")
        if not isinstance(ship_id, str) or not ship_id.strip():
            await self._finish_event_tool_with_error(
                params, ValueError("ship_id is required"), run_llm=True
            )
            return
        ship_id = ship_id.strip()
        template = args.get("template")
        custom_prompt = args.get("custom_prompt")

        # Any write field present → SET (with merge for unspecified fields).
        # Only ship_id present → GET. Partial SETs (e.g. only custom_prompt)
        # merge with the ship's current strategy so the commander can "add a
        # custom prompt" without having to restate the template.
        is_set = template is not None or custom_prompt is not None

        try:
            if not is_set:
                # GET — edge function returns:
                #   {strategy: {template, custom_prompt, doctrine, ...} | null,
                #    default_template, default_doctrine}
                result = await self._game_client.combat_get_strategy(
                    ship_id=ship_id,
                    character_id=self._character_id,
                )
                strategy = result.get("strategy") if isinstance(result, dict) else None
                default_template = (
                    result.get("default_template") if isinstance(result, dict) else None
                ) or "balanced"
                default_doctrine = (
                    result.get("default_doctrine") if isinstance(result, dict) else None
                )
                if strategy is None:
                    await params.result_callback(
                        {
                            "ship_id": ship_id,
                            "strategy": None,
                            "default_template": default_template,
                            "default_doctrine": default_doctrine,
                            "note": (
                                f"No explicit strategy set; the ship uses the "
                                f"default '{default_template}' combat doctrine. "
                                "Describe it to the commander from the "
                                "default_doctrine text."
                            ),
                        }
                    )
                else:
                    await params.result_callback(
                        {
                            "ship_id": ship_id,
                            "strategy": strategy,
                            "note": (
                                "Strategy = base doctrine (template) + optional "
                                "custom_prompt. Describe BOTH when asked, "
                                "since custom_prompt is additive guidance "
                                "layered on top of the doctrine."
                            ),
                        }
                    )
                return

            # SET — merge missing fields from the current row so a call like
            # `ship_strategy(ship_id, custom_prompt="…")` doesn't reset the
            # template and `ship_strategy(ship_id, template="…")` doesn't
            # blow away existing custom guidance.
            if template is None or custom_prompt is None:
                current = await self._game_client.combat_get_strategy(
                    ship_id=ship_id,
                    character_id=self._character_id,
                )
                current_strategy = (
                    current.get("strategy") if isinstance(current, dict) else None
                ) or {}
                current_default = (
                    current.get("default_template") if isinstance(current, dict) else None
                ) or "balanced"
                if template is None:
                    template = (
                        current_strategy.get("template")
                        if isinstance(current_strategy, dict)
                        else None
                    ) or current_default
                if custom_prompt is None:
                    custom_prompt = (
                        current_strategy.get("custom_prompt")
                        if isinstance(current_strategy, dict)
                        else None
                    )

            result = await self._game_client.combat_set_strategy(
                ship_id=ship_id,
                template=str(template).lower(),
                custom_prompt=custom_prompt,
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
                {"error": "Leaderboard data is unavailable or too large to summarize safely."}
            )
            return
        await params.result_callback({"summary": summary})

    async def _handle_ship_definitions(self, params: FunctionCallParams):
        from gradientbang.utils.formatting import summarize_ship_definitions

        result = await self._game_client.get_ship_definitions(include_description=True)
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

        result = await self._game_client.list_known_ports(character_id=self._character_id, **kwargs)
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
        if game_task_id in self._task_groups:
            try:
                await self.cancel_task(game_task_id, reason="Cancelled by client")
                logger.info(f"Cancelled task {game_task_id[:8]} via client cancel")
            except Exception as e:
                logger.error(f"Failed to cancel task {game_task_id[:8]} via client cancel: {e}")
            return

        if self._cancel_pending_byoa_wake(
            game_task_id,
            summary="Task was cancelled before the BYOA agent came online.",
        ):
            return

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

    def _cancel_pending_byoa_wake(self, game_task_id: str, *, summary: str) -> bool:
        """Clear a BYOA task that was cancelled before the runner became ready."""
        target_character_id = next(
            (
                ship_id
                for ship_id, task_id in self._locked_ships.items()
                if task_id == game_task_id
            ),
            None,
        )
        if not target_character_id:
            return False

        agent_name = self.byoa_agent_name(target_character_id)
        had_pending_task = agent_name in self._pending_tasks
        watchdog = self._pending_wakes.pop(target_character_id, None)
        had_watchdog = watchdog is not None
        if not had_pending_task and not had_watchdog:
            return False

        if watchdog is not None and not watchdog.done():
            watchdog.cancel()
        self._pending_tasks.pop(agent_name, None)
        self._locked_ships.pop(target_character_id, None)
        self._update_polling_scope()

        event_xml = (
            f'<event name="task.cancelled" task_id="{game_task_id[:8]}" '
            'task_type="corp_ship">\n'
            f"{summary}\n"
            "</event>"
        )
        self._enqueue_deferred_update(event_xml, ship_id=target_character_id)
        logger.info(
            f"byoa.pending_wake_cancelled ship={target_character_id[:8]} "
            f"task={game_task_id[:8]}"
        )
        return True

    def is_our_task(self, task_id: str) -> bool:
        """Check if a task_id belongs to one of our active task groups."""
        return task_id in self._task_groups

    # ── Child agent helpers ───────────────────────────────────────────

    def _find_task_agent_by_task_id(self, task_id: str) -> Optional[Tuple[str, TaskAgent]]:
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

    def update_polling_scope(self) -> None:
        """Derive corp ship IDs from children and update game_client polling.

        Public interface for EventRelay's TaskStateProvider protocol.
        """
        ship_ids = sorted(
            {c._character_id for c in self.children if isinstance(c, TaskAgent) and c._is_corp_ship}
        )
        self._game_client.set_event_polling_scope(
            character_ids=[self._character_id],
            corp_id=self._game_client.corporation_id,
            ship_ids=ship_ids,
        )

    # Keep private alias for internal callers
    _update_polling_scope = update_polling_scope

    def _get_task_type(self, ship_id: Optional[str]) -> str:
        if ship_id and ship_id != self._character_id:
            return "corp_ship"
        return "player_ship"

    @staticmethod
    def _is_valid_uuid(value: str) -> bool:
        return bool(_UUID_PATTERN.match(value))

    async def _resolve_ship_id_prefix(self, prefix: str) -> Optional[dict]:
        """Resolve a ship_id prefix to the matching corp ship dict.

        Returns the full ship entry from `corp.ships` so callers can read
        `ship_id`/`name` without a second `my_corporation` RPC. A bare UUID
        is returned as a stub dict with just `ship_id` set — the caller is
        responsible for any further lookup on that branch.
        """
        if not isinstance(prefix, str):
            return None
        cleaned = prefix.strip().strip("[]").lower()
        if not cleaned:
            return None
        if self._is_valid_uuid(cleaned):
            return {"ship_id": cleaned}
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
                matches.append(ship)
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise ValueError(
                f"Ambiguous ship_id prefix '{cleaned}' matches {len(matches)} ships. "
                "Use a longer prefix."
            )
        return None

    async def _is_corp_ship_id(self, ship_id: str) -> tuple[bool, Optional[str]]:
        """Check if a ship_id belongs to a corporation ship.

        Returns:
            Tuple of (is_corp_ship, ship_name). ship_name is None when
            the ship is not found or the lookup fails.
        """
        try:
            corp_result = await self._game_client._request(
                "my_corporation",
                {"character_id": self._character_id},
            )
        except Exception as exc:
            logger.error(f"Failed to check corp ship: {exc}")
            return True, None
        corp = corp_result.get("corporation")
        if not isinstance(corp, dict):
            return False, None
        ships = corp.get("ships")
        if not isinstance(ships, list):
            return False, None
        for ship in ships:
            if isinstance(ship, dict) and ship.get("ship_id") == ship_id:
                name = ship.get("name")
                return True, (name if isinstance(name, str) and name.strip() else None)
        return False, None

    # ── Agent lifecycle ────────────────────────────────────────────────

    async def on_agent_ready(self, data) -> None:
        await super().on_agent_ready(data)
        pending = self._pending_tasks.pop(data.agent_name, None)
        if not pending:
            return
        framework_task_id, payload = pending
        # Cancel the BYOA wake-hook watchdog if this is a remote BYOA agent
        # that just came online. The agent_name format is `byoa_<ship_id>`
        # for the wake-flow path; in-process spawns use `task_<6hex>` and
        # never register a watchdog.
        if data.agent_name.startswith("byoa_"):
            target_character_id = data.agent_name[len("byoa_") :]
            watchdog = self._pending_wakes.pop(target_character_id, None)
            if watchdog is not None and not watchdog.done():
                watchdog.cancel()
                logger.info(
                    f"byoa.wake_ready ship={target_character_id[:8]} "
                    f"task={framework_task_id[:8]}"
                )
        # Universal liveness handshake. For an in-process TaskAgent this
        # returns ~instantly; for a BYOA agent it bridges the cold-start window.
        try:
            await self._send_hello_and_wait(data.agent_name)
        except (asyncio.TimeoutError, RuntimeError) as exc:
            logger.warning(
                f"VoiceAgent: hello handshake with '{data.agent_name}' failed: {exc}"
            )
            await self._rollback_failed_spawn(
                agent_name=data.agent_name,
                framework_task_id=framework_task_id,
                reason="agent failed wake-up handshake",
            )
            return
        if self._is_byoa_agent_name(data.agent_name):
            target_character_id = data.agent_name[len("byoa_") :]
            task_metadata = payload.get("task_metadata") if isinstance(payload, dict) else None
            task_metadata = task_metadata if isinstance(task_metadata, dict) else {}
            actor = task_metadata.get("actor_character_id")
            self._byoa_active_agents[data.agent_name] = {
                "task_id": framework_task_id,
                "character_id": target_character_id,
                "actor_character_id": actor if isinstance(actor, str) else "",
                "task_metadata": task_metadata,
            }
        try:
            await self._dispatch_task_with_id(
                data.agent_name,
                framework_task_id,
                payload=payload,
                timeout=self._task_agent_timeout,
            )
        except Exception:
            self._byoa_active_agents.pop(data.agent_name, None)
            raise
        self._update_polling_scope()
        logger.info("VoiceAgent: task agent '{}' ready, dispatched task", data.agent_name)

    async def _rollback_failed_spawn(
        self,
        *,
        agent_name: str,
        framework_task_id: str,
        reason: str,
    ) -> None:
        """Unwind a TaskAgent spawn after the wake-up handshake fails.

        The in-memory ship lock was taken in ``_handle_start_task``;
        clearing it here unblocks a follow-up task. Best-effort — each
        step swallows its own exceptions so the rest of cleanup runs.
        """
        target_character_id: Optional[str] = None
        child = next((c for c in self._children if c.name == agent_name), None)
        if child is not None:
            target_character_id = getattr(child, "_character_id", None)
        # Local map first so a concurrent acquire doesn't see a phantom lock.
        if target_character_id:
            self._locked_ships.pop(target_character_id, None)
        self._byoa_active_agents.pop(agent_name, None)
        # Server-side release.
        try:
            await self._game_client.task_cancel(
                task_id=framework_task_id,
                character_id=self._character_id,
            )
        except Exception as exc:
            logger.warning(f"rollback: server task_cancel failed: {exc}")
        # End the child agent's pipeline + remove it from _children.
        try:
            await self.send_message(
                BusEndAgentMessage(
                    source=self.name, target=agent_name, reason=reason
                )
            )
        except Exception as exc:
            logger.warning(f"rollback: BusEndAgentMessage send failed: {exc}")
        self._children = [c for c in self._children if c.name != agent_name]
        self._update_polling_scope()

    async def _dispatch_task_with_id(
        self,
        agent_name: str,
        task_id: str,
        *,
        payload: dict,
        timeout: Optional[float],
    ) -> None:
        """Dispatch a task to ``agent_name`` using the supplied ``task_id``.

        Mirrors :meth:`BaseAgent.create_task_group_and_request_task` but lets the
        caller pin the task identifier instead of generating a fresh UUID. The
        voice agent needs this so it can return a stable ``task_id`` to the LLM
        synchronously from the start_task tool call, then dispatch the request
        once the worker pipeline has come up.
        """
        from pipecat_subagents.agents.task_context import TaskGroup, TaskGroupError

        all_ready = await self._wait_agents_ready([agent_name])
        try:
            await asyncio.wait_for(all_ready, timeout=timeout)
        except asyncio.TimeoutError as exc:
            raise TaskGroupError("agents not ready within timeout") from exc

        group = TaskGroup(task_id=task_id, agent_names={agent_name}, cancel_on_error=True)
        self._task_groups[task_id] = group
        if timeout is not None:
            group.timeout_task = self.create_asyncio_task(
                self._task_timeout(task_id, timeout), f"task_timeout_{task_id[:8]}"
            )

        await self._send_task_request(agent_name, task_id, payload=payload)

    # ── Bus task protocol ─────────────────────────────────────────────

    async def on_task_update(self, message: BusTaskUpdateMessage) -> None:
        byoa_ctx = self._byoa_active_agents.get(message.source)
        if byoa_ctx is not None and message.task_id != str(byoa_ctx.get("task_id") or ""):
            logger.warning(
                f"ignoring BYOA task update from {message.source!r} "
                f"for unexpected task_id={message.task_id[:8]!r}"
            )
            return

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
        agent_name = message.source
        child = next(
            (c for c in self.children if isinstance(c, TaskAgent) and c.name == agent_name), None
        )
        byoa_ctx = self._byoa_active_agents.get(agent_name)
        if byoa_ctx is not None and message.task_id != str(byoa_ctx.get("task_id") or ""):
            logger.warning(
                f"ignoring BYOA task response from {agent_name!r} "
                f"for unexpected task_id={message.task_id[:8]!r}"
            )
            return

        await super().on_task_response(message)

        task_type = (
            "corp_ship"
            if (child and child._is_corp_ship) or byoa_ctx is not None
            else "player_ship"
        )

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
        task_metadata = (
            child._task_metadata
            if child
            else byoa_ctx.get("task_metadata", {}) if byoa_ctx else {}
        )
        ship_name = task_metadata.get("ship_name") if isinstance(task_metadata, dict) else None
        ship_attr = f' ship_name="{ship_name}"' if ship_name else ""
        event_xml = (
            f'<event name="task.{status_label}" task_id="{message.task_id[:8]}" '
            f'task_type="{task_type}"{ship_attr}>\n{llm_msg}\n</event>'
        )

        ship_character_id = (
            child._character_id
            if child
            else str(byoa_ctx.get("character_id") or "") if byoa_ctx else None
        )
        # Hand off to the deferred-update queue. The drain coordinator
        # batches close-together completions, gates on bot/user speech state,
        # and silently folds in entries once the topic has clearly moved on.
        self._enqueue_deferred_update(event_xml, ship_id=ship_character_id)

        # Clear the local ship lock. TaskAgent emits task_lifecycle finish
        # before exiting.
        if ship_character_id:
            self._locked_ships.pop(ship_character_id, None)

        # Corp ship agents: end pipeline, remove from children. Player agents
        # stay alive for reuse — pipeline stays running. There is no per-task
        # game client to close; the broker owns the single client.
        if child and child._is_corp_ship:
            try:
                await self.send_message(
                    BusEndAgentMessage(source=self.name, target=agent_name, reason="task complete")
                )
            except Exception as e:
                logger.error(f"Failed to end task agent '{agent_name}': {e}")
            self._children = [c for c in self._children if c.name != agent_name]
        if byoa_ctx is not None:
            self._byoa_active_agents.pop(agent_name, None)
            self._invalidate_byoa_registry_entry(agent_name)

        self._update_polling_scope()

    # ── BYOA broker ────────────────────────────────────────────────────
    #
    # TaskAgents, including external BYOA runners, speak typed bus messages
    # instead of holding their own AsyncGameClient. This broker is the only
    # edge-function ingress for the whole agent ecosystem. Each handler:
    #   - derives character_id / actor_character_id from local broker state
    #     for remote BYOA messages, falling back to local TaskAgent metadata
    #     or legacy message fields for in-process callers
    #   - tags task_id for the call duration via a ContextVar so concurrent
    #     brokered RPCs don't trample each other's event correlation
    #   - catches exceptions → error=str(e) in the response. Never re-raises.
    #
    @staticmethod
    def _is_byoa_agent_name(agent_name: str) -> bool:
        return agent_name.startswith("byoa_") and not agent_name.startswith("byoa_runner_")

    @staticmethod
    def _is_byoa_runner_name(agent_name: str) -> bool:
        return agent_name.startswith("byoa_runner_")

    def _broker_identity_for_message(
        self,
        message: BusMessage,
        *,
        task_id: Optional[str] = None,
    ) -> tuple[str, Optional[str], Optional[str]]:
        """Resolve authoritative identity for a brokered request.

        Remote BYOA messages are untrusted even after the SQL wrapper verifies
        their source name. The broker only accepts them while there is a
        matching active task and derives character/actor identity from the
        pending task payload it created, not from fields supplied by the
        remote process.
        """
        source = getattr(message, "source", "") or ""
        incoming_task_id = task_id if task_id is not None else getattr(message, "task_id", "")

        if self._is_byoa_runner_name(source):
            raise PermissionError("unauthorized_byoa_source")

        if self._is_byoa_agent_name(source):
            ctx = self._byoa_active_agents.get(source)
            if not ctx:
                raise PermissionError("unauthorized_byoa_source")
            expected_task_id = str(ctx.get("task_id") or "")
            if not incoming_task_id or str(incoming_task_id) != expected_task_id:
                raise PermissionError("unauthorized_byoa_task")
            return (
                str(ctx.get("character_id") or ""),
                str(ctx.get("actor_character_id") or "") or None,
                expected_task_id,
            )

        child = next(
            (c for c in self.children if isinstance(c, TaskAgent) and c.name == source),
            None,
        )
        if child is not None:
            actor = child._task_metadata.get("actor_character_id") if child._task_metadata else None
            return (
                child._character_id,
                actor if isinstance(actor, str) else None,
                child._active_task_id or (str(incoming_task_id) if incoming_task_id else None),
            )

        return (
            str(getattr(message, "character_id", "") or ""),
            str(getattr(message, "actor_character_id", "") or "") or None,
            str(incoming_task_id) if incoming_task_id else None,
        )

    async def on_bus_message(self, message: BusMessage) -> None:
        """Dispatch typed messages; delegate everything else upstream."""
        # Targeted messages for other agents are ignored upstream; mirror
        # that here so we don't broker requests addressed to siblings.
        if (
            getattr(message, "target", None)
            and message.target != self.name
        ):
            await super().on_bus_message(message)
            return

        if isinstance(message, BusGameToolCallRequest):
            await self._on_game_tool_call_request(message)
        elif isinstance(message, BusCombatStrategyRequest):
            await self._on_combat_strategy_request(message)
        elif isinstance(message, BusCorporationQueryRequest):
            await self._on_corporation_query_request(message)
        elif isinstance(message, BusTaskFinishNotification):
            await self._on_task_finish_notification(message)
        elif isinstance(message, BusByoaPresenceMessage):
            await self._on_byoa_presence(message)
        elif isinstance(message, BusAgentHelloResponse):
            self._resolve_hello_response(message)

        await super().on_bus_message(message)

    async def _on_byoa_presence(self, message: BusByoaPresenceMessage) -> None:
        """Track external BYOA runner process liveness and push it to RTVI."""
        ship_id = (message.ship_id or "").strip()
        source = getattr(message, "source", "") or ""
        if not ship_id or source != self.byoa_agent_name(ship_id):
            logger.warning(
                f"byoa.presence_ignored source={source!r} ship={ship_id[:8]!r}"
            )
            return

        if ship_id not in self._byoa_known_ships:
            owner = await self._lookup_byoa_owner(ship_id)
            if not owner:
                logger.warning(
                    f"byoa.presence_ignored_not_claimed source={source!r} ship={ship_id[:8]}"
                )
                return
            self._byoa_known_ships.add(ship_id)

        online = bool(message.online)
        status = "online" if online else "offline"
        last_seen_at = message.last_seen_at
        now = time.monotonic()
        previous = self._byoa_presence.get(ship_id)
        self._byoa_presence[ship_id] = _ByoaPresence(
            ship_id=ship_id,
            online=online,
            status=status,
            last_seen_at=last_seen_at,
            last_seen_monotonic=now,
        )

        if online:
            self._ensure_byoa_presence_sweeper()
        else:
            # Child harness reported on_finished — invalidate its registry
            # entry so the next watch_agent waits for a fresh ready event
            # instead of synchronously dispatching against a dead child.
            self._invalidate_byoa_registry_entry(self.byoa_agent_name(ship_id))

        changed = previous is None or previous.online != online or previous.status != status
        if changed:
            await self._push_byoa_presence(
                ship_id=ship_id,
                online=online,
                status=status,
                last_seen_at=last_seen_at,
            )

    async def _push_byoa_presence(
        self,
        *,
        ship_id: str,
        online: bool,
        status: str,
        last_seen_at: Optional[str],
    ) -> None:
        await self._rtvi.push_frame(
            RTVIServerMessageFrame(
                {
                    "frame_type": "event",
                    "event": "byoa.presence",
                    "payload": {
                        "ship_id": ship_id,
                        "online": online,
                        "status": status,
                        "last_seen_at": last_seen_at,
                    },
                }
            )
        )

    def _ensure_byoa_presence_sweeper(self) -> None:
        if self._byoa_presence_sweep_task is None or self._byoa_presence_sweep_task.done():
            self._byoa_presence_sweep_task = asyncio.create_task(
                self._byoa_presence_sweep_loop(),
                name="byoa_presence_sweeper",
            )

    async def _byoa_presence_sweep_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(BYOA_PRESENCE_SWEEP_SECONDS)
                if not self._byoa_presence:
                    return
                await self._mark_stale_byoa_presence_offline()
        except asyncio.CancelledError:
            return
        finally:
            if asyncio.current_task() is self._byoa_presence_sweep_task:
                self._byoa_presence_sweep_task = None

    async def _mark_stale_byoa_presence_offline(self) -> None:
        now = time.monotonic()
        for ship_id, presence in list(self._byoa_presence.items()):
            if (
                presence.online
                and now - presence.last_seen_monotonic > BYOA_PRESENCE_STALE_SECONDS
            ):
                self._byoa_presence[ship_id] = replace(
                    presence,
                    online=False,
                    status="offline",
                )
                self._invalidate_byoa_registry_entry(self.byoa_agent_name(ship_id))
                await self._push_byoa_presence(
                    ship_id=ship_id,
                    online=False,
                    status="offline",
                    last_seen_at=presence.last_seen_at,
                )
                # If this BYOA was running a task, the bot is the only
                # authority on its lock. Release it locally and emit a
                # task.cancel event so downstream consumers (event log, UI)
                # see the task ended. The zombie BYOA (if still alive) won't
                # affect this bot's state — any belated bus messages tagged
                # with the cancelled task_id are filtered out by TaskAgent.
                await self._release_lock_on_byoa_offline(ship_id)

    async def _release_lock_on_byoa_offline(self, ship_character_id: str) -> None:
        framework_task_id = self._locked_ships.pop(ship_character_id, None)
        if not framework_task_id:
            return
        logger.warning(
            f"byoa.presence_stale ship={ship_character_id[:8]} "
            f"task={framework_task_id[:8]} releasing lock locally"
        )
        try:
            await self._game_client.task_cancel(
                task_id=framework_task_id,
                character_id=self._character_id,
            )
        except Exception as exc:
            logger.warning(
                f"byoa.presence_stale task_cancel emit failed for "
                f"ship={ship_character_id[:8]} task={framework_task_id[:8]}: {exc}"
            )
        try:
            await self.send_message(
                BusEndAgentMessage(
                    source=self.name,
                    target=self.byoa_agent_name(ship_character_id),
                    reason="byoa_offline",
                )
            )
        except Exception as exc:
            logger.warning(
                f"byoa.presence_stale end_agent failed for "
                f"ship={ship_character_id[:8]}: {exc}"
            )

    def _invalidate_byoa_registry_entry(self, agent_name: str) -> None:
        """Pop a BYOA agent from pipecat's AgentRegistry.

        BYOA agents are one-shot: each wake spawns a fresh child that
        advertises ready, runs one task, and exits. The framework
        registry is sticky (no public deregister API) so without this
        helper a subsequent ``watch_agent`` synchronously fires
        ``on_agent_ready`` against a dead child and blocks on its
        unanswerable hello handshake.

        Reaches into private state because pipecat-subagents 0.4's
        AgentRegistry exposes ``register``/``watch``/``get`` but no
        removal — swap for a public API once the library grows one.
        """
        registry = getattr(self, "_registry", None)
        if registry is None:
            return
        local_agents = getattr(registry, "_local_agents", None)
        if isinstance(local_agents, dict):
            local_agents.pop(agent_name, None)
        remote_runners = getattr(registry, "_remote_runners", None)
        if isinstance(remote_runners, dict):
            for remote_agents in remote_runners.values():
                if isinstance(remote_agents, dict):
                    remote_agents.pop(agent_name, None)

    def _resolve_hello_response(self, message: BusAgentHelloResponse) -> None:
        """Resolve the awaiting hello future for ``correlation_id``.

        Two cases:

        - ``correlation_id`` set + matches a pending request: the hello
          handshake path. ``ready=True`` resolves the awaiting future;
          ``ready=False`` rejects with the agent's error string.
        - ``correlation_id`` empty/missing: an unsolicited "I'm online"
          broadcast from a BYOA agent that just cold-started. The actual
          dispatch is driven by ``on_agent_ready`` (registry-level signal);
          this branch just logs the signal for observability.

        Late or unknown correlation_ids are silent no-ops on PendingRequests.
        """
        if not message.correlation_id:
            # Unsolicited online signal — log and let on_agent_ready drive
            # the dispatch + watchdog cancellation.
            source = getattr(message, "source", None) or "<unknown>"
            if message.ready:
                logger.info(f"byoa.online_signal source={source!r}")
            else:
                logger.warning(
                    f"byoa.online_signal_not_ready source={source!r} "
                    f"error={message.error!r}"
                )
            return
        if message.ready:
            self._hello_pending.resolve(message.correlation_id, message)
        else:
            self._hello_pending.reject(
                message.correlation_id,
                message.error or "agent reported not ready",
            )

    def _broker_tool_kwargs(
        self, method: Callable[..., Any], args: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Return user/tool args only, with identity kept out of method kwargs.

        The broker applies authoritative identity through ContextVars at the
        Supabase transport boundary. Some legacy client methods still require
        a ``character_id`` argument and validate it against the bound player
        client before calling ``_request``; pass the bound player id only to
        satisfy that local signature. ``_inject_character_ids`` overwrites the
        outbound payload with the broker envelope identity later.
        """
        kwargs = {
            key: value
            for key, value in dict(args).items()
            if key not in {"character_id", "actor_character_id"}
        }
        try:
            signature = inspect.signature(method)
        except (TypeError, ValueError):
            return kwargs

        character_param = signature.parameters.get("character_id")
        if (
            character_param is not None
            and character_param.default is inspect.Parameter.empty
            and character_param.kind
            in (
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
                inspect.Parameter.KEYWORD_ONLY,
            )
            and "character_id" not in kwargs
        ):
            kwargs["character_id"] = self._character_id
        return kwargs

    async def _on_game_tool_call_request(
        self, msg: BusGameToolCallRequest
    ) -> None:
        """Dispatch a TaskAgent tool call to the player-bound game client.

        ``character_id`` and ``actor_character_id`` from the envelope
        are applied through per-call ContextVars at the Supabase transport
        boundary, not passed through heterogeneous Python method signatures.
        The broker is the trust boundary between TaskAgent / future BYOA
        senders and the edge functions, so identity keys in ``msg.args`` are
        stripped before dispatch and cannot hijack the envelope identity.

        ``task_id`` propagates via a ContextVar (``per_call_task_id``) for
        the duration of the call rather than by mutating the shared
        client's ``current_task_id`` field; that mutation would race when
        two concurrent brokered RPCs are in flight on the same client.
        """
        result: Optional[Dict[str, Any]] = None
        error: Optional[str] = None
        method = getattr(self._game_client, msg.tool_name, None)
        try:
            character_id, actor_character_id, task_id = self._broker_identity_for_message(
                msg,
                task_id=msg.task_id or None,
            )
            if method is None or not callable(method):
                error = f"unknown tool: {msg.tool_name!r}"
            else:
                kwargs = self._broker_tool_kwargs(method, msg.args)
                with per_call_identity(
                    character_id or None,
                    actor_character_id or None,
                ), per_call_task_id(task_id or None):
                    raw = await method(**kwargs)
                result = raw if isinstance(raw, dict) else {"result": raw}
        except Exception as exc:
            logger.warning(
                f"broker game_tool_call({msg.tool_name}) failed: {exc}"
            )
            error = str(exc)

        await self.send_message(
            BusGameToolCallResponse(
                source=self.name,
                target=msg.source,
                correlation_id=msg.correlation_id,
                result=result,
                error=error,
            )
        )

    async def _on_combat_strategy_request(
        self, msg: BusCombatStrategyRequest
    ) -> None:
        strategy: Optional[Dict[str, Any]] = None
        error: Optional[str] = None
        try:
            character_id, _actor_character_id, _task_id = self._broker_identity_for_message(
                msg,
                task_id=msg.task_id or None,
            )
            if self._is_byoa_agent_name(msg.source) and msg.ship_id and msg.ship_id != character_id:
                raise PermissionError("unauthorized_byoa_ship")
            kwargs: Dict[str, Any] = {"character_id": character_id}
            if msg.ship_id:
                kwargs["ship_id"] = msg.ship_id
            raw = await self._game_client.combat_get_strategy(**kwargs)
            strategy = raw if isinstance(raw, dict) else {"strategy": raw}
        except Exception as exc:
            logger.warning(f"broker combat_strategy failed: {exc}")
            error = str(exc)

        await self.send_message(
            BusCombatStrategyResponse(
                source=self.name,
                target=msg.source,
                correlation_id=msg.correlation_id,
                strategy=strategy,
                error=error,
            )
        )

    async def _on_corporation_query_request(
        self, msg: BusCorporationQueryRequest
    ) -> None:
        result: Optional[Dict[str, Any]] = None
        error: Optional[str] = None
        try:
            character_id, _actor_character_id, _task_id = self._broker_identity_for_message(
                msg,
                task_id=msg.task_id or None,
            )
            if msg.query_type == "list":
                raw = await self._game_client._request("corporation.list", {})
            elif msg.query_type == "info":
                if not msg.corp_id:
                    raise ValueError("corp_id required for query_type='info'")
                raw = await self._game_client._request(
                    "corporation.info",
                    {"character_id": character_id, "corp_id": msg.corp_id},
                )
            elif msg.query_type == "my":
                raw = await self._game_client._request(
                    "my_corporation",
                    {"character_id": character_id},
                )
            else:
                raise ValueError(f"unknown query_type: {msg.query_type!r}")
            result = raw if isinstance(raw, dict) else {"result": raw}
        except Exception as exc:
            logger.warning(f"broker corp_query({msg.query_type}) failed: {exc}")
            error = str(exc)

        await self.send_message(
            BusCorporationQueryResponse(
                source=self.name,
                target=msg.source,
                correlation_id=msg.correlation_id,
                result=result,
                error=error,
            )
        )

    async def _on_task_finish_notification(
        self, msg: BusTaskFinishNotification
    ) -> None:
        """Fire-and-forget — call task_lifecycle(finish) and log on failure.

        Server-side this triggers the pair-matched ship-lock release.
        No response message; the bundled TaskAgent already finishes its
        own bookkeeping before sending this.

        actor_character_id is forwarded explicitly. For a BYOA
        corp ship the server's owner-only check is keyed on this field,
        and defaulting it to character_id (the pseudo-character) would
        403 the finish and leave the lock until stale recovery.
        """
        task_metadata: Dict[str, Any] = {}
        try:
            character_id, actor_character_id, _task_id = self._broker_identity_for_message(
                msg,
                task_id=msg.task_id,
            )
            if actor_character_id:
                task_metadata["actor_character_id"] = actor_character_id
            await self._game_client.task_lifecycle(
                character_id=character_id,
                task_id=msg.task_id,
                event_type="finish",
                task_status=msg.status,
                task_summary=msg.summary,
                task_metadata=task_metadata or None,
            )
        except Exception as exc:
            # Task is already done from the agent's POV; log and move on.
            logger.warning(
                f"broker task_finish failed for {msg.task_id[:8]}: {exc}"
            )

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
            agent_name = None
            target_character_id = None
            try:
                task_desc = params.arguments.get("task_description", "")
                explicit_context = params.arguments.get("context")
                ship_id = params.arguments.get("ship_id")

                if isinstance(ship_id, str):
                    ship_id = ship_id.strip().strip("[]")

                resolved_ship: Optional[dict] = None
                if ship_id and not self._is_valid_uuid(ship_id):
                    try:
                        resolved_ship = await self._resolve_ship_id_prefix(ship_id)
                    except ValueError as exc:
                        return {"success": False, "error": str(exc)}
                    if not resolved_ship:
                        return {"success": False, "error": f"Unknown ship_id '{ship_id}'."}
                    ship_id = resolved_ship.get("ship_id")

                # If ship_id is the player's character_id, or resolves to their
                # personal ship rather than a corp ship, treat as a player task.
                corp_ship_name: Optional[str] = None
                if ship_id:
                    if ship_id == self._character_id:
                        ship_id = None
                    elif resolved_ship is not None:
                        # Came from corp.ships — known corp ship, name in hand.
                        # Skips a second `my_corporation` RPC.
                        name = resolved_ship.get("name")
                        if isinstance(name, str) and name.strip():
                            corp_ship_name = name
                    else:
                        is_corp, corp_ship_name = await self._is_corp_ship_id(ship_id)
                        if not is_corp:
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
                            c
                            for c in self.children
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
                                tid
                                for tid, group in self._task_groups.items()
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
                    "ship_name": corp_ship_name,
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
                        (
                            c
                            for c in self.children
                            if isinstance(c, TaskAgent)
                            and not c._is_corp_ship
                            and not c._active_task_id
                        ),
                        None,
                    )
                    if existing:
                        # Same ordering as a new agent: emit task.start
                        # (which gates BYOA-owner auth) before dispatching,
                        # so the child can't run tools without a (ship_id,
                        # task_id) pair.
                        framework_task_id = str(uuid.uuid4())
                        server_err = await self._acquire_server_ship_lock(
                            target_character_id=target_character_id,
                            framework_task_id=framework_task_id,
                            task_desc=task_desc,
                            task_metadata=task_metadata,
                            task_status=None,
                        )
                        if server_err:
                            return server_err
                        self._locked_ships[target_character_id] = framework_task_id
                        # Universal hello handshake before dispatching to
                        # the reused idle TaskAgent. For an in-process child
                        # this returns ~immediately; for a future remote
                        # BYOA agent this is where the cold-start wait
                        # lives. On failure release the lock so a follow-up
                        # start_task can immediately retry.
                        try:
                            await self._send_hello_and_wait(existing.name)
                        except (asyncio.TimeoutError, RuntimeError) as exc:
                            logger.warning(
                                f"reuse-path hello with '{existing.name}' failed: {exc}"
                            )
                            self._locked_ships.pop(target_character_id, None)
                            try:
                                await self._game_client.task_cancel(
                                    task_id=framework_task_id,
                                    character_id=self._character_id,
                                )
                            except Exception as release_exc:
                                logger.warning(
                                    f"task_cancel after reuse hello failure errored: {release_exc}"
                                )
                            return {
                                "success": False,
                                "error": (
                                    "Task agent didn't acknowledge wake-up in time. "
                                    "Try again in a moment."
                                ),
                            }
                        try:
                            await self._dispatch_task_with_id(
                                existing.name,
                                framework_task_id,
                                payload=payload,
                                timeout=self._task_agent_timeout,
                            )
                        except Exception:
                            self._locked_ships.pop(target_character_id, None)
                            try:
                                await self._game_client.task_cancel(
                                    task_id=framework_task_id,
                                    character_id=self._character_id,
                                )
                            except Exception as exc:
                                logger.warning(
                                    f"task_cancel after reuse dispatch failure errored: {exc}"
                                )
                            raise
                        self._update_polling_scope()
                        return {
                            "success": True,
                            "message": "Task started",
                            "task_id": framework_task_id,
                            "task_type": task_type,
                            "ship_character_id": target_character_id,
                        }

                # Corp-ship and player-ship TaskAgents both go over the bus
                # to VoiceAgent's broker. No separate AsyncGameClient is
                # constructed per task — the broker uses the player-bound
                # client and overrides character_id / actor_character_id per
                # call from each inbound BusGameToolCallRequest.

                # Pre-generate the framework task UUID so we can return it to
                # the LLM immediately. The bus name `task_xxxxxx` is purely
                # internal routing; the framework UUID is the only identifier
                # the LLM (and event_relay) ever sees.
                framework_task_id = str(uuid.uuid4())

                byoa_owner_id: Optional[str] = None
                if ship_id:
                    byoa_owner_id = await self._lookup_byoa_owner(ship_id)
                    if byoa_owner_id:
                        self._byoa_known_ships.add(ship_id)
                        current_prefix = self._character_id.replace("-", "").lower()
                        owner_prefix = byoa_owner_id.replace("-", "").lower()
                        if not current_prefix.startswith(owner_prefix):
                            return {
                                "success": False,
                                "error": (
                                    f"This is member {byoa_owner_id}'s BYOA ship. "
                                    "Only the BYOA owner can start tasks for it "
                                    "in this version."
                                ),
                            }
                        # Presence broadcasts happen within this VoiceAgent's
                        # per-session channel. A local BYOA process must have
                        # been started with that channel; remote wake will
                        # eventually spawn one with the same value. The
                        # wake-timeout watchdog handles the missing-process
                        # case and releases the lock after
                        # agent_wake_timeout_seconds.

                # Server-side acquire BEFORE spawning the TaskAgent. A 409
                # ship_busy or 403 byoa_private_not_owner here surfaces as a
                # user-facing error without ever creating the local child.
                server_err = await self._acquire_server_ship_lock(
                    target_character_id=target_character_id,
                    framework_task_id=framework_task_id,
                    task_desc=task_desc,
                    task_metadata=task_metadata,
                    task_status="waking" if byoa_owner_id else None,
                )
                if server_err:
                    return server_err

                # BYOA dispatch. When the corp ship is BYOA-claimed the
                # task runs in an operator-owned process subscribed to the
                # bus. We don't spawn a local TaskAgent — we just publish
                # to the operator's queue and wait for the bus
                # advertisement (via the existing on_agent_ready path).
                # The watchdog releases the lock if no agent ever responds.
                # BYOA workers are one-task processes, so every task is
                # marked waking and every task calls wake_agent; presence is
                # only liveness/UI state, never a dispatch shortcut.
                if byoa_owner_id:
                    byoa_agent_name = self.byoa_agent_name(target_character_id)
                    # task_metadata.task_id is the stale-task guard the
                    # operator's agent checks against ship.current_task_id
                    # before doing real work. Include the framework id
                    # explicitly so a delayed wake reading a queued task
                    # knows what to validate against.
                    task_metadata["task_id"] = framework_task_id
                    payload = dict(payload)
                    payload["task_metadata"] = task_metadata
                    # Reuse the standard pending-tasks path so on_agent_ready
                    # dispatches as usual when the operator's agent advertises.
                    self._pending_tasks[byoa_agent_name] = (framework_task_id, payload)
                    self._locked_ships[target_character_id] = framework_task_id
                    # Register watchdog before watch_agent so a same-tick
                    # ready event can cancel it cleanly.
                    self._pending_wakes[target_character_id] = asyncio.create_task(
                        self._watch_wake_timeout(
                            target_character_id=target_character_id,
                            framework_task_id=framework_task_id,
                            agent_name=byoa_agent_name,
                        ),
                        name=f"byoa_wake_watchdog_{framework_task_id[:8]}",
                    )
                    try:
                        await self.watch_agent(byoa_agent_name)
                    except Exception as exc:
                        logger.warning(
                            f"byoa.watch_agent_failed name={byoa_agent_name} error={exc!r}"
                        )
                        # Roll back local state; the watchdog will still
                        # cancel the task and clear local state if cleanup
                        # races us.
                        watchdog = self._pending_wakes.pop(target_character_id, None)
                        if watchdog and not watchdog.done():
                            watchdog.cancel()
                        self._pending_tasks.pop(byoa_agent_name, None)
                        self._locked_ships.pop(target_character_id, None)
                        try:
                            await self._game_client.task_cancel(
                                task_id=framework_task_id,
                                character_id=self._character_id,
                                force=True,
                            )
                        except Exception as release_exc:
                            logger.warning(
                                f"byoa.watch_agent_failed.release error={release_exc!r}"
                            )
                        return {"success": False, "error": str(exc)}
                    # Always fire wake_agent. The BYOA pattern is wake → task
                    # → exit, so each new task needs a fresh harness; the
                    # previous "skip wake when presence is fresh" optimization
                    # was racy (presence cache lagging the just-exited
                    # harness's offline broadcast caused the next task to
                    # silently time out). wake_agent is a notification —
                    # cheap and idempotent on the receive side. The tool
                    # returns immediately with status="waking" so the LLM
                    # keeps talking instead of blocking on the HTTP
                    # round-trip. On failure the dispatcher cancels the
                    # watchdog, tears down local state, cancels the task,
                    # and surfaces a task.cancelled event via the deferred-
                    # update queue (same path the watchdog uses).
                    asyncio.create_task(
                        self._dispatch_byoa_wake(
                            target_character_id=target_character_id,
                            framework_task_id=framework_task_id,
                            agent_name=byoa_agent_name,
                        ),
                        name=f"byoa_wake_dispatch_{framework_task_id[:8]}",
                    )
                    if byoa_agent_name not in self._pending_tasks:
                        return {
                            "success": True,
                            "message": "Task started",
                            "status": "active",
                            "task_id": framework_task_id,
                            "task_type": task_type,
                            "ship_character_id": target_character_id,
                        }
                    return {
                        "success": True,
                        "message": "Task started",
                        "status": "waking",
                        "task_id": framework_task_id,
                        "task_type": task_type,
                        "ship_character_id": target_character_id,
                    }

                agent_name = f"task_{uuid.uuid4().hex[:6]}"
                task_agent = TaskAgent(
                    agent_name,
                    bus=self._bus,
                    character_id=target_character_id,
                    is_corp_ship=bool(ship_id),
                    task_metadata=task_metadata,
                    tag_outbound_rpcs_with_task_id=bool(ship_id),
                    byoa_config=self._byoa_config,
                )

                # Lock ship BEFORE add_agent — if add_agent partially fails
                # (child in _children but pipeline not started), the ship stays
                # locked so no second agent can be added for it. The
                # task.start event already emitted; the local _locked_ships
                # entry is the only thing still to wire up.
                self._pending_tasks[agent_name] = (framework_task_id, payload)
                self._locked_ships[target_character_id] = framework_task_id
                try:
                    await self.add_agent(task_agent)
                    # pipecat-subagents 0.4 requires explicit watch_agent for
                    # on_agent_ready to fire on dynamically-spawned children.
                    # Without it, _pending_tasks is never drained.
                    await self.watch_agent(agent_name)
                except Exception:
                    self._locked_ships.pop(target_character_id, None)
                    self._pending_tasks.pop(agent_name, None)
                    self._children = [c for c in self._children if c.name != agent_name]
                    # Best-effort task cancel so a partially-spawned agent
                    # doesn't leave a dangling task.
                    try:
                        await self._game_client.task_cancel(
                            task_id=framework_task_id,
                            character_id=self._character_id,
                        )
                    except Exception as exc:
                        logger.warning(f"task_cancel after add_agent failure errored: {exc}")
                    try:
                        await self.send_message(
                            BusEndAgentMessage(
                                source=self.name, target=agent_name, reason="startup failed"
                            )
                        )
                    except Exception:
                        pass
                    raise

                return {
                    "success": True,
                    "message": "Task started",
                    "task_id": framework_task_id,
                    "task_type": task_type,
                    "ship_character_id": target_character_id,
                }
            except Exception as e:
                logger.error(f"start_task failed: {e}")
                if target_character_id:
                    self._locked_ships.pop(target_character_id, None)
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
                    (
                        tid
                        for tid, group in self._task_groups.items()
                        if child.name in group.agent_names
                    ),
                    None,
                )
                if framework_task_id is None:
                    return {"success": False, "error": "No active task group for player ship"}

            # Release the ship lock synchronously so a follow-up start_task in
            # the same turn can proceed. on_task_response releases the lock
            # too, but it blocks on `tool_call_active` which is held by *this*
            # tool call — so the async release can't land until we return.
            # `.pop(..., None)` is idempotent, so the later release is a no-op.
            await self._game_client.task_cancel(
                task_id=framework_task_id,
                character_id=self._character_id,
            )
            self._locked_ships.pop(child._character_id, None)

            await self.cancel_task(framework_task_id, reason="Cancelled by user")
            task_type = "corp_ship" if child._is_corp_ship else "player_ship"
            return {
                "success": True,
                "message": "Task cancelled",
                "task_id": framework_task_id,
                "task_type": task_type,
                "ship_character_id": child._character_id,
            }
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
            "ship_character_id": child._character_id,
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
                (
                    tid
                    for tid, group in self._task_groups.items()
                    if child.name in group.agent_names
                ),
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
        """Cancel all active tasks and end all task agent pipelines.

        Order is load-bearing: stop background sweepers + wake watchdogs
        first, emit task.cancel events for each held lock, then cancel
        framework tasks, then end pipelines, then clear local state.
        """
        # 1. Stop background sweepers so they can't fire during teardown.
        if self._byoa_presence_sweep_task and not self._byoa_presence_sweep_task.done():
            self._byoa_presence_sweep_task.cancel()
        self._byoa_presence_sweep_task = None

        # 1a. Cancel any BYOA wake watchdogs so they don't fire mid-shutdown.
        for watchdog in list(self._pending_wakes.values()):
            if not watchdog.done():
                watchdog.cancel()
        self._pending_wakes.clear()

        # 2. Emit task.cancel event for each held lock so downstream
        # consumers (event log, UI history) see the task ended. The bot is
        # the only authority on the in-memory lock; clearing _locked_ships
        # in step 5 is what actually releases the ship.
        for ship_character_id, framework_task_id in list(self._locked_ships.items()):
            try:
                await self._game_client.task_cancel(
                    task_id=framework_task_id,
                    character_id=self._character_id,
                )
            except Exception as exc:
                logger.warning(
                    f"close_tasks: task_cancel emit failed for ship "
                    f"{ship_character_id[:8]} task {framework_task_id[:8]}: {exc}"
                )

        # 3. Framework-level cancellation. Sends BusTaskCancel; TaskAgents
        # run their own cancel flow.
        for task_id in list(self._task_groups.keys()):
            try:
                await self.cancel_task(task_id, reason="Disconnected")
            except Exception as e:
                logger.error(f"Failed to cancel task: {e}")

        # 4. End any remaining task agent pipelines (including idle player agent)
        for child in list(self._children):
            if isinstance(child, TaskAgent):
                try:
                    await self.send_message(
                        BusEndAgentMessage(
                            source=self.name, target=child.name, reason="Disconnected"
                        )
                    )
                except Exception as e:
                    logger.error(f"Failed to end task agent '{child.name}': {e}")
        self._children = [c for c in self._children if not isinstance(c, TaskAgent)]
        self._locked_ships.clear()

    # ── task.start emit ────────────────────────────────────────────────

    async def _acquire_server_ship_lock(
        self,
        *,
        target_character_id: str,
        framework_task_id: str,
        task_desc: str,
        task_metadata: Dict[str, Any],
        task_status: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Emit ``task_lifecycle event_type=start``; translate a BYOA 403
        into a user-facing error dict.

        The in-memory ``_locked_ships`` is the authority on ship busy-ness;
        this just fires the lifecycle event so downstream consumers see the
        transition.

        Returns:
            ``None`` on success, or a ``{"success": False, "error": ...}``
            dict on a 403 BYOA-owner failure. Other RPC errors re-raise.
        """
        try:
            await self._game_client.task_lifecycle(
                character_id=target_character_id,
                task_id=framework_task_id,
                event_type="start",
                task_description=task_desc,
                task_metadata=task_metadata,
                task_status=task_status,
            )
            return None
        except RPCError as err:
            body = err.body if isinstance(err.body, dict) else {}
            err_code = body.get("error") if isinstance(body, dict) else None
            if err.status == 403 and err_code == "byoa_private_not_owner":
                owner_prefix = body.get("byoa_owner_character_id_prefix")
                owner_desc = f"member {owner_prefix}" if owner_prefix else "another corp member"
                return {
                    "success": False,
                    "error": (
                        f"This is {owner_desc}'s BYOA ship. Only the BYOA "
                        "owner can issue tasks to it in this version."
                    ),
                }
            raise

    async def _send_hello_and_wait(self, agent_name: str) -> BusAgentHelloResponse:
        """Send a BusAgentHelloRequest to ``agent_name`` and await the response.

        Universal liveness probe. For an in-process TaskAgent the response is
        essentially instant; for a BYOA agent the round-trip covers the
        cold-start window. Times out per
        ``ByoaAgentConfig.agent_wake_timeout_seconds``.

        Raises:
            asyncio.TimeoutError: Target didn't respond in time.
            RuntimeError: Target responded ``ready=false`` (treat as a
                warm-up failure — caller should release the ship lock).
        """
        correlation_id = uuid.uuid4().hex
        await self.send_message(
            BusAgentHelloRequest(
                source=self.name,
                target=agent_name,
                correlation_id=correlation_id,
            )
        )
        return await self._hello_pending.issue(
            correlation_id,
            timeout=self._byoa_config.agent_wake_timeout_seconds,
        )

    def byoa_agent_name(self, target_character_id: str) -> str:
        """Bus identity convention for a remote BYOA agent.

        The operator's ``uv run byoa`` CLI advertises itself with this exact
        name so the bot can target it via ``watch_agent`` / ``request_task``.
        Format: ``byoa_<ship_id>`` with the full UUID (dashes kept).
        """
        return f"byoa_{target_character_id}"

    async def _lookup_byoa_owner(self, ship_id: str) -> Optional[str]:
        """Return the BYOA owner character_id for ``ship_id``, or None.

        Hits ``my_corporation`` to read the ``byoa`` block surfaced by
        ``_shared/corporations.ts``. Truthy return means the ship is
        BYOA-claimed (route via wake_agent); None means in-process spawn.
        """
        try:
            corp_result = await self._game_client._request(
                "my_corporation",
                {"character_id": self._character_id},
            )
        except Exception as exc:
            logger.warning(f"_lookup_byoa_owner failed: {exc}")
            return None
        corp = corp_result.get("corporation") if isinstance(corp_result, dict) else None
        if not isinstance(corp, dict):
            return None
        ships = corp.get("ships")
        if not isinstance(ships, list):
            return None
        for ship in ships:
            if not isinstance(ship, dict):
                continue
            if ship.get("ship_id") != ship_id:
                continue
            byoa = ship.get("byoa")
            if not isinstance(byoa, dict):
                return None
            # The corp payload exposes a truncated 12-char prefix, not the
            # full UUID. That's enough as a routing hint for the wake_agent
            # call (the server re-resolves the owner from the row).
            owner_prefix = byoa.get("owner_character_id_prefix")
            return owner_prefix if isinstance(owner_prefix, str) and owner_prefix else None
        return None

    async def _call_wake_agent(
        self,
        *,
        task_id: str,
        ship_id: str,
    ) -> Dict[str, Any]:
        """Call the server-side ``wake_agent`` endpoint and return spawn status."""
        if not self._byoa_bus_channel:
            logger.warning(
                f"byoa.wake_agent.skipped ship={ship_id[:8]} reason=no_bus_channel"
            )
            return {"spawn_target": "none", "spawn_status": "missing_bus_channel"}
        try:
            result = await self._game_client.wake_agent(
                ship_id=ship_id,
                channel=self._byoa_bus_channel,
                task_id=task_id,
            )
            spawn_target = str(result.get("spawn_target") or "unknown")
            spawn_status = str(result.get("spawn_status") or "unknown")
            logger.info(
                f"byoa.wake_agent.called ship={ship_id[:8]} "
                f"task={task_id[:8]} channel_prefix={self._byoa_bus_channel[:11]} "
                f"spawn_target={spawn_target!r} spawn_status={spawn_status!r}"
            )
            return result
        except RPCError as exc:
            body = exc.body if isinstance(exc.body, dict) else {}
            spawn_target = str(body.get("spawn_target") or "error")
            spawn_status = str(body.get("spawn_status") or "call_failed")
            logger.warning(
                f"byoa.wake_agent.call_failed ship={ship_id[:8]} "
                f"spawn_target={spawn_target!r} spawn_status={spawn_status!r} "
                f"error={exc!r}"
            )
            return {
                "spawn_target": spawn_target,
                "spawn_status": spawn_status,
                "error": str(body.get("error") or exc.detail),
            }
        except Exception as exc:
            logger.warning(
                f"byoa.wake_agent.call_failed ship={ship_id[:8]} error={exc!r}"
            )
            return {
                "spawn_target": "error",
                "spawn_status": "call_failed",
                "error": repr(exc),
            }

    def _byoa_wake_failure_message(
        self,
        wake_result: Dict[str, Any],
        *,
        ship_id: str,
    ) -> Optional[str]:
        target = str(wake_result.get("spawn_target") or "unknown")
        status = str(wake_result.get("spawn_status") or "unknown")
        if target == "http" and status == "accepted":
            return None
        if target == "noop":
            return (
                "BYOA wake is configured as noop and no runner is online for "
                f"ship {ship_id[:8]}. Set BYOA_WAKE_TARGET=http and run "
                "`uv run byoa --serve`, or start a manual BYOA runner before "
                "assigning the task."
            )
        return f"BYOA wake failed before the runner came online ({target}/{status})."

    async def _dispatch_byoa_wake(
        self,
        *,
        target_character_id: str,
        framework_task_id: str,
        agent_name: str,
    ) -> None:
        """Fire ``wake_agent`` off the start_task hot path.

        Returning the tool result immediately is the goal — the LLM keeps
        talking and the player UI shows ``waking`` while wake_agent does
        its HTTP round-trip. On failure we mirror ``_watch_wake_timeout``'s
        cleanup so the task doesn't get stuck waking.
        """
        wake_result = await self._call_wake_agent(
            task_id=framework_task_id,
            ship_id=target_character_id,
        )
        wake_error = self._byoa_wake_failure_message(
            wake_result,
            ship_id=target_character_id,
        )
        if not wake_error:
            return
        # A `task.started` event for this task has already been consumed by
        # on_agent_ready — bail out so we don't double-cancel a live task.
        if agent_name not in self._pending_tasks:
            logger.info(
                f"byoa.wake_agent.rejected.no_pending ship={target_character_id[:8]} "
                f"task={framework_task_id[:8]} (agent already ready)"
            )
            return
        logger.warning(
            f"byoa.wake_agent.rejected ship={target_character_id[:8]} "
            f"task={framework_task_id[:8]} error={wake_error!r}"
        )
        watchdog = self._pending_wakes.pop(target_character_id, None)
        if watchdog is not None and not watchdog.done():
            watchdog.cancel()
        self._pending_tasks.pop(agent_name, None)
        if self._locked_ships.get(target_character_id) == framework_task_id:
            self._locked_ships.pop(target_character_id, None)
        self._invalidate_byoa_registry_entry(agent_name)
        try:
            await self._game_client.task_cancel(
                task_id=framework_task_id,
                character_id=self._character_id,
                force=True,
            )
        except Exception as release_exc:
            logger.warning(
                f"byoa.wake_agent.rejected.release error={release_exc!r}"
            )
        self._enqueue_deferred_update(
            (
                f'<event name="task.cancelled" task_id="{framework_task_id[:8]}" '
                'task_type="corp_ship">\n'
                f"{wake_error}\n"
                "</event>"
            ),
            ship_id=target_character_id,
        )

    async def _watch_wake_timeout(
        self,
        *,
        target_character_id: str,
        framework_task_id: str,
        agent_name: str,
    ) -> None:
        """Watchdog that fires after ``agent_wake_timeout_seconds`` if the
        BYOA agent never advertises ready.

        Cancellation is the happy path — `on_agent_ready` cancels this
        watchdog when the operator's agent comes online. Expiry is the
        failure path: cancel the task via ``task_cancel(force=true)`` and
        drop local state. A buffered ``BusTaskRequest`` (if still sitting
        in PGMQ) ages out per the bus's retention; if the operator's
        agent eventually wakes, it MUST verify its ``task_id`` is still
        the active lock holder before processing.
        """
        try:
            await asyncio.sleep(self._byoa_config.agent_wake_timeout_seconds)
        except asyncio.CancelledError:
            return

        logger.warning(
            f"byoa.wake_timeout ship={target_character_id[:8]} "
            f"task={framework_task_id[:8]} — clearing ship lock + cancelling task"
        )
        # Clean local state first so a concurrent unsolicited hello after
        # this point can't trigger a half-dispatched task.
        self._pending_tasks.pop(agent_name, None)
        self._pending_wakes.pop(target_character_id, None)
        self._locked_ships.pop(target_character_id, None)
        self._invalidate_byoa_registry_entry(agent_name)

        # Force-cancel the task so the BYOA-owner check is bypassed when the
        # bot cleans up a failed wake.
        try:
            await self._game_client.task_cancel(
                task_id=framework_task_id,
                character_id=self._character_id,
                force=True,
            )
        except Exception as exc:
            logger.warning(
                f"byoa.wake_timeout.release_failed task={framework_task_id[:8]} error={exc!r}"
            )
        self._enqueue_deferred_update(
            (
                f'<event name="task.cancelled" task_id="{framework_task_id[:8]}" '
                'task_type="corp_ship">\n'
                "Task was cancelled because the BYOA agent did not come online in time.\n"
                "</event>"
            ),
            ship_id=target_character_id,
        )


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
            ship_character_id = result.get("ship_character_id")
            summary = (
                str(result.get("message") or result.get("summary") or "Task started").strip()
                or "Task started"
            )

            # If the user is queueing a new task on a ship that has a pending
            # task.completed in the deferred queue, fold that completion into
            # context silently — the new command itself signals that the player
            # has moved on, regardless of turn count.
            if isinstance(ship_character_id, str) and ship_character_id:
                await self._silent_flush_for_ship(ship_character_id)

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
        if not result.get("success"):
            await params.result_callback({"result": result})
            return

        # Mirror _handle_start_task_tool: ack via run_llm=False, then drive a
        # post-tool inference through _inject_context. The deferred LLMRunFrame
        # is what clears the client's "thinking" state — without it, isThinking
        # stays true until the next user turn (BotStartedSpeaking is the only
        # thing that flips it off; see ConversationProvider.tsx).
        await params.result_callback(
            {"result": result},
            properties=FunctionCallResultProperties(run_llm=False),
        )

        task_id = str(result.get("task_id", "")).strip()
        task_type = str(result.get("task_type", "player_ship")).strip() or "player_ship"
        ship_character_id = result.get("ship_character_id")
        summary = (
            str(result.get("message") or result.get("summary") or "Task cancelled").strip()
            or "Task cancelled"
        )

        # Fold any pending task.completed for this ship into context silently —
        # cancelling signals the player has moved on, regardless of turn count.
        if isinstance(ship_character_id, str) and ship_character_id:
            await self._silent_flush_for_ship(ship_character_id)

        attrs = ['name="task.cancelled"']
        if task_id:
            attrs.append(f'task_id="{task_id}"')
        attrs.append(f'task_type="{task_type}"')
        event_xml = f"<event {' '.join(attrs)}>\n{summary}\n</event>"
        await self._inject_context(
            [{"role": "user", "content": event_xml}],
            run_llm=True,
        )

    async def _handle_steer_task_tool(self, params: FunctionCallParams):
        result = await self._handle_steer_task(params)
        if isinstance(result, dict) and result.get("success") is False:
            self._begin_assistant_response_cycle()
            await params.result_callback(
                {"error": result.get("error", "Request failed.")},
                properties=FunctionCallResultProperties(run_llm=True),
            )
            return

        # Mirror _handle_start_task_tool: ack via run_llm=False, then drive a
        # post-tool inference through _inject_context. The deferred LLMRunFrame
        # is what clears the client's "thinking" state — without it, isThinking
        # stays true until the next user turn (BotStartedSpeaking is the only
        # thing that flips it off; see ConversationProvider.tsx).
        summary_field = result.get("summary") if isinstance(result, dict) else None
        payload = {"summary": summary_field or "steer_task completed."}
        if isinstance(result, dict) and result.get("task_id"):
            payload["task_id"] = result["task_id"]
        await params.result_callback(
            payload,
            properties=FunctionCallResultProperties(run_llm=False),
        )

        task_id = str(result.get("task_id", "")).strip() if isinstance(result, dict) else ""
        task_type = (
            str(result.get("task_type", "player_ship")).strip() or "player_ship"
            if isinstance(result, dict)
            else "player_ship"
        )
        summary = str(summary_field or "Steering instruction sent.").strip() or "Steering instruction sent."

        attrs = ['name="task.steered"']
        if task_id:
            attrs.append(f'task_id="{task_id}"')
        attrs.append(f'task_type="{task_type}"')
        event_xml = f"<event {' '.join(attrs)}>\n{summary}\n</event>"
        await self._inject_context(
            [{"role": "user", "content": event_xml}],
            run_llm=True,
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
