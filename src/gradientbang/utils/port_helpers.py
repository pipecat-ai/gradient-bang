"""Helpers for interpreting minimal port snapshots.

These utilities derive buys/sells and prices from the compact port_info
structure returned by the server (code, last_seen_prices, last_seen_stock).
"""

from typing import Dict, List, Optional

# Commodity order in code string: index 0=QF, 1=RO, 2=NS
RESOURCES: List[str] = ["quantum_foam", "retro_organics", "neuro_symbolics"]


def _code_str(port_info: Dict) -> str:
    return str(port_info.get("code", ""))


def list_sells(port_info: Dict) -> List[str]:
    """Return list of resources this port sells to the player."""
    code = _code_str(port_info)
    if len(code) < 3:
        return []
    return [RESOURCES[i] for i, ch in enumerate(code[:3]) if ch == "S"]


def list_buys(port_info: Dict) -> List[str]:
    """Return list of resources this port buys from the player."""
    code = _code_str(port_info)
    if len(code) < 3:
        return []
    return [RESOURCES[i] for i, ch in enumerate(code[:3]) if ch == "B"]


def sells_commodity(port_info: Dict, commodity: str) -> bool:
    """Whether the port sells the given commodity to the player."""
    return commodity in list_sells(port_info)


def buys_commodity(port_info: Dict, commodity: str) -> bool:
    """Whether the port buys the given commodity from the player."""
    return commodity in list_buys(port_info)


def last_seen_price(port_info: Dict, commodity: str) -> Optional[int]:
    """Return the last-seen price for a commodity at this port.

    For a selling commodity, this is what the player would pay.
    For a buying commodity, this is what the player would receive.
    """
    prices = port_info.get("last_seen_prices", {}) or {}
    value = prices.get(commodity)
    # Prices may include non-int entries (e.g., warp_power_depot as a dict)
    return value if isinstance(value, int) else None


def last_seen_stock(port_info: Dict, commodity: str) -> Optional[int]:
    """Return the last-seen stock snapshot for a commodity at this port."""
    stock = port_info.get("last_seen_stock", {}) or {}
    value = stock.get(commodity)
    return value if isinstance(value, int) else None

