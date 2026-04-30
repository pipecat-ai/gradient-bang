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
from gradientbang.utils.formatting import looks_like_uuid
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
DEFERRED_UPDATE_COOLDOWN_SECONDS = 1.5
TASK_RESPONSE_SPEECH_START_GRACE_SECONDS = 0.75
DEFERRED_UPDATE_STALE_TURNS = 5
DEFERRED_UPDATE_SETTLE_SECONDS = 2.0
DEFERRED_UPDATE_MAX_SETTLE_SECONDS = 8.0

_UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)


@dataclass
class _DeferredUpdate:
    xml: str
    ship_id: Optional[str] = None


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
        self._locked_ships: set[str] = set()  # character_ids with an active task

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
            (
                BotStartedSpeakingFrame,
                BotStoppedSpeakingFrame,
                UserStartedSpeakingFrame,
                UserStoppedSpeakingFrame,
            )
        )

        @self.pipeline_task.event_handler("on_frame_reached_downstream")
        async def _on_llm_response_lifecycle(task, frame):
            if isinstance(frame, LLMFullResponseStartFrame):
                self._handle_llm_response_started()
            elif isinstance(frame, LLMFullResponseEndFrame):
                self._handle_llm_response_ended()

        @self.pipeline_task.event_handler("on_frame_reached_upstream")
        async def _on_speaking_lifecycle(task, frame):
            if isinstance(frame, BotStartedSpeakingFrame):
                self._handle_bot_started_speaking()
            elif isinstance(frame, BotStoppedSpeakingFrame):
                self._handle_bot_stopped_speaking()
            elif isinstance(frame, UserStartedSpeakingFrame):
                self._handle_user_started_speaking()
            elif isinstance(frame, UserStoppedSpeakingFrame):
                self._handle_user_stopped_speaking()

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
        llm.add_event_handler("on_function_calls_started", self._on_tool_batch_started)
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
        await super().queue_frame(
            LLMMessagesAppendFrame(messages=[{"role": "user", "content": event_xml}], run_llm=True)
        )

    # ── Deferred-update queue ──────────────────────────────────────────

    def _enqueue_deferred_update(
        self, event_xml: str, *, ship_id: Optional[str] = None
    ) -> None:
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
                        await asyncio.wait_for(
                            self._deferred_event.wait(), timeout=settle_wait
                        )
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
            new_code = (
                result.get("new_invite_code") if isinstance(result, dict) else None
            )
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
            {"success": True, "corp_name": result.get("name") if isinstance(result, dict) else None},
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
                        "target_id is required. Ask the player to identify "
                        "which member to remove."
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
            corp = (
                my_corp.get("corporation") if isinstance(my_corp, dict) else None
            )
            members = (
                corp.get("members") if isinstance(corp, dict) else None
            ) or []
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
        ship_name = child._task_metadata.get("ship_name") if child else None
        ship_attr = f' ship_name="{ship_name}"' if ship_name else ""
        event_xml = (
            f'<event name="task.{status_label}" task_id="{message.task_id[:8]}" '
            f'task_type="{task_type}"{ship_attr}>\n{llm_msg}\n</event>'
        )

        ship_character_id = child._character_id if child else None
        # Hand off to the deferred-update queue. The drain coordinator
        # batches close-together completions, gates on bot/user speech state,
        # and silently folds in entries once the topic has clearly moved on.
        self._enqueue_deferred_update(event_xml, ship_id=ship_character_id)

        # Release ship lock (both player and corp)
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
                            "ship_character_id": target_character_id,
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
                    "ship_character_id": target_character_id,
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
