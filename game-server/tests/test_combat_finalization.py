"""Tests for combat.finalization module."""

import pytest
from unittest.mock import AsyncMock, MagicMock

from combat.finalization import resolve_participant_owner, finalize_combat
from combat.models import GarrisonState
from ships import ShipType


class TestResolveParticipantOwner:
    """Tests for resolve_participant_owner function."""

    def test_participant_not_found(self):
        """Test returns None when participant doesn't exist."""
        encounter = MagicMock()
        encounter.participants = {}

        result = resolve_participant_owner(encounter, "unknown")
        assert result is None

    def test_character_with_owner_id(self):
        """Test returns owner_character_id for characters."""
        encounter = MagicMock()
        encounter.participants = {
            "char1": MagicMock(
                combatant_type="character",
                owner_character_id="player1",
                combatant_id="char1",
            )
        }

        result = resolve_participant_owner(encounter, "char1")
        assert result == "player1"

    def test_character_without_owner_id(self):
        """Test falls back to combatant_id for characters."""
        encounter = MagicMock()
        encounter.participants = {
            "char1": MagicMock(
                combatant_type="character",
                owner_character_id=None,
                combatant_id="char1",
            )
        }

        result = resolve_participant_owner(encounter, "char1")
        assert result == "char1"

    def test_garrison_with_owner(self):
        """Test returns owner_character_id for garrisons."""
        encounter = MagicMock()
        encounter.participants = {
            "garrison1": MagicMock(
                combatant_type="garrison",
                owner_character_id="player1",
                combatant_id="garrison1",
            )
        }

        result = resolve_participant_owner(encounter, "garrison1")
        assert result == "player1"

    def test_garrison_without_owner(self):
        """Test returns None for garrison without owner."""
        encounter = MagicMock()
        encounter.participants = {
            "garrison1": MagicMock(
                combatant_type="garrison",
                owner_character_id=None,
                combatant_id="garrison1",
            )
        }

        result = resolve_participant_owner(encounter, "garrison1")
        assert result is None


