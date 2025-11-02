"""Tests for combat.garrison_ai module."""

import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from combat.garrison_ai import (
    calculate_garrison_commit,
    auto_submit_garrison_actions,
)
from combat.models import CombatantAction


class TestCalculateGarrisonCommit:
    """Tests for calculate_garrison_commit function."""

    def test_offensive_mode(self):
        """Test offensive mode commit calculation."""
        # Offensive: max(1, min(fighters, max(50, fighters // 2)))
        assert calculate_garrison_commit("offensive", 0) == 0
        assert calculate_garrison_commit("offensive", 1) == 1
        assert calculate_garrison_commit("offensive", 50) == 50
        assert calculate_garrison_commit("offensive", 100) == 50
        assert calculate_garrison_commit("offensive", 200) == 100  # 200 // 2
        assert calculate_garrison_commit("offensive", 300) == 150  # 300 // 2

    def test_defensive_mode(self):
        """Test defensive mode commit calculation."""
        # Defensive: max(1, min(fighters, max(25, fighters // 4)))
        assert calculate_garrison_commit("defensive", 0) == 0
        assert calculate_garrison_commit("defensive", 1) == 1
        assert calculate_garrison_commit("defensive", 25) == 25
        assert calculate_garrison_commit("defensive", 50) == 25
        assert calculate_garrison_commit("defensive", 100) == 25
        assert calculate_garrison_commit("defensive", 200) == 50  # 200 // 4
        assert calculate_garrison_commit("defensive", 400) == 100  # 400 // 4

    def test_toll_mode(self):
        """Test toll mode commit calculation."""
        # Toll: max(1, min(fighters, max(50, fighters // 3)))
        assert calculate_garrison_commit("toll", 0) == 0
        assert calculate_garrison_commit("toll", 1) == 1
        assert calculate_garrison_commit("toll", 50) == 50
        assert calculate_garrison_commit("toll", 100) == 50
        assert calculate_garrison_commit("toll", 150) == 50
        assert calculate_garrison_commit("toll", 200) == 66  # 200 // 3
        assert calculate_garrison_commit("toll", 300) == 100  # 300 // 3

    def test_default_to_offensive(self):
        """Test None or empty mode defaults to offensive."""
        assert calculate_garrison_commit(None, 100) == 50
        assert calculate_garrison_commit("", 100) == 50

    def test_case_insensitive(self):
        """Test mode is case insensitive."""
        assert calculate_garrison_commit("OFFENSIVE", 100) == 50
        assert calculate_garrison_commit("Defensive", 100) == 25
        assert calculate_garrison_commit("TOLL", 200) == 66


