"""Unit tests for new combat event serialization functions."""

import pytest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, AsyncMock, patch

from combat.utils import (
    serialize_participant_for_event,
    serialize_garrison_for_event,
    serialize_round_waiting_event,
    serialize_round_resolved_event,
    serialize_combat_ended_event,
)
from combat.models import CombatantState, GarrisonState
from combat.salvage import SalvageContainer


def _make_ship_record(
    character_id: str,
    *,
    ship_type: str = "kestrel_courier",
    name: str | None = None,
    fighters: int = 300,
    shields: int = 150,
    warp_power: int = 300,
    warp_power_capacity: int = 300,
    cargo: dict | None = None,
    cargo_holds: int = 30,
):
    state_cargo = {"quantum_foam": 0, "retro_organics": 0, "neuro_symbolics": 0}
    if cargo:
        state_cargo.update({k: int(v) for k, v in cargo.items()})
    return {
        "ship_id": f"{character_id}-ship",
        "ship_type": ship_type,
        "name": name,
        "sector": 0,
        "owner_type": "character",
        "owner_id": character_id,
        "acquired": datetime.now(timezone.utc).isoformat(),
        "state": {
            "fighters": fighters,
            "shields": shields,
            "cargo": state_cargo,
            "cargo_holds": cargo_holds,
            "warp_power": warp_power,
            "warp_power_capacity": warp_power_capacity,
            "modules": [],
        },
        "became_unowned": None,
        "former_owner_name": None,
    }


class TestSerializeParticipantForEvent:
    """Tests for serialize_participant_for_event function."""

    def test_character_participant_with_full_shields(self):
        """Test serializing character with 100% shields."""
        # Mock world and dependencies
        world = MagicMock()
        ship_record = _make_ship_record(
            "char1",
            name="Star Runner",
            fighters=300,
            shields=131,
            warp_power=0,
        )
        world.knowledge_manager.get_ship.return_value = ship_record
        world.knowledge_manager.load_knowledge.return_value = MagicMock()

        character = MagicMock()
        character.first_visit = datetime(2025, 10, 6, 1, 0, 0, tzinfo=timezone.utc)
        world.characters.get.return_value = character

        state = CombatantState(
            combatant_id="char1",
            combatant_type="character",
            name="Player One",
            fighters=300,
            shields=150,
            max_fighters=300,
            max_shields=150,
            turns_per_warp=3,
            owner_character_id="char1",
            ship_type="kestrel_courier",
        )

        with patch("combat.utils.get_ship_stats") as mock_stats:
            mock_stats.return_value = MagicMock(name="Kestrel Courier")
            result = serialize_participant_for_event(
                world, state, shield_integrity=100.0
            )

        assert result["created_at"] == "2025-10-06T01:00:00+00:00"
        assert result["name"] == "Player One"
        assert result["player_type"] == "human"
        assert result["ship"]["ship_type"] == "kestrel_courier"
        assert result["ship"]["ship_name"] == "Star Runner"
        assert result["ship"]["shield_integrity"] == 100.0
        assert result["ship"]["shield_damage"] is None
        assert result["ship"]["fighter_loss"] is None

    def test_character_participant_with_damage(self):
        """Test serializing character with shield damage and fighter loss."""
        world = MagicMock()
        ship_record = _make_ship_record(
            "char1",
            fighters=285,
            shields=120,
            warp_power=200,
        )
        world.knowledge_manager.get_ship.return_value = ship_record
        world.knowledge_manager.load_knowledge.return_value = MagicMock()

        character = MagicMock()
        character.first_visit = datetime(2025, 10, 6, 1, 0, 0, tzinfo=timezone.utc)
        world.characters.get.return_value = character

        state = CombatantState(
            combatant_id="char1",
            combatant_type="character",
            name="Player One",
            fighters=285,
            shields=120,
            max_fighters=300,
            max_shields=150,
            turns_per_warp=3,
            owner_character_id="char1",
            ship_type="kestrel_courier",
        )

        with patch("combat.utils.get_ship_stats") as mock_stats:
            ship_stats = MagicMock()
            ship_stats.name = "Kestrel Courier"
            mock_stats.return_value = ship_stats
            result = serialize_participant_for_event(
                world,
                state,
                shield_integrity=80.0,
                shield_damage=-20.0,
                fighter_loss=15,
            )

        assert result["ship"]["shield_integrity"] == 80.0
        assert result["ship"]["shield_damage"] == -20.0
        assert result["ship"]["fighter_loss"] == 15
        # Should use ship type name when custom name not set
        assert result["ship"]["ship_name"] == "Kestrel Courier"

    def test_garrison_participant_raises_error(self):
        """Test that serializing garrison as participant raises error."""
        world = MagicMock()
        state = CombatantState(
            combatant_id="garrison:1:owner1",
            combatant_type="garrison",
            name="Garrison (owner1)",
            fighters=50,
            shields=0,
            max_fighters=50,
            max_shields=0,
            turns_per_warp=0,
            owner_character_id="owner1",
        )

        with pytest.raises(ValueError, match="Garrisons should not be serialized as participants"):
            serialize_participant_for_event(world, state, shield_integrity=0.0)


