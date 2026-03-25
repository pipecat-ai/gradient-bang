"""Shared formatting helpers for display names, IDs, and ship data."""

import json
import re
from typing import Any, Dict, List, Mapping, Optional

_ID_PREFIX_LEN = 6
_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{12}"
)
_BRACKET_HEX_RE = re.compile(r"\[([0-9a-fA-F]{8,})\]")


def short_id(value: Any, prefix_len: int = _ID_PREFIX_LEN) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    return text[:prefix_len]


def shorten_embedded_ids(text: str, prefix_len: int = _ID_PREFIX_LEN) -> str:
    if not isinstance(text, str) or not text:
        return text
    text = _UUID_RE.sub(lambda match: match.group(0)[:prefix_len], text)
    text = _BRACKET_HEX_RE.sub(lambda match: f"[{match.group(1)[:prefix_len]}]", text)
    return text


def friendly_ship_type(raw_type: Optional[str]) -> str:
    if not isinstance(raw_type, str) or not raw_type:
        return "unknown"
    return raw_type.replace("_", " ").title()


def format_ship_holds(ship: Dict[str, Any]) -> str:
    cargo = ship.get("cargo") if isinstance(ship, dict) else None
    capacity = ship.get("cargo_capacity")
    used = 0
    if isinstance(cargo, dict):
        for value in cargo.values():
            if isinstance(value, (int, float)):
                used += int(value)
    if isinstance(capacity, (int, float)):
        empty = max(int(capacity) - used, 0)
        return f"holds {int(capacity)} (empty {empty})"
    return "holds ?"


def format_ship_summary_line(ship: Dict[str, Any], include_id: bool = True) -> str:
    """Format a single ship dict into a concise one-line summary.

    Produces a markdown list item with ship name, type, sector, cargo holds,
    warp power, and current task. Used by voice summaries to present fleet
    information to the LLM.

    Example output:
        - Voyager [abc123] (Frigate) in sector 5; holds 100 (empty 50); warp 3/10; task abc123
    """
    ship_name = shorten_embedded_ids(str(ship.get("ship_name") or "Unnamed"))
    ship_type = friendly_ship_type(ship.get("ship_type"))
    sector = ship.get("sector")
    sector_display = sector if isinstance(sector, int) else "unknown"
    id_suffix = ""
    if include_id:
        prefix = short_id(ship.get("ship_id"))
        if prefix:
            id_suffix = f" [{prefix}]"
    details = [f"{ship_name}{id_suffix} ({ship_type}) in sector {sector_display}"]
    details.append(format_ship_holds(ship))
    warp = ship.get("warp_power")
    warp_max = ship.get("warp_power_capacity")
    if isinstance(warp, (int, float)) and isinstance(warp_max, (int, float)):
        details.append(f"warp {int(warp)}/{int(warp_max)}")
    current_task_id = ship.get("current_task_id")
    if isinstance(current_task_id, str) and current_task_id:
        details.append(f"task {short_id(current_task_id) or current_task_id}")
    else:
        details.append("task none")
    return "- " + "; ".join(details)