@pytest.mark.asyncio
class TestFinalizeCombat:
    """Tests for finalize_combat function."""

    async def test_no_defeated_characters(self):
        """Test finalization with no defeated characters."""
        encounter = MagicMock()
        encounter.combat_id = "combat1"
        encounter.sector_id = 10
        encounter.participants = {
            "char1": MagicMock(
                combatant_id="char1",
                combatant_type="character",
                owner_character_id="player1",
                fighters=100,
            )
        }
        encounter.context = {}

        outcome = MagicMock()
        outcome.fighters_remaining = {"char1": 100}
        outcome.flee_results = {}

        world = MagicMock()
        world.garrisons = None
        emit_status_update = AsyncMock()
        event_dispatcher = AsyncMock()

        salvages = await finalize_combat(
            encounter, outcome, world, emit_status_update, event_dispatcher
        )

        assert salvages == []
        emit_status_update.assert_not_called()

    async def test_defeated_character_creates_salvage(self):
        """Test defeated character creates salvage and converts to escape pod."""
        encounter = MagicMock()
        encounter.combat_id = "combat1"
        encounter.sector_id = 10
        encounter.participants = {
            "char1": MagicMock(
                combatant_id="char1",
                combatant_type="character",
                owner_character_id="loser1",
                fighters=0,
            ),
            "char2": MagicMock(
                combatant_id="char2",
                combatant_type="character",
                owner_character_id="winner1",
                fighters=100,
            ),
        }
        encounter.context = {}

        outcome = MagicMock()
        outcome.fighters_remaining = {"char1": 0, "char2": 100}
        outcome.flee_results = {}

        # Mock world and managers
        world = MagicMock()
        world.garrisons = None

        # Mock knowledge for loser
        loser_knowledge = MagicMock()
        loser_knowledge.ship_config.ship_type = ShipType.SPARROW_SCOUT.value
        loser_knowledge.ship_config.cargo = {"retro_organics": 10, "neuro_symbolics": 5}

        world.knowledge_manager.load_knowledge.return_value = loser_knowledge
        world.knowledge_manager.get_credits.side_effect = lambda char_id: (
            1000 if char_id == "loser1" else 500
        )

        # Mock salvage creation
        salvage_container = MagicMock()
        salvage_container.to_dict.return_value = {"id": "salvage1"}
        world.salvage_manager.create.return_value = salvage_container

        emit_status_update = AsyncMock()
        event_dispatcher = AsyncMock()

        salvages = await finalize_combat(
            encounter, outcome, world, emit_status_update, event_dispatcher
        )

        # Verify salvage created
        assert len(salvages) == 1
        world.salvage_manager.create.assert_called_once()

        # Verify loser converted to escape pod
        world.knowledge_manager.initialize_ship.assert_called_once_with(
            "loser1", ShipType.ESCAPE_POD
        )

        # Verify credits transferred
        world.knowledge_manager.update_credits.assert_any_call("loser1", 0)
        world.knowledge_manager.update_credits.assert_any_call("winner1", 1500)  # 500 + 1000

        # Verify status updates emitted
        assert emit_status_update.call_count >= 2  # loser and winner

    async def test_escaped_pod_not_processed(self):
        """Test character already in escape pod is not processed."""
        encounter = MagicMock()
        encounter.combat_id = "combat1"
        encounter.sector_id = 10
        encounter.participants = {
            "char1": MagicMock(
                combatant_id="char1",
                combatant_type="character",
                owner_character_id="player1",
                fighters=0,
            )
        }
        encounter.context = {}

        outcome = MagicMock()
        outcome.fighters_remaining = {"char1": 0}
        outcome.flee_results = {}

        world = MagicMock()
        world.garrisons = None

        # Already in escape pod
        knowledge = MagicMock()
        knowledge.ship_config.ship_type = ShipType.ESCAPE_POD.value
        world.knowledge_manager.load_knowledge.return_value = knowledge

        emit_status_update = AsyncMock()
        event_dispatcher = AsyncMock()

        salvages = await finalize_combat(
            encounter, outcome, world, emit_status_update, event_dispatcher
        )

        # No salvage created, no pod conversion
        assert salvages == []
        world.knowledge_manager.initialize_ship.assert_not_called()

    async def test_surviving_garrison_updated(self):
        """Test surviving garrison is updated in store."""
        encounter = MagicMock()
        encounter.combat_id = "combat1"
        encounter.sector_id = 10
        encounter.participants = {
            "garrison1": MagicMock(
                combatant_id="garrison1",
                combatant_type="garrison",
                owner_character_id="owner1",
                fighters=50,  # Survived
            )
        }
        encounter.context = {
            "garrison_sources": [
                {"owner_id": "owner1", "mode": "offensive", "toll_amount": 0, "toll_balance": 0}
            ]
        }

        outcome = MagicMock()
        outcome.fighters_remaining = {"garrison1": 50}
        outcome.flee_results = {}

        world = MagicMock()
        world.garrisons = AsyncMock()
        garrison_state = GarrisonState(
            owner_id="owner1",
            fighters=50,
            mode="offensive",
            toll_amount=0,
        )
        world.garrisons.deploy.return_value = garrison_state
        world.garrisons.list_sector = AsyncMock(return_value=[garrison_state])

        emit_status_update = AsyncMock()
        event_dispatcher = AsyncMock()

        await finalize_combat(
            encounter, outcome, world, emit_status_update, event_dispatcher
        )

        # Verify garrison deployed/updated
        world.garrisons.deploy.assert_called_once_with(
            sector_id=10,
            owner_id="owner1",
            fighters=50,
            mode="offensive",
            toll_amount=0,
            toll_balance=0,
        )

        # Finalization relies on callbacks to emit sector.update events
        event_dispatcher.emit.assert_not_called()

    async def test_destroyed_garrison_removed(self):
        """Test destroyed garrison is removed from store."""
        encounter = MagicMock()
        encounter.combat_id = "combat1"
        encounter.sector_id = 10
        encounter.participants = {
            "garrison1": MagicMock(
                combatant_id="garrison1",
                combatant_type="garrison",
                owner_character_id="owner1",
                fighters=0,  # Destroyed
            )
        }
        encounter.context = {
            "garrison_sources": [
                {"owner_id": "owner1", "mode": "offensive"}
            ]
        }

        outcome = MagicMock()
        outcome.fighters_remaining = {"garrison1": 0}
        outcome.flee_results = {}

        world = MagicMock()
        world.garrisons = AsyncMock()
        world.garrisons.list_sector = AsyncMock(return_value=[])

        emit_status_update = AsyncMock()
        event_dispatcher = AsyncMock()

        await finalize_combat(
            encounter, outcome, world, emit_status_update, event_dispatcher
        )

        # Verify garrison removed
        world.garrisons.remove.assert_called_once_with(10, "owner1")

    async def test_toll_winnings_distributed(self):
        """Test toll balance from destroyed garrison goes to winner."""
        encounter = MagicMock()
        encounter.combat_id = "combat1"
        encounter.sector_id = 10
        encounter.participants = {
            "garrison1": MagicMock(
                combatant_id="garrison1",
                combatant_type="garrison",
                owner_character_id="owner1",
                fighters=0,  # Destroyed
            ),
            "char1": MagicMock(
                combatant_id="char1",
                combatant_type="character",
                owner_character_id="winner1",
                fighters=100,  # Winner
            ),
        }
        encounter.context = {
            "garrison_sources": [
                {
                    "owner_id": "owner1",
                    "mode": "toll",
                    "toll_amount": 100,
                    "toll_balance": 500,  # Toll balance to distribute
                }
            ]
        }

        outcome = MagicMock()
        outcome.fighters_remaining = {"garrison1": 0, "char1": 100}
        outcome.flee_results = {}

        world = MagicMock()
        world.garrisons = AsyncMock()
        world.garrisons.list_sector = AsyncMock(return_value=[])
        world.knowledge_manager.get_credits.return_value = 1000

        emit_status_update = AsyncMock()
        event_dispatcher = AsyncMock()

        await finalize_combat(
            encounter, outcome, world, emit_status_update, event_dispatcher
        )

        # Verify toll winnings distributed to winner
        world.knowledge_manager.update_credits.assert_any_call("winner1", 1500)  # 1000 + 500
