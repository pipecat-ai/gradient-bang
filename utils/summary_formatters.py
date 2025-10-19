"""Client-side summary formatters for API responses.

These formatters extract concise summaries from full API responses,
reducing token usage when sending tool results to the LLM.
"""

from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Tuple


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


def _format_cargo(cargo: Dict[str, int]) -> str:
    """Format cargo as 'X QF | Y RO | Z NS'."""
    qf = cargo.get("quantum_foam", 0)
    ro = cargo.get("retro_organics", 0)
    ns = cargo.get("neuro_symbolics", 0)
    return f"{qf} QF | {ro} RO | {ns} NS"


def _format_port(port: Dict[str, Any]) -> List[str]:
    """Format port information with prices and stock.

    Returns list of lines describing port trades.
    """
    if not port:
        return []

    code = port.get("code", "???")
    lines = [f"Port: {code}"]
    prices = port.get("prices", {})
    stock = port.get("stock", {})

    # Map commodities to their abbreviations and port code positions
    commodities = [
        ("quantum_foam", "QF", 0),
        ("retro_organics", "RO", 1),
        ("neuro_symbolics", "NS", 2),
    ]

    for commodity, abbrev, idx in commodities:
        price = prices.get(commodity)
        if price is None:
            continue

        # Determine if port buys or sells based on code letter
        # B = port buys, S = port sells
        if idx < len(code):
            trade_type = "buying" if code[idx] == "B" else "selling"
        else:
            trade_type = "unknown"

        units = stock.get(commodity, 0)
        lines.append(f"  - {abbrev} {trade_type} {units} units at {price}")

    return lines


def _format_players(players: List[Dict[str, Any]]) -> List[str]:
    """Format player list with names and ships."""
    if not players:
        return []

    lines = ["Players:"]
    for player in players:
        name = player.get("name", "unknown")
        ship = player.get("ship", {})
        ship_name = ship.get("ship_name", "unknown")
        ship_type = ship.get("ship_type", "unknown")
        lines.append(f"  - {name} in {ship_name} ({ship_type})")

    return lines


def _format_garrison(garrison: Dict[str, Any]) -> str:
    """Format garrison information."""
    if not garrison:
        return "Garrison: None"

    owner = garrison.get("owner_name", "unknown")
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

    # Build summary sections
    lines = [first_line]

    # Adjacent sectors
    adjacent = sector.get("adjacent_sectors", [])
    lines.append(f"Adjacent sectors: {adjacent}")

    # Credits and cargo
    credits = player.get("credits_on_hand", 0)
    cargo = ship.get("cargo", {})
    cargo_str = _format_cargo(cargo)
    cargo_used = sum(cargo.values())
    cargo_capacity = ship.get("cargo_capacity", 0)
    empty_holds = cargo_capacity - cargo_used
    lines.append(f"Credits: {credits}. Cargo: {cargo_str}. Empty holds: {empty_holds}.")

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

    Returns:
        Multi-line human-readable summary string
    """
    sector_id = result.get("sector", {}).get("id", "unknown")
    return _status_summary(result, f"Now in sector {sector_id}.")


def join_summary(result: Dict[str, Any]) -> str:
    """Format a comprehensive natural language summary for join() and my_status() results.

    Args:
        result: Full response containing player, ship, and sector data

    Returns:
        Multi-line human-readable summary string
    """
    sector_id = result.get("sector", {}).get("id", "unknown")
    return _status_summary(result, f"In sector {sector_id}.")


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
        return f"No ports found from sector {from_sector}."

    lines = [
        f"Found {total_found} port{'s' if total_found != 1 else ''} from sector {from_sector}:"
    ]

    for port_info in ports:
        sector_id = port_info.get("sector_id", "?")
        hops = port_info.get("hops_from_start", 0)
        port_data = port_info.get("port", {})
        port_code = port_data.get("code", "???")
        last_visited = port_info.get("last_visited")

        port_line = f"  - Sector {sector_id} ({hops} hop{'s' if hops != 1 else ''}): {port_code}"

        if last_visited:
            relative_time = _format_relative_time(last_visited)
            port_line += f" [visited {relative_time}]"

        lines.append(port_line)

    return "\n".join(lines)


def movement_start_summary(event: Dict[str, Any]) -> str:
    """Summarize movement.start events."""

    sector = event.get("sector", {}) if isinstance(event, dict) else {}
    destination = sector.get("id", "unknown")
    eta = event.get("hyperspace_time") if isinstance(event, dict) else None

    if isinstance(eta, (int, float)):
        eta_str = f"{eta:.1f}s"
    elif eta is not None:
        eta_str = str(eta)
    else:
        eta_str = "unknown"

    return f"Entering hyperspace to sector {destination} (ETA: {eta_str})."


def map_local_summary(result: Dict[str, Any], current_sector: Optional[int]) -> str:
    """Summarize map.local events and tool responses."""

    center = result.get("center_sector", "unknown")
    visited = result.get("total_visited")
    total = result.get("total_sectors")
    unvisited = result.get("total_unvisited")

    lines: List[str] = [
        f"Local map around sector {center}: {visited}/{total} visited, {unvisited} unvisited."
    ]

    sectors = result.get("sectors", [])
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

    sector = event.get("sector", {}) if isinstance(event, dict) else {}
    sector_id = sector.get("id", "unknown")
    port = event.get("port", {}) if isinstance(event, dict) else {}
    code = port.get("code", "???")

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


def character_moved_summary(event: Dict[str, Any]) -> str:
    """Summarize character.moved events."""

    name = event.get("name") if isinstance(event, dict) else None
    ship_type = event.get("ship_type") if isinstance(event, dict) else None
    movement = event.get("movement") if isinstance(event, dict) else None

    if movement == "arrive":
        return f"{name} ({ship_type}) arrived."
    if movement == "depart":
        return f"{name} ({ship_type}) departed."

    to_sector = event.get("to_sector") if isinstance(event, dict) else None
    from_sector = event.get("from_sector") if isinstance(event, dict) else None

    if to_sector is not None and from_sector is not None:
        return f"{name} ({ship_type}) moved from {from_sector} to {to_sector}."
    if to_sector is not None:
        return f"{name} ({ship_type}) moved to {to_sector}."
    if from_sector is not None:
        return f"{name} ({ship_type}) departed sector {from_sector}."

    return f"{name} ({ship_type}) movement update."
