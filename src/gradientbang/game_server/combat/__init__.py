"""Combat subsystem for Gradient Bang."""

from gradientbang.game_server.combat.models import (
    CombatantState,
    CombatEncounter,
    CombatRoundLog,
    CombatantAction,
    CombatRoundOutcome,
    GarrisonState,
)
from gradientbang.game_server.combat.engine import resolve_round
from gradientbang.game_server.combat.manager import CombatManager
from gradientbang.game_server.combat.garrisons import GarrisonStore
from gradientbang.game_server.combat.salvage import (
    SalvageManager,
    SalvageContainer,
)

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