def summarize_corporation_info(result: Any) -> str:
    """Produce a concise text summary of a corporation_info API response.

    Handles both the ``corporation_list`` (multiple corps) and
    ``my_corporation`` (single corp with ships/members) response shapes.
    Ship lines include a short hex prefix in brackets so the LLM can
    reference them by ID when starting corp ship tasks.
    """
    if not isinstance(result, dict):
        return "Corporation info unavailable."

    # ── Multi-corp list response ──
    corporations = result.get("corporations")
    if isinstance(corporations, list):
        count = len(corporations)
        if count == 0:
            return "No corporations found."
        entries: List[str] = []
        for corp in corporations[:5]:
            if not isinstance(corp, dict):
                continue
            name = shorten_embedded_ids(str(corp.get("name", "Unknown")))
            member_count = corp.get("member_count")
            if isinstance(member_count, int):
                entries.append(f"{name} ({member_count})")
            else:
                entries.append(name)
        summary = f"Corporations: {count} total. " + ", ".join(entries)
        remaining = count - len(entries)
        if remaining > 0:
            summary += f", +{remaining} more"
        return summary

    # ── Single-corp response ──
    corp = result.get("corporation")
    if corp is None and any(
        key in result for key in ("corp_id", "name", "member_count", "members", "ships")
    ):
        corp = result
    if corp is None:
        return "You are not in a corporation."
    if not isinstance(corp, dict):
        return "Corporation info unavailable."

    corp_name = shorten_embedded_ids(str(corp.get("name", "Unknown corporation")))
    ships = corp.get("ships") if isinstance(corp.get("ships"), list) else []
    ship_count = len(ships)
    member_count = corp.get("member_count")
    header = f"Corporation: {corp_name}"
    if isinstance(member_count, int):
        header += f" (members: {member_count}, ships: {ship_count})"
    else:
        header += f" (ships: {ship_count})"
    lines: List[str] = [header]

    members = corp.get("members")
    if isinstance(members, list) and members:
        names: List[str] = []
        for member in members:
            if not isinstance(member, dict):
                continue
            name = member.get("name") or member.get("character_id")
            if isinstance(name, str) and name:
                names.append(shorten_embedded_ids(name))
        if names:
            lines.append("Members: " + ", ".join(names))

    if ships:
        lines.append("Ships:")
        for ship in ships:
            if not isinstance(ship, dict):
                continue
            ship_name = ship.get("name") or ship.get("ship_name") or "Unnamed Vessel"
            ship_name = shorten_embedded_ids(str(ship_name))
            ship_type = friendly_ship_type(ship.get("ship_type"))
            ship_id_prefix = short_id(ship.get("ship_id"))
            id_suffix = f" [{ship_id_prefix}]" if ship_id_prefix else ""
            sector = ship.get("sector")
            sector_display = sector if isinstance(sector, int) else "unknown"
            details: List[str] = [
                f"{ship_name}{id_suffix} ({ship_type}) in sector {sector_display}",
                format_ship_holds(ship),
            ]
            warp = ship.get("warp_power")
            warp_max = ship.get("warp_power_capacity")
            if isinstance(warp, (int, float)) and isinstance(warp_max, (int, float)):
                details.append(f"warp {int(warp)}/{int(warp_max)}")
            credits_val = ship.get("credits")
            if isinstance(credits_val, (int, float)):
                details.append(f"credits {int(credits_val)}")
            current_task_id = ship.get("current_task_id")
            if isinstance(current_task_id, str) and current_task_id:
                task_display = short_id(current_task_id) or current_task_id
            else:
                task_display = "none"
            details.append(f"task {task_display}")
            fighters = ship.get("fighters")
            if isinstance(fighters, (int, float)):
                details.append(f"fighters {int(fighters)}")
            lines.append("- " + "; ".join(details))
    else:
        lines.append("Ships: none")

    destroyed_ships = corp.get("destroyed_ships") if isinstance(corp.get("destroyed_ships"), list) else []
    if destroyed_ships:
        lines.append(f"Destroyed ships ({len(destroyed_ships)}):")
        for ship in destroyed_ships:
            if not isinstance(ship, dict):
                continue
            ship_name = ship.get("name") or ship.get("ship_name") or "Unnamed Vessel"
            ship_name = shorten_embedded_ids(str(ship_name))
            ship_type = friendly_ship_type(ship.get("ship_type"))
            sector = ship.get("sector")
            sector_display = sector if isinstance(sector, int) else "unknown"
            lines.append(f"- [DESTROYED] {ship_name} ({ship_type}) last seen sector {sector_display}")

    return "\n".join(lines)


def _parse_stats(raw: Any) -> Dict[str, Any]:
    """Parse a stats field that may be a dict or JSON string."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            pass
    return {}


def summarize_ship_definitions(result: Any) -> str:
    """Produce a concise text summary of ship definitions."""
    if not isinstance(result, (dict, list)):
        return "Ship definitions unavailable."
    definitions = result if isinstance(result, list) else result.get("definitions")
    if not isinstance(definitions, list) or not definitions:
        return "No ship definitions found."
    lines: List[str] = []
    for d in definitions:
        if not isinstance(d, dict):
            continue
        name = d.get("display_name") or d.get("ship_type", "?")
        price = d.get("purchase_price")
        stats = _parse_stats(d.get("stats"))
        trade_in = stats.get("trade_in_value")
        if not isinstance(price, (int, float)):
            lines.append(f"- {name}: price unknown")
            continue
        parts = [f"{int(price):,} credits"]
        if isinstance(trade_in, (int, float)):
            parts.append(f"trade-in: {int(trade_in):,}")
        lines.append(f"- {name}: {', '.join(parts)}")
    return "Ship definitions (purchase_price / trade-in value):\n" + "\n".join(lines)


def summarize_leaderboard(result: Any) -> Optional[str]:
    """Produce a concise text summary of the resource leaderboard."""
    if not isinstance(result, dict):
        return None
    players = result.get("players")
    corporations = result.get("corporations")
    if not isinstance(players, list):
        players = []
    if not isinstance(corporations, list):
        corporations = []

    summary = f"Leaderboard: {len(players)} players, {len(corporations)} corporations."

    def _extract_name(entry: Any, keys: tuple) -> Optional[str]:
        if not isinstance(entry, dict):
            return None
        for key in keys:
            candidate = entry.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
        return None

    top_player_name = _extract_name(
        players[0] if players else None, ("name", "player_name", "character_name")
    )
    if top_player_name:
        summary += f" Top player: {shorten_embedded_ids(top_player_name)}."

    top_corp_name = _extract_name(
        corporations[0] if corporations else None, ("name", "corp_name", "corporation_name")
    )
    if top_corp_name:
        summary += f" Top corp: {shorten_embedded_ids(top_corp_name)}."

    return summary


def extract_display_name(payload: Mapping[str, Any]) -> Optional[str]:
    """Extract a display name from a game event payload."""
    def _clean(value: Any) -> Optional[str]:
        if isinstance(value, str):
            value = value.strip()
            if value:
                return value
        return None

    if not isinstance(payload, Mapping):
        return None
    player = payload.get("player")
    if isinstance(player, Mapping):
        for key in ("name", "display_name", "player_name"):
            candidate = _clean(player.get(key))
            if candidate:
                return candidate
    for fallback in ("player_name", "name"):
        candidate = _clean(payload.get(fallback))
        if candidate:
            return candidate
    return None
