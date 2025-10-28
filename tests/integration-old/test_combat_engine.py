from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "game-server"))

from combat.engine import resolve_round
from combat.models import CombatEncounter, CombatantState, RoundAction, CombatantAction


def _encounter_template() -> CombatEncounter:
    participants = {
        "alpha": CombatantState(
            combatant_id="alpha",
            combatant_type="character",
            name="Alpha",
            fighters=100,
            shields=50,
            turns_per_warp=4,
            max_fighters=100,
            max_shields=50,
            owner_character_id="alpha",
        ),
        "beta": CombatantState(
            combatant_id="beta",
            combatant_type="character",
            name="Beta",
            fighters=100,
            shields=50,
            turns_per_warp=4,
            max_fighters=100,
            max_shields=50,
            owner_character_id="beta",
        ),
    }
    return CombatEncounter(
        combat_id="test",
        sector_id=42,
        participants=participants,
        round_number=1,
        base_seed=1234,
    )


def test_resolve_round_stalemate_when_all_brace():
    encounter = _encounter_template()
    actions = {
        "alpha": RoundAction(action=CombatantAction.BRACE, commit=0),
        "beta": RoundAction(action=CombatantAction.BRACE, commit=0),
    }

    outcome = resolve_round(encounter, actions)

    assert outcome.end_state == "stalemate"
    assert outcome.fighters_remaining["alpha"] == 100
    assert outcome.fighters_remaining["beta"] == 100
    assert outcome.shields_remaining["alpha"] == 50
    assert outcome.shields_remaining["beta"] == 50


def test_resolve_round_attack_without_target_defaults_to_stalemate():
    encounter = _encounter_template()
    actions = {
        "alpha": RoundAction(action=CombatantAction.ATTACK, commit=5),
        "beta": RoundAction(action=CombatantAction.BRACE, commit=0),
    }

    outcome = resolve_round(encounter, actions)

    assert outcome.end_state == "stalemate"
    assert outcome.fighters_remaining["alpha"] == 100
    assert outcome.fighters_remaining["beta"] == 100


def test_resolve_round_with_multiple_participants():
    encounter = _encounter_template()
    encounter.participants["gamma"] = CombatantState(
        combatant_id="gamma",
        combatant_type="character",
        name="Gamma",
        fighters=120,
        shields=60,
        turns_per_warp=3,
        max_fighters=120,
        max_shields=60,
        owner_character_id="gamma",
    )

    actions = {
        "alpha": RoundAction(action=CombatantAction.ATTACK, commit=10, target_id="beta"),
        "beta": RoundAction(action=CombatantAction.ATTACK, commit=10, target_id="alpha"),
        "gamma": RoundAction(action=CombatantAction.BRACE, commit=0),
    }

    outcome = resolve_round(encounter, actions)

    assert set(outcome.fighters_remaining.keys()) == {"alpha", "beta", "gamma"}
    assert outcome.fighters_remaining["gamma"] == encounter.participants["gamma"].fighters
    assert outcome.flee_results.get("gamma") is False
