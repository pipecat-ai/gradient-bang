import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from api import combat_initiate
from combat.models import CombatEncounter, CombatantState
from combat import utils as combat_utils


def _make_character(sector: int = 5, fighters: int = 10):
    return SimpleNamespace(
        sector=sector,
        fighters=fighters,
        in_hyperspace=False,
        max_fighters=fighters,
    )


@pytest.mark.asyncio
async def test_combat_initiate_returns_minimal_success(monkeypatch):
    character_id = "initiator"
    world = SimpleNamespace(
        characters={
            character_id: _make_character(),
            "opponent": _make_character(),
        },
        knowledge_manager=SimpleNamespace(
            load_knowledge=MagicMock(
                return_value=SimpleNamespace(
                    current_ship_id="ship-123"
                )
            ),
            get_ship=MagicMock(
                return_value={
                    "ship_id": "ship-123",
                    "state": {"fighters": 25},
                    "ship_type": "kestrel_courier",
                }
            ),
        ),
        character_to_corp={},
    )

    start_mock = AsyncMock(return_value={"combat_id": "combat-xyz"})
    monkeypatch.setattr(combat_initiate, "start_sector_combat", start_mock)

    result = await combat_initiate.handle({"character_id": character_id}, world)

    assert result == {"success": True, "combat_id": "combat-xyz"}
    start_mock.assert_awaited_once_with(
        world,
        sector_id=world.characters[character_id].sector,
        initiator_id=character_id,
        garrisons_to_include=None,
        reason="manual",
    )


def _build_encounter(round_number: int) -> CombatEncounter:
    participant = CombatantState(
        combatant_id="initiator",
        combatant_type="character",
        name="initiator",
        fighters=40,
        shields=30,
        turns_per_warp=2,
        max_fighters=40,
        max_shields=40,
        owner_character_id="initiator",
        ship_type="kestrel_courier",
    )
    return CombatEncounter(
        combat_id="combat-alpha",
        sector_id=7,
        participants={"initiator": participant},
        round_number=round_number,
        context={"initiator": "initiator"},
    )


def _patch_serialization_helpers(monkeypatch):
    monkeypatch.setattr(
        combat_utils,
        "_list_sector_garrisons",
        AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(
        combat_utils,
        "serialize_participant_for_event",
        lambda _world, state, **__: {"participant": state.combatant_id},
    )
    monkeypatch.setattr(
        combat_utils,
        "_build_ship_payload",
        lambda *_args, **__kwargs: None,
    )


@pytest.mark.asyncio
async def test_round_waiting_includes_initiator_round_one(monkeypatch):
    encounter = _build_encounter(round_number=1)
    encounter.context["initiator"] = "initiator"
    # Add characters dict so initiator name can be resolved
    world = SimpleNamespace(
        garrisons=None,
        characters={"initiator": SimpleNamespace(name="initiator")}
    )

    _patch_serialization_helpers(monkeypatch)

    payload = await combat_utils.serialize_round_waiting_event(
        world,
        encounter,
        viewer_id="initiator",
    )

    assert payload["initiator"] == "initiator"
    assert payload["round"] == 1


@pytest.mark.asyncio
async def test_round_waiting_omits_initiator_after_first_round(monkeypatch):
    encounter = _build_encounter(round_number=2)
    # Add characters dict for consistency (even though not used in round 2)
    world = SimpleNamespace(
        garrisons=None,
        characters={"initiator": SimpleNamespace(name="initiator")}
    )

    _patch_serialization_helpers(monkeypatch)

    payload = await combat_utils.serialize_round_waiting_event(
        world,
        encounter,
        viewer_id="initiator",
    )

    assert payload["round"] == 2
    assert "initiator" not in payload


@pytest.mark.asyncio
async def test_round_waiting_initiator_falls_back_to_identifier(monkeypatch):
    encounter = _build_encounter(round_number=1)
    encounter.context["initiator"] = "missing-character-id"
    world = SimpleNamespace(
        garrisons=None,
        characters={"initiator": SimpleNamespace(name="initiator")},
        character_registry=None,
    )

    _patch_serialization_helpers(monkeypatch)

    payload = await combat_utils.serialize_round_waiting_event(
        world,
        encounter,
        viewer_id="initiator",
    )

    assert payload["initiator"] == "missing-character-id"
