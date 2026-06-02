"""Small combat-event helpers for runtime routing and task-agent context.

Keeps the canonical combat event name set and the participant-matching
helpers in one place so routing code does not drift.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

# Canonical set of combat event names the runtime cares about.
# EventRelay's EVENT_CONFIGS is the source of truth for routing rules
# (priority, append rule, inference rule); this set is the source of truth
# for "is this event part of the combat flow"; used by TaskAgent to
# match by participants rather than payload.player.
COMBAT_EVENT_NAMES: frozenset[str] = frozenset(
    {
        "combat.round_waiting",
        "combat.round_resolved",
        "combat.ended",
        "combat.action_accepted",
        "combat.round_timeout",
    }
)


def is_combat_participant(payload: Mapping[str, Any] | None, character_id: str | None) -> bool:
    """True if ``character_id`` appears in the combat payload's participants list."""
    if not character_id or not isinstance(payload, Mapping):
        return False
    participants = payload.get("participants")
    if not isinstance(participants, list):
        return False
    for p in participants:
        if isinstance(p, Mapping) and p.get("id") == character_id:
            return True
    return False


def own_ship_id_from_participants(
    payload: Mapping[str, Any] | None, character_id: str | None
) -> Optional[str]:
    """Pull ``character_id``'s ``ship_id`` out of a combat event's ``participants[]``.

    Ship id may live on the participant directly or nested on a ``ship``
    sub-object; accept either. Returns None if the character is not a
    participant or no ship_id is recorded.
    """
    if not character_id or not isinstance(payload, Mapping):
        return None
    participants = payload.get("participants")
    if not isinstance(participants, list):
        return None
    for p in participants:
        if not isinstance(p, Mapping) or p.get("id") != character_id:
            continue
        for source in (p, p.get("ship")):
            if not isinstance(source, Mapping):
                continue
            ship_id = source.get("ship_id")
            if isinstance(ship_id, str) and ship_id.strip():
                return ship_id.strip()
    return None


def owned_corp_ship_participant_ids(
    payload: Mapping[str, Any] | None, corp_id: str | None
) -> list[str]:
    """Return owned corporation-ship participant character ids.

    The combat payload already carries ``player_type`` and ``corp_id`` on
    participant rows, so the orchestrator can avoid a corporation ship lookup
    during the combat hot path.
    """
    if not isinstance(payload, Mapping):
        return []
    participants = payload.get("participants")
    if not isinstance(participants, list):
        return []
    if not corp_id:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for p in participants:
        if not isinstance(p, Mapping):
            continue
        if p.get("player_type") != "corporation_ship" or p.get("corp_id") != corp_id:
            continue
        cid = p.get("id")
        if not isinstance(cid, str) or cid in seen:
            continue
        seen.add(cid)
        out.append(cid)
    return out


def combat_id_from_payload(payload: Mapping[str, Any] | None) -> Optional[str]:
    """Return the encounter id used by combat payloads, accepting legacy names."""
    if not isinstance(payload, Mapping):
        return None
    for key in ("combat_id", "encounter_id"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def build_combat_task_description(
    payload: Mapping[str, Any] | None,
    character_id: str | None = None,
) -> str:
    """Build the normal task instruction used when combat takes priority."""
    combat_id = combat_id_from_payload(payload)
    sector = payload.get("sector") if isinstance(payload, Mapping) else None
    sector_text = ""
    if isinstance(sector, Mapping):
        sector_id = sector.get("id") or sector.get("sector_id")
        if sector_id is not None:
            sector_text = f" in sector {sector_id}"

    opponent_names: list[str] = []
    if isinstance(payload, Mapping):
        participants = payload.get("participants")
        if isinstance(participants, list):
            for p in participants:
                if not isinstance(p, Mapping) or p.get("id") == character_id:
                    continue
                name = p.get("name") or p.get("id")
                if isinstance(name, str) and name.strip():
                    opponent_names.append(name.strip())

    parts = [f"Combat has started{sector_text}."]
    if combat_id:
        parts.append(f"Encounter: {combat_id}.")
    if opponent_names:
        parts.append(f"Visible opponents: {', '.join(opponent_names[:5])}.")
    parts.append(
        "Drop the previous plan and fight this encounter now. "
        "When a combat.round_waiting event arrives, use combat_action for that round. "
        "Call finished only after combat.ended."
    )
    return " ".join(parts)


def should_inject_combat_preamble(
    event_name: Optional[str],
    payload: Any,
    character_id: str | None,
) -> bool:
    """Guard for combat preamble injection.

    A task may be created or woken after the first waiting event was missed.
    The caller owns once-per-combat suppression; this helper only checks that
    the current event is a waiting event for the local combat participant.
    """
    if event_name != "combat.round_waiting":
        return False
    if not isinstance(payload, Mapping):
        return False
    return is_combat_participant(payload, character_id)
