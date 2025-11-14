"""Combat subsystem for Gradient Bang."""

from .models import (
    CombatantState,
    CombatEncounter,
    CombatRoundLog,
    CombatantAction,
    CombatRoundOutcome,
    GarrisonState,
)
from .engine import resolve_round
from .manager import CombatManager
from .garrisons import GarrisonStore
from .salvage import SalvageManager, SalvageContainer

__all__ = [
    "CombatantState",
    "CombatEncounter",
    "CombatRoundLog",
    "CombatantAction",
    "CombatRoundOutcome",
    "GarrisonState",
    "resolve_round",
    "CombatManager",
    "GarrisonStore",
    "SalvageManager",
    "SalvageContainer",
]