@pytest.mark.asyncio
class TestAutoSubmitGarrisonActions:
    """Tests for auto_submit_garrison_actions function."""

    async def test_no_manager(self):
        """Test handles None manager gracefully."""
        encounter = MagicMock()
        # Should not raise exception
        await auto_submit_garrison_actions(encounter, None)

    async def test_no_garrison_participants(self):
        """Test handles encounter with no garrisons."""
        encounter = MagicMock()
        encounter.participants = {
            "char1": MagicMock(combatant_type="character", fighters=100),
        }
        encounter.context = {}

        manager = AsyncMock()

        await auto_submit_garrison_actions(encounter, manager)

        # No actions submitted
        manager.submit_action.assert_not_called()

    async def test_offensive_garrison_attacks_strongest(self):
        """Test offensive garrison targets strongest enemy."""
        # Create mock participants
        garrison = MagicMock(
            combatant_id="garrison1",
            combatant_type="garrison",
            owner_character_id="owner1",
            fighters=100,
        )

        weak_char = MagicMock(
            combatant_id="char1",
            combatant_type="character",
            owner_character_id="player1",
            fighters=50,
            shields=10,
        )
        weak_char.is_escape_pod = False

        strong_char = MagicMock(
            combatant_id="char2",
            combatant_type="character",
            owner_character_id="player2",
            fighters=150,
            shields=20,
        )
        strong_char.is_escape_pod = False

        encounter = MagicMock()
        encounter.combat_id = "combat1"
        encounter.participants = {
            "garrison1": garrison,
            "char1": weak_char,
            "char2": strong_char,
        }
        encounter.context = {
            "garrison_sources": [
                {"owner_id": "owner1", "mode": "offensive"}
            ]
        }

        manager = AsyncMock()

        await auto_submit_garrison_actions(encounter, manager)

        # Should attack strongest character (char2)
        manager.submit_action.assert_called_once()
        call_args = manager.submit_action.call_args
        assert call_args.kwargs["combat_id"] == "combat1"
        assert call_args.kwargs["combatant_id"] == "garrison1"
        assert call_args.kwargs["action"] == CombatantAction.ATTACK
        assert call_args.kwargs["commit"] == 50  # 100 // 2 for offensive
        assert call_args.kwargs["target_id"] == "char2"  # Strongest

    async def test_defensive_garrison_commits_less(self):
        """Test defensive garrison commits fewer fighters."""
        garrison = MagicMock(
            combatant_id="garrison1",
            combatant_type="garrison",
            owner_character_id="owner1",
            fighters=100,
        )

        enemy = MagicMock(
            combatant_id="char1",
            combatant_type="character",
            owner_character_id="player1",
            fighters=100,
            shields=10,
        )
        enemy.is_escape_pod = False

        encounter = MagicMock()
        encounter.combat_id = "combat1"
        encounter.participants = {"garrison1": garrison, "char1": enemy}
        encounter.context = {
            "garrison_sources": [
                {"owner_id": "owner1", "mode": "defensive"}
            ]
        }

        manager = AsyncMock()

        await auto_submit_garrison_actions(encounter, manager)

        call_args = manager.submit_action.call_args
        assert call_args.kwargs["commit"] == 25  # 100 // 4 for defensive

    async def test_garrison_ignores_own_characters(self):
        """Test garrison doesn't target characters with same owner."""
        garrison = MagicMock(
            combatant_id="garrison1",
            combatant_type="garrison",
            owner_character_id="owner1",
            fighters=100,
        )

        own_char = MagicMock(
            combatant_id="char1",
            combatant_type="character",
            owner_character_id="owner1",  # Same owner
            fighters=100,
            shields=10,
        )

        encounter = MagicMock()
        encounter.participants = {"garrison1": garrison, "char1": own_char}
        encounter.context = {
            "garrison_sources": [
                {"owner_id": "owner1", "mode": "offensive"}
            ]
        }

        manager = AsyncMock()

        await auto_submit_garrison_actions(encounter, manager)

        # No valid targets, no action submitted
        manager.submit_action.assert_not_called()

    async def test_garrison_skips_corporation_members(self):
        """Test garrison prefers enemies over corporation allies."""
        garrison = MagicMock(
            combatant_id="garrison1",
            combatant_type="garrison",
            owner_character_id="owner1",
            fighters=120,
        )

        corp_ally = MagicMock(
            combatant_id="char1",
            combatant_type="character",
            owner_character_id="ally1",
            fighters=200,
            shields=50,
        )
        corp_ally.is_escape_pod = False

        enemy = MagicMock(
            combatant_id="char2",
            combatant_type="character",
            owner_character_id="enemy1",
            fighters=80,
            shields=20,
        )
        enemy.is_escape_pod = False

        encounter = MagicMock()
        encounter.combat_id = "combat1"
        encounter.participants = {
            "garrison1": garrison,
            "char1": corp_ally,
            "char2": enemy,
        }
        encounter.context = {
            "garrison_sources": [
                {"owner_id": "owner1", "mode": "offensive"}
            ]
        }

        manager = AsyncMock()
        world = SimpleNamespace(character_to_corp={
            "owner1": "corp-alpha",
            "ally1": "corp-alpha",
            "enemy1": "corp-beta",
        })

        await auto_submit_garrison_actions(encounter, manager, world)

        manager.submit_action.assert_called_once()
        kwargs = manager.submit_action.call_args.kwargs
        assert kwargs["target_id"] == "char2"

    async def test_garrison_with_only_corp_members_stands_down(self):
        """Test garrison does nothing when only corporation allies are present."""
        garrison = MagicMock(
            combatant_id="garrison1",
            combatant_type="garrison",
            owner_character_id="owner1",
            fighters=90,
        )

        corp_ally = MagicMock(
            combatant_id="char1",
            combatant_type="character",
            owner_character_id="ally1",
            fighters=75,
            shields=30,
        )
        corp_ally.is_escape_pod = False

        encounter = MagicMock()
        encounter.participants = {
            "garrison1": garrison,
            "char1": corp_ally,
        }
        encounter.context = {
            "garrison_sources": [
                {"owner_id": "owner1", "mode": "offensive"}
            ]
        }

        manager = AsyncMock()
        world = SimpleNamespace(character_to_corp={
            "owner1": "corp-gamma",
            "ally1": "corp-gamma",
        })

        await auto_submit_garrison_actions(encounter, manager, world)

        manager.submit_action.assert_not_called()

    async def test_toll_garrison_braces_first_round(self):
        """Test toll garrison braces on demand round."""
        garrison = MagicMock(
            combatant_id="garrison1",
            combatant_type="garrison",
            owner_character_id="owner1",
            fighters=100,
        )

        enemy = MagicMock(
            combatant_id="char1",
            combatant_type="character",
            owner_character_id="player1",
            fighters=100,
            shields=10,
        )

        encounter = MagicMock()
        encounter.combat_id = "combat1"
        encounter.round_number = 1
        encounter.participants = {"garrison1": garrison, "char1": enemy}
        encounter.context = {
            "garrison_sources": [
                {"owner_id": "owner1", "mode": "toll", "toll_amount": 100}
            ]
        }

        manager = AsyncMock()

        await auto_submit_garrison_actions(encounter, manager)

        # First round should brace (demand)
        call_args = manager.submit_action.call_args
        assert call_args.kwargs["action"] == CombatantAction.BRACE
        assert call_args.kwargs["commit"] == 0

    async def test_toll_garrison_attacks_after_demand(self):
        """Test toll garrison attacks on subsequent rounds if not paid."""
        garrison = MagicMock(
            combatant_id="garrison1",
            combatant_type="garrison",
            owner_character_id="owner1",
            fighters=100,
        )

        enemy = MagicMock(
            combatant_id="char1",
            combatant_type="character",
            owner_character_id="player1",
            fighters=100,
            shields=10,
        )

        encounter = MagicMock()
        encounter.combat_id = "combat1"
        encounter.round_number = 2  # Second round
        encounter.participants = {"garrison1": garrison, "char1": enemy}
        encounter.context = {
            "garrison_sources": [
                {"owner_id": "owner1", "mode": "toll", "toll_amount": 100}
            ],
            "toll_registry": {
                "garrison1": {
                    "owner_id": "owner1",
                    "toll_amount": 100,
                    "toll_balance": 0,
                    "target_id": "char1",
                    "paid": False,
                    "paid_round": None,
                    "demand_round": 1,
                }
            }
        }

        manager = AsyncMock()

        await auto_submit_garrison_actions(encounter, manager)

        # Second round should attack with all fighters
        call_args = manager.submit_action.call_args
        assert call_args.kwargs["action"] == CombatantAction.ATTACK
        assert call_args.kwargs["commit"] == 100  # All fighters
        assert call_args.kwargs["target_id"] == "char1"

    async def test_toll_garrison_stands_down_when_paid(self):
        """Test toll garrison braces when payment received."""
        garrison = MagicMock(
            combatant_id="garrison1",
            combatant_type="garrison",
            owner_character_id="owner1",
            fighters=100,
        )

        enemy = MagicMock(
            combatant_id="char1",
            combatant_type="character",
            owner_character_id="player1",
            fighters=100,
            shields=10,
        )

        encounter = MagicMock()
        encounter.combat_id = "combat1"
        encounter.round_number = 2
        encounter.participants = {"garrison1": garrison, "char1": enemy}
        encounter.context = {
            "garrison_sources": [
                {"owner_id": "owner1", "mode": "toll", "toll_amount": 100}
            ],
            "toll_registry": {
                "garrison1": {
                    "owner_id": "owner1",
                    "toll_amount": 100,
                    "toll_balance": 100,
                    "target_id": "char1",
                    "paid": True,  # Payment received
                    "paid_round": 1,
                    "demand_round": 1,
                }
            }
        }

        manager = AsyncMock()

        await auto_submit_garrison_actions(encounter, manager)

        # Should brace when paid
        call_args = manager.submit_action.call_args
        assert call_args.kwargs["action"] == CombatantAction.BRACE

    async def test_garrison_with_zero_fighters_ignored(self):
        """Test garrison with 0 fighters doesn't submit actions."""
        garrison = MagicMock(
            combatant_id="garrison1",
            combatant_type="garrison",
            owner_character_id="owner1",
            fighters=0,  # No fighters
        )

        encounter = MagicMock()
        encounter.participants = {"garrison1": garrison}
        encounter.context = {
            "garrison_sources": [
                {"owner_id": "owner1", "mode": "offensive"}
            ]
        }

        manager = AsyncMock()

        await auto_submit_garrison_actions(encounter, manager)

        # No action submitted for garrison with 0 fighters
        manager.submit_action.assert_not_called()