class TestSerializeGarrisonForEvent:
    """Tests for serialize_garrison_for_event function."""

    def test_garrison_without_actual_garrison(self):
        """Test serializing garrison combatant without actual garrison data."""
        state = CombatantState(
            combatant_id="garrison:1:owner1",
            combatant_type="garrison",
            name="Garrison (owner1)",
            fighters=50,
            shields=0,
            max_fighters=50,
            max_shields=0,
            turns_per_warp=0,
            owner_character_id="owner1",
        )

        result = serialize_garrison_for_event(state)

        assert result["owner_name"] == "owner1"
        assert result["fighters"] == 50
        assert result["fighter_loss"] is None
        assert result["mode"] == "unknown"
        assert "deployed_at" in result

    def test_garrison_with_actual_garrison(self):
        """Test serializing garrison with actual GarrisonState data."""
        state = CombatantState(
            combatant_id="garrison:1:owner1",
            combatant_type="garrison",
            name="Garrison (owner1)",
            fighters=35,
            shields=0,
            max_fighters=50,
            max_shields=0,
            turns_per_warp=0,
            owner_character_id="owner1",
        )

        actual_garrison = GarrisonState(
            owner_id="owner1",
            fighters=50,
            mode="toll",
            toll_amount=100,
            toll_balance=500,
            deployed_at="2025-10-06T10:00:00+00:00",
        )

        result = serialize_garrison_for_event(state, actual_garrison, fighter_loss=15)

        assert result["owner_name"] == "owner1"
        assert result["fighters"] == 35
        assert result["fighter_loss"] == 15
        assert result["mode"] == "toll"
        assert result["toll_amount"] == 100
        assert "toll_balance" not in result
        assert result["deployed_at"] == "2025-10-06T10:00:00+00:00"


