from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "game-server"))

from combat.manager import CombatManager
from combat.models import CombatEncounter, CombatantAction, CombatantState
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


@pytest.mark.asyncio
async def test_toll_pay_action_triggers_standdown():
    credits = {"runner": 100}

    def pay_handler(payer: str, amount: int) -> bool:
        balance = credits.get(payer, 0)
        if balance < amount:
            return False
        credits[payer] = balance - amount
        return True

    manager = CombatManager(on_pay_action=pay_handler)

    stats = get_ship_stats(ShipType.KESTREL_COURIER)
    garrison_id = "garrison:42:owner"
    participants = {
        garrison_id: CombatantState(
            combatant_id=garrison_id,
            combatant_type="garrison",
            name="Toll Fighters",
            fighters=10,
            shields=0,
            turns_per_warp=0,
            max_fighters=10,
            max_shields=0,
            owner_character_id="owner",
        ),
        "runner": CombatantState(
            combatant_id="runner",
            combatant_type="character",
            name="runner",
            fighters=stats.fighters,
            shields=stats.shields,
            turns_per_warp=stats.turns_per_warp,
            max_fighters=stats.fighters,
            max_shields=stats.shields,
            owner_character_id="runner",
        ),
    }

    encounter = CombatEncounter(
        combat_id="toll-test",
        sector_id=999,
        participants=participants,
        context={
            "initiator": "runner",
            "garrison_sources": [
                {
                    "owner_id": "owner",
                    "mode": "toll",
                    "toll_amount": 23,
                    "toll_balance": 0,
                }
            ],
            "toll_registry": {
                garrison_id: {
                    "owner_id": "owner",
                    "toll_amount": 23,
                    "toll_balance": 0,
                    "target_id": "runner",
                    "demand_round": 0,
                    "paid": False,
                }
            },
        },
    )

    await manager.start_encounter(encounter)

    # Player pays the toll
    pay_outcome = await manager.submit_action(
        combat_id="toll-test",
        combatant_id="runner",
        action=CombatantAction.PAY,
        commit=0,
    )
    assert pay_outcome is None

    # Garrison braces in the same round after payment
    attack_outcome = await manager.submit_action(
        combat_id="toll-test",
        combatant_id=garrison_id,
        action=CombatantAction.BRACE,
        commit=0,
        target_id=None,
    )

    assert attack_outcome is not None
    assert getattr(attack_outcome, "round_result", None) == "toll_satisfied"
    assert encounter.ended is True
    assert credits["runner"] == 77

    registry = encounter.context.get("toll_registry", {})
    entry = registry.get(garrison_id, {})
    assert entry.get("paid") is True
    assert entry.get("toll_balance") == 23


@pytest.mark.asyncio
async def test_toll_pay_insufficient_funds_braces():
    def pay_handler(_payer: str, _amount: int) -> bool:
        return False

    manager = CombatManager(on_pay_action=pay_handler)

    stats = get_ship_stats(ShipType.KESTREL_COURIER)
    garrison_id = "garrison:7:owner"
    participants = {
        garrison_id: CombatantState(
            combatant_id=garrison_id,
            combatant_type="garrison",
            name="Toll Fighters",
            fighters=5,
            shields=0,
            turns_per_warp=0,
            max_fighters=5,
            max_shields=0,
            owner_character_id="owner",
        ),
        "runner": CombatantState(
            combatant_id="runner",
            combatant_type="character",
            name="runner",
            fighters=stats.fighters,
            shields=stats.shields,
            turns_per_warp=stats.turns_per_warp,
            max_fighters=stats.fighters,
            max_shields=stats.shields,
            owner_character_id="runner",
        ),
    }

    encounter = CombatEncounter(
        combat_id="toll-fail",
        sector_id=100,
        participants=participants,
        context={
            "toll_registry": {
                garrison_id: {
                    "owner_id": "owner",
                    "toll_amount": 50,
                    "toll_balance": 0,
                    "target_id": "runner",
                    "paid": False,
                }
            }
        },
    )

    await manager.start_encounter(encounter)

    await manager.submit_action(
        combat_id="toll-fail",
        combatant_id="runner",
        action=CombatantAction.PAY,
        commit=0,
    )

    pending = encounter.pending_actions.get("runner")
    assert pending is not None
    assert pending.action == CombatantAction.BRACE
    registry = encounter.context.get("toll_registry", {})
    entry = registry.get(garrison_id, {})
    assert entry.get("paid") is False


@pytest.mark.asyncio
async def test_toll_demand_stalemate_does_not_end_combat():
    manager = CombatManager()

    stats = get_ship_stats(ShipType.KESTREL_COURIER)
    garrison_id = "garrison:9:owner"
    participants = {
        garrison_id: CombatantState(
            combatant_id=garrison_id,
            combatant_type="garrison",
            name="Toll Fighters",
            fighters=15,
            shields=0,
            turns_per_warp=0,
            max_fighters=15,
            max_shields=0,
            owner_character_id="owner",
        ),
        "runner": CombatantState(
            combatant_id="runner",
            combatant_type="character",
            name="runner",
            fighters=stats.fighters,
            shields=stats.shields,
            turns_per_warp=stats.turns_per_warp,
            max_fighters=stats.fighters,
            max_shields=stats.shields,
            owner_character_id="runner",
        ),
    }

    encounter = CombatEncounter(
        combat_id="toll-stall",
        sector_id=9,
        participants=participants,
        context={
            "toll_registry": {
                garrison_id: {
                    "owner_id": "owner",
                    "toll_amount": 25,
                    "toll_balance": 0,
                    "target_id": "runner",
                    "paid": False,
                }
            }
        },
    )

    await manager.start_encounter(encounter)

    await manager.submit_action(
        combat_id="toll-stall",
        combatant_id=garrison_id,
        action=CombatantAction.BRACE,
    )
    outcome = await manager.submit_action(
        combat_id="toll-stall",
        combatant_id="runner",
        action=CombatantAction.BRACE,
    )

    assert outcome is not None
    assert getattr(outcome, "round_result", None) is None
    assert encounter.ended is False
    assert encounter.round_number == 2
