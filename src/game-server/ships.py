"""Ship definitions and registry for the game."""

from enum import Enum
from dataclasses import dataclass
from typing import Optional, List


class ShipType(str, Enum):
    """Available ship types in the game."""
    KESTREL_COURIER = "kestrel_courier"
    SPARROW_SCOUT = "sparrow_scout"
    WAYFARER_FREIGHTER = "wayfarer_freighter"
    ATLAS_HAULER = "atlas_hauler"
    CORSAIR_RAIDER = "corsair_raider"
    PIKE_FRIGATE = "pike_frigate"
    BULWARK_DESTROYER = "bulwark_destroyer"
    AEGIS_CRUISER = "aegis_cruiser"
    PIONEER_LIFTER = "pioneer_lifter"
    SOVEREIGN_STARCRUISER = "sovereign_starcruiser"


@dataclass
class ShipStats:
    """Statistics and capabilities for a ship type."""
    name: str
    role: str
    price: int
    trade_in_value: int
    cargo_holds: int
    fighters: int
    shields: int
    turns_per_warp: int
    warp_power_capacity: int
    equipment_slots: int
    built_in_features: List[str]


# Ship registry with all ship definitions
SHIP_REGISTRY = {
    ShipType.KESTREL_COURIER: ShipStats(
        name="Kestrel Courier",
        role="starter",
        price=25000,
        trade_in_value=15000,
        cargo_holds=30,
        fighters=300,
        shields=150,
        turns_per_warp=3,
        warp_power_capacity=300,
        equipment_slots=2,
        built_in_features=[]
    ),
    ShipType.SPARROW_SCOUT: ShipStats(
        name="Sparrow Scout",
        role="recon",
        price=35000,
        trade_in_value=21000,
        cargo_holds=20,
        fighters=200,
        shields=120,
        turns_per_warp=2,
        warp_power_capacity=280,
        equipment_slots=2,
        built_in_features=["scanner"]
    ),
    ShipType.WAYFARER_FREIGHTER: ShipStats(
        name="Wayfarer Freighter",
        role="main trader",
        price=120000,
        trade_in_value=72000,
        cargo_holds=120,
        fighters=600,
        shields=300,
        turns_per_warp=3,
        warp_power_capacity=800,
        equipment_slots=3,
        built_in_features=[]
    ),
    ShipType.ATLAS_HAULER: ShipStats(
        name="Atlas Hauler",
        role="bulk cargo",
        price=260000,
        trade_in_value=156000,
        cargo_holds=300,
        fighters=500,
        shields=250,
        turns_per_warp=4,
        warp_power_capacity=1600,
        equipment_slots=3,
        built_in_features=[]
    ),
    ShipType.CORSAIR_RAIDER: ShipStats(
        name="Corsair Raider",
        role="pirate",
        price=180000,
        trade_in_value=108000,
        cargo_holds=60,
        fighters=1500,
        shields=400,
        turns_per_warp=3,
        warp_power_capacity=700,
        equipment_slots=3,
        built_in_features=[]
    ),
    ShipType.PIKE_FRIGATE: ShipStats(
        name="Pike Frigate",
        role="assault",
        price=300000,
        trade_in_value=180000,
        cargo_holds=70,
        fighters=2000,
        shields=600,
        turns_per_warp=3,
        warp_power_capacity=900,
        equipment_slots=3,
        built_in_features=[]
    ),
    ShipType.BULWARK_DESTROYER: ShipStats(
        name="Bulwark Destroyer",
        role="line combat",
        price=450000,
        trade_in_value=270000,
        cargo_holds=80,
        fighters=4000,
        shields=1200,
        turns_per_warp=4,
        warp_power_capacity=1500,
        equipment_slots=3,
        built_in_features=[]
    ),
    ShipType.AEGIS_CRUISER: ShipStats(
        name="Aegis Cruiser",
        role="control/escort",
        price=700000,
        trade_in_value=420000,
        cargo_holds=90,
        fighters=3500,
        shields=1000,
        turns_per_warp=3,
        warp_power_capacity=1300,
        equipment_slots=4,
        built_in_features=[]
    ),
    ShipType.PIONEER_LIFTER: ShipStats(
        name="Pioneer Lifter",
        role="logistics",
        price=220000,
        trade_in_value=132000,
        cargo_holds=180,
        fighters=500,
        shields=200,
        turns_per_warp=4,
        warp_power_capacity=1400,
        equipment_slots=3,
        built_in_features=[]
    ),
    ShipType.SOVEREIGN_STARCRUISER: ShipStats(
        name="Sovereign Starcruiser",
        role="flagship",
        price=2500000,
        trade_in_value=1500000,
        cargo_holds=140,
        fighters=6500,
        shields=2000,
        turns_per_warp=3,
        warp_power_capacity=3000,
        equipment_slots=5,
        built_in_features=["transwarp"]
    ),
}


def get_ship_stats(ship_type: ShipType) -> ShipStats:
    """Get the stats for a specific ship type.
    
    Args:
        ship_type: The type of ship to get stats for
        
    Returns:
        ShipStats object with all ship properties
        
    Raises:
        ValueError: If ship type is not found in registry
    """
    if ship_type not in SHIP_REGISTRY:
        raise ValueError(f"Unknown ship type: {ship_type}")
    return SHIP_REGISTRY[ship_type]


def validate_ship_type(ship_type_str: str) -> Optional[ShipType]:
    """Validate a ship type string and return the enum.
    
    Args:
        ship_type_str: String representation of ship type
        
    Returns:
        ShipType enum if valid, None otherwise
    """
    try:
        return ShipType(ship_type_str.lower())
    except ValueError:
        return None