@pytest.mark.asyncio
class TestSerializeRoundWaitingEvent:
    """Tests for serialize_round_waiting_event function."""

    async def test_round_waiting_with_character_and_garrison(self):
        """Test serializing round_waiting event with both character and garrison."""
        world = MagicMock()
        world.garrisons = AsyncMock()

        garrison = GarrisonState(
            owner_id="garrison_owner",
            fighters=50,
            mode="toll",
            toll_amount=100,
            toll_balance=500,
            deployed_at="2025-10-06T10:00:00+00:00",
        )
        world.garrisons.list_sector = AsyncMock(return_value=[garrison])

        ship_record = _make_ship_record(
            "char1",
            name="Star Runner",
            fighters=285,
            shields=120,
            warp_power=0,
        )
        world.knowledge_manager.get_ship.side_effect = lambda cid: ship_record
        world.knowledge_manager.load_knowledge.side_effect = lambda cid: MagicMock()

        character = MagicMock()
        character.first_visit = datetime(2025, 10, 6, 1, 0, 0, tzinfo=timezone.utc)
        world.characters.get.return_value = character

        encounter = MagicMock()
        encounter.combat_id = "combat123"
        encounter.sector_id = 1203
        encounter.round_number = 1
        encounter.deadline = datetime(2025, 10, 6, 12, 34, 56, tzinfo=timezone.utc)

        char_state = CombatantState(
            combatant_id="char1",
            combatant_type="character",
            name="Trader Alice",
            fighters=300,
            shields=131,
            max_fighters=300,
            max_shields=150,
            turns_per_warp=3,
            owner_character_id="char1",
            ship_type="kestrel_courier",
        )

        garrison_state = CombatantState(
            combatant_id="garrison:1203:garrison_owner",
            combatant_type="garrison",
            name="Garrison (garrison_owner)",
            fighters=50,
            shields=0,
            max_fighters=50,
            max_shields=0,
            turns_per_warp=0,
            owner_character_id="garrison_owner",
        )

        encounter.participants = {
            "char1": char_state,
            "garrison:1203:garrison_owner": garrison_state,
        }

        with patch("combat.utils.get_ship_stats") as mock_stats:
            mock_stats.return_value = MagicMock(name="Kestrel Courier")
            result = await serialize_round_waiting_event(world, encounter, viewer_id="char1")

        payload = result
        assert payload["combat_id"] == "combat123"
        assert payload["sector"]["id"] == 1203
        assert payload["round"] == 1
        assert "current_time" in payload
        assert payload["deadline"] == "2025-10-06T12:34:56+00:00"

        # Check participants array
        assert len(payload["participants"]) == 1
        participant = payload["participants"][0]
        assert participant["name"] == "Trader Alice"
        assert participant["ship"]["shield_integrity"] == 87.3
        assert "participants_map" not in payload

        ship_payload = payload.get("ship")
        assert isinstance(ship_payload, dict)
        assert ship_payload["fighters"] == 300
        assert ship_payload["max_fighters"] == 300
        assert ship_payload["shields"] == 131
        assert ship_payload["max_shields"] == 150
        assert ship_payload["ship_type"] == "kestrel_courier"

        # Check garrison object
        assert payload["garrison"] is not None
        assert payload["garrison"]["owner_name"] == "garrison_owner"
        assert payload["garrison"]["fighters"] == 50
        assert payload["garrison"]["mode"] == "toll"
        assert "toll_balance" not in payload["garrison"]


@pytest.mark.asyncio
class TestSerializeRoundResolvedEvent:
    """Tests for serialize_round_resolved_event function."""

    async def test_round_resolved_with_deltas(self):
        """Test serializing round_resolved event with deltas calculated."""
        world = MagicMock()
        world.garrisons = AsyncMock()

        garrison = GarrisonState(
            owner_id="garrison_owner",
            fighters=35,
            mode="toll",
            toll_amount=100,
            toll_balance=500,
            deployed_at="2025-10-06T10:00:00+00:00",
        )
        world.garrisons.list_sector = AsyncMock(return_value=[garrison])

        ship_record = _make_ship_record(
            "char1",
            name="Star Runner",
            fighters=285,
            shields=120,
        )
        world.knowledge_manager.get_ship.side_effect = lambda cid: ship_record
        world.knowledge_manager.load_knowledge.side_effect = lambda cid: MagicMock()

        character = MagicMock()
        character.first_visit = datetime(2025, 10, 6, 1, 0, 0, tzinfo=timezone.utc)
        world.characters.get.return_value = character

        # Previous encounter (before round)
        previous_encounter = MagicMock()
        previous_encounter.deadline = None
        previous_char_state = CombatantState(
            combatant_id="char1",
            combatant_type="character",
            name="Trader Alice",
            fighters=300,
            shields=150,
            max_fighters=300,
            max_shields=150,
            turns_per_warp=3,
            owner_character_id="char1",
            ship_type="kestrel_courier",
        )
        previous_garrison_state = CombatantState(
            combatant_id="garrison:1203:garrison_owner",
            combatant_type="garrison",
            name="Garrison (garrison_owner)",
            fighters=50,
            shields=0,
            max_fighters=50,
            max_shields=0,
            turns_per_warp=0,
            owner_character_id="garrison_owner",
        )
        previous_encounter.participants = {
            "char1": previous_char_state,
            "garrison:1203:garrison_owner": previous_garrison_state,
        }

        # Current encounter (after round)
        current_encounter = MagicMock()
        current_encounter.combat_id = "combat123"
        current_encounter.sector_id = 1203
        current_encounter.round_number = 1
        current_encounter.deadline = None

        current_char_state = CombatantState(
            combatant_id="char1",
            combatant_type="character",
            name="Trader Alice",
            fighters=285,
            shields=120,
            max_fighters=300,
            max_shields=150,
            turns_per_warp=3,
            owner_character_id="char1",
            ship_type="kestrel_courier",
        )
        current_garrison_state = CombatantState(
            combatant_id="garrison:1203:garrison_owner",
            combatant_type="garrison",
            name="Garrison (garrison_owner)",
            fighters=35,
            shields=0,
            max_fighters=50,
            max_shields=0,
            turns_per_warp=0,
            owner_character_id="garrison_owner",
        )
        current_encounter.participants = {
            "char1": current_char_state,
            "garrison:1203:garrison_owner": current_garrison_state,
        }

        outcome = MagicMock()
        outcome.round_number = 1
        outcome.participant_deltas = {
            "char1": {"fighters": -15, "shields": -30},
            "garrison:1203:garrison_owner": {"fighters": -15, "shields": 0},
        }
        outcome.fighters_remaining = {"char1": 285, "garrison:1203:garrison_owner": 35}
        outcome.shields_remaining = {"char1": 120, "garrison:1203:garrison_owner": 0}
        outcome.flee_results = {}
        outcome.hits = {}
        outcome.offensive_losses = {}
        outcome.defensive_losses = {}
        outcome.shield_loss = {}
        outcome.end_state = "ongoing"
        outcome.round_result = "ongoing"
        outcome.effective_actions = {}

        with patch("combat.utils.get_ship_stats") as mock_stats:
            mock_stats.return_value = MagicMock(name="Kestrel Courier")
            result = await serialize_round_resolved_event(
                world,
                current_encounter,
                outcome,
                viewer_id="char1",
                previous_encounter=previous_encounter,
            )

        payload = result

        # Check deltas
        participant = payload["participants"][0]
        assert participant["name"] == "Trader Alice"
        assert participant["ship"]["shield_integrity"] == 80.0
        assert participant["ship"]["shield_damage"] == -20.0  # Lost 30 shields = 20%
        assert participant["ship"]["fighter_loss"] == 15

        ship_payload = payload.get("ship")
        assert isinstance(ship_payload, dict)
        assert ship_payload["fighters"] == 285
        assert ship_payload["max_fighters"] == 300
        assert ship_payload["shields"] == 120
        assert ship_payload["max_shields"] == 150
        assert ship_payload["ship_type"] == "kestrel_courier"

        garrison_data = payload["garrison"]
        assert garrison_data["fighters"] == 35
        assert garrison_data["fighter_loss"] == 15
        assert garrison_data["owner_name"] == "garrison_owner"
        assert "toll_balance" not in garrison_data
        assert "participants_map" not in payload


class TestSerializeCombatEndedEvent:
    """Tests for serialize_combat_ended_event function."""

    @pytest.mark.asyncio
    async def test_combat_ended_with_salvage(self):
        """Test serializing combat.ended event with salvage containers."""
        world = MagicMock()
        world.garrisons = AsyncMock()
        world.garrisons.list_sector.return_value = []
        world.knowledge_manager = MagicMock()

        encounter = MagicMock()
        encounter.combat_id = "combat123"
        encounter.sector_id = 1203
        char_state = CombatantState(
            combatant_id="char1",
            combatant_type="character",
            name="Trader Alice",
            fighters=280,
            shields=120,
            max_fighters=300,
            max_shields=150,
            turns_per_warp=3,
            owner_character_id="char1",
            ship_type="kestrel_courier",
        )
        encounter.participants = {"char1": char_state}

        outcome = MagicMock()
        outcome.round_number = 2
        outcome.hits = {}
        outcome.offensive_losses = {}
        outcome.defensive_losses = {}
        outcome.shield_loss = {}
        outcome.fighters_remaining = {}
        outcome.shields_remaining = {}
        outcome.flee_results = {}
        outcome.end_state = "foe_defeated"
        outcome.round_result = "foe_defeated"
        outcome.participant_deltas = {}
        outcome.effective_actions = {}

        ship_record = _make_ship_record(
            "char1",
            name="Star Runner",
            fighters=280,
            shields=120,
            warp_power=0,
        )
        world.knowledge_manager.get_ship.side_effect = lambda cid: ship_record
        world.knowledge_manager.load_knowledge.side_effect = lambda cid: MagicMock()

        now = datetime(2025, 10, 6, 12, 0, tzinfo=timezone.utc)
        salvage1 = SalvageContainer(
            salvage_id="salv_001",
            sector=1203,
            created_at=now,
            expires_at=now + timedelta(minutes=15),
            cargo={"quantum_foam": 10, "retro_organics": 5},
            scrap=15,
            credits=0,
            metadata={
                "ship_name": "Star Runner",
                "ship_type": "kestrel_courier",
            },
        )
        salvage2 = SalvageContainer(
            salvage_id="salv_002",
            sector=1203,
            created_at=now,
            expires_at=now + timedelta(minutes=15),
            cargo={"neuro_symbolics": 3},
            scrap=20,
            credits=0,
            metadata={
                "ship_name": "Unknown Ship",
                "ship_type": "atlas_freighter",
            },
        )

        logs = [
            "Trader Alice destroyed Trader Bob",
            "Trader Bob converted to escape pod",
        ]

        result = await serialize_combat_ended_event(world, encounter, [salvage1, salvage2], logs, outcome, viewer_id="char1")

        assert result["combat_id"] == "combat123"
        assert result["sector"]["id"] == 1203
        assert len(result["salvage"]) == 2

        # Check first salvage
        salv1 = result["salvage"][0]
        assert salv1["salvage_id"] == "salv_001"
        assert salv1["cargo"] == {"quantum_foam": 10, "retro_organics": 5}
        assert salv1["scrap"] == 15
        assert salv1["source"] == {
            "ship_name": "Star Runner",
            "ship_type": "kestrel_courier",
        }
        assert "victor_id" not in salv1
        assert "claimed_by" not in salv1

        salv2 = result["salvage"][1]
        assert salv2["salvage_id"] == "salv_002"
        assert salv2["cargo"] == {"neuro_symbolics": 3}
        assert salv2["scrap"] == 20
        assert salv2["source"] == {
            "ship_name": "Unknown Ship",
            "ship_type": "atlas_freighter",
        }

        # Check logs
        assert result["logs"] == logs

        ship_payload = result.get("ship")
        assert isinstance(ship_payload, dict)
        assert ship_payload["fighters"] == 280
        assert ship_payload["max_fighters"] == 300

    @pytest.mark.asyncio
    async def test_combat_ended_no_salvage(self):
        """Test combat.ended event with no salvage."""
        world = MagicMock()
        world.garrisons = AsyncMock()
        world.garrisons.list_sector.return_value = []
        world.knowledge_manager = MagicMock()

        encounter = MagicMock()
        encounter.combat_id = "combat456"
        encounter.sector_id = 500
        char_state = CombatantState(
            combatant_id="char1",
            combatant_type="character",
            name="Trader Alice",
            fighters=200,
            shields=100,
            max_fighters=300,
            max_shields=150,
            turns_per_warp=3,
            owner_character_id="char1",
            ship_type="kestrel_courier",
        )
        encounter.participants = {"char1": char_state}

        outcome = MagicMock()
        outcome.round_number = 1
        outcome.hits = {}
        outcome.offensive_losses = {}
        outcome.defensive_losses = {}
        outcome.shield_loss = {}
        outcome.fighters_remaining = {}
        outcome.shields_remaining = {}
        outcome.flee_results = {}
        outcome.end_state = "draw"
        outcome.round_result = "draw"
        outcome.participant_deltas = {}
        outcome.effective_actions = {}

        ship_record = _make_ship_record(
            "char1",
            name="Star Runner",
            fighters=200,
            shields=100,
            warp_power=0,
        )
        world.knowledge_manager.get_ship.side_effect = lambda cid: ship_record
        world.knowledge_manager.load_knowledge.side_effect = lambda cid: MagicMock()

        result = await serialize_combat_ended_event(world, encounter, [], [], outcome, viewer_id="char1")

        assert result["combat_id"] == "combat456"
        assert result["sector"]["id"] == 500
        assert result["salvage"] == []
        assert result["logs"] == []
        ship_payload = result.get("ship")
        assert isinstance(ship_payload, dict)
        assert ship_payload["fighters"] == 200
