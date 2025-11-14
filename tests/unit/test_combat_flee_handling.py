"""Tests for improved flee handling in combat system."""

import pytest
from unittest.mock import AsyncMock, MagicMock, call, patch

from gradientbang.game_server.combat.callbacks import on_round_resolved, on_combat_ended
from gradientbang.game_server.combat.models import CombatantAction, RoundAction


def _sector_id(value):
    if isinstance(value, dict):
        return value.get("id")
    return value


@pytest.mark.asyncio
class TestFleeHandling:
    """Tests for flee handling improvements."""

    @patch("combat.callbacks.api_move")
    @patch("combat.callbacks.emit_status_update")
    async def test_fled_character_receives_immediate_combat_ended(
        self, mock_emit_status, mock_api_move
    ):
        """Test that a successfully fled character receives immediate combat.ended event."""
        # Mock the move handler
        mock_api_move.handle = AsyncMock()

        # Mock emit_status_update
        mock_emit_status.return_value = AsyncMock()

        # Setup encounter
        encounter = MagicMock()
        encounter.combat_id = "combat1"
        encounter.sector_id = 100
        encounter.round_number = 3
        encounter.participants = {
            "char1": MagicMock(
                combatant_id="char1",
                combatant_type="character",
                owner_character_id="char1",
                fighters=50,
                shields=30,
                max_fighters=100,
                max_shields=50,
            ),
            "char2": MagicMock(
                combatant_id="char2",
                combatant_type="character",
                owner_character_id="char2",
                fighters=80,
                shields=40,
                max_fighters=100,
                max_shields=50,
            ),
        }
        encounter.context = {}

        # Setup outcome with successful flee
        outcome = MagicMock()
        outcome.round_number = 3
        outcome.flee_results = {"char1": True}  # char1 fled successfully
        outcome.fighters_remaining = {"char1": 50, "char2": 80}
        outcome.shields_remaining = {"char1": 30, "char2": 40}
        outcome.effective_actions = {
            "char1": MagicMock(
                action=CombatantAction.FLEE,
                destination_sector=150,
            ),
            "char2": MagicMock(action=CombatantAction.ATTACK),
        }

        # Mock world and event_dispatcher
        world = MagicMock()
        world.knowledge_manager = MagicMock()
        world.characters = {}

        event_dispatcher = AsyncMock()

        # Execute callback
        await on_round_resolved(encounter, outcome, world, event_dispatcher)

        # Verify immediate combat.ended was sent to fled character
        combat_ended_calls = [
            call_args
            for call_args in event_dispatcher.emit.call_args_list
            if call_args[0][0] == "combat.ended"
        ]

        assert len(combat_ended_calls) == 1
        call_args = combat_ended_calls[0]

        # Verify payload
        payload = call_args[0][1]
        assert payload["combat_id"] == "combat1"
        assert _sector_id(payload.get("sector")) == 100  # Where they fled FROM
        assert payload["result"] == "fled"
        assert payload["round"] == 3
        assert payload["fled_to_sector"] == 150
        assert payload["salvage"] == []

        # Verify character_filter
        assert call_args[1]["character_filter"] == ["char1"]

    async def test_fled_character_not_in_final_combat_ended(self):
        """Test that fled characters are NOT included in final combat.ended notification."""
        # Setup encounter (combat already over)
        encounter = MagicMock()
        encounter.combat_id = "combat1"
        encounter.sector_id = 100
        encounter.round_number = 5
        encounter.participants = {
            "char2": MagicMock(
                combatant_id="char2",
                combatant_type="character",
                owner_character_id="char2",
                fighters=100,
            )
        }
        encounter.context = {
            "recent_flee_character_ids": ["char1"],  # char1 fled in earlier round
        }

        # Setup outcome (char2 won)
        outcome = MagicMock()
        outcome.round_number = 5
        outcome.end_state = "victory"
        outcome.flee_results = {}
        outcome.fighters_remaining = {"char2": 100}

        # Mock world and event_dispatcher
        world = MagicMock()
        world.garrisons = None
        world.port_manager = MagicMock()
        world.port_manager.load_port_state.return_value = None
        world.salvage_manager = MagicMock()
        world.salvage_manager.create.return_value = None
        event_dispatcher = AsyncMock()
        emit_status_update = AsyncMock()

        # Execute callback
        await on_combat_ended(encounter, outcome, world, event_dispatcher)

        # Verify combat.ended was emitted
        combat_calls = [args for args in event_dispatcher.emit.call_args_list if args[0][0] == "combat.ended"]
        assert len(combat_calls) == 1
        call_args = combat_calls[0]

        # Verify character_filter does NOT include fled character
        character_filter = call_args[1]["character_filter"]
        assert "char1" not in character_filter
        assert "char2" in character_filter

    @patch("combat.callbacks.api_move")
    @patch("combat.callbacks.emit_status_update")
    async def test_multiple_fled_characters_receive_separate_events(
        self, mock_emit_status, mock_api_move
    ):
        """Test that multiple fled characters each receive their own combat.ended event."""
        # Mock the move handler
        mock_api_move.handle = AsyncMock()

        # Mock emit_status_update
        mock_emit_status.return_value = AsyncMock()

        # Setup encounter
        encounter = MagicMock()
        encounter.combat_id = "combat1"
        encounter.sector_id = 100
        encounter.round_number = 2
        encounter.participants = {
            "char1": MagicMock(
                combatant_id="char1",
                combatant_type="character",
                owner_character_id="char1",
                fighters=50,
                shields=30,
                max_fighters=100,
                max_shields=50,
            ),
            "char2": MagicMock(
                combatant_id="char2",
                combatant_type="character",
                owner_character_id="char2",
                fighters=60,
                shields=35,
                max_fighters=100,
                max_shields=50,
            ),
            "char3": MagicMock(
                combatant_id="char3",
                combatant_type="character",
                owner_character_id="char3",
                fighters=80,
                shields=40,
                max_fighters=100,
                max_shields=50,
            ),
        }
        encounter.context = {}

        # Setup outcome with two successful flees
        outcome = MagicMock()
        outcome.round_number = 2
        outcome.flee_results = {"char1": True, "char2": True}
        outcome.fighters_remaining = {"char1": 50, "char2": 60, "char3": 80}
        outcome.shields_remaining = {"char1": 30, "char2": 35, "char3": 40}
        outcome.effective_actions = {
            "char1": MagicMock(action=CombatantAction.FLEE, destination_sector=150),
            "char2": MagicMock(action=CombatantAction.FLEE, destination_sector=200),
            "char3": MagicMock(action=CombatantAction.ATTACK),
        }

        # Mock world and event_dispatcher
        world = MagicMock()
        world.knowledge_manager = MagicMock()
        world.characters = {}

        event_dispatcher = AsyncMock()

        # Execute callback
        await on_round_resolved(encounter, outcome, world, event_dispatcher)

        # Verify two combat.ended events were sent
        combat_ended_calls = [
            call_args
            for call_args in event_dispatcher.emit.call_args_list
            if call_args[0][0] == "combat.ended"
        ]

        assert len(combat_ended_calls) == 2

        # Extract character filters
        char_filters = [call_args[1]["character_filter"] for call_args in combat_ended_calls]

        # Verify each fled character received their own event
        assert ["char1"] in char_filters
        assert ["char2"] in char_filters

    @patch("combat.callbacks.api_move")
    @patch("combat.callbacks.emit_status_update")
    async def test_failed_flee_does_not_send_combat_ended(
        self, mock_emit_status, mock_api_move
    ):
        """Test that a failed flee does NOT send combat.ended event."""
        # Mock the move handler
        mock_api_move.handle = AsyncMock()

        # Mock emit_status_update
        mock_emit_status.return_value = AsyncMock()

        # Setup encounter
        encounter = MagicMock()
        encounter.combat_id = "combat1"
        encounter.sector_id = 100
        encounter.round_number = 1
        encounter.participants = {
            "char1": MagicMock(
                combatant_id="char1",
                combatant_type="character",
                owner_character_id="char1",
                fighters=50,
                shields=30,
                max_fighters=100,
                max_shields=50,
            ),
            "char2": MagicMock(
                combatant_id="char2",
                combatant_type="character",
                owner_character_id="char2",
                fighters=80,
                shields=40,
                max_fighters=100,
                max_shields=50,
            ),
        }
        encounter.context = {}

        # Setup outcome with FAILED flee
        outcome = MagicMock()
        outcome.round_number = 1
        outcome.flee_results = {"char1": False}  # Flee failed
        outcome.fighters_remaining = {"char1": 45, "char2": 80}  # char1 took damage
        outcome.shields_remaining = {"char1": 30, "char2": 40}
        outcome.effective_actions = {
            "char1": MagicMock(action=CombatantAction.FLEE),
            "char2": MagicMock(action=CombatantAction.ATTACK),
        }

        # Mock world and event_dispatcher
        world = MagicMock()
        world.knowledge_manager = MagicMock()
        world.characters = {}

        event_dispatcher = AsyncMock()

        # Execute callback
        await on_round_resolved(encounter, outcome, world, event_dispatcher)

        # Verify NO combat.ended events were sent
        combat_ended_calls = [
            call_args
            for call_args in event_dispatcher.emit.call_args_list
            if call_args[0][0] == "combat.ended"
        ]

        assert len(combat_ended_calls) == 0
