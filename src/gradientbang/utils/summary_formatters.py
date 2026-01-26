"""Client-side summary formatters for API responses.

These formatters extract concise summaries from full API responses,
reducing token usage when sending tool results to the LLM.
"""

from datetime import datetime, timezone
from typing import Callable, Dict, Any, List, Optional, Tuple
from collections import defaultdict
import re

from gradientbang.game_server.ships import ShipType, get_ship_stats

_ID_PREFIX_LEN = 6
_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{12}"
)
_BRACKET_HEX_RE = re.compile(r"\[([0-9a-fA-F]{8,})\]")
_ID_KEY_HINTS = ("ship", "character", "player", "actor", "owner", "target")


def _short_id(value: Any, prefix_len: int = _ID_PREFIX_LEN) -> Optional[str]:
    """Return a short ID prefix for known ID strings."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    return text[:prefix_len]


def _shorten_embedded_ids(text: str, prefix_len: int = _ID_PREFIX_LEN) -> str:
    """Shorten UUIDs or bracketed hex IDs embedded in display names."""
    if not isinstance(text, str) or not text:
        return text
    text = _UUID_RE.sub(lambda match: match.group(0)[:prefix_len], text)
    text = _BRACKET_HEX_RE.sub(lambda match: f"[{match.group(1)[:prefix_len]}]", text)
    return text


def _should_shorten_id_for_value_key(key: str) -> bool:
    """Return True when key likely represents a ship/character identifier value."""
    key_lower = key.lower()
    if "id" not in key_lower:
        return False
    return any(hint in key_lower for hint in _ID_KEY_HINTS)


def _should_shorten_id_for_object_key(key: str) -> bool:
    """Return True when key likely represents a ship/character object."""
    key_lower = key.lower()
    return any(hint in key_lower for hint in _ID_KEY_HINTS)

def _format_relative_time(timestamp_str: str) -> str:
    """Format an ISO timestamp as relative time (e.g., '5 minutes ago', '2 hours ago').

    Args:
        timestamp_str: ISO format timestamp string

    Returns:
        Human-readable relative time string
    """
    try:
        # Parse the timestamp (handle both with and without timezone)
        if timestamp_str.endswith("Z"):
            timestamp = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
        elif "+" in timestamp_str or timestamp_str.count("-") > 2:
            timestamp = datetime.fromisoformat(timestamp_str)
        else:
            # Assume UTC if no timezone
            timestamp = datetime.fromisoformat(timestamp_str).replace(
                tzinfo=timezone.utc
            )

        # Get current time in UTC
        now = datetime.now(timezone.utc)

        # Calculate difference
        delta = now - timestamp
        total_seconds = delta.total_seconds()

        if total_seconds < 60:
            return "just now"
        elif total_seconds < 3600:  # Less than 1 hour
            minutes = int(total_seconds / 60)
            unit = "minute" if minutes == 1 else "minutes"
            return f"{minutes} {unit} ago"
        elif total_seconds < 86400:  # Less than 1 day
            hours = int(total_seconds / 3600)
            unit = "hour" if hours == 1 else "hours"
            return f"{hours} {unit} ago"
        else:  # 1 day or more
            days = int(total_seconds / 86400)
            unit = "day" if days == 1 else "days"
            return f"{days} {unit} ago"
    except (ValueError, AttributeError):
        # If parsing fails, return original string
        return timestamp_str


def _format_iso_clock(timestamp_str: Optional[str]) -> str:
    """Format ISO timestamps as HH:MM:SS (UTC if timezone present)."""

    if not isinstance(timestamp_str, str) or not timestamp_str:
        return "unknown"

    try:
        normalized = timestamp_str.replace("Z", "+00:00")
        moment = datetime.fromisoformat(normalized)
        if moment.tzinfo is None:
            return moment.strftime("%H:%M:%S")
        return moment.astimezone(timezone.utc).strftime("%H:%M:%SZ")
    except ValueError:
        return timestamp_str


def _format_cargo(cargo: Dict[str, int]) -> str:
    """Format cargo as 'X QF | Y RO | Z NS'."""
    qf = cargo.get("quantum_foam", 0)
    ro = cargo.get("retro_organics", 0)
    ns = cargo.get("neuro_symbolics", 0)
    return f"{qf} QF | {ro} RO | {ns} NS"


def _format_holds(ship: Dict[str, Any]) -> str:
    """Format holds as 'holds N (empty M)'."""
    cargo = ship.get("cargo") if isinstance(ship, dict) else {}
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


def _format_port_prices_compact(port: Dict[str, Any]) -> str:
    """Format port with prices as compact single-line string.

    Returns format like: 'BSS buys QF@45 sells RO@120,NS@85'
    """
    if not port:
        return ""

    code = port.get("code", "???")
    mega = port.get("mega") is True
    prices = port.get("prices", {})

    prefix = "MEGA " if mega else ""
    if not code or not prices:
        return f"{prefix}{code}".strip()

    # Map commodities to their abbreviations and port code positions
    commodities = [
        ("quantum_foam", "QF", 0),
        ("retro_organics", "RO", 1),
        ("neuro_symbolics", "NS", 2),
    ]

    buys: List[str] = []
    sells: List[str] = []

    for commodity, abbrev, idx in commodities:
        price = prices.get(commodity)
        if price is None:
            continue

        # B = port buys (player sells), S = port sells (player buys)
        if idx < len(code) and code[idx] == "B":
            buys.append(f"{abbrev}@{price}")
        else:
            sells.append(f"{abbrev}@{price}")

    parts = [f"{prefix}{code}".strip()]
    if buys:
        parts.append(f"buys {','.join(buys)}")
    if sells:
        parts.append(f"sells {','.join(sells)}")

    return " ".join(parts)


def _format_port(port: Dict[str, Any]) -> List[str]:
    """Format port information with prices.

    Returns list with single line using compact format.
    """
    if not port:
        return []

    port_str = _format_port_prices_compact(port)
    return [f"Port: {port_str}"]


def _friendly_ship_type(raw_type: Optional[str]) -> str:
    """Return a human-friendly ship type name."""
    if not isinstance(raw_type, str) or not raw_type:
        return "unknown"
    if " " in raw_type and raw_type[0].isupper():
        return raw_type
    if "ShipType" in globals() and ShipType is not None and get_ship_stats is not None:  # type: ignore[truthy-function]
        try:
            enum_value = ShipType(raw_type)  # type: ignore[call-arg]
            stats = get_ship_stats(enum_value)  # type: ignore[misc]
            friendly = getattr(stats, "name", None)
            if isinstance(friendly, str) and friendly:
                return friendly
        except Exception:
            pass
    return raw_type.replace("_", " ").title()


def _format_players(players: List[Dict[str, Any]]) -> List[str]:
    """Format player list with names and ships."""
    if not players:
        return []

    lines = ["Players:"]
    for player in players:
        name = _shorten_embedded_ids(player.get("name", "unknown"))
        ship = player.get("ship", {})
        ship_name = _shorten_embedded_ids(ship.get("ship_name", "unknown"))
        ship_type_raw = ship.get("ship_type")
        ship_type = _friendly_ship_type(ship_type_raw)
        corp = player.get("corporation")
        corp_name = corp.get("name") if isinstance(corp, dict) else None
        corp_suffix = f" [{corp_name}]" if corp_name else ""
        player_type = player.get("player_type")
        if player_type == "corporation_ship":
            # Use ship name (not character name) so ship-targeting tools can match.
            display_name = ship_name or name
            ship_id = player.get("id")
            ship_id_prefix = _short_id(ship_id)
            ship_id_suffix = f" ship_id={ship_id_prefix}" if ship_id_prefix else ""
            lines.append(
                f'  - Corp ship "{display_name}" ({ship_type}){corp_suffix}{ship_id_suffix}'
            )
        else:
            lines.append(
                f"  - {name} in {ship_name} ({ship_type}){corp_suffix}"
            )

    return lines


def _format_garrison(garrison: Dict[str, Any]) -> str:
    """Format garrison information."""
    if not garrison:
        return "Garrison: None"

    owner = _shorten_embedded_ids(garrison.get("owner_name", "unknown"))
    fighters = garrison.get("fighters", 0)
    mode = garrison.get("mode", "unknown")
    toll = garrison.get("toll_amount", 0)

    info = f"Garrison: {fighters} fighters ({mode})"
    if mode == "toll":
        info += f" toll={toll}"
    info += f" - owner: {owner}"

    return info


def _format_salvage(salvage: List[Dict[str, Any]]) -> List[str]:
    """Format salvage container information."""
    if not salvage:
        return []

    lines = ["Salvage:"]
    for container in salvage:
        salvage_id = container.get("salvage_id", "unknown")
        credits = container.get("credits", 0)
        scrap = container.get("scrap", 0)
        cargo = container.get("cargo", {})
        cargo_str = _format_cargo(cargo)
        scrap_part = f", Scrap: {scrap}" if scrap else ""
        lines.append(
            f"  - ID: {salvage_id}, Credits: {credits}{scrap_part}, Cargo: {cargo_str}"
        )

    return lines


def _status_summary(result: Dict[str, Any], first_line: str) -> str:
    """Build status summary with shared formatting logic.

    Args:
        result: Full response containing player, ship, and sector data
        first_line: Opening line for the summary

    Returns:
        Multi-line human-readable summary string
    """
    sector = result.get("sector", {})
    ship = result.get("ship", {})
    player = result.get("player", {})
    corp = result.get("corporation") if isinstance(result, dict) else None

    # Build summary sections
    player_name = player.get("name") or player.get("display_name") or "Unknown player"
    player_name = _shorten_embedded_ids(player_name)
    lines = [f"Player: {player_name}", first_line]

    if isinstance(corp, dict) and corp.get("name"):
        corp_line = f"Corporation: {corp['name']}"
        member_count = corp.get("member_count")
        if isinstance(member_count, int):
            corp_line += f" (members: {member_count})"
        lines.append(corp_line)

    # Adjacent sectors
    adjacent = sector.get("adjacent_sectors", [])
    lines.append(f"Adjacent sectors: {adjacent}")
    region = sector.get("region")
    if isinstance(region, str) and region:
        lines.append(f"Region: {region}")

    # Exploration stats (personal, corp, and total)
    visited = player.get("sectors_visited") if isinstance(player, dict) else None
    corp_visited = player.get("corp_sectors_visited") if isinstance(player, dict) else None
    total_known = player.get("total_sectors_known") if isinstance(player, dict) else None
    universe_size = player.get("universe_size") if isinstance(player, dict) else None

    if (
        isinstance(visited, int)
        and visited >= 0
        and isinstance(universe_size, int)
        and universe_size > 0
    ):
        percentage = round((visited / universe_size) * 100)
        exploration_line = f"Explored {visited} sectors ({percentage}%)."

        # Add corp and total knowledge if available
        if isinstance(corp_visited, int) and corp_visited > 0:
            exploration_line += f" Corp knows {corp_visited}."
        if isinstance(total_known, int) and total_known > visited:
            total_percentage = round((total_known / universe_size) * 100)
            exploration_line += f" Total known: {total_known} ({total_percentage}%)."

        lines.append(exploration_line)
    ship_name = ship.get("ship_name") or ship.get("name") or "unknown ship"
    ship_name = _shorten_embedded_ids(ship_name)
    ship_type_raw = ship.get("ship_type") or ship.get("ship_type_name")
    ship_type = _friendly_ship_type(ship_type_raw)
    lines.append(f"Ship: {ship_name} ({ship_type})")

    # Credits and cargo
    ship_credits = ship.get("credits")
    if not isinstance(ship_credits, (int, float)):
        ship_credits = player.get("credits_on_hand", 0)
    bank_credits = player.get("credits_in_bank")
    cargo = ship.get("cargo", {})
    cargo_str = _format_cargo(cargo)
    cargo_used = sum(cargo.values())
    cargo_capacity = ship.get("cargo_capacity", 0)
    empty_holds = cargo_capacity - cargo_used
    bank_suffix = ""
    if isinstance(bank_credits, (int, float)):
        bank_suffix = f" (bank: {int(bank_credits)})"
    credit_value = int(ship_credits) if isinstance(ship_credits, (int, float)) else 0
    lines.append(
        f"Credits: {credit_value}{bank_suffix}. Cargo: {cargo_str}. Empty holds: {empty_holds}."
    )

    # Warp power and shields
    warp = ship.get("warp_power", 0)
    warp_max = ship.get("warp_power_capacity", 0)
    shields = ship.get("shields", 0)
    shields_max = ship.get("max_shields", 0)
    fighters = ship.get("fighters", 0)
    lines.append(
        f"Warp: {warp}/{warp_max}. Shields: {shields}/{shields_max}. Fighters: {fighters}."
    )

    # Port
    port = sector.get("port")
    if port:
        lines.extend(_format_port(port))
    else:
        lines.append("Port: None")

    # Players
    players = sector.get("players", [])
    if players:
        lines.extend(_format_players(players))

    # Garrison
    garrison = sector.get("garrison")
    lines.append(_format_garrison(garrison))

    # Salvage
    salvage = sector.get("salvage", [])
    if salvage:
        lines.extend(_format_salvage(salvage))

    return "\n".join(lines)


def move_summary(result: Dict[str, Any]) -> str:
    """Format a comprehensive natural language summary for move() results.

    Args:
        result: Full move response containing player, ship, and sector data
            - first_visit: True if this is the player's first personal visit
            - known_to_corp: True if the corporation already knew about this sector

    Returns:
        Multi-line human-readable summary string
    """
    sector_id = result.get("sector", {}).get("id", "unknown")
    first_visit = result.get("first_visit", False)
    known_to_corp = result.get("known_to_corp", False)

    # Build first line with visit status
    first_line = f"Now in sector {sector_id}."
    if first_visit and known_to_corp:
        first_line += " First personal visit (known to corp)."
    elif first_visit:
        first_line += " First visit!"

    return _status_summary(result, first_line)


def join_summary(result: Dict[str, Any]) -> str:
    """Format a comprehensive natural language summary for join() and my_status() results.

    Args:
        result: Full response containing player, ship, and sector data

    Returns:
        Multi-line human-readable summary string
    """
    sector_id = result.get("sector", {}).get("id", "unknown")
    return _status_summary(result, f"In sector {sector_id}.")


def status_update_summary(result: Dict[str, Any]) -> str:
    """Produce a concise summary for status.update."""

    sector = result.get("sector", {}) if isinstance(result, dict) else {}
    player = result.get("player", {}) if isinstance(result, dict) else {}
    ship = result.get("ship", {}) if isinstance(result, dict) else {}

    sector_id = sector.get("id", "unknown")
    ship_credits = ship.get("credits")
    if not isinstance(ship_credits, (int, float)):
        ship_credits = player.get("credits_on_hand")
    bank_credits = player.get("credits_in_bank")
    warp = ship.get("warp_power")
    warp_max = ship.get("warp_power_capacity")
    shields = ship.get("shields")
    shields_max = ship.get("max_shields")
    fighters = ship.get("fighters")
    port = sector.get("port", {}) if isinstance(sector, dict) else {}

    parts: List[str] = [f"Sector {sector_id}"]
    if isinstance(ship_credits, (int, float)):
        credit_part = f"Credits {int(ship_credits)}"
        if isinstance(bank_credits, (int, float)):
            credit_part += f" (bank {int(bank_credits)})"
        parts.append(credit_part)
    ship_id = ship.get("ship_id")
    ship_id_prefix = _short_id(ship_id)
    if ship_id_prefix:
        parts.append(f"Ship ID {ship_id_prefix}")
    if isinstance(warp, (int, float)) and isinstance(warp_max, (int, float)):
        parts.append(f"Warp {int(warp)}/{int(warp_max)}")
    if isinstance(shields, (int, float)) and isinstance(shields_max, (int, float)):
        parts.append(f"Shields {int(shields)}/{int(shields_max)}")
    if isinstance(fighters, (int, float)):
        parts.append(f"Fighters {int(fighters)}")
    corp = result.get("corporation") if isinstance(result, dict) else None
    if isinstance(corp, dict) and corp.get("name"):
        corp_part = f"Corp {corp['name']}"
        member_count = corp.get("member_count")
        if isinstance(member_count, int):
            corp_part += f" ({member_count})"
        parts.append(corp_part)
    if isinstance(port, dict) and port.get("code"):
        port_str = _format_port_prices_compact(port)
        parts.append(f"Port {port_str}")

    player_block = result.get("player") if isinstance(result, dict) else None
    visited = player_block.get("sectors_visited") if isinstance(player_block, dict) else None
    corp_visited = player_block.get("corp_sectors_visited") if isinstance(player_block, dict) else None
    total_known = player_block.get("total_sectors_known") if isinstance(player_block, dict) else None
    universe_size = (
        player_block.get("universe_size") if isinstance(player_block, dict) else None
    )
    if (
        isinstance(visited, int)
        and visited >= 0
        and isinstance(universe_size, int)
        and universe_size > 0
    ):
        percentage = round((visited / universe_size) * 100)
        explore_part = f"Explored {visited} ({percentage}%)"
        # Add total known if corp contributes additional knowledge
        if isinstance(total_known, int) and total_known > visited:
            total_percentage = round((total_known / universe_size) * 100)
            explore_part += f", total known {total_known} ({total_percentage}%)"
        parts.append(explore_part)

    return "Status update: " + "; ".join(parts) + "."


def plot_course_summary(result: Dict[str, Any]) -> str:
    """Format a concise summary for plot_course() results.

    Args:
        result: Response with from_sector, to_sector, path, and distance

    Returns:
        Single-line summary string
    """
    path = result.get("path", [])
    distance = result.get("distance", 0)
    return f"Course: {path}. Distance: {distance}."


def list_known_ports_summary(result: Dict[str, Any]) -> str:
    """Format a concise summary for list_known_ports() results.

    Args:
        result: Response with from_sector, ports list, and totals

    Returns:
        Multi-line summary listing ports by sector and distance
    """
    from_sector = result.get("from_sector", "unknown")
    ports = result.get("ports", [])
    total_found = result.get("total_ports_found", 0)

    if not ports:
        mega_filter = result.get("mega")
        if mega_filter is True:
            return "No mega-port found within range."
        return "No ports found matching the search filters."

    lines = [
        f"Found {total_found} port{'s' if total_found != 1 else ''} from sector {from_sector}:"
    ]

    for port_info in ports:
        sector = port_info.get("sector") or {}
        if not isinstance(sector, dict):
            sector = {}
        sector_id = sector.get("id", "?")
        hops = port_info.get("hops_from_start", 0)
        port_entry = sector.get("port")
        port_data = port_entry if isinstance(port_entry, dict) else {}
        last_visited = port_info.get("last_visited")
        observed_at = port_data.get("observed_at")
        if observed_at is None:
            observed_at = port_info.get("updated_at")

        # Format port with prices
        port_str = _format_port_prices_compact(port_data) if port_data else "???"
        port_line = f"  - Sector {sector_id} ({hops} hop{'s' if hops != 1 else ''}): {port_str}"

        if last_visited:
            relative_time = _format_relative_time(last_visited)
            port_line += f" [visited {relative_time}]"
        if observed_at and isinstance(observed_at, str):
            port_line += f" [observed {_format_relative_time(observed_at)}]"

        lines.append(port_line)

    return "\n".join(lines)


def movement_start_summary(event: Dict[str, Any]) -> str:
    """Summarize movement.start events."""

    sector = event.get("sector", {}) if isinstance(event, dict) else {}
    destination = sector.get("id", "unknown")
    region = sector.get("region")
    eta = event.get("hyperspace_time") if isinstance(event, dict) else None

    if isinstance(eta, (int, float)):
        eta_str = f"{eta:.1f}s"
    elif eta is not None:
        eta_str = str(eta)
    else:
        eta_str = "unknown"

    region_part = ""
    if isinstance(region, str) and region:
        region_part = f" Region: {region}."
    return f"Entering hyperspace to sector {destination} (ETA: {eta_str}).{region_part}"


def map_local_summary(result: Dict[str, Any], current_sector: Optional[int]) -> str:
    """Summarize map.local events and tool responses."""

    center = result.get("center_sector", "unknown")
    visited = result.get("total_visited")
    total = result.get("total_sectors")
    unvisited = result.get("total_unvisited")

    lines: List[str] = [
        f"Local map around sector {center}: {visited}/{total} visited, {unvisited} unvisited."
    ]

    center_region = None
    sectors = result.get("sectors", [])
    if isinstance(center, (int, float)):
        for sector in sectors:
            if not isinstance(sector, dict):
                continue
            if sector.get("id") != center:
                continue
            if sector.get("visited") and sector.get("region"):
                center_region = sector.get("region")
                break
    if isinstance(center_region, str) and center_region:
        lines.append(f"Region: {center_region}.")

    unvisited_sectors: List[Tuple[Optional[int], Optional[int]]] = []
    for sector in sectors:
        if not isinstance(sector, dict):
            continue
        if sector.get("visited"):
            continue
        sector_id = sector.get("id")
        hops = sector.get("hops_from_center")
        hops_sort = hops if isinstance(hops, (int, float)) else None
        unvisited_sectors.append((sector_id, hops_sort))

    def _sort_key(item: Tuple[Optional[int], Optional[int]]) -> Tuple[int, int]:
        sector_id, hops_sort = item
        hops_val = hops_sort if isinstance(hops_sort, (int, float)) else 1_000_000
        sector_val = sector_id if isinstance(sector_id, int) else 1_000_000
        return (hops_val, sector_val)

    unvisited_sectors.sort(key=_sort_key)

    if unvisited_sectors:
        entries: List[str] = []
        for sector_id, hops_sort in unvisited_sectors[:3]:
            hops_display = hops_sort if isinstance(hops_sort, (int, float)) else "?"
            entries.append(f"{sector_id} ({hops_display} hops)")
        if entries:
            lines.append("Nearest unvisited: " + ", ".join(entries) + ".")

    if isinstance(current_sector, (int, float)):
        sector_display = int(current_sector)
    else:
        sector_display = "unknown"
    lines.append(f"We are currently in sector {sector_display}.")

    return "\n".join(lines)


def path_region_summary(result: Dict[str, Any]) -> str:
    """Summarize path.region events and tool responses."""

    path = result.get("path", [])
    distance = result.get("distance", "unknown")
    total = result.get("total_sectors")
    known = result.get("known_sectors")
    unknown = result.get("unknown_sectors")

    lines: List[str] = []
    if isinstance(path, list) and path:
        lines.append(f"Path: {path}. Distance: {distance}.")
    else:
        lines.append(f"Path computed. Distance: {distance}.")

    sectors = result.get("sectors", [])

    def _find_region(sector_id: Optional[int]) -> Optional[str]:
        if not isinstance(sector_id, int):
            return None
        for sector in sectors:
            if not isinstance(sector, dict):
                continue
            if sector.get("sector_id") != sector_id:
                continue
            region = sector.get("region")
            if isinstance(region, str) and region:
                return region
        return None

    start_region = _find_region(path[0] if isinstance(path, list) and path else None)
    end_region = _find_region(path[-1] if isinstance(path, list) and path else None)
    if start_region or end_region:
        region_parts = []
        if start_region:
            region_parts.append(f"start {start_region}")
        if end_region:
            region_parts.append(f"end {end_region}")
        lines.append("Region: " + ", ".join(region_parts) + ".")

    if isinstance(total, int) and isinstance(known, int) and isinstance(unknown, int):
        lines.append(f"Sectors: {known}/{total} known, {unknown} unknown.")

    return "\n".join(lines)


def _format_participant_names(event: Dict[str, Any]) -> str:
    participants = event.get("participants")
    names: List[str] = []
    if isinstance(participants, list):
        for entry in participants:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name")
            if not name and isinstance(entry.get("ship"), dict):
                name = entry["ship"].get("ship_name")
            if name:
                names.append(_shorten_embedded_ids(str(name)))
    if not names:
        return "unknown opponents"
    if len(names) > 4:
        head = ", ".join(names[:3])
        return f"{head}, +{len(names) - 3} more"
    return ", ".join(names)


def combat_round_waiting_summary(event: Dict[str, Any]) -> str:
    """Summarize combat.round_waiting events."""

    round_number = event.get("round")
    sector = event.get("sector", {}) if isinstance(event, dict) else {}
    sector_id = sector.get("id", "unknown")
    deadline = _format_iso_clock(event.get("deadline"))
    participants = _format_participant_names(event)
    round_display = round_number if isinstance(round_number, int) else "?"
    combat_id = event.get("combat_id", "unknown")

    return (
        f"Combat {combat_id} round {round_display} waiting in sector {sector_id}; "
        f"deadline {deadline}; participants: {participants}."
    )


def combat_action_accepted_summary(event: Dict[str, Any]) -> str:
    """Summarize combat.action_accepted events."""

    round_number = event.get("round")
    action = str(event.get("action", "unknown")).lower()
    commit = event.get("commit")
    target = event.get("target_id")
    destination = event.get("destination_sector")
    round_resolved = event.get("round_resolved")

    detail_parts: List[str] = [action]
    if isinstance(commit, (int, float)) and commit not in (0, 0.0):
        detail_parts.append(f"commit={int(commit)}")
    if target:
        target_display = _short_id(target) if isinstance(target, str) else str(target)
        detail_parts.append(f"target={target_display}")
    if destination is not None:
        detail_parts.append(f"dest={destination}")

    detail = ", ".join(detail_parts)
    round_display = round_number if isinstance(round_number, int) else "?"
    resolved_text = "yes" if round_resolved else "no"

    return (
        f"Combat action accepted for round {round_display}: {detail}. "
        f"Round resolved: {resolved_text}."
    )


def combat_round_resolved_summary(event: Dict[str, Any]) -> str:
    """Summarize combat.round_resolved events."""

    round_number = event.get("round")
    sector = event.get("sector", {}) if isinstance(event, dict) else {}
    sector_id = sector.get("id", "unknown")
    result = event.get("result") or event.get("end") or "in_progress"

    losses = event.get("defensive_losses")
    loss_entries: List[str] = []
    if isinstance(losses, dict):
        for name, value in losses.items():
            if isinstance(value, (int, float)) and value > 0:
                loss_entries.append(f"{name}:{int(value)}")
    loss_summary = ", ".join(loss_entries) if loss_entries else "no defensive losses"

    flee_results = event.get("flee_results")
    fleers: List[str] = []
    if isinstance(flee_results, dict):
        for name, fled in flee_results.items():
            if fled:
                fleers.append(str(name))
    flee_summary = ", ".join(fleers) if fleers else "none"

    round_display = round_number if isinstance(round_number, int) else "?"

    return (
        f"Combat round {round_display} resolved in sector {sector_id}: result {result}. "
        f"Losses: {loss_summary}. Flees: {flee_summary}."
    )


def combat_ended_summary(event: Dict[str, Any]) -> str:
    """Summarize combat.ended events, highlighting losses and flees."""

    sector = event.get("sector", {}) if isinstance(event, dict) else {}
    sector_id = sector.get("id", "unknown")
    round_number = event.get("round")
    result = event.get("result") or event.get("end") or "unknown"

    header = f"Combat ended in sector {sector_id}"
    if isinstance(round_number, int):
        header += f" (round {round_number})"
    header += f": result {result}."

    loss_totals: Dict[str, int] = defaultdict(int)
    for bucket in ("defensive_losses", "offensive_losses"):
        losses = event.get(bucket)
        if not isinstance(losses, dict):
            continue
        for name, value in losses.items():
            if isinstance(value, (int, float)) and value > 0:
                loss_totals[str(name)] += int(value)

    flee_results = event.get("flee_results")
    fleers: Dict[str, Optional[int]] = {}
    if isinstance(flee_results, dict):
        for name, fled in flee_results.items():
            if fled:
                fleers[str(name)] = None

    fled_to_sector = event.get("fled_to_sector")
    if fleers and isinstance(fled_to_sector, int):
        # Assume the primary fleer used this destination if no mapping provided
        for name in list(fleers.keys()):
            if fleers[name] is None:
                fleers[name] = fled_to_sector
                break

    details: List[str] = []
    for name, losses in sorted(loss_totals.items(), key=lambda item: (-item[1], item[0])):
        entry = f"{name} lost {losses} fighters"
        if name in fleers:
            dest = fleers.pop(name)
            if isinstance(dest, int):
                entry += f" and fled to sector {dest}"
            else:
                entry += " and fled"
        details.append(entry)

    for name in sorted(fleers.keys()):
        dest = fleers[name]
        if isinstance(dest, int):
            details.append(f"{name} fled to sector {dest}")
        else:
            details.append(f"{name} fled")

    salvage = event.get("salvage")
    if isinstance(salvage, list) and salvage:
        details.append(f"Salvage available: {len(salvage)}")

    if not details:
        return header

    return header + " " + "; ".join(details) + "."


def garrison_combat_alert_summary(event: Dict[str, Any]) -> str:
    """Summarize garrison.combat_alert events for corp operators."""

    sector = event.get("sector", {}) if isinstance(event, dict) else {}
    sector_id = sector.get("id", "unknown")
    garrison = event.get("garrison") if isinstance(event, dict) else {}
    owner_name = None
    if isinstance(garrison, dict):
        owner_name = garrison.get("owner_name") or _short_id(garrison.get("owner_id"))
    if not owner_name:
        owner_name = "unknown owner"
    owner_name = _shorten_embedded_ids(str(owner_name))

    combat = event.get("combat") if isinstance(event, dict) else {}
    combat_id = combat.get("combat_id") if isinstance(combat, dict) else None
    initiator = combat.get("initiator_name") if isinstance(combat, dict) else None

    parts = [f"Garrison alert in sector {sector_id} for {owner_name}."]
    if combat_id:
        parts.append(f"Combat ID: {combat_id}.")
    if initiator:
        parts.append(f"Initiated by {initiator}.")

    return " ".join(parts)


def sector_update_summary(event: Dict[str, Any]) -> str:
    """Summarize sector.update snapshots."""

    sector_id = event.get("id", "unknown")
    adjacent = event.get("adjacent_sectors", [])
    port = event.get("port", {}) if isinstance(event, dict) else {}
    port_display = "none"
    if isinstance(port, dict) and port.get("code"):
        port_display = _format_port_prices_compact(port)

    players = event.get("players")
    player_names: List[str] = []
    if isinstance(players, list):
        for entry in players:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name")
            if not name:
                continue
            display = str(name)
            corp_obj = entry.get("corporation")
            corp_name = corp_obj.get("name") if isinstance(corp_obj, dict) else None
            if corp_name:
                display += f" ({corp_name})"
            player_names.append(display)
    players_part = ", ".join(player_names) if player_names else "none"

    garrison = event.get("garrison")
    if garrison:
        garrison_part = "1"
    else:
        garrison_part = "0"

    salvage = event.get("salvage")
    salvage_part = str(len(salvage)) if isinstance(salvage, list) else "0"

    unowned = event.get("unowned_ships")
    unowned_part = str(len(unowned)) if isinstance(unowned, list) else "0"

    region = event.get("region")
    region_part = None
    if isinstance(region, str) and region:
        region_part = f"region {region}"

    parts = [
        f"Sector {sector_id}",
        *([region_part] if region_part else []),
        f"adjacent {list(adjacent)}",
        f"port {port_display}",
        f"players {players_part}",
        f"garrisons {garrison_part}",
        f"salvage {salvage_part}",
        f"derelicts {unowned_part}",
    ]

    return "Sector update: " + "; ".join(parts) + "."


def trade_executed_summary(event: Dict[str, Any]) -> str:
    """Summarize trade.executed events."""

    player = event.get("player", {}) if isinstance(event, dict) else {}
    ship = event.get("ship", {}) if isinstance(event, dict) else {}
    trade = event.get("trade", {}) if isinstance(event, dict) else {}

    trade_type = trade.get("trade_type")
    commodity = trade.get("commodity")
    units = trade.get("units")
    price_per_unit = trade.get("price_per_unit")
    total_price = trade.get("total_price")
    new_credits = trade.get("new_credits")
    new_cargo = trade.get("new_cargo")

    pieces: List[str] = ["Trade executed."]

    credits_value = (
        new_credits
        if isinstance(new_credits, (int, float))
        else player.get("credits_on_hand")
    )
    if isinstance(credits_value, (int, float)):
        pieces.append(f"Credits: {credits_value}.")

    if isinstance(units, (int, float)) and isinstance(commodity, str):
        action = (
            "Bought"
            if trade_type == "buy"
            else "Sold"
            if trade_type == "sell"
            else "Traded"
        )
        phrase = f"{action} {int(units)} {commodity.replace('_', ' ')}"
        price_bits: List[str] = []
        if isinstance(price_per_unit, (int, float)):
            price_bits.append(f"@ {price_per_unit} each")
        if isinstance(total_price, (int, float)):
            price_bits.append(f"total {total_price}")
        if price_bits:
            phrase += " (" + ", ".join(price_bits) + ")"
        pieces.append(phrase + ".")

    cargo_source = new_cargo if isinstance(new_cargo, dict) else ship.get("cargo", {})
    cargo_str = _format_cargo(cargo_source)
    if cargo_str:
        pieces.append(f"Cargo: {cargo_str}.")

    fighters = ship.get("fighters")
    if isinstance(fighters, (int, float)):
        pieces.append(f"Fighters: {fighters}.")

    return " ".join(pieces)


def port_update_summary(event: Dict[str, Any]) -> str:
    """Summarize port.update events."""

    if not isinstance(event, dict):
        return "Port update received."

    sector = event.get("sector") or {}
    if not isinstance(sector, dict):
        sector = {}

    sector_id = sector.get("id", "unknown")
    port = sector.get("port")
    if not isinstance(port, dict):
        port = {}

    code = port.get("code", "???")
    if port.get("mega") is True:
        code = f"MEGA {code}"

    pieces: List[str] = []
    prices = port.get("prices", {}) if isinstance(port, dict) else {}
    stock = port.get("stock", {}) if isinstance(port, dict) else {}

    commodities = [
        ("quantum_foam", "QF"),
        ("retro_organics", "RO"),
        ("neuro_symbolics", "NS"),
    ]

    for commodity, abbrev in commodities:
        price = prices.get(commodity)
        quantity = stock.get(commodity)
        if price is None and quantity is None:
            continue
        if price is None:
            pieces.append(f"{abbrev} stock {quantity}")
        elif quantity is None:
            pieces.append(f"{abbrev} @{price}")
        else:
            pieces.append(f"{abbrev} {quantity}@{price}")

    if not pieces:
        pieces.append("No price data")

    line = ", ".join(pieces)
    return f"Port update at sector {sector_id} ({code}): {line}."


def character_moved_summary(
    event: Dict[str, Any],
    viewer_corporation_id: Optional[str] = None,
) -> str:
    """Summarize character.moved events."""
    if not isinstance(event, dict):
        return "Character movement update."

    player = event.get("player") or {}
    ship = event.get("ship") or {}
    owner_type = event.get("owner_type", "character")
    owner_corp_id = event.get("owner_corporation_id")

    name = player.get("name")
    if not name:
        name = event.get("name")
    if not name:
        name = _short_id(player.get("id")) or "Unknown"
    name = _shorten_embedded_ids(str(name))

    ship_name_raw = ship.get("ship_name")
    if not ship_name_raw:
        ship_name_raw = event.get("ship_name") or ship.get("ship_type") or event.get("ship_type")
    ship_name = _shorten_embedded_ids(ship_name_raw or "unknown ship")
    movement = event.get("movement")

    # Determine movement verb
    if movement == "arrive":
        verb = "arrived"
    elif movement == "depart":
        verb = "departed"
    else:
        verb = "movement update"

    # Corp ship format
    if owner_type == "corporation":
        if viewer_corporation_id and owner_corp_id == viewer_corporation_id:
            corp_desc = "your corp"
        else:
            corp_desc = "another corp"
        return f'Corp ship "{ship_name}" owned by {corp_desc} {verb}.'

    # Player ship format (no enum string, just display name)
    return f"{name} in {ship_name} {verb}."


def garrison_character_moved_summary(
    event: Dict[str, Any],
    viewer_corporation_id: Optional[str] = None,
) -> str:
    """Summarize garrison.character_moved events for corporation members."""
    base = character_moved_summary(event, viewer_corporation_id)
    if not isinstance(event, dict):
        return base

    garrison = event.get("garrison") or {}
    if not isinstance(garrison, dict):
        return base

    owner_name = garrison.get("owner_name") or _short_id(garrison.get("owner_id")) or "corp member"
    owner_name = _shorten_embedded_ids(str(owner_name))
    mode = garrison.get("mode")
    fighters = garrison.get("fighters")

    details: list[str] = [f"Detected by {owner_name}'s garrison"]
    if mode:
        details.append(f"mode={mode}")
    if isinstance(fighters, int):
        details.append(f"{fighters} fighters")

    return f"{base} ({', '.join(details)})."


def transfer_summary(event: Dict[str, Any]) -> str:
    """Summarize transfer events (credits and warp).

    Handles both credits.transfer and warp.transfer events with
    direction-aware messaging.
    """
    direction = event.get("transfer_direction", "unknown")
    details = event.get("transfer_details", {})
    from_data = event.get("from", {})
    to_data = event.get("to", {})

    from_name = _shorten_embedded_ids(from_data.get("name", "unknown"))
    to_name = _shorten_embedded_ids(to_data.get("name", "unknown"))

    # Build transfer description
    parts = []
    if "warp_power" in details:
        parts.append(f"{details['warp_power']} warp power")
    if "credits" in details:
        parts.append(f"{details['credits']} credits")
    if "cargo" in details:
        # Future: format cargo details
        cargo = details["cargo"]
        cargo_parts = [f"{qty} {commodity}" for commodity, qty in cargo.items()]
        parts.extend(cargo_parts)

    if not parts:
        transfer_desc = "unknown resources"
    else:
        transfer_desc = " and ".join(parts)

    # Direction-aware message
    if direction == "sent":
        return f"Sent {transfer_desc} to {to_name}."
    elif direction == "received":
        return f"Received {transfer_desc} from {from_name}."
    else:
        return f"Transfer: {transfer_desc} between {from_name} and {to_name}."


def ships_list_summary(event: Dict[str, Any]) -> str:
    """Summarize ships.list events with short identifiers."""
    if not isinstance(event, dict):
        return "Ships list received."

    ships = event.get("ships")
    if not isinstance(ships, list) or not ships:
        return "Ships: none."

    lines = [f"Ships: {len(ships)} total."]
    for ship in ships:
        if not isinstance(ship, dict):
            continue
        name = _shorten_embedded_ids(str(ship.get("name") or "Unnamed Vessel"))
        ship_type = _friendly_ship_type(ship.get("ship_type"))
        ship_id_prefix = _short_id(ship.get("ship_id"))
        id_suffix = f" [{ship_id_prefix}]" if ship_id_prefix else ""
        sector = ship.get("sector")
        sector_display = sector if isinstance(sector, int) else "unknown"
        holds = _format_holds(ship)
        task_id = ship.get("current_task_id")
        if isinstance(task_id, str) and task_id:
            task_display = _short_id(task_id) or task_id
        else:
            task_display = "none"
        details = [
            f"{name}{id_suffix} ({ship_type}) in sector {sector_display}",
            holds,
            f"task {task_display}",
        ]
        lines.append("- " + "; ".join(details))

    return "\n".join(lines)


def ship_renamed_summary(event: Dict[str, Any]) -> str:
    """Summarize ship.renamed events."""
    if not isinstance(event, dict):
        return "Ship renamed."

    new_name = event.get("ship_name") or event.get("new_name")
    old_name = event.get("previous_ship_name") or event.get("old_name")
    if isinstance(new_name, str):
        new_name = _shorten_embedded_ids(new_name)
    if isinstance(old_name, str):
        old_name = _shorten_embedded_ids(old_name)

    if new_name and old_name and new_name != old_name:
        return f'Renamed ship from \"{old_name}\" to \"{new_name}\".'
    if new_name:
        return f'Ship renamed to \"{new_name}\".'
    return "Ship renamed."


def corporation_ship_purchased_summary(event: Dict[str, Any]) -> str:
    """Summarize corporation.ship_purchased events."""
    if not isinstance(event, dict):
        return "Corporation ship purchased."

    name = event.get("ship_name") or event.get("name") or "Unnamed Vessel"
    if isinstance(name, str):
        name = _shorten_embedded_ids(name)
    else:
        name = "Unnamed Vessel"

    ship_type = _friendly_ship_type(event.get("ship_type"))
    ship_id_prefix = _short_id(event.get("ship_id"))
    id_suffix = f" [{ship_id_prefix}]" if ship_id_prefix else ""

    price = event.get("purchase_price")
    price_clause = ""
    if isinstance(price, (int, float)):
        price_clause = f" for {int(price):,} credits"

    return f'Purchased corp ship \"{name}\"{id_suffix} ({ship_type}){price_clause}.'


def salvage_created_summary(event: Dict[str, Any]) -> str:
    """Summarize salvage.created events (dump cargo).

    Private event - only the dumping player receives it.
    """
    salvage_details = event.get("salvage_details", {})

    # Build items description
    parts = []
    cargo = salvage_details.get("cargo", {})
    for commodity, qty in cargo.items():
        parts.append(f"{qty} {commodity}")

    credits = salvage_details.get("credits", 0)
    if credits > 0:
        parts.append(f"{credits} credits")

    scrap = salvage_details.get("scrap", 0)
    if scrap > 0:
        parts.append(f"{scrap} scrap")

    if not parts:
        return "Created empty salvage container."
    elif len(parts) == 1:
        items_desc = parts[0]
    else:
        items_desc = ", ".join(parts[:-1]) + f" and {parts[-1]}"

    return f"Dumped {items_desc} into salvage container."


def salvage_collected_summary(event: Dict[str, Any]) -> str:
    """Summarize salvage.collected events.

    Shows what was collected and whether container was fully cleared.
    Private event - only the collecting player receives it.
    """
    salvage_details = event.get("salvage_details", {})
    collected = salvage_details.get("collected", {})
    fully_collected = salvage_details.get("fully_collected", False)

    # Build collected items description
    parts = []
    cargo = collected.get("cargo", {})
    for commodity, qty in cargo.items():
        parts.append(f"{qty} {commodity}")

    credits = collected.get("credits", 0)
    if credits > 0:
        parts.append(f"{credits} credits")

    if not parts:
        return "Salvage container was empty."

    if len(parts) == 1:
        items_desc = parts[0]
    else:
        items_desc = ", ".join(parts[:-1]) + f" and {parts[-1]}"

    # Add status suffix
    if fully_collected:
        return f"Collected {items_desc} from salvage (we retrieved the entire salvage)."
    else:
        return f"Partially collected {items_desc} from salvage."


def chat_message_summary(event: Dict[str, Any]) -> str:
    """Summarize chat message events (broadcast and direct).

    Handles both broadcast and direct messages with type-aware formatting.
    """
    msg_type = event.get("type", "unknown")
    from_name = event.get("from_name", event.get("from", "unknown"))
    from_name = _shorten_embedded_ids(str(from_name))
    content = event.get("content", event.get("message", ""))
    if isinstance(content, str):
        content = _shorten_embedded_ids(content)

    # Truncate long messages
    max_length = 50
    if len(content) > max_length:
        content = content[:max_length] + "..."

    if msg_type == "broadcast":
        return f"{from_name} (broadcast): {content}"
    elif msg_type == "direct":
        to_name = event.get("to_name", event.get("to", "unknown"))
        to_name = _shorten_embedded_ids(str(to_name))
        return f"{from_name} → {to_name}: {content}"
    else:
        return f"{from_name}: {content}"


def task_start_summary(event: Dict[str, Any]) -> str:
    """Summarize task.start events showing task description."""
    description = event.get("task_description", "")
    return description if description else "Task started"


def task_finish_summary(event: Dict[str, Any]) -> str:
    """Summarize task.finish events showing task summary."""
    summary = event.get("task_summary", "")
    return summary if summary else "Task finished"


def event_query_summary(
    data: Dict[str, Any],
    get_nested_summary: Callable[[str, Dict[str, Any]], Optional[str]],
) -> str:
    """Format event.query response - detailed summary for TaskAgent LLM context.

    This detailed format provides the LLM with properly summarized event data
    including timestamps, nested summaries for each event, and context lines.
    The raw payload would be too verbose and hurt instruction following.

    When the query is NOT filtered by task_id, each event line includes a short
    task ID (first 6 hex chars of the UUID) to allow the LLM to correlate events
    with tasks and query further using the short ID prefix.
    """
    events = data.get("events", [])
    count = data.get("count", len(events))
    has_more = data.get("has_more", False)
    filters = data.get("filters", {})

    # Only show task_id if we didn't filter by it (avoid redundancy)
    show_task_id = filters.get("filter_task_id") is None

    if not events:
        result = f"Query returned {count} event{'s' if count != 1 else ''}."
        if has_more:
            result += " More available."
        return result

    lines: List[str] = [f"Query returned {count} event{'s' if count != 1 else ''}:"]

    for event in events:
        if not isinstance(event, dict):
            continue

        event_name = event.get("event", "unknown")
        timestamp = event.get("timestamp")
        payload = event.get("payload", {})
        task_id = event.get("task_id")

        # Format timestamp
        time_str = _format_iso_clock(timestamp) if timestamp else "unknown"

        # Build task suffix - show first 6 chars as short ID for filtering
        task_suffix = ""
        if show_task_id and task_id:
            short_task_id = task_id[:6] if len(task_id) >= 6 else task_id
            task_suffix = f" [task={short_task_id}]"

        # Try to get a nested summary for the event payload
        nested_summary = None
        if isinstance(payload, dict):
            nested_summary = get_nested_summary(event_name, payload)

        # Build event line
        if nested_summary:
            lines.append(f"  [{time_str}] {event_name}{task_suffix}: {nested_summary}")
        elif isinstance(payload, dict) and payload:
            # Provide a compact representation of key fields
            compact_parts: List[str] = []
            for key, value in list(payload.items())[:5]:
                if isinstance(value, (str, int, float, bool)):
                    display_value = value
                    if isinstance(value, str) and _should_shorten_id_for_value_key(key):
                        display_value = _short_id(value) or value
                    compact_parts.append(f"{key}={display_value}")
                elif isinstance(value, dict) and "id" in value:
                    nested_id = value.get("id")
                    display_id = nested_id
                    if isinstance(nested_id, str) and _should_shorten_id_for_object_key(key):
                        display_id = _short_id(nested_id) or nested_id
                    compact_parts.append(f"{key}.id={display_id}")
            if compact_parts:
                lines.append(f"  [{time_str}] {event_name}{task_suffix}: {', '.join(compact_parts)}")
            else:
                lines.append(f"  [{time_str}] {event_name}{task_suffix}")
        else:
            lines.append(f"  [{time_str}] {event_name}{task_suffix}")

    if has_more:
        lines.append("More events available (use offset/limit to paginate).")

    return "\n".join(lines)


def task_cancel_summary(event: Dict[str, Any]) -> str:
    """Summarize task.cancel events."""
    task_id = event.get("task_id", "")
    short_task_id = _short_id(task_id) if task_id else "unknown"
    return f"Task {short_task_id} cancelled"


def warp_purchase_summary(event: Dict[str, Any]) -> str:
    """Summarize warp.purchase events."""
    units = event.get("units", 0)
    total_cost = event.get("total_cost", 0)
    new_warp = event.get("new_warp_power", 0)
    capacity = event.get("warp_power_capacity", 0)
    ship_name = event.get("ship_name")
    ship_id = event.get("ship_id")
    short_ship_id = _short_id(ship_id) if ship_id else None

    ship_label = ""
    if ship_name:
        ship_label = f"{_shorten_embedded_ids(ship_name)}"
        if short_ship_id:
            ship_label += f" [{short_ship_id}]"
    elif short_ship_id:
        ship_label = f"[{short_ship_id}]"

    if ship_label:
        return f"{ship_label}: Purchased {units} warp power for {total_cost} credits. Now {new_warp}/{capacity}."
    return f"Purchased {units} warp power for {total_cost} credits. Now {new_warp}/{capacity}."


def bank_transaction_summary(event: Dict[str, Any]) -> str:
    """Summarize bank.transaction events."""
    direction = event.get("direction", "transaction")
    amount = event.get("amount", 0)
    bank_after = event.get("credits_in_bank_after")
    ship_after = event.get("ship_credits_after")
    ship_name = event.get("ship_name")
    ship_id = event.get("ship_id")
    short_ship_id = _short_id(ship_id) if ship_id else None

    # Build ship label
    ship_label = ""
    if ship_name:
        ship_label = f"{_shorten_embedded_ids(ship_name)}"
        if short_ship_id:
            ship_label += f" [{short_ship_id}]"
    elif short_ship_id:
        ship_label = f"[{short_ship_id}]"

    if direction == "deposit":
        result = f"Deposited {amount} credits to bank"
    elif direction == "withdraw":
        result = f"Withdrew {amount} credits from bank"
    else:
        result = f"Bank transaction: {amount} credits"

    if ship_label:
        result += f" from {ship_label}"
    result += "."

    if isinstance(bank_after, (int, float)):
        result += f" Bank balance: {int(bank_after)}."
    if isinstance(ship_after, (int, float)):
        result += f" Ship credits: {int(ship_after)}."

    return result
