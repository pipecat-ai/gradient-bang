"""Trading system for Gradient Bang.

Handles commodity pricing, port inventory management, and trade transactions.
"""

import math
from typing import Dict, Optional, Tuple
from enum import Enum

# Commodity base prices
BASE_PRICES = {
    "fuel_ore": 25,
    "organics": 10,
    "equipment": 40
}

# Price bands for port trading
SELL_MIN = 0.75  # Port sells to player at 75% when full stock
SELL_MAX = 1.10  # Port sells to player at 110% when low stock
BUY_MIN = 0.90   # Port buys from player at 90% when low demand
BUY_MAX = 1.30   # Port buys from player at 130% when high demand

# Port inventory defaults (matching universe-bang.py)
PORT_DEFAULT_CAP = 1000
PORT_STARTING_FILL = 0.70

# Regeneration rates for port inventory
REGEN_FRACTION_STOCK = 0.25   # 25% of max per regeneration
REGEN_FRACTION_DEMAND = 0.25  # 25% of max per regeneration


class TradeType(Enum):
    """Type of trade transaction."""
    BUY = "buy"    # Player buys from port
    SELL = "sell"  # Player sells to port


class TradingError(Exception):
    """Base exception for trading errors."""
    pass


def calculate_price_sell_to_player(commodity: str, stock: int, max_capacity: int) -> int:
    """Calculate the price a port sells to a player.
    
    Uses sqrt curve: price rises slowly when stock is high, spikes when low.
    
    Args:
        commodity: Commodity type (fuel_ore, organics, equipment)
        stock: Current stock level
        max_capacity: Maximum stock capacity
        
    Returns:
        Price in credits
        
    Raises:
        ValueError: If commodity is unknown or max_capacity is 0
    """
    if commodity not in BASE_PRICES:
        raise ValueError(f"Unknown commodity: {commodity}")
    if max_capacity <= 0:
        raise ValueError("Max capacity must be positive")
    
    # Calculate scarcity (0 = full stock, 1 = empty)
    fullness = stock / max_capacity
    scarcity = 1 - fullness
    
    # Use sqrt curve for more realistic pricing
    # Prices rise slowly at first, then spike near depletion
    price_multiplier = SELL_MIN + (SELL_MAX - SELL_MIN) * math.sqrt(scarcity)
    
    return int(round(BASE_PRICES[commodity] * price_multiplier))


def calculate_price_buy_from_player(commodity: str, stock: int, max_capacity: int) -> int:
    """Calculate the price a port buys from a player.
    
    Uses sqrt curve: price is high when stock is low (need more), low when stock is high (saturated).
    
    Args:
        commodity: Commodity type (fuel_ore, organics, equipment)
        stock: Current stock level
        max_capacity: Maximum stock capacity
        
    Returns:
        Price in credits
        
    Raises:
        ValueError: If commodity is unknown or max_capacity is 0
    """
    if commodity not in BASE_PRICES:
        raise ValueError(f"Unknown commodity: {commodity}")
    if max_capacity <= 0:
        raise ValueError("Max capacity must be positive")
    
    # Calculate need (0 = full/saturated, 1 = empty/desperate)
    fullness = stock / max_capacity
    need = 1 - fullness  # Lower stock = higher need = higher price
    
    # Use sqrt curve for more realistic pricing
    # Prices drop slowly at first, then plunge near saturation
    price_multiplier = BUY_MIN + (BUY_MAX - BUY_MIN) * math.sqrt(need)
    
    return int(round(BASE_PRICES[commodity] * price_multiplier))


def get_port_prices(port_data: Dict) -> Dict[str, Optional[int]]:
    """Get current prices for all commodities at a port.
    
    Args:
        port_data: Port data dictionary with stock/max_capacity info
        
    Returns:
        Dictionary mapping commodities to their prices (None if not traded).
        The price is for selling TO player if port sells it, or buying FROM player if port buys it.
    """
    # Map commodity names to their keys in port data
    commodity_keys = {
        "fuel_ore": "FO",
        "organics": "OG",
        "equipment": "EQ"
    }
    
    prices = {}
    
    for commodity, key in commodity_keys.items():
        price = None
        
        stock = port_data.get("stock", {}).get(key, 0)
        max_capacity = port_data.get("max_capacity", {}).get(key, 0)
        
        # Check if port sells this commodity (price is what player pays)
        if commodity in port_data.get("sells", []):
            if max_capacity > 0:
                price = calculate_price_sell_to_player(commodity, stock, max_capacity)
        
        # Check if port buys this commodity (price is what player receives)
        elif commodity in port_data.get("buys", []):
            # Port can only buy if it has room (stock < max_capacity)
            if max_capacity > 0 and stock < max_capacity:
                price = calculate_price_buy_from_player(commodity, stock, max_capacity)
        
        prices[commodity] = price
    
    return prices


def validate_buy_transaction(
    player_credits: int,
    cargo_used: int,
    cargo_capacity: int,
    commodity: str,
    quantity: int,
    port_stock: int,
    price_per_unit: int
) -> None:
    """Validate a buy transaction can be completed.
    
    Args:
        player_credits: Player's current credits
        cargo_used: Current cargo space used
        cargo_capacity: Maximum cargo capacity
        commodity: Commodity to buy
        quantity: Quantity to buy
        port_stock: Port's current stock
        price_per_unit: Price per unit
        
    Raises:
        TradingError: If transaction cannot be completed
    """
    if quantity <= 0:
        raise TradingError("Quantity must be positive")
    
    if port_stock < quantity:
        raise TradingError(f"Port only has {port_stock} units of {commodity}")
    
    free_space = cargo_capacity - cargo_used
    if free_space < quantity:
        raise TradingError(f"Not enough cargo space. Available: {free_space}")
    
    total_cost = price_per_unit * quantity
    if player_credits < total_cost:
        raise TradingError(f"Insufficient credits. Need {total_cost}, have {player_credits}")


def validate_sell_transaction(
    player_cargo: Dict[str, int],
    commodity: str,
    quantity: int,
    port_stock: int,
    port_max_capacity: int
) -> None:
    """Validate a sell transaction can be completed.
    
    Args:
        player_cargo: Player's current cargo
        commodity: Commodity to sell
        quantity: Quantity to sell
        port_stock: Port's current stock
        port_max_capacity: Port's maximum capacity
        
    Raises:
        TradingError: If transaction cannot be completed
    """
    if quantity <= 0:
        raise TradingError("Quantity must be positive")
    
    if player_cargo.get(commodity, 0) < quantity:
        raise TradingError(f"Not enough {commodity} to sell. Have {player_cargo.get(commodity, 0)}")
    
    available_capacity = port_max_capacity - port_stock
    if available_capacity < quantity:
        raise TradingError(f"Port can only buy {available_capacity} units of {commodity}")