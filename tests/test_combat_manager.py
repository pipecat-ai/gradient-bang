from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "game-server"))

from combat.manager import CombatManager
from combat.models import CombatEncounter, CombatantState
from ships import ShipType, get_ship_stats


@pytest.mark.asyncio
async def test_stalemate_round_keeps_combat_active():
    manager = CombatManager()

    stats = get_ship_stats(ShipType.KESTREL_COURIER)
    participants = {
        "aggressor": CombatantState(
            combatant_id="aggressor",
            combatant_type="character",
            name="aggressor",
            fighters=stats.fighters,
            shields=stats.shields,
            turns_per_warp=stats.turns_per_warp,
            max_fighters=stats.fighters,
            max_shields=stats.shields,
            owner_character_id="aggressor",
        ),
        "defender": CombatantState(
            combatant_id="defender",
            combatant_type="character",
            name="defender",
            fighters=stats.fighters,
            shields=stats.shields,
            turns_per_warp=stats.turns_per_warp,
            max_fighters=stats.fighters,
            max_shields=stats.shields,
            owner_character_id="defender",
        ),
    }
    encounter = CombatEncounter(
        combat_id="stalemate-test",
        sector_id=822,
        participants=participants,
    )

    await manager.start_encounter(encounter)
    outcome = await manager._resolve_round(encounter.combat_id)

    assert getattr(outcome, "round_result", None) == "stalemate"
    assert outcome.end_state == "stalemate"
    assert encounter.ended is True
    assert encounter.round_number == 1
    # Clean up any pending timers started by the manager
    await manager.cancel_encounter(encounter.combat_id)
