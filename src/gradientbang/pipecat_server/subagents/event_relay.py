"""Event relay service.

Subscribes to game_client events and routes them to RTVI (client push)
and/or LLM context.  Each event type has a declarative config entry
(EventConfig) that controls routing.  Cross-cutting concerns (combat
priority, onboarding, deferred batching) are focused helper methods
called from explicit phases in the router.
"""

from __future__ import annotations

import asyncio
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
from pipecat.frames.frames import LLMMessagesAppendFrame, LLMRunFrame
from pipecat.processors.frameworks.rtvi import RTVIProcessor, RTVIServerMessageFrame

from gradientbang.pipecat_server.chat_history import emit_chat_history, fetch_chat_history
from gradientbang.utils.formatting import (
    extract_display_name,
    format_ship_summary_line,
    friendly_ship_type,
    short_id,
    shorten_embedded_ids,
)
from gradientbang.utils.prompt_loader import (
    render_combat_md_preamble_message,
    render_ship_doctrine_preamble_message,
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
EventXmlAttrsFn = Callable[["EventRelay", Mapping[str, Any]], list[tuple[str, str]]]


def _xml_escape_attr(value: Any) -> str:
    """Escape an XML attribute value. Attr values may contain user-controlled
    text (ship names, character names, etc.); a stray `"`, `<`, `>`, or `&`
    would corrupt the envelope the LLM parses, so escape the standard set."""
    return (
        str(value)
        .replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


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
    corp_scope_always_append: bool = False  # Append corp-scoped events for ANY corp member, not just the actor
    task_scoped_allowlisted: bool = False  # Pass through task-scoped direct filter

    # Side-effect flags
    track_sector: bool = False  # Update current sector from this event
    sync_display_name: bool = False  # Update display name from this event
    suppress_deferred_inference: bool = False  # Suppress run_llm when deferred during tool calls
    debounce_seconds: Optional[float] = None  # Debounce rapid-fire inference triggers

    # XML envelope attrs. Use xml_attrs_fn when attrs depend on viewer POV
    # (e.g. combat encounters render different ship_id/garrison_id per viewer)
    # or when the event needs multiple subject-scoped attrs. Falls back to
    # xml_context_key for the simple single-attr case.
    xml_context_key: Optional[str] = None
    xml_attrs_fn: Optional[EventXmlAttrsFn] = field(default=None, repr=False)


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
    active = [s for s in ships if not s.get("destroyed_at")]
    destroyed = [s for s in ships if s.get("destroyed_at")]
    personal = [s for s in active if s.get("owner_type") == "personal"]
    corp = [s for s in active if s.get("owner_type") == "corporation"]
    header = f"Fleet: {len(active)} active"
    if destroyed:
        header += f", {len(destroyed)} destroyed"
    lines = [header]
    if personal:
        lines.append("Your ship:")
        for ship in personal:
            lines.append(format_ship_summary_line(ship, include_id=True))
    if corp:
        lines.append(f"Corporation ships ({len(corp)}):")
        for ship in corp:
            lines.append(format_ship_summary_line(ship, include_id=True))
    if destroyed:
        lines.append(f"Destroyed ships ({len(destroyed)}):")
        for ship in destroyed:
            name = shorten_embedded_ids(
                str(ship.get("ship_name") or ship.get("name") or "Unnamed Vessel")
            )
            ship_type = friendly_ship_type(ship.get("ship_type"))
            sector = ship.get("sector")
            sector_display = sector if isinstance(sector, int) else "unknown"
            lines.append(
                f"- [DESTROYED] {name} ({ship_type}) last seen sector {sector_display}"
            )
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


# ── Combat POV resolver ───────────────────────────────────────────────────
#
# Per-viewer "stake" classification for combat encounter events.
# Resolution order: DIRECT > OBSERVED via corp ship > OBSERVED via garrison
# > OBSERVED sector only. Drives both POV-line summaries and XML envelope
# attrs (see catalog appendix A).


class CombatPOV(Enum):
    DIRECT = "direct"
    OBSERVED_VIA_CORP_SHIP = "observed_via_corp_ship"
    OBSERVED_VIA_GARRISON = "observed_via_garrison"
    OBSERVED_SECTOR_ONLY = "observed_sector_only"


@dataclass(frozen=True, slots=True)
class CombatPOVInfo:
    pov: CombatPOV
    sector_id: Optional[int] = None
    # Subject the viewer is observing through (when not DIRECT).
    ship_id: Optional[str] = None
    ship_name: Optional[str] = None
    garrison_id: Optional[str] = None
    garrison_owner: Optional[str] = None  # owner_character_id
    garrison_owner_name: Optional[str] = None
    garrison_owned_by_self: bool = False  # vs corp-mate's garrison
    garrison_mode: Optional[str] = None


def _viewer_corp_id(relay: EventRelay) -> Optional[str]:
    corp_id = getattr(relay._game_client, "corporation_id", None)
    return corp_id if isinstance(corp_id, str) and corp_id else None


def _compute_combat_pov(relay: EventRelay, payload: Mapping[str, Any]) -> CombatPOVInfo:
    viewer_id = relay._character_id
    viewer_corp = _viewer_corp_id(relay)
    sector = payload.get("sector")
    sector_id = sector.get("id") if isinstance(sector, Mapping) else None
    sector_id = sector_id if isinstance(sector_id, int) else None

    participants = payload.get("participants")
    participants_list: list[Mapping[str, Any]] = (
        [p for p in participants if isinstance(p, Mapping)]
        if isinstance(participants, list)
        else []
    )

    # 1. DIRECT — viewer is a participant
    for p in participants_list:
        if p.get("id") == viewer_id:
            return CombatPOVInfo(pov=CombatPOV.DIRECT, sector_id=sector_id)

    # 2. OBSERVED via corp ship — corp-mate corp-ship is a participant
    if viewer_corp:
        for p in participants_list:
            if p.get("player_type") != "corporation_ship":
                continue
            if p.get("corp_id") != viewer_corp:
                continue
            ship = p.get("ship") if isinstance(p.get("ship"), Mapping) else None
            ship_name = (
                ship.get("ship_name")
                if isinstance(ship, Mapping) and isinstance(ship.get("ship_name"), str)
                else None
            )
            ship_id = p.get("ship_id") if isinstance(p.get("ship_id"), str) else None
            return CombatPOVInfo(
                pov=CombatPOV.OBSERVED_VIA_CORP_SHIP,
                sector_id=sector_id,
                ship_id=ship_id,
                ship_name=ship_name,
            )

    # 3. OBSERVED via garrison — viewer owns or is corp-mate of owner
    garrison = payload.get("garrison")
    if isinstance(garrison, Mapping):
        owner_id = garrison.get("owner_character_id")
        owner_corp = garrison.get("owner_corp_id")
        owner_name = garrison.get("owner_name")
        garrison_id = garrison.get("id")
        mode = garrison.get("mode")
        owned_by_self = isinstance(owner_id, str) and owner_id == viewer_id
        owned_by_corp = (
            not owned_by_self
            and isinstance(owner_corp, str)
            and viewer_corp is not None
            and owner_corp == viewer_corp
        )
        if owned_by_self or owned_by_corp:
            return CombatPOVInfo(
                pov=CombatPOV.OBSERVED_VIA_GARRISON,
                sector_id=sector_id,
                garrison_id=garrison_id if isinstance(garrison_id, str) else None,
                garrison_owner=owner_id if isinstance(owner_id, str) else None,
                garrison_owner_name=owner_name if isinstance(owner_name, str) else None,
                garrison_owned_by_self=owned_by_self,
                garrison_mode=mode if isinstance(mode, str) else None,
            )

    return CombatPOVInfo(pov=CombatPOV.OBSERVED_SECTOR_ONLY, sector_id=sector_id)


def has_observed_combat_stake(relay: EventRelay, payload: Mapping[str, Any]) -> bool:
    pov_info = _compute_combat_pov(relay, payload)
    return pov_info.pov in (
        CombatPOV.OBSERVED_VIA_CORP_SHIP,
        CombatPOV.OBSERVED_VIA_GARRISON,
    )


def is_terminal_combat_resolution(payload: Mapping[str, Any]) -> bool:
    for key in ("result", "end", "round_result"):
        value = payload.get(key)
        if value is None:
            continue
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized and normalized != "in_progress":
                return True
            continue
        return True
    return False


def is_corp_ship_destroyed_for_viewer(relay: EventRelay, payload: Mapping[str, Any]) -> bool:
    viewer_corp = _viewer_corp_id(relay)
    if viewer_corp is None:
        return False
    player_type = payload.get("player_type")
    if player_type != "corporation_ship":
        return False
    corp_id = payload.get("corp_id")
    return isinstance(corp_id, str) and corp_id == viewer_corp


def is_garrison_subject_for_viewer(relay: EventRelay, payload: Mapping[str, Any]) -> bool:
    owner_id = payload.get("owner_character_id")
    if isinstance(owner_id, str) and owner_id == relay._character_id:
        return True
    viewer_corp = _viewer_corp_id(relay)
    owner_corp = payload.get("owner_corp_id")
    return (
        isinstance(owner_corp, str)
        and viewer_corp is not None
        and owner_corp == viewer_corp
    )


def _is_owned_subject(relay: EventRelay, payload: Mapping[str, Any]) -> bool:
    owner_id = payload.get("owner_character_id")
    return (
        isinstance(owner_id, str)
        and relay._character_id is not None
        and owner_id == relay._character_id
    )


def _sector_text(pov_info: CombatPOVInfo) -> str:
    return (
        f"sector {pov_info.sector_id}"
        if isinstance(pov_info.sector_id, int)
        else "the sector"
    )


def _combat_suffix(payload: Mapping[str, Any]) -> str:
    """Trailing parenthetical: (round N, combat_id ID)."""
    parts: list[str] = []
    round_num = payload.get("round")
    if isinstance(round_num, int):
        parts.append(f"round {round_num}")
    combat_id = payload.get("combat_id")
    if isinstance(combat_id, str) and combat_id.strip():
        parts.append(f"combat_id {combat_id.strip()}")
    return f" ({', '.join(parts)})" if parts else ""


def _ship_ref(pov_info: CombatPOVInfo) -> str:
    """Render '"<name>" (ship_id=<short>)' from POV info; falls back gracefully."""
    name_part = f'"{pov_info.ship_name}"' if pov_info.ship_name else "ship"
    if pov_info.ship_id:
        return f"{name_part} (ship_id={pov_info.ship_id[:6]})"
    return name_part


def _round_waiting_pov_line(pov_info: CombatPOVInfo, payload: Mapping[str, Any]) -> str:
    round_num = payload.get("round")
    is_round_one = round_num == 1
    if not is_round_one:
        if pov_info.pov == CombatPOV.DIRECT:
            return "Combat state: you are currently in active combat."
        if pov_info.pov == CombatPOV.OBSERVED_VIA_CORP_SHIP:
            return (
                f"Combat update: your corp's {_ship_ref(pov_info)} "
                f"is still engaged in {_sector_text(pov_info)}."
            )
        if pov_info.pov == CombatPOV.OBSERVED_VIA_GARRISON:
            owner_word = "your" if pov_info.garrison_owned_by_self else "your corp's"
            return (
                f"Combat update: {owner_word} garrison in {_sector_text(pov_info)} "
                "is still engaged."
            )
        return f"Combat update in {_sector_text(pov_info)}."
    sector_text = _sector_text(pov_info)
    if pov_info.pov == CombatPOV.DIRECT:
        return "A new combat has begun. You are a participant."
    if pov_info.pov == CombatPOV.OBSERVED_VIA_CORP_SHIP:
        return (
            f"A new combat has begun. Your corp's {_ship_ref(pov_info)} "
            f"has entered combat in {sector_text}."
        )
    if pov_info.pov == CombatPOV.OBSERVED_VIA_GARRISON:
        owner_word = "Your" if pov_info.garrison_owned_by_self else "Your corp's"
        mode_text = (
            f" It is currently in {pov_info.garrison_mode} mode."
            if pov_info.garrison_mode
            else ""
        )
        return f"A new combat has begun. {owner_word} garrison in {sector_text} has engaged.{mode_text}"
    return f"A new combat has begun in {sector_text}."


def _round_resolved_pov_line(pov_info: CombatPOVInfo) -> str:
    if pov_info.pov == CombatPOV.DIRECT:
        return "Combat state: you are currently in active combat."
    if pov_info.pov == CombatPOV.OBSERVED_VIA_CORP_SHIP:
        return f"Combat state: your corp's {_ship_ref(pov_info)} is engaged in combat."
    if pov_info.pov == CombatPOV.OBSERVED_VIA_GARRISON:
        owner_word = "your" if pov_info.garrison_owned_by_self else "your corp's"
        return f"Combat state: {owner_word} garrison in {_sector_text(pov_info)} is engaged in combat."
    return "Combat state: this combat event is not your fight."


def _combat_ended_pov_line(pov_info: CombatPOVInfo) -> str:
    if pov_info.pov == CombatPOV.DIRECT:
        return "Your combat has ended."
    if pov_info.pov == CombatPOV.OBSERVED_VIA_CORP_SHIP:
        return (
            f"Your corp's {_ship_ref(pov_info)} combat in {_sector_text(pov_info)} "
            f"has ended."
        )
    if pov_info.pov == CombatPOV.OBSERVED_VIA_GARRISON:
        owner_word = "Your" if pov_info.garrison_owned_by_self else "Your corp's"
        garrison_attr = (
            f" (garrison_id={pov_info.garrison_id})" if pov_info.garrison_id else ""
        )
        return (
            f"{owner_word} garrison in {_sector_text(pov_info)}{garrison_attr} "
            f"combat has ended."
        )
    return f"Observed combat in {_sector_text(pov_info)} has ended."


def _xml_attrs_combat_encounter(
    relay: EventRelay, payload: Mapping[str, Any]
) -> list[tuple[str, str]]:
    """Per-viewer envelope attrs for combat.round_waiting / _resolved / ended.
    Always emits combat_pov so downstream gating (InferenceGate) can tell
    direct combat from observed combat without inferring from event name.
    DIRECT and sector-only viewers see only combat_id + combat_pov;
    corp-ship observers add ship_id (+ ship_name); garrison observers
    add garrison_id + garrison_owner. See catalog appendix A."""
    attrs: list[tuple[str, str]] = []
    combat_id = payload.get("combat_id")
    if isinstance(combat_id, str) and combat_id.strip():
        attrs.append(("combat_id", combat_id.strip()))
    pov_info = _compute_combat_pov(relay, payload)
    attrs.append(("combat_pov", pov_info.pov.value))
    if pov_info.pov == CombatPOV.OBSERVED_VIA_CORP_SHIP:
        if pov_info.ship_id:
            attrs.append(("ship_id", pov_info.ship_id))
        if pov_info.ship_name:
            attrs.append(("ship_name", pov_info.ship_name))
    elif pov_info.pov == CombatPOV.OBSERVED_VIA_GARRISON:
        if pov_info.garrison_id:
            attrs.append(("garrison_id", pov_info.garrison_id))
        if pov_info.garrison_owner:
            attrs.append(("garrison_owner", pov_info.garrison_owner))
    return attrs


def _xml_attrs_ship_destroyed(
    _relay: EventRelay, payload: Mapping[str, Any]
) -> list[tuple[str, str]]:
    """Subject-scoped: combat_id + ship_id always; ship_name when present."""
    attrs: list[tuple[str, str]] = []
    for key in ("combat_id", "ship_id", "ship_name"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            attrs.append((key, val.strip()))
    return attrs


def _xml_attrs_garrison_destroyed(
    _relay: EventRelay, payload: Mapping[str, Any]
) -> list[tuple[str, str]]:
    """Subject-scoped: combat_id + garrison_id + garrison_owner always."""
    attrs: list[tuple[str, str]] = []
    combat_id = payload.get("combat_id")
    if isinstance(combat_id, str) and combat_id.strip():
        attrs.append(("combat_id", combat_id.strip()))
    garrison_id = payload.get("garrison_id") or payload.get("combatant_id")
    if isinstance(garrison_id, str) and garrison_id.strip():
        attrs.append(("garrison_id", garrison_id.strip()))
    owner = payload.get("owner_character_id")
    if isinstance(owner, str) and owner.strip():
        attrs.append(("garrison_owner", owner.strip()))
    return attrs


def _summarize_combat_waiting(relay: EventRelay, event: dict) -> Optional[str]:
    payload = event.get("payload", {})
    if not isinstance(payload, Mapping):
        return event.get("summary")
    pov_info = _compute_combat_pov(relay, payload)
    pov_line = _round_waiting_pov_line(pov_info, payload)
    suffix = _combat_suffix(payload)
    body = f"{pov_line}{suffix}"
    deadline = payload.get("deadline")
    if isinstance(deadline, str) and deadline.strip():
        body += f" deadline {deadline.strip()}"
    if pov_info.pov == CombatPOV.DIRECT:
        body += "\nSubmit a combat action now."
    return body


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
    pov_info = _compute_combat_pov(relay, payload)
    pov_line = _round_resolved_pov_line(pov_info)
    suffix = _combat_suffix(payload)
    result_display = str(payload.get("result") or payload.get("end") or "in_progress")

    loss_fragment = _round_loss_fragment(relay, pov_info, payload)
    return f"{pov_line}{suffix}\nRound resolved: {result_display}; {loss_fragment}."


def _round_loss_fragment(
    relay: EventRelay, pov_info: CombatPOVInfo, payload: Mapping[str, Any]
) -> str:
    """One fragment per stake the viewer has — DIRECT shows own losses;
    OBSERVED via corp ship shows the corp ship's losses. OBSERVED via
    garrison falls back to a generic phrase since the garrison loss line
    would be the substantive update there."""
    if pov_info.pov == CombatPOV.DIRECT:
        return _format_actor_losses(relay._character_id, payload, "your")
    if pov_info.pov == CombatPOV.OBSERVED_VIA_CORP_SHIP and pov_info.ship_id:
        actor_id = _participant_id_for_ship(payload, pov_info.ship_id)
        if actor_id:
            ship_label = _ship_ref(pov_info)
            return _format_actor_losses(actor_id, payload, f"corp ship {ship_label}")
    return "no fighter losses, no shield damage"


def _participant_id_for_ship(
    payload: Mapping[str, Any], ship_id: str
) -> Optional[str]:
    participants = payload.get("participants")
    if not isinstance(participants, list):
        return None
    for p in participants:
        if not isinstance(p, Mapping):
            continue
        if p.get("ship_id") == ship_id and isinstance(p.get("id"), str):
            return p["id"]
    return None


def _format_actor_losses(
    actor_id: Optional[str], payload: Mapping[str, Any], label: str
) -> str:
    fighter_loss = 0
    shield_damage: float = 0.0
    if actor_id:
        participants = payload.get("participants")
        if isinstance(participants, list):
            for p in participants:
                if not isinstance(p, Mapping) or p.get("id") != actor_id:
                    continue
                ship = p.get("ship")
                if isinstance(ship, Mapping):
                    fl = ship.get("fighter_loss")
                    sd = ship.get("shield_damage")
                    if isinstance(fl, (int, float)):
                        fighter_loss = max(0, int(fl))
                    if isinstance(sd, (int, float)):
                        shield_damage = max(0.0, float(sd))
                break
    fighter_part = (
        f"fighters lost {fighter_loss}" if fighter_loss > 0 else "no fighter losses"
    )
    shield_part = (
        f"shield damage {shield_damage:.1f}%" if shield_damage > 0 else "no shield damage"
    )
    return f"{label}: {fighter_part}, {shield_part}"


def _summarize_ships_strategy_set(_relay: EventRelay, event: dict) -> Optional[str]:
    payload = event.get("payload", {})
    if not isinstance(payload, Mapping):
        return None
    ship_id = payload.get("ship_id")
    ship_name = payload.get("ship_name") or payload.get("ship_type") or "ship"
    ship_ref = f'"{ship_name}"' if isinstance(ship_name, str) else "ship"
    if isinstance(ship_id, str) and ship_id.strip():
        ship_ref = f"{ship_ref} (ship_id={ship_id.strip()[:6]})"
    strategy = payload.get("strategy")
    if not isinstance(strategy, Mapping):
        return f"Combat strategy updated for {ship_ref}."
    template = strategy.get("template") or "balanced"
    custom = strategy.get("custom_prompt")
    is_default = strategy.get("is_default") is True
    header = (
        f"Combat strategy for {ship_ref} is now the default '{template}' doctrine"
        if is_default
        else f"Combat strategy for {ship_ref} set to {template}"
    )
    if isinstance(custom, str) and custom.strip():
        return f"{header}. Additional commander guidance: {custom.strip()}"
    return f"{header}."


def _summarize_ships_strategy_cleared(_relay: EventRelay, event: dict) -> Optional[str]:
    payload = event.get("payload", {})
    if not isinstance(payload, Mapping):
        return None
    ship_id = payload.get("ship_id")
    ship_name = payload.get("ship_name") or payload.get("ship_type") or "ship"
    ship_ref = f'"{ship_name}"' if isinstance(ship_name, str) else "ship"
    if isinstance(ship_id, str) and ship_id.strip():
        ship_ref = f"{ship_ref} (ship_id={ship_id.strip()[:6]})"
    return (
        f"Combat strategy cleared for {ship_ref}. "
        "Ship falls back to the default 'balanced' doctrine."
    )


def _summarize_combat_ended(relay: EventRelay, event: dict) -> Optional[str]:
    payload = event.get("payload", {})
    if not isinstance(payload, Mapping):
        return event.get("summary")
    pov_info = _compute_combat_pov(relay, payload)
    pov_line = _combat_ended_pov_line(pov_info)
    result = payload.get("result") or payload.get("end")
    if isinstance(result, str) and result.strip():
        return f"{pov_line} Result: {result.strip()}."
    return pov_line


def _summarize_garrison_destroyed(relay: EventRelay, event: dict) -> Optional[str]:
    payload = event.get("payload", {})
    if not isinstance(payload, Mapping):
        return event.get("summary")
    sector = payload.get("sector")
    sector_id = sector.get("id") if isinstance(sector, Mapping) else None
    mode = payload.get("mode") if isinstance(payload.get("mode"), str) else "unknown"
    garrison_id = payload.get("garrison_id") or payload.get("combatant_id") or ""
    owner_character_id = payload.get("owner_character_id")
    is_owner = (
        isinstance(owner_character_id, str) and owner_character_id == relay._character_id
    )
    sector_text = f"sector {sector_id}" if isinstance(sector_id, int) else "the sector"
    if is_owner:
        return (
            f"Your garrison was destroyed in {sector_text} "
            f"garrison_id={garrison_id}, mode={mode}."
        )
    owner_name = payload.get("owner_name")
    owner_suffix = (
        f" (owner: {owner_name})" if isinstance(owner_name, str) and owner_name else ""
    )
    return (
        f"Garrison destroyed in {sector_text} "
        f"garrison_id={garrison_id}, mode={mode}{owner_suffix}."
    )


def _summarize_ship_destroyed(relay: EventRelay, event: dict) -> Optional[str]:
    payload = event.get("payload", {})
    if not isinstance(payload, Mapping):
        return event.get("summary")
    ship_name = payload.get("ship_name")
    ship_type = payload.get("ship_type")
    ship_label = (
        str(ship_name).strip()
        if isinstance(ship_name, str) and ship_name.strip()
        else str(ship_type).strip()
        if isinstance(ship_type, str) and ship_type.strip()
        else "ship"
    )
    sector = payload.get("sector")
    sector_id = sector.get("id") if isinstance(sector, Mapping) else None
    sector_text = f"sector {sector_id}" if isinstance(sector_id, int) else "the sector"
    combat_id = payload.get("combat_id")
    suffix = (
        f" combat_id={combat_id}" if isinstance(combat_id, str) and combat_id.strip() else ""
    )
    if _is_owned_subject(relay, payload):
        return f"Your ship {ship_label} was destroyed in {sector_text}.{suffix}"
    if is_corp_ship_destroyed_for_viewer(relay, payload):
        return f"Your corp ship {ship_label} was destroyed in {sector_text}.{suffix}"
    return f"Ship {ship_label} was destroyed in {sector_text}.{suffix}"


# ── Event config registry ─────────────────────────────────────────────────

EVENT_CONFIGS: dict[str, EventConfig] = {
    # RTVI only
    "map.update": EventConfig(append=AppendRule.NEVER),
    # Combat
    "combat.round_waiting": EventConfig(
        append=AppendRule.PARTICIPANT,
        inference=InferenceRule.ON_PARTICIPANT,
        priority=Priority.HIGH,
        xml_attrs_fn=_xml_attrs_combat_encounter,
        voice_summary=_summarize_combat_waiting,
    ),
    "combat.round_resolved": EventConfig(
        append=AppendRule.PARTICIPANT,
        inference=InferenceRule.ALWAYS,
        priority=Priority.HIGH,
        xml_attrs_fn=_xml_attrs_combat_encounter,
        voice_summary=_summarize_combat_round,
    ),
    "combat.ended": EventConfig(
        append=AppendRule.PARTICIPANT,
        # round_resolved already carries the player-facing outcome; a second
        # ended-triggered inference makes the voice agent restate the same
        # toll/combat resolution.
        inference=InferenceRule.NEVER,
        priority=Priority.LOW,
        xml_attrs_fn=_xml_attrs_combat_encounter,
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
    "garrison.destroyed": EventConfig(
        append=AppendRule.PARTICIPANT,
        # Voice fires for the owner only; corp members get silent context append.
        inference=InferenceRule.OWNED,
        priority=Priority.HIGH,
        xml_attrs_fn=_xml_attrs_garrison_destroyed,
        voice_summary=_summarize_garrison_destroyed,
    ),
    # Strategy lifecycle — direct to the setting character; inference fires so
    # voice acknowledges ("Strategy set to offensive.") and the tool's Executed
    # ack doesn't have to carry data itself.
    "ships.strategy_set": EventConfig(
        append=AppendRule.DIRECT,
        inference=InferenceRule.ALWAYS,
        xml_context_key="ship_id",
        voice_summary=_summarize_ships_strategy_set,
    ),
    "ships.strategy_cleared": EventConfig(
        append=AppendRule.DIRECT,
        inference=InferenceRule.ALWAYS,
        xml_context_key="ship_id",
        voice_summary=_summarize_ships_strategy_cleared,
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
    # ports.list is emitted whenever anyone queries known ports. The VoiceAgent
    # now calls list_known_ports as a direct-response tool (data returns inline
    # in the tool result), so appending the event would duplicate the data and
    # trigger a redundant second inference pass. Suppress append; onboarding's
    # passive observers and the TaskAgent's bus consumer both run before the
    # append check and are unaffected.
    "ports.list": EventConfig(append=AppendRule.NEVER),
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
    "quest.reward_claimed": EventConfig(inference=InferenceRule.ALWAYS, debounce_seconds=2.0),
    # Task-scoped allowlisted (direct events pass through when task-scoped)
    "trade.executed": EventConfig(task_scoped_allowlisted=True),
    "port.update": EventConfig(append=AppendRule.LOCAL),
    "bank.transaction": EventConfig(task_scoped_allowlisted=True),
    "warp.purchase": EventConfig(task_scoped_allowlisted=True),
    "map.local": EventConfig(task_scoped_allowlisted=True),
    # Corp events (allow corp scope when voice agent)
    "corporation.created": EventConfig(corp_scope_if_own_action=True),
    "corporation.ship_purchased": EventConfig(corp_scope_always_append=True),
    "corporation.ship_sold": EventConfig(corp_scope_always_append=True),
    # Always append to every corp member's LLM context so corpmates learn
    # about new members without a forced refresh. InferenceRule.NEVER (default)
    # means context updates but no spontaneous narration is triggered.
    "corporation.member_joined": EventConfig(corp_scope_always_append=True),
    "corporation.member_left": EventConfig(corp_scope_if_own_action=True),
    "corporation.member_kicked": EventConfig(corp_scope_if_own_action=True),
    "corporation.disbanded": EventConfig(corp_scope_if_own_action=True),
    "corporation.data": EventConfig(corp_scope_if_own_action=True),
    # Pending confirmation events: client-only. The client opens a
    # confirmation modal; the bot's client_message_handler drives the
    # follow-up confirm/cancel and injects its own <event> context for
    # the voice agent. Leaking the raw pending event into LLM context
    # would cause duplicate narration ("you're about to remove Bob...")
    # before the confirm fires.
    "corporation.kick_pending": EventConfig(append=AppendRule.NEVER),
    "corporation.leave_pending": EventConfig(append=AppendRule.NEVER),
    # Invite-code regeneration: client-only UI signal. The founder's
    # CorporationDetailsDialog listens for it to refresh the displayed
    # code. LLM context is injected separately by
    # client_message_handler._handle_regenerate_invite_code (modal path)
    # and by the voice-agent tool handler's run_llm=True acknowledgement
    # (LLM path). We must still subscribe here so the event reaches the
    # RTVI push that feeds the client.
    "corporation.invite_code_regenerated": EventConfig(append=AppendRule.NEVER),
    # Audited legacy overrides:
    # - event.query needs a shared bounded task/bus summary plus a shorter voice summary
    # - chat.message, ships.list, and combat overrides remain voice-only; generic client summaries
    #   are sufficient for bus/task consumers
    "event.query": EventConfig(
        task_summary=_summarize_event_query_for_task,
        voice_summary=_summarize_event_query,
    ),
    "ships.list": EventConfig(voice_summary=_summarize_ships_list),
    # Misc event configs
    "sector.update": EventConfig(append=AppendRule.LOCAL),
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
    "ship.destroyed": EventConfig(
        append=AppendRule.LOCAL,
        inference=InferenceRule.OWNED,
        xml_attrs_fn=_xml_attrs_ship_destroyed,
        voice_summary=_summarize_ship_destroyed,
    ),
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

    # Current task slot usage (appended to status.snapshot summaries so the
    # voice agent knows whether it has capacity to start another task).
    def active_tasks_summary(self) -> str: ...

    # Polling scope management
    def update_polling_scope(self) -> None: ...

    # Request ID tracking
    def is_recent_request_id(self, request_id: str) -> bool: ...
    # LLM frame management (inherited from LLMAgent)
    @property
    def tool_call_active(self) -> bool: ...
    # Agent activation state (inherited from BaseAgent). EventRelay gates
    # onboarding injection on this so the welcome event doesn't fire while
    # the voice agent is still bridged-inactive (e.g., tutorial scripted
    # intro is running).
    @property
    def active(self) -> bool: ...
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
        self.actor_ship_id: Optional[str] = None
        self._current_sector_id: Optional[int] = None
        self._last_poll_corp_id: Optional[str] = game_client.corporation_id
        # Onboarding (passive observation)
        self.is_new_player: Optional[bool] = None  # None=unknown, True=new, False=veteran
        self._first_status_delivered = False
        self._megaport_check_request_id: Optional[str] = None
        self._onboarding_complete = False
        self._onboarding_route: Optional[list[int]] = None
        self._session_started_at: Optional[str] = None
        self._debounce_tasks: dict[str, asyncio.Task] = {}
        self._debounce_held_messages: dict[str, list[dict]] = {}
        # Combat preamble tracking: combat.md is loaded at most once per
        # session; strategy is re-fetched on every DIRECT round-1 entry (may
        # have changed between combats).
        self._combat_md_loaded = False

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
        self._onboarding_route = None
        self._session_started_at = None
        result = await self._game_client.join(self._character_id)
        self._session_started_at = datetime.now(timezone.utc).isoformat()
        # Extract onboarding route if present (new players only)
        if isinstance(result, Mapping):
            route = result.get("onboarding_route")
            if isinstance(route, list) and len(route) > 1:
                self._onboarding_route = [int(s) for s in route]
                logger.info(
                    f"Onboarding: route to mega port received, "
                    f"{len(self._onboarding_route)} hops: "
                    f"{self._onboarding_route[0]} → {self._onboarding_route[-1]}"
                )
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
        from gradientbang import __version__

        await self._rtvi.push_frame(
            RTVIServerMessageFrame(
                {"frame_type": "event", "event": "session.version", "payload": {"version": __version__}}
            )
        )
        return result

    async def close(self) -> None:
        for task in self._debounce_tasks.values():
            task.cancel()
        self._debounce_tasks.clear()
        self._debounce_held_messages.clear()
        self.is_new_player = None
        self._first_status_delivered = False
        self._onboarding_complete = False
        self._onboarding_route = None
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

    def _update_actor_ship_id(self, payload: Mapping[str, Any]) -> None:
        ship = payload.get("ship")
        if isinstance(ship, Mapping):
            ship_id = ship.get("ship_id")
            if isinstance(ship_id, str) and ship_id.strip():
                self.actor_ship_id = ship_id

    def _sync_corp_polling_scope(self) -> None:
        """Sync polling scope when corporation_id changes on the game client.

        Called after status.snapshot/status.update sets corporation_id.
        Mirrors the pattern from the old VoiceTaskManager._sync_corp_polling_scope.
        """
        corp_id = self._game_client.corporation_id
        if corp_id == self._last_poll_corp_id:
            return
        self._last_poll_corp_id = corp_id
        self._task_state.update_polling_scope()

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
        # Wait until the voice agent is active so the injection actually
        # reaches the user. While inactive, the LLM run would produce no
        # audible output (the edge sink drops outbound frames) and would
        # pollute context. The caller (bot.py _on_tutorial_complete) re-invokes
        # this method after activation to deliver the deferred event.
        if not self._task_state.active:
            return
        self._onboarding_complete = True
        if self.is_new_player:
            from gradientbang.utils.prompt_loader import load_prompt

            if self._onboarding_route:
                route_str = " → ".join(str(s) for s in self._onboarding_route)
            else:
                route_str = "unavailable"
            content = load_prompt("fragments/onboarding.md").format(
                display_name=self.display_name,
                route_to_megaport=route_str,
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

    def _bound_character_id(self) -> str:
        candidate = getattr(self._game_client, "_canonical_character_id", None)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
        return self._character_id

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
    def _extract_sector_id(
        payload: Mapping[str, Any], *, allow_top_level_id: bool = False
    ) -> Optional[int]:
        sector = payload.get("sector")
        if isinstance(sector, Mapping):
            candidate = sector.get("id")
            if candidate is None:
                candidate = sector.get("sector_id")
        else:
            candidate = payload.get("sector_id")
            if candidate is None:
                candidate = sector
        if candidate is None and allow_top_level_id:
            candidate = payload.get("id")
        if isinstance(candidate, bool):
            return None
        if isinstance(candidate, int):
            return candidate
        if isinstance(candidate, str) and candidate.strip().isdigit():
            return int(candidate.strip())
        return None

    # ── Debounced inference ─────────────────────────────────────────────

    def _schedule_debounced_inference(
        self, event_name: str, delay: float, held_message: Optional[str] = None
    ) -> None:
        """Start or reset a debounce timer for the given event type.

        When *held_message* is provided the event XML is not delivered
        immediately — the timer owns both delivery and inference so the
        events appear fresh in context after any in-flight tool-completion
        response.
        """
        existing = self._debounce_tasks.get(event_name)
        if existing and not existing.done():
            existing.cancel()

        if held_message is not None:
            self._debounce_held_messages.setdefault(event_name, []).append(
                {"role": "user", "content": held_message}
            )

        async def _fire():
            await asyncio.sleep(delay)
            self._debounce_tasks.pop(event_name, None)
            held = self._debounce_held_messages.pop(event_name, None)
            if held:
                await self._task_state.queue_frame(
                    LLMMessagesAppendFrame(messages=held, run_llm=False)
                )
            await self._task_state.queue_frame(LLMRunFrame())

        self._debounce_tasks[event_name] = asyncio.get_event_loop().create_task(_fire())

    # ── LLM event delivery ─────────────────────────────────────────────

    async def _deliver_llm_event(self, event_xml: str, should_run_llm: bool) -> None:
        await self._task_state.queue_frame(
            LLMMessagesAppendFrame(
                messages=[{"role": "user", "content": event_xml}],
                run_llm=should_run_llm,
            )
        )
        logger.info("LLM deliver complete")

    async def _inject_combat_preamble(self, payload: Mapping[str, Any]) -> None:
        """Inject combat.md + the ship's strategy into LLM context ahead of a
        DIRECT round-1 combat event.

        combat.md is loaded once per session; strategy is re-fetched every
        combat (may change between combats). Both frames are queued with
        ``run_llm=False`` so they land in context without triggering
        inference — the subsequent XML event frame (with the normal
        InferenceRule) is what wakes the LLM.

        Order is fixed: combat.md → doctrine → event XML. The corp-ship
        TaskAgent path mirrors this same order in
        ``TaskAgent._maybe_inject_combat_preamble``.
        """
        # ── combat.md (once per session) ──
        if not self._combat_md_loaded:
            try:
                content = render_combat_md_preamble_message()
                await self._task_state.queue_frame(
                    LLMMessagesAppendFrame(
                        messages=[{"role": "user", "content": content}],
                        run_llm=False,
                    )
                )
                self._combat_md_loaded = True
            except Exception:  # noqa: BLE001
                logger.warning(
                    "relay.combat_preamble.combat_md_failed", exc_info=True
                )

        # ── ship strategy (every combat) ──
        ship_id = self._extract_own_ship_id_from_participants(payload)
        if not ship_id:
            ship_id = self.actor_ship_id
        if not ship_id:
            return
        try:
            result = await self._game_client.combat_get_strategy(
                ship_id=ship_id,
                character_id=self._character_id,
            )
        except Exception:  # noqa: BLE001
            logger.warning(
                "relay.combat_preamble.strategy_fetch_failed",
                exc_info=True,
            )
            return
        strategy = result.get("strategy") if isinstance(result, Mapping) else None
        try:
            content = render_ship_doctrine_preamble_message(strategy)
        except Exception:  # noqa: BLE001
            logger.warning(
                "relay.combat_preamble.render_failed", exc_info=True
            )
            return
        await self._task_state.queue_frame(
            LLMMessagesAppendFrame(
                messages=[{"role": "user", "content": content}],
                run_llm=False,
            )
        )

    def _extract_own_ship_id_from_participants(
        self,
        payload: Mapping[str, Any],
    ) -> Optional[str]:
        """Pull the bound character's ship_id out of a combat event's
        ``participants[]``. More reliable than ``self.actor_ship_id`` for
        combat entry — a status.snapshot may not have fired yet."""
        participants = payload.get("participants")
        if not isinstance(participants, list):
            return None
        for p in participants:
            if not isinstance(p, Mapping):
                continue
            if p.get("id") != self._character_id:
                continue
            # Ship id may live on the participant directly or nested on a
            # `ship` sub-object; accept either.
            for source in (p, p.get("ship")):
                if not isinstance(source, Mapping):
                    continue
                ship_id = source.get("ship_id")
                if isinstance(ship_id, str) and ship_id.strip():
                    return ship_id.strip()
        return None

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
        try:
            await self._task_state.broadcast_game_event(event)
        except Exception:
            logger.exception("task.cancel handler failed")

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
            if isinstance(clean_payload, Mapping):
                if event_name == "combat.round_waiting":
                    if clean_payload.get("round") == 1:
                        return True
                    return combat_for_player or has_observed_combat_stake(
                        self, clean_payload
                    )
                if event_name == "combat.round_resolved":
                    return combat_for_player or has_observed_combat_stake(
                        self, clean_payload
                    )
                if event_name == "garrison.destroyed":
                    return is_garrison_subject_for_viewer(self, clean_payload)
            return combat_for_player

        if rule == AppendRule.OWNED_TASK:
            return is_our_task

        if rule == AppendRule.LOCAL:
            if isinstance(clean_payload, Mapping) and event_name == "ship.destroyed":
                owned_or_corp_ship = _is_owned_subject(
                    self, clean_payload
                ) or is_corp_ship_destroyed_for_viewer(self, clean_payload)
                if owned_or_corp_ship:
                    return True
            if isinstance(clean_payload, Mapping):
                sector_id = self._extract_sector_id(
                    clean_payload,
                    allow_top_level_id=event_name == "sector.update",
                )
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
        # DIRECT rows can be delivered to the voice client because the shared
        # poller includes corp-ship ids for TaskAgent fan-out. If the event
        # subject is another player/pseudo-character, keep it out of voice LLM
        # context; LOCAL/PARTICIPANT/OWNED_TASK rules make their own decisions.
        if is_other_player:
            return False

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
        # corp_scope_always_append is deliberately broader than
        # corp_scope_if_own_action: we append corp-scoped events to ANY corp
        # member's voice context, not only when the voice agent was the actor.
        # Used for e.g. corporation.member_joined so every corpmate's LLM
        # learns about the new member (inference still gated by InferenceRule).
        if scope == "corp" and cfg.corp_scope_always_append:
            return True
        return False

    def _should_run_llm(
        self,
        cfg: EventConfig,
        event_name: str,
        is_our_task: bool,
        request_id: Optional[str],
        combat_for_player: bool,
        clean_payload: Any,
    ) -> bool:
        rule = cfg.inference
        is_voice = self._task_state.is_recent_request_id(request_id) if request_id else False

        if (
            event_name == "combat.round_resolved"
            and isinstance(clean_payload, Mapping)
            and not combat_for_player
        ):
            result = has_observed_combat_stake(
                self, clean_payload
            ) and is_terminal_combat_resolution(clean_payload)
        elif rule == InferenceRule.ALWAYS:
            result = True
        elif rule == InferenceRule.VOICE_AGENT:
            result = is_voice
        elif rule == InferenceRule.ON_PARTICIPANT:
            result = combat_for_player
            # Round-1 combat broadcast also notifies viewers with an owned
            # or corp stake — corp-ship participant or owned/corp garrison
            # in the engagement. Sector-only observers stay silent (no
            # personal stake → no spoken interruption). The relay still
            # appends the round-1 frame as silent context for those
            # observers; only `run_llm` differs here.
            if (
                not result
                and event_name == "combat.round_waiting"
                and isinstance(clean_payload, Mapping)
                and clean_payload.get("round") == 1
            ):
                pov_info = _compute_combat_pov(self, clean_payload)
                if pov_info.pov in (
                    CombatPOV.OBSERVED_VIA_CORP_SHIP,
                    CombatPOV.OBSERVED_VIA_GARRISON,
                ):
                    result = True
        elif rule == InferenceRule.OWNED:
            # Viewer owns the event subject (e.g. their garrison was destroyed).
            result = False
            if isinstance(clean_payload, Mapping):
                result = _is_owned_subject(self, clean_payload)
                if not result and event_name == "ship.destroyed":
                    result = is_corp_ship_destroyed_for_viewer(self, clean_payload)
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
        bound_character_id = self._bound_character_id()
        is_other_player = bool(player_id and player_id != bound_character_id)

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

        # Display name / corp polling scope sync
        if cfg.sync_display_name and not is_other_player and isinstance(clean_payload, Mapping):
            self._update_display_name(clean_payload)
            self._update_actor_ship_id(clean_payload)
            self._sync_corp_polling_scope()

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

        # Append current task slot usage to our own status.snapshot summaries
        # so the voice agent sees capacity info every time status refreshes.
        if event_name == "status.snapshot" and not is_other_player and isinstance(summary, str):
            summary = f"{summary}\n{self._task_state.active_tasks_summary()}"

        # Build XML. Attr values may contain user-controlled strings (e.g.
        # ship_name) — escape quotes and angle brackets so they can't
        # corrupt the envelope the LLM consumes.
        attrs = [f'name="{_xml_escape_attr(event_name)}"']
        if payload_task_id:
            attrs.append(f'task_id="{_xml_escape_attr(payload_task_id)}"')
        if cfg.xml_attrs_fn is not None and isinstance(clean_payload, Mapping):
            for key, val in cfg.xml_attrs_fn(self, clean_payload) or []:
                attrs.append(f'{key}="{_xml_escape_attr(val)}"')
        elif cfg.xml_context_key and isinstance(clean_payload, Mapping):
            ctx_val = clean_payload.get(cfg.xml_context_key)
            if isinstance(ctx_val, str) and ctx_val.strip():
                attrs.append(
                    f'{cfg.xml_context_key}="{_xml_escape_attr(ctx_val.strip())}"'
                )
        event_xml = f"<event {' '.join(attrs)}>\n{summary}\n</event>"

        should_run_llm = self._should_run_llm(
            cfg, event_name, is_our_task, request_id, combat_for_player, clean_payload
        )

        # Debounce rapid-fire inference triggers.
        # Hold delivery so events appear fresh in context when the timer
        # fires, avoiding them being buried behind a tool-completion response.
        if should_run_llm and cfg.debounce_seconds is not None:
            self._schedule_debounced_inference(
                event_name, cfg.debounce_seconds, held_message=event_xml
            )
            return

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

        # DIRECT round-1 combat entry: prepend combat.md (once per session)
        # and this ship's strategy so the LLM has both in context before it
        # has to decide an action. Silent appends — the XML frame below is
        # what wakes inference.
        if (
            event_name == "combat.round_waiting"
            and isinstance(clean_payload, Mapping)
            and clean_payload.get("round") == 1
            and _is_player_participant(self, clean_payload)
        ):
            await self._inject_combat_preamble(clean_payload)

        await self._deliver_llm_event(event_xml, should_run_llm)
