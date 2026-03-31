"""Event relay service.

Subscribes to game_client events and routes them to RTVI (client push)
and/or LLM context.  Each event type has a declarative config entry
(EventConfig) that controls routing.  Cross-cutting concerns (combat
priority, onboarding, deferred batching) are focused helper methods
called from explicit phases in the router.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    Dict,
    Mapping,
    Optional,
    Protocol,
    runtime_checkable,
)

from loguru import logger
from pipecat.frames.frames import LLMMessagesAppendFrame
from pipecat.processors.frameworks.rtvi import RTVIProcessor, RTVIServerMessageFrame

from gradientbang.pipecat_server.chat_history import emit_chat_history, fetch_chat_history
from gradientbang.utils.formatting import (
    extract_display_name,
    format_ship_summary_line,
    short_id,
    shorten_embedded_ids,
)
from gradientbang.utils.summary_formatters import event_query_summary

if TYPE_CHECKING:
    from gradientbang.utils.supabase_client import AsyncGameClient


# ── Routing enums ─────────────────────────────────────────────────────────


class AppendRule(Enum):
    """How to decide whether an event is appended to LLM context."""

    NEVER = "never"  # RTVI only, never sent to LLM
    PARTICIPANT = "participant"  # Append if player is a participant in the event
    OWNED_TASK = "owned_task"  # Append if the task belongs to us
    DIRECT = "direct"  # Append if event_context scope is direct/self and we're the recipient
    LOCAL = "local"  # Append if the event is local to the player's current sector


class InferenceRule(Enum):
    """How to decide whether to trigger LLM inference after appending."""

    NEVER = "never"  # Don't trigger inference
    ALWAYS = "always"  # Always trigger (bot should respond to this event)
    VOICE_AGENT = "voice_agent"  # Trigger only if event came from our own tool call
    ON_PARTICIPANT = "on_participant"  # Trigger only when player is a participant
    OWNED = "owned"  # Trigger only if we own the subject (e.g. our task finished)


class Priority(Enum):
    """Event priority level — metadata for consumers (e.g. VoiceAgent)."""

    NORMAL = "normal"  # Default
    HIGH = "high"  # High priority (e.g. combat started)
    LOW = "low"  # Low priority (e.g. combat ended)


# ── Event config ──────────────────────────────────────────────────────────

EventSummaryFn = Callable[["EventRelay", dict], Optional[str]]


@dataclass(frozen=True, slots=True)
class EventConfig:
    """Declarative routing rules for a single event type."""

    # Core routing
    append: AppendRule = AppendRule.DIRECT  # How to decide LLM append
    inference: InferenceRule = InferenceRule.NEVER  # How to decide inference trigger
    priority: Priority = Priority.NORMAL  # Event priority level
    task_summary: Optional[EventSummaryFn] = field(default=None, repr=False)  # Shared bus/task summary
    voice_summary: Optional[EventSummaryFn] = field(default=None, repr=False)  # Voice override

    # Append modifiers for DIRECT rule
    corp_scope_if_own_action: bool = False  # Also append corp-scoped events from our own tool calls
    task_scoped_allowlisted: bool = False  # Pass through task-scoped direct filter

    # Side-effect flags
    track_sector: bool = False  # Update current sector from this event
    sync_display_name: bool = False  # Update display name from this event
    suppress_deferred_inference: bool = False  # Suppress run_llm when deferred during tool calls

    # XML
    xml_context_key: Optional[str] = (
        None  # Payload key to extract as an XML attribute (e.g. "combat_id")
    )


_DEFAULT_CONFIG = EventConfig()


# ── Voice summary functions (module-level) ────────────────────────────────


def _summarize_event_query(_relay: EventRelay, event: dict) -> Optional[str]:
    payload = event.get("payload", {})
    count = payload.get("count", 0)
    has_more = payload.get("has_more", False)
    filters = payload.get("filters", {})
    parts = []
    if filters.get("filter_event_type"):
        parts.append(f"type={filters['filter_event_type']}")
    if filters.get("filter_task_id"):
        parts.append("task-scoped")
    if filters.get("filter_sector"):
        parts.append(f"sector {filters['filter_sector']}")
    filter_str = f" ({', '.join(parts)})" if parts else ""
    summary = f"Query returned {count} events{filter_str}."
    if has_more:
        summary += " More available."
    return summary


def _summarize_event_query_for_task(relay: EventRelay, event: dict) -> Optional[str]:
    payload = event.get("payload", {})
    if not isinstance(payload, dict):
        summary = event.get("summary")
        return summary if isinstance(summary, str) else None

    def nested_summary(event_name: str, nested_payload: Dict[str, Any]) -> Optional[str]:
        if event_name == "event.query":
            count = nested_payload.get("count", 0)
            has_more = nested_payload.get("has_more", False)
            suffix = " (more available)" if has_more else ""
            return f"nested query returned {count} events{suffix}"
        getter = getattr(relay._game_client, "_get_summary", None)
        if callable(getter):
            return getter(event_name, nested_payload)
        return None

    return event_query_summary(payload, nested_summary)


def _summarize_chat(_relay: EventRelay, event: dict) -> Optional[str]:
    payload = event.get("payload", {})
    if not isinstance(payload, Mapping):
        return event.get("summary")
    msg_type = payload.get("type", "unknown")
    from_name = shorten_embedded_ids(str(payload.get("from_name", payload.get("from", "unknown"))))
    to_name = shorten_embedded_ids(str(payload.get("to_name", payload.get("to", "unknown"))))
    raw = payload.get("content", payload.get("message", ""))
    content = (
        shorten_embedded_ids(raw.replace("\n", " ").strip())
        if isinstance(raw, str)
        else shorten_embedded_ids(str(raw))
    )
    if msg_type == "broadcast":
        return f"{from_name} (broadcast): {content}"
    if msg_type == "direct":
        return f"{from_name} → {to_name}: {content}"
    return f"{from_name}: {content}"


def _summarize_ships_list(relay: EventRelay, event: dict) -> Optional[str]:
    payload = event.get("payload", {})
    ships = payload.get("ships", [])
    if not ships:
        return "No ships available."
    personal = [s for s in ships if s.get("owner_type") == "personal"]
    corp = [s for s in ships if s.get("owner_type") == "corporation"]
    lines = [f"Fleet: {len(ships)} ship{'s' if len(ships) != 1 else ''}"]
    if personal:
        lines.append("Your ship:")
        for ship in personal:
            lines.append(format_ship_summary_line(ship, include_id=False))
    if corp:
        lines.append(f"Corporation ships ({len(corp)}):")
        for ship in corp:
            lines.append(format_ship_summary_line(ship, include_id=True))
    return "\n".join(lines)


def _is_player_participant(relay: EventRelay, payload: Any) -> bool:
    """Check if the relay's character is listed in the event's participants."""
    if not isinstance(payload, Mapping):
        return False
    participants = payload.get("participants")
    if isinstance(participants, list):
        for p in participants:
            if isinstance(p, Mapping) and p.get("id") == relay._character_id:
                return True
    return False


def _combat_context(payload: Mapping[str, Any], is_player: bool) -> str:
    """Build a combat context prefix line from payload data."""
    combat_id = payload.get("combat_id")
    round_num = payload.get("round")
    details: list[str] = []
    if isinstance(round_num, int):
        details.append(f"round {round_num}")
    if isinstance(combat_id, str) and combat_id.strip():
        details.append(f"combat_id {combat_id}")
    suffix = f" ({', '.join(details)})" if details else ""
    if is_player:
        return f"Combat state: you are currently in active combat.{suffix}"
    return f"Combat state: this combat event is not your fight.{suffix}"


def _summarize_combat_waiting(relay: EventRelay, event: dict) -> Optional[str]:
    payload = event.get("payload", {})
    if not isinstance(payload, Mapping):
        return event.get("summary")
    is_player = _is_player_participant(relay, payload)
    ctx = _combat_context(payload, is_player)
    deadline = payload.get("deadline")
    if isinstance(deadline, str) and deadline.strip():
        ctx += f" deadline {deadline.strip()}"
    if is_player:
        ctx += " Submit a combat action now."
    return ctx


def _summarize_combat_action(_relay: EventRelay, event: dict) -> Optional[str]:
    payload = event.get("payload", {})
    if not isinstance(payload, Mapping):
        return event.get("summary")
    round_display = str(payload.get("round")) if isinstance(payload.get("round"), int) else "?"
    action = payload.get("action")
    action_display = str(action).lower() if isinstance(action, str) else "unknown"
    commit = payload.get("commit")
    commit_display = (
        f" commit {int(commit)}" if isinstance(commit, (int, float)) and int(commit) > 0 else ""
    )
    target = payload.get("target_id")
    target_display = (
        f", target {short_id(target) or target}"
        if isinstance(target, str) and target.strip()
        else ""
    )
    return f"Action accepted for round {round_display}: {action_display}{commit_display}{target_display}."


def _summarize_combat_round(relay: EventRelay, event: dict) -> Optional[str]:
    payload = event.get("payload", {})
    if not isinstance(payload, Mapping):
        return event.get("summary")
    is_player = _is_player_participant(relay, payload)
    ctx = _combat_context(payload, is_player)
    result_display = str(payload.get("result") or payload.get("end") or "in_progress")
    own_fighter_loss = 0
    own_shield_damage: float = 0.0
    if is_player:
        participants = payload.get("participants", [])
        for p in participants:
            if isinstance(p, Mapping) and p.get("id") == relay._character_id:
                ship = p.get("ship")
                if isinstance(ship, Mapping):
                    fl = ship.get("fighter_loss")
                    sd = ship.get("shield_damage")
                    if isinstance(fl, (int, float)):
                        own_fighter_loss = max(0, int(fl))
                    if isinstance(sd, (int, float)):
                        own_shield_damage = max(0.0, float(sd))
                break
    parts = []
    parts.append(
        f"fighters lost {own_fighter_loss}" if own_fighter_loss > 0 else "no fighter losses"
    )
    parts.append(
        f"shield damage {own_shield_damage:.1f}%" if own_shield_damage > 0 else "no shield damage"
    )
    return f"{ctx}\nRound resolved: {result_display}; {', '.join(parts)}."


def _summarize_combat_ended(relay: EventRelay, event: dict) -> Optional[str]:
    payload = event.get("payload", {})
    is_player = _is_player_participant(relay, payload)
    if is_player:
        return "Combat state: your combat has ended."
    return "Combat state: observed combat ended."


# ── Event config registry ─────────────────────────────────────────────────

EVENT_CONFIGS: dict[str, EventConfig] = {
    # RTVI only
    "map.update": EventConfig(append=AppendRule.NEVER),
    # Combat
    "combat.round_waiting": EventConfig(
        append=AppendRule.PARTICIPANT,
        inference=InferenceRule.ON_PARTICIPANT,
        priority=Priority.HIGH,
        xml_context_key="combat_id",
        voice_summary=_summarize_combat_waiting,
    ),
    "combat.round_resolved": EventConfig(
        append=AppendRule.PARTICIPANT,
        inference=InferenceRule.ALWAYS,
        priority=Priority.HIGH,
        xml_context_key="combat_id",
        voice_summary=_summarize_combat_round,
    ),
    "combat.ended": EventConfig(
        append=AppendRule.PARTICIPANT,
        # round_resolved already carries the player-facing outcome; a second
        # ended-triggered inference makes the voice agent restate the same
        # toll/combat resolution.
        inference=InferenceRule.NEVER,
        priority=Priority.LOW,
        xml_context_key="combat_id",
        voice_summary=_summarize_combat_ended,
    ),
    "combat.action_accepted": EventConfig(
        append=AppendRule.PARTICIPANT,
        # Keep the accepted action in context, but don't wake the LLM for it.
        # The user-facing update should come from round_resolved / round_waiting.
        inference=InferenceRule.NEVER,
        xml_context_key="combat_id",
        voice_summary=_summarize_combat_action,
    ),
    # Task lifecycle
    # VoiceAgent injects a synthetic task.started event after successful
    # start_task. Appending the framework's task.start as a second startup
    # event gives the LLM two different task ids for the same launch and
    # often produces duplicate acknowledgements.
    "task.start": EventConfig(append=AppendRule.NEVER),
    # Bus protocol (on_task_response) already injects task.completed into the
    # voice LLM. Keeping task.finish in the voice context as a second copy of
    # the same completion summary makes the assistant repeat itself, so route it
    # only to RTVI + the bus and skip LLM append entirely.
    "task.finish": EventConfig(
        append=AppendRule.NEVER,
    ),
    # Local movement
    "character.moved": EventConfig(append=AppendRule.LOCAL),
    "garrison.character_moved": EventConfig(append=AppendRule.LOCAL),
    # Status with side-effects
    "status.snapshot": EventConfig(
        inference=InferenceRule.VOICE_AGENT,
        track_sector=True,
        sync_display_name=True,
    ),
    "status.update": EventConfig(sync_display_name=True, task_scoped_allowlisted=True),
    "movement.complete": EventConfig(track_sector=True, task_scoped_allowlisted=True),
    # Voice-agent inference
    "ports.list": EventConfig(inference=InferenceRule.VOICE_AGENT),
    "course.plot": EventConfig(inference=InferenceRule.VOICE_AGENT),
    "error": EventConfig(inference=InferenceRule.VOICE_AGENT),
    # Always-trigger inference
    "chat.message": EventConfig(
        inference=InferenceRule.ALWAYS,
        task_scoped_allowlisted=True,
        voice_summary=_summarize_chat,
    ),
    "ship.renamed": EventConfig(inference=InferenceRule.ALWAYS, corp_scope_if_own_action=True),
    # Voice-agent inference only — when a TaskAgent action completes a quest
    # step, on_task_response already triggers inference with run_llm=True.
    # Using ALWAYS here would double-fire (same pattern as task.finish).
    "quest.step_completed": EventConfig(inference=InferenceRule.VOICE_AGENT),
    "quest.completed": EventConfig(inference=InferenceRule.VOICE_AGENT),
    "quest.reward_claimed": EventConfig(inference=InferenceRule.ALWAYS),
    # Task-scoped allowlisted (direct events pass through when task-scoped)
    "trade.executed": EventConfig(task_scoped_allowlisted=True),
    "port.update": EventConfig(task_scoped_allowlisted=True),
    "bank.transaction": EventConfig(task_scoped_allowlisted=True),
    "warp.purchase": EventConfig(task_scoped_allowlisted=True),
    "map.local": EventConfig(task_scoped_allowlisted=True),
    # Corp events (allow corp scope when voice agent)
    "corporation.created": EventConfig(corp_scope_if_own_action=True),
    "corporation.ship_purchased": EventConfig(corp_scope_if_own_action=True),
    "corporation.ship_sold": EventConfig(corp_scope_if_own_action=True),
    "corporation.member_joined": EventConfig(corp_scope_if_own_action=True),
    "corporation.member_left": EventConfig(corp_scope_if_own_action=True),
    "corporation.member_kicked": EventConfig(corp_scope_if_own_action=True),
    "corporation.disbanded": EventConfig(corp_scope_if_own_action=True),
    "corporation.data": EventConfig(corp_scope_if_own_action=True),
    # Audited legacy overrides:
    # - event.query needs a shared bounded task/bus summary plus a shorter voice summary
    # - chat.message, ships.list, and combat overrides remain voice-only; generic client summaries
    #   are sufficient for bus/task consumers
    "event.query": EventConfig(
        task_summary=_summarize_event_query_for_task,
        voice_summary=_summarize_event_query,
    ),
    "ships.list": EventConfig(voice_summary=_summarize_ships_list),
    # Plain defaults (DIRECT append, NEVER inference)
    "sector.update": EventConfig(),
    "path.region": EventConfig(),
    "movement.start": EventConfig(),
    "map.knowledge": EventConfig(),
    "map.region": EventConfig(),
    "fighter.purchase": EventConfig(),
    "warp.transfer": EventConfig(),
    "credits.transfer": EventConfig(),
    "garrison.deployed": EventConfig(),
    "garrison.collected": EventConfig(),
    "garrison.mode_changed": EventConfig(),
    "garrison.combat_alert": EventConfig(),
    "salvage.collected": EventConfig(),
    "salvage.created": EventConfig(),
    "ship.destroyed": EventConfig(),
    "ship.definitions": EventConfig(),
    "quest.status": EventConfig(),
    "quest.progress": EventConfig(),
}


# ── Task-state callback protocol ──────────────────────────────────────────


@runtime_checkable
class TaskStateProvider(Protocol):
    """Callbacks that EventRelay needs from the task-state owner (VoiceAgent)."""

    # Event distribution to TaskAgent children via bus
    async def broadcast_game_event(
        self, event: Dict[str, Any], *, voice_agent_originated: bool = False
    ) -> None: ...

    # Task awareness (for routing decisions)
    def is_our_task(self, task_id: str) -> bool: ...

    # Request ID tracking
    def is_recent_request_id(self, request_id: str) -> bool: ...
    # LLM frame management (inherited from LLMAgent)
    @property
    def tool_call_active(self) -> bool: ...
    async def queue_frame(self, frame) -> None: ...


# ── EventRelay ────────────────────────────────────────────────────────────


class EventRelay:
    """Routes game events to RTVI and LLM context using declarative config."""

    def __init__(
        self,
        *,
        game_client: AsyncGameClient,
        rtvi_processor: RTVIProcessor,
        character_id: str,
        task_state: TaskStateProvider,
    ):
        self._game_client = game_client
        self._rtvi = rtvi_processor
        self._character_id = character_id
        self._task_state = task_state

        self.display_name: str = character_id
        self._current_sector_id: Optional[int] = None
        # Onboarding (passive observation)
        self.is_new_player: Optional[bool] = None  # None=unknown, True=new, False=veteran
        self._first_status_delivered = False
        self._megaport_check_request_id: Optional[str] = None
        self._onboarding_complete = False
        self._session_started_at: Optional[str] = None

        # Subscribe to game events from config registry
        for event_name in EVENT_CONFIGS:
            game_client.on(event_name)(self._relay_event)
        game_client.on("task.cancel")(self._handle_task_cancel_event)

    @property
    def character_id(self) -> str:
        return self._character_id

    @property
    def game_client(self) -> AsyncGameClient:
        return self._game_client

    @property
    def session_started_at(self) -> Optional[str]:
        return self._session_started_at

    # ── Session lifecycle ──────────────────────────────────────────────

    async def join(self) -> Mapping[str, Any]:
        logger.info(f"Joining game as character: {self._character_id}")
        self.is_new_player = None
        self._first_status_delivered = False
        self._onboarding_complete = False
        self._session_started_at = None
        result = await self._game_client.join(self._character_id)
        self._session_started_at = datetime.now(timezone.utc).isoformat()
        await self._game_client.subscribe_my_messages()
        await self._game_client.list_user_ships(character_id=self._character_id)
        await self._game_client.quest_status(character_id=self._character_id)
        # Issue megaport check — response arrives as a ports.list event after resume
        try:
            mega_ack = await self._game_client.list_known_ports(
                character_id=self._character_id,
                mega=True,
                max_hops=100,
            )
            req_id = mega_ack.get("request_id") if isinstance(mega_ack, Mapping) else None
            if req_id:
                self._megaport_check_request_id = req_id
                logger.info(f"Onboarding: mega-port check issued, request_id={req_id}")
        except Exception:
            logger.exception("Onboarding: mega-port check failed, assuming veteran")
            self.is_new_player = False
        await self._send_initial_chat_history()
        if isinstance(result, Mapping):
            self._update_display_name(result)
        logger.info(f"Join successful as {self.display_name}: {result}")
        return result

    async def close(self) -> None:
        self.is_new_player = None
        self._first_status_delivered = False
        self._onboarding_complete = False
        self._megaport_check_request_id = None
        self._session_started_at = None

    async def _send_initial_chat_history(self) -> None:
        try:
            messages = await fetch_chat_history(self._game_client, self._character_id)
            await emit_chat_history(self._rtvi, messages)
            logger.info(f"Sent initial chat history: {len(messages)} messages")
        except Exception:
            logger.exception("Failed to send initial chat history")

    # ── Display name / sector tracking ─────────────────────────────────

    def _update_display_name(self, payload: Mapping[str, Any]) -> None:
        candidate = extract_display_name(payload)
        if isinstance(candidate, str) and candidate and candidate != self.display_name:
            self.display_name = candidate

    # ── Onboarding (passive observation) ─────────────────────────────

    async def _observe_ports_list(self, clean_payload: Any) -> None:
        """Observe ports.list events to detect mega-port knowledge."""
        if not isinstance(clean_payload, Mapping):
            return
        ports = clean_payload.get("ports", [])
        has_mega = isinstance(ports, list) and len(ports) > 0
        if has_mega and self.is_new_player is not False:
            was_new = self.is_new_player is True
            logger.info("Onboarding: mega-ports found, player is veteran")
            self.is_new_player = False
            if was_new and self._onboarding_complete:
                logger.info("Onboarding: mega-port discovered, injecting onboarding.complete")
                await self._deliver_llm_event(
                    '<event name="onboarding.complete">\n'
                    "Player has discovered a mega-port. Onboarding is complete "
                    "— disregard earlier onboarding instructions.\n"
                    "</event>",
                    should_run_llm=False,
                )

    def _resolve_initial_megaport_check(
        self, request_id: Optional[str], clean_payload: Any
    ) -> None:
        """Resolve the initial megaport check from join()."""
        if not self._megaport_check_request_id:
            return
        if request_id != self._megaport_check_request_id:
            return
        self._megaport_check_request_id = None
        ports = clean_payload.get("ports", []) if isinstance(clean_payload, Mapping) else []
        if isinstance(ports, list) and len(ports) > 0:
            self.is_new_player = False
            logger.info("Onboarding: initial check — player knows mega-ports (veteran)")
        else:
            self.is_new_player = True
            logger.info("Onboarding: initial check — player has no mega-ports (new)")

    async def _maybe_inject_onboarding(self) -> None:
        """Inject onboarding or session.start after first status + megaport check resolve."""
        if self._onboarding_complete:
            return
        if not self._first_status_delivered or self.is_new_player is None:
            return
        self._onboarding_complete = True
        if self.is_new_player:
            from gradientbang.utils.prompt_loader import load_prompt

            content = load_prompt("fragments/onboarding.md").format(
                display_name=self.display_name,
            )
            onboarding_xml = f'<event name="onboarding">\n{content}</event>'
            logger.info("Onboarding: new player, injecting welcome message")
            await self._deliver_llm_event(onboarding_xml, should_run_llm=True)
        else:
            logger.info("Onboarding: veteran player, normal startup")
            await self._deliver_llm_event(
                '<event name="session.start"></event>',
                should_run_llm=True,
            )

    # ── Payload helpers ─────────────────────────────────────────────────

    @staticmethod
    def _extract_combat_id(payload: Any) -> Optional[str]:
        if not isinstance(payload, Mapping):
            return None
        val = payload.get("combat_id")
        if isinstance(val, str) and val.strip():
            return val.strip()
        return None

    @staticmethod
    def _is_friendly_garrison_move(event_name: str, payload: Any) -> bool:
        """Suppress garrison.character_moved for friendly (own/corp) movements."""
        if event_name != "garrison.character_moved":
            return False
        if not isinstance(payload, Mapping):
            return False
        player = payload.get("player")
        garrison = payload.get("garrison")
        if not isinstance(player, Mapping) or not isinstance(garrison, Mapping):
            return False
        # Moving player owns the garrison
        if player.get("id") and player["id"] == garrison.get("owner_id"):
            return True
        # Moving player is in the garrison's corp
        corp = player.get("corporation")
        if isinstance(corp, Mapping):
            player_corp_id = corp.get("corp_id")
            garrison_corp_id = garrison.get("corporation_id")
            if player_corp_id and garrison_corp_id and player_corp_id == garrison_corp_id:
                return True
        return False

    def _is_direct_recipient_event(self, ctx: Optional[Mapping[str, Any]]) -> bool:
        reason = self._resolve_recipient_reason(ctx, self._character_id)
        if reason in {"direct", "task_owner", "recipient"}:
            return True
        if ctx and self._character_id:
            if (
                isinstance(ctx.get("character_id"), str)
                and ctx["character_id"] == self._character_id
            ):
                return True
        return False

    @staticmethod
    def _resolve_recipient_reason(
        ctx: Optional[Mapping[str, Any]], character_id: Optional[str]
    ) -> Optional[str]:
        if not ctx or not character_id:
            return None
        reason = ctx.get("reason")
        if isinstance(reason, str):
            return reason
        ids = ctx.get("recipient_ids")
        reasons = ctx.get("recipient_reasons")
        if isinstance(ids, list) and isinstance(reasons, list) and len(ids) == len(reasons):
            for rid, r in zip(ids, reasons):
                if isinstance(rid, str) and rid == character_id and isinstance(r, str):
                    return r
        return None

    @staticmethod
    def _strip_internal_event_metadata(payload: Any) -> Any:
        if not isinstance(payload, Mapping):
            return payload
        cleaned = dict(payload)
        for key in ("__event_context", "event_context", "recipient_ids", "recipient_reasons"):
            cleaned.pop(key, None)
        return cleaned

    @staticmethod
    def _extract_event_context(payload: Any) -> Optional[Mapping[str, Any]]:
        if not isinstance(payload, Mapping):
            return None
        ctx = payload.get("__event_context") or payload.get("event_context")
        return ctx if isinstance(ctx, Mapping) else None

    @staticmethod
    def _extract_sector_id(payload: Mapping[str, Any]) -> Optional[int]:
        sector = payload.get("sector")
        if isinstance(sector, Mapping):
            candidate = sector.get("id") or sector.get("sector_id")
        else:
            candidate = payload.get("sector_id")
            if candidate is None:
                candidate = sector
        if isinstance(candidate, int):
            return candidate
        if isinstance(candidate, str) and candidate.strip().isdigit():
            return int(candidate.strip())
        return None

    # ── LLM event delivery ─────────────────────────────────────────────

    async def _deliver_llm_event(self, event_xml: str, should_run_llm: bool) -> None:
        await self._task_state.queue_frame(
            LLMMessagesAppendFrame(
                messages=[{"role": "user", "content": event_xml}],
                run_llm=should_run_llm,
            )
        )
        logger.info("LLM deliver complete")

    def _resolve_task_summary(
        self,
        cfg: EventConfig,
        event_name: Optional[str],
        event_for_summary: Dict[str, Any],
    ) -> Optional[str]:
        summary: Optional[str] = None
        if cfg.task_summary:
            summary = cfg.task_summary(self, event_for_summary)
        if not summary:
            existing = event_for_summary.get("summary")
            if isinstance(existing, str) and existing.strip():
                summary = existing.strip()
        if not summary and event_name:
            payload = event_for_summary.get("payload")
            getter = getattr(self._game_client, "_get_summary", None)
            if isinstance(payload, dict) and callable(getter):
                summary = getter(event_name, payload)
        if isinstance(summary, str):
            summary = summary.strip()
            return summary or None
        return None

    def _resolve_voice_summary(
        self,
        cfg: EventConfig,
        event_for_summary: Dict[str, Any],
        task_summary: Optional[str],
    ) -> Any:
        if cfg.voice_summary:
            voice_summary = cfg.voice_summary(self, event_for_summary)
            if isinstance(voice_summary, str):
                voice_summary = voice_summary.strip()
                if voice_summary:
                    return voice_summary
            elif voice_summary:
                return voice_summary
        if task_summary is not None:
            return task_summary
        return event_for_summary.get("payload")

    # ── Task cancel event handler ──────────────────────────────────────

    async def _handle_task_cancel_event(self, event: Dict[str, Any]) -> None:
        payload = event.get("payload", {})
        task_id_to_cancel = payload.get("task_id")
        if not task_id_to_cancel:
            return
        # Broadcast to bus so TaskAgents and VoiceAgent can react
        await self._task_state.broadcast_game_event(event)

    # ── Router helpers ─────────────────────────────────────────────────

    def _should_append_to_llm(
        self,
        cfg: EventConfig,
        event_name: str,
        event_context: Optional[Mapping],
        direct_recipient: bool,
        combat_for_player: bool,
        is_our_task: bool,
        payload_task_id: Optional[str],
        request_id: Optional[str],
        is_other_player: bool,
        clean_payload: Any,
    ) -> bool:
        rule = cfg.append

        if rule == AppendRule.NEVER:
            return False

        if rule == AppendRule.PARTICIPANT:
            if event_context is None:
                logger.warning(
                    "voice.event_context.missing allowing critical combat event event_name={} request_id={}",
                    event_name,
                    request_id,
                )
                return True
            return combat_for_player

        if rule == AppendRule.OWNED_TASK:
            return is_our_task

        if rule == AppendRule.LOCAL:
            if isinstance(clean_payload, Mapping):
                sector_id = self._extract_sector_id(clean_payload)
                is_local = (
                    sector_id is not None
                    and self._current_sector_id is not None
                    and sector_id == self._current_sector_id
                )
            else:
                is_local = False
            if not is_local:
                return False
            # Suppress corp ship movements from voice LLM (task agent handles them)
            if is_other_player and is_our_task:
                return False
            return True

        # AppendRule.DIRECT (default)
        if event_context is None:
            logger.info(
                "voice.event_context.missing event_name={} request_id={} payload_task_id={}",
                event_name,
                request_id,
                payload_task_id,
            )
            return False

        scope = event_context.get("scope")
        is_voice = self._task_state.is_recent_request_id(request_id) if request_id else False
        is_direct = isinstance(scope, str) and scope in {"direct", "self"} and direct_recipient
        if is_direct:
            if payload_task_id is not None:
                return cfg.task_scoped_allowlisted or is_voice
            return True
        if scope == "corp" and cfg.corp_scope_if_own_action and is_voice:
            return True
        return False

    def _should_run_llm(
        self,
        cfg: EventConfig,
        event_name: str,
        is_our_task: bool,
        request_id: Optional[str],
        combat_for_player: bool,
    ) -> bool:
        rule = cfg.inference
        is_voice = self._task_state.is_recent_request_id(request_id) if request_id else False

        if rule == InferenceRule.ALWAYS:
            result = True
        elif rule == InferenceRule.VOICE_AGENT:
            result = is_voice
        elif rule == InferenceRule.ON_PARTICIPANT:
            result = combat_for_player
        elif rule == InferenceRule.OWNED:
            result = is_our_task
        else:
            result = False

        # Suppress initial status.snapshot inference until onboarding resolves
        if result and not self._onboarding_complete and event_name == "status.snapshot":
            logger.info(
                "Onboarding: suppressing status.snapshot inference until onboarding resolves"
            )
            result = False

        return result

    # ── Core event router ──────────────────────────────────────────────

    async def _relay_event(self, event: Dict[str, Any]) -> None:
        # ── Phase 1: Parse ──
        event_name = event.get("event_name")
        payload = event.get("payload")
        request_id = event.get("request_id")
        clean_payload = self._strip_internal_event_metadata(payload)
        event_context = self._extract_event_context(payload)
        cfg = EVENT_CONFIGS.get(event_name, _DEFAULT_CONFIG)

        # Swallow friendly garrison movement alerts (own ship / corp ships)
        if self._is_friendly_garrison_move(event_name, clean_payload):
            return

        # Detect voice-agent origin before broadcasting to the bus.
        #
        # For non-error events: check the top-level request_id against
        # VoiceAgent's recent-request cache (set on successful tool calls).
        #
        # For error events: cache-based detection doesn't work because errors
        # are synthesized and emitted *before* the exception returns to the
        # VoiceAgent handler, so the request_id is never cached. Instead, rely
        # on the architectural fact: all errors flowing through EventRelay come
        # from VoiceAgent's game_client — TaskAgents have their own client and
        # receive their own errors via exceptions, never via the bus. A
        # source.request_id being present (always true for synthesized errors)
        # is sufficient to confirm it's a VoiceAgent API call error.
        if event_name == "error":
            _src_rid = None
            if isinstance(payload, Mapping):
                src = payload.get("source")
                if isinstance(src, Mapping):
                    _src_rid = src.get("request_id")
            is_voice_originated = _src_rid is not None
        else:
            is_voice_originated = (
                self._task_state.is_recent_request_id(request_id) if request_id else False
            )

        event_for_summary = {**event, "payload": clean_payload}
        task_summary = self._resolve_task_summary(cfg, event_name, event_for_summary)
        event_for_bus = dict(event_for_summary)
        if task_summary is not None:
            event_for_bus["summary"] = task_summary

        # Broadcast every event to the bus for TaskAgent children
        await self._task_state.broadcast_game_event(
            event_for_bus, voice_agent_originated=is_voice_originated
        )

        direct_recipient = self._is_direct_recipient_event(event_context)
        in_participants = _is_player_participant(self, clean_payload)
        combat_for_player = direct_recipient or in_participants or event_context is None

        # Extract player_id for other-player detection
        player_id: Optional[str] = None
        if isinstance(payload, Mapping):
            player = payload.get("player")
            if isinstance(player, Mapping):
                pid = player.get("id")
                if isinstance(pid, str) and pid.strip():
                    player_id = pid
        is_other_player = bool(player_id and player_id != self._character_id)

        # ── Phase 2: Pre-routing side effects ──

        # Task ID resolution
        payload_task_id: Optional[str] = None
        if isinstance(payload, Mapping):
            candidate = payload.get("__task_id") or payload.get("task_id")
            if isinstance(candidate, str) and candidate.strip():
                payload_task_id = candidate.strip()

        is_our_task = False
        if payload_task_id:
            is_our_task = self._task_state.is_our_task(payload_task_id)

        # Display name / corp sync
        if cfg.sync_display_name and not is_other_player and isinstance(clean_payload, Mapping):
            self._update_display_name(clean_payload)

        # ── Phase 3: RTVI push ──
        await self._rtvi.push_frame(
            RTVIServerMessageFrame(
                {"frame_type": "event", "event": event_name, "payload": clean_payload}
            )
        )

        # Sector tracking
        if cfg.track_sector and not is_other_player and isinstance(clean_payload, Mapping):
            sector_id = self._extract_sector_id(clean_payload)
            if sector_id is not None:
                self._current_sector_id = sector_id

        # ── Passive onboarding observation ──
        # Runs on every event, independent of LLM append decision.
        if event_name == "ports.list":
            self._resolve_initial_megaport_check(request_id, clean_payload)
            await self._observe_ports_list(clean_payload)
            await self._maybe_inject_onboarding()
        elif event_name == "status.snapshot" and not is_other_player:
            if not self._first_status_delivered:
                self._first_status_delivered = True
                await self._maybe_inject_onboarding()

        # ── Phase 4: Append decision ──
        should_append = self._should_append_to_llm(
            cfg,
            event_name,
            event_context,
            direct_recipient,
            combat_for_player,
            is_our_task,
            payload_task_id,
            request_id,
            is_other_player,
            clean_payload,
        )
        if not should_append:
            return

        # ── Phase 5: Summary, inference, delivery ──
        summary = self._resolve_voice_summary(cfg, event_for_bus, task_summary)

        # Build XML
        attrs = [f'name="{event_name}"']
        if payload_task_id:
            attrs.append(f'task_id="{payload_task_id}"')
        if cfg.xml_context_key and isinstance(clean_payload, Mapping):
            ctx_val = clean_payload.get(cfg.xml_context_key)
            if isinstance(ctx_val, str) and ctx_val.strip():
                attrs.append(f'{cfg.xml_context_key}="{ctx_val.strip()}"')
        event_xml = f"<event {' '.join(attrs)}>\n{summary}\n</event>"

        should_run_llm = self._should_run_llm(
            cfg, event_name, is_our_task, request_id, combat_for_player
        )

        # Deferred batching
        if payload_task_id and self._task_state.tool_call_active:
            if cfg.suppress_deferred_inference:
                should_run_llm = False
            await self._task_state.queue_frame(
                LLMMessagesAppendFrame(
                    messages=[{"role": "user", "content": event_xml}],
                    run_llm=should_run_llm,
                )
            )
            return

        await self._deliver_llm_event(event_xml, should_run_llm)
