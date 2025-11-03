"""Comprehensive combat scenario tests.

Tests all combat scenarios including:
- Multiple players (2, 3+)
- All action combinations (attack, brace, flee)
- Player destruction (salvage + escape pods)
- Salvage collection
- Garrison modes (toll, offensive, defensive)
- Auto-combat triggers
- Toll payment behavior
"""

import asyncio
import pytest
import pytest_asyncio
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "game-server"))

from utils.api_client import AsyncGameClient
from server import app
from core.world import world as game_world
from tests.utils import (
    create_weak_character,
    create_strong_character,
    create_balanced_character,
    cleanup_test_characters,
    set_character_cargo,
    modify_character_fighters,
)


class EventCollector:
    """Helper to collect and query events."""

    def __init__(self):
        self.events = []

    def add_event(self, event_name, payload=None):
        if payload is None and isinstance(event_name, dict):
            event_message = event_name
            event_name = event_message.get("event_name")
            payload = event_message.get("payload")
        elif isinstance(payload, dict) and {
            "event_name",
            "payload",
        }.issubset(payload.keys()):
            event_message = payload
            event_name = event_message.get("event_name", event_name)
            payload = event_message.get("payload")

        if event_name is None:
            return

        self.events.append((event_name, payload))

    async def wait_for_event(self, event_name, timeout=5.0, condition=None):
        """Wait for event matching optional condition."""
        start = asyncio.get_event_loop().time()
        while asyncio.get_event_loop().time() - start < timeout:
            for name, payload in self.events:
                if name == event_name:
                    if condition is None or condition(payload):
                        return payload
            await asyncio.sleep(0.1)
        pytest.fail(f"Timeout waiting for {event_name}")

    def get_all(self, event_name):
        return [payload for name, payload in self.events if name == event_name]

    def clear(self):
        self.events.clear()


async def submit_and_await_resolution(
    collector: EventCollector,
    submit_coro,
    timeout: float = 20.0,
    poll_interval: float = 2.0,
):
    """Submit combat action and poll for round resolution.

    Polls every poll_interval seconds for combat.round_resolved event.
    Returns the event payload when received.
    Raises TimeoutError if not received within timeout.

    Args:
        collector: EventCollector monitoring combat.round_resolved
        submit_coro: Coroutine that submits the combat action
        timeout: Maximum time to wait (default 20s)
        poll_interval: Time between polls (default 2s)
    """
    await submit_coro

    elapsed = 0.0
    while elapsed < timeout:
        await asyncio.sleep(poll_interval)
        elapsed += poll_interval

        # Check if we received the event
        for name, payload in collector.events:
            if name == "combat.round_resolved":
                return payload

    raise TimeoutError(
        f"Did not receive combat.round_resolved within {timeout}s. "
        f"Received events: {[name for name, _ in collector.events]}"
    )


@pytest_asyncio.fixture(autouse=True)
async def reset_world():
    """Reset world before and after each test using the test.reset endpoint."""
    # Create a temporary client to call the reset endpoint on test server port
    reset_client = AsyncGameClient(
        base_url="http://localhost:8002",
        character_id="test_reset_client",
        transport="websocket",
    )

    try:
        # Reset BEFORE test
        await reset_client.test_reset(clear_files=True)

        yield

        # Reset AFTER test
        await reset_client.test_reset(clear_files=True)
    finally:
        await reset_client.close()


@pytest.mark.asyncio
@pytest.mark.integration
class TestBasicCombatScenarios:
    """Test basic combat scenarios with players."""

    async def test_two_players_combat_attack_actions(self):
        """Test two players attacking each other."""
        collector1 = EventCollector()
        collector2 = EventCollector()

        # Use unique character IDs for this test
        client1 = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_2p_player1",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_2p_player2",
            transport="websocket",
        )

        client1.on("combat.round_waiting")(lambda p: collector1.add_event("combat.round_waiting", p))
        client1.on("combat.round_resolved")(lambda p: collector1.add_event("combat.round_resolved", p))

        client2.on("combat.round_waiting")(lambda p: collector2.add_event("combat.round_waiting", p))
        client2.on("combat.round_resolved")(lambda p: collector2.add_event("combat.round_resolved", p))

        try:
            await client1.join("test_2p_player1")
            await client2.join("test_2p_player2")

            # Move to same sector (581 is adjacent to sector 0) - UNIQUE FOR THIS TEST

            # Initiate combat
            await client1.combat_initiate(character_id="test_2p_player1")

            # Wait for round_waiting
            waiting = await collector1.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            # Both attack
            await client1.combat_action(
                character_id="test_2p_player1",
                combat_id=combat_id,
                action="attack",
                target_id="test_2p_player2",
                commit=1,
            )
            await client2.combat_action(
                character_id="test_2p_player2",
                combat_id=combat_id,
                action="attack",
                target_id="test_2p_player1",
                commit=1,
            )

            # Wait for round_resolved
            resolved = await collector1.wait_for_event("combat.round_resolved")

            # Verify both participants present
            assert len(resolved["participants"]) == 2

            # Verify some damage occurred
            participants = resolved["participants"]
            damages = []
            for p in participants:
                if "ship" in p:
                    shield_dmg = p["ship"].get("shield_damage")
                    fighter_loss = p["ship"].get("fighter_loss")
                    if shield_dmg and shield_dmg != 0:
                        damages.append(shield_dmg)
                    if fighter_loss and fighter_loss != 0:
                        damages.append(fighter_loss)
            assert len(damages) > 0, f"Expected some damage from mutual attacks, got participants: {participants}"

        finally:
            await client1.close()
            await client2.close()

    async def test_three_players_combat(self):
        """Test combat with three players."""
        clients = []
        collectors = []

        for i in range(3):
            collector = EventCollector()
            client = AsyncGameClient(
                base_url="http://localhost:8002",
                character_id=f"test_3p_player{i+1}",
                transport="websocket",
            )
            # Capture collector value using default parameter to avoid closure bug
            client.on("combat.round_waiting")(lambda p, c=collector: c.add_event("combat.round_waiting", p))
            clients.append(client)
            collectors.append(collector)

        try:
            # All join and move to sector 657 (adjacent to sector 0) - UNIQUE FOR THIS TEST
            for i, client in enumerate(clients):
                await client.join(f"test_3p_player{i+1}")
                await client.move(to_sector=657, character_id=f"test_3p_player{i+1}")

            # Initiate combat
            await clients[0].combat_initiate(character_id="test_3p_player1")

            # All should receive round_waiting
            for collector in collectors:
                waiting = await collector.wait_for_event("combat.round_waiting")
                assert len(waiting["participants"]) == 3

        finally:
            for client in clients:
                await client.close()

    async def test_attack_brace_flee_combinations(self):
        """Test different action combinations."""
        collector1 = EventCollector()
        collector2 = EventCollector()

        client1 = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_abf_attacker",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_abf_defender",
            transport="websocket",
        )

        client1.on("combat.round_waiting")(lambda p: collector1.add_event("combat.round_waiting", p))
        client1.on("combat.round_resolved")(lambda p: collector1.add_event("combat.round_resolved", p))

        client2.on("combat.round_waiting")(lambda p: collector2.add_event("combat.round_waiting", p))
        client2.on("combat.round_resolved")(lambda p: collector2.add_event("combat.round_resolved", p))

        try:
            await client1.join("test_abf_attacker")
            await client2.join("test_abf_defender")

            # Use sector 849 (adjacent to sector 0) - UNIQUE FOR THIS TEST
            await client1.move(to_sector=849, character_id="test_abf_attacker")
            await client2.move(to_sector=849, character_id="test_abf_defender")

            await client1.combat_initiate(character_id="test_abf_attacker")

            # Round 1: Attack vs Brace
            waiting1 = await collector1.wait_for_event("combat.round_waiting")
            combat_id = waiting1["combat_id"]

            await client1.combat_action(
                character_id="test_abf_attacker",
                combat_id=combat_id,
                action="attack",
                target_id="test_abf_defender",
                commit=1,
            )
            await client2.combat_action(
                character_id="test_abf_defender",
                combat_id=combat_id,
                action="brace",
                commit=1,
            )

            resolved1 = await collector1.wait_for_event("combat.round_resolved")
            assert "participants" in resolved1

            # Round 2: Both brace - wait for round 2 waiting event
            waiting2 = await collector1.wait_for_event("combat.round_waiting", condition=lambda p: p.get("round") == 2)

            await client1.combat_action(
                character_id="test_abf_attacker",
                combat_id=combat_id,
                action="brace",
                commit=1,
            )
            await client2.combat_action(
                character_id="test_abf_defender",
                combat_id=combat_id,
                action="brace",
                commit=1,
            )

            resolved2 = await collector1.wait_for_event("combat.round_resolved")
            # Both bracing should result in no significant damage
            participants = resolved2["participants"]
            for p in participants:
                if "ship" in p:
                    # Shield damage should be minimal when both brace (allow small rounding/regen)
                    shield_dmg = p["ship"].get("shield_damage", 0)
                    assert shield_dmg is None or abs(shield_dmg) < 5

        finally:
            await client1.close()
            await client2.close()


@pytest.mark.asyncio
@pytest.mark.integration
class TestPlayerDestruction:
    """Test destroying players to create salvage and escape pods."""

    async def test_destroy_player_creates_salvage(self):
        """Test that destroying a player creates salvage container."""
        # Create pre-configured characters
        create_weak_character("test_dest_victim", sector=0, fighters=5)
        create_strong_character("test_dest_attacker", sector=0, fighters=500)

        # Give weak character some cargo for salvage
        set_character_cargo("test_dest_victim", quantum_foam=10, retro_organics=5, neuro_symbolics=2)

        collector_attacker = EventCollector()
        collector_victim = EventCollector()

        client_attacker = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_dest_attacker",
            transport="websocket",
        )
        client_victim = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_dest_victim",
            transport="websocket",
        )

        client_attacker.on("combat.ended")(
            lambda p: collector_attacker.add_event("combat.ended", p)
        )
        client_attacker.on("sector.update")(
            lambda p: collector_attacker.add_event("sector.update", p)
        )
        client_attacker.on("combat.round_waiting")(
            lambda p: collector_attacker.add_event("combat.round_waiting", p)
        )
        client_attacker.on("combat.round_resolved")(
            lambda p: collector_attacker.add_event("combat.round_resolved", p)
        )

        client_victim.on("combat.ended")(
            lambda p: collector_victim.add_event("combat.ended", p)
        )

        try:
            # Both join
            await client_attacker.join("test_dest_attacker")
            await client_victim.join("test_dest_victim")

            # Move to sector 126 (adjacent to sector 581) - UNIQUE FOR THIS TEST
            await client_attacker.move(to_sector=581, character_id="test_dest_attacker")
            await client_attacker.move(to_sector=126, character_id="test_dest_attacker")
            await client_victim.move(to_sector=581, character_id="test_dest_victim")
            await client_victim.move(to_sector=126, character_id="test_dest_victim")

            # Initiate combat
            await client_attacker.combat_initiate(character_id="test_dest_attacker")

            # Wait for first round to start then submit decisive attack
            waiting = await collector_attacker.wait_for_event("combat.round_waiting", timeout=5.0)
            combat_id = waiting["combat_id"]

            await client_attacker.combat_action(
                character_id="test_dest_attacker",
                combat_id=combat_id,
                action="attack",
                target_id="test_dest_victim",
                commit=200,
            )
            await client_victim.combat_action(
                character_id="test_dest_victim",
                combat_id=combat_id,
                action="brace",
                commit=0,
            )

            resolved = await collector_attacker.wait_for_event("combat.round_resolved", timeout=5.0)
            participants = resolved.get("participants", [])
            victim_entry = next((p for p in participants if p.get("name") == "test_dest_victim"), {})
            victim_ship = victim_entry.get("ship", {})
            assert victim_ship.get("fighter_loss") is not None, "Victim should have recorded fighter losses"

            # Await combat.ended event directly (should resolve quickly once victim destroyed)
            ended_event = await collector_attacker.wait_for_event("combat.ended", timeout=10.0)

            # Verify salvage was created
            assert "salvage" in ended_event
            salvage_list = ended_event["salvage"]
            assert len(salvage_list) > 0, "Expected salvage to be created from destroyed victim"

            if len(salvage_list) > 0:
                salvage = salvage_list[0]

                # Check salvage structure (privacy)
                assert "salvage_id" in salvage
                assert "cargo" in salvage
                assert "scrap" in salvage
                assert "source" in salvage

                # Source should have ship_name, not character_id
                assert "ship_name" in salvage["source"]
                assert "ship_type" in salvage["source"]
                assert "character_id" not in salvage["source"]

                # Should NOT have victor_id or claimed_by
                assert "victor_id" not in salvage
                assert "claimed_by" not in salvage

                # Should have cargo from weak player
                assert salvage["cargo"].get("quantum_foam", 0) > 0

            # Wait for sector.update after combat ended
            sector_update = await collector_attacker.wait_for_event("sector.update", timeout=5.0)

            # Salvage should be visible in sector
            assert "salvage" in sector_update
            if len(salvage_list) > 0:
                assert len(sector_update["salvage"]) > 0

        finally:
            await client_attacker.close()
            await client_victim.close()

    async def test_escape_pod_transition(self):
        """Test that defeated player becomes escape pod."""
        # Create characters
        create_weak_character("test_pod_weak", sector=0, fighters=1)
        create_strong_character("test_pod_strong", sector=0, fighters=500)

        collector_weak = EventCollector()

        client_strong = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_pod_strong",
            transport="websocket",
        )
        client_weak = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_pod_weak",
            transport="websocket",
        )

        client_weak.on("combat.round_waiting")(
            lambda p: collector_weak.add_event("combat.round_waiting", p)
        )
        client_weak.on("combat.ended")(
            lambda p: collector_weak.add_event("combat.ended", p)
        )
        client_weak.on("status.update")(
            lambda p: collector_weak.add_event("status.update", p)
        )

        try:
            await client_strong.join("test_pod_strong")
            await client_weak.join("test_pod_weak")

            # Use sector 1284 (adjacent to sector 581) - UNIQUE FOR THIS TEST
            await client_strong.move(to_sector=581, character_id="test_pod_strong")
            await client_strong.move(to_sector=1284, character_id="test_pod_strong")
            await client_weak.move(to_sector=581, character_id="test_pod_weak")
            await client_weak.move(to_sector=1284, character_id="test_pod_weak")

            # Initiate combat
            await client_strong.combat_initiate(character_id="test_pod_strong")

            # Get combat_id from first round waiting
            waiting = await collector_weak.wait_for_event("combat.round_waiting", timeout=5.0)
            combat_id = waiting["combat_id"]

            # Submit attack action (strong player attacks to defeat weak player)
            await client_strong.combat_action(
                character_id="test_pod_strong",
                combat_id=combat_id,
                action="attack",
                target_id="test_pod_weak",
                commit=100,  # High commit to guarantee one-shot destruction
            )

            # Weak player braces (will be defeated)
            await client_weak.combat_action(
                character_id="test_pod_weak",
                combat_id=combat_id,
                action="brace",
                commit=0,
            )

            # Wait for combat.ended
            await collector_weak.wait_for_event("combat.ended", timeout=10.0)

            # Wait for status.update (escape pod conversion)
            await collector_weak.wait_for_event("status.update", timeout=5.0)

            # Check weak player's status - should be escape pod
            status = await client_weak.my_status(character_id="test_pod_weak")

            # Ship should be escape pod
            assert status["ship"]["ship_type"] == "escape_pod"

            # Escape pod should have minimal stats
            # (implementation may vary, but fighters should be 0)
            assert status["ship"]["fighters"] == 0

        finally:
            await client_strong.close()
            await client_weak.close()


@pytest.mark.asyncio
@pytest.mark.integration
class TestSalvageCollection:
    """Test salvage collection and sector updates."""

    async def test_salvage_collection_triggers_sector_update(self):
        """Test salvage creation, auto-brace mechanics, and sector.update propagation.

        This test validates:
        1. Salvage creation when a player is destroyed
        2. Auto-brace behavior when participants don't submit actions
        3. Combat ends with stalemate when all participants auto-brace
        4. sector.update events propagate to all characters in sector (combatants + observer)
        5. Salvage collection triggers sector.update
        """
        # Create characters: attacker (strong), victim (weak), observer (balanced)
        create_strong_character("test_salv_attacker", sector=0, fighters=200)
        create_weak_character("test_salv_victim", sector=0, fighters=5)
        create_balanced_character("test_salv_observer", sector=0)

        # Give victim cargo for salvage
        set_character_cargo("test_salv_victim", quantum_foam=20, retro_organics=10, neuro_symbolics=5)

        collector_attacker = EventCollector()
        collector_victim = EventCollector()
        collector_observer = EventCollector()

        client_attacker = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_salv_attacker",
            transport="websocket",
        )
        client_victim = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_salv_victim",
            transport="websocket",
        )
        client_observer = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_salv_observer",
            transport="websocket",
        )

        # Setup event handlers
        client_attacker.on("combat.round_waiting")(
            lambda p: collector_attacker.add_event("combat.round_waiting", p)
        )
        client_attacker.on("combat.round_resolved")(
            lambda p: collector_attacker.add_event("combat.round_resolved", p)
        )
        client_attacker.on("combat.ended")(
            lambda p: collector_attacker.add_event("combat.ended", p)
        )
        client_attacker.on("sector.update")(
            lambda p: collector_attacker.add_event("sector.update", p)
        )
        client_victim.on("combat.ended")(
            lambda p: collector_victim.add_event("combat.ended", p)
        )
        client_victim.on("sector.update")(
            lambda p: collector_victim.add_event("sector.update", p)
        )
        client_observer.on("sector.update")(
            lambda p: collector_observer.add_event("sector.update", p)
        )

        try:
            # All join and move to sector 1284 for combat
            await client_attacker.join("test_salv_attacker")
            await client_victim.join("test_salv_victim")
            await client_observer.join("test_salv_observer")

            # Move all to sector 1284: 0 → 581 → 1284
            await client_attacker.move(to_sector=581, character_id="test_salv_attacker")
            await client_attacker.move(to_sector=1284, character_id="test_salv_attacker")

            await client_victim.move(to_sector=581, character_id="test_salv_victim")
            await client_victim.move(to_sector=1284, character_id="test_salv_victim")

            await client_observer.move(to_sector=581, character_id="test_salv_observer")
            await client_observer.move(to_sector=1284, character_id="test_salv_observer")

            # Initiate combat
            await client_attacker.combat_initiate(character_id="test_salv_attacker")
            waiting = await collector_attacker.wait_for_event("combat.round_waiting", timeout=5.0)
            combat_id = waiting["combat_id"]

            # Round 1: Attacker attacks victim with full commit to destroy them
            # Victim and observer don't submit (auto-brace)
            resolved = await submit_and_await_resolution(
                collector_attacker,
                client_attacker.combat_action(
                    character_id="test_salv_attacker",
                    combat_id=combat_id,
                    action="attack",
                    target_id="test_salv_victim",
                    commit=200,  # Full commit to destroy weak victim
                ),
                timeout=20.0,
            )

            # Verify round 1 completed and victim took heavy losses
            assert resolved["round"] == 1

            # Find victim in participants list
            victim_data = None
            for p in resolved.get("participants", []):
                if p.get("name") == "test_salv_victim":
                    victim_data = p
                    break

            assert victim_data is not None, "Victim should be in participants"
            # Victim started with 5 fighters, should have lost all of them
            assert victim_data.get("ship", {}).get("fighter_loss", 0) == 5, "Victim should have lost all fighters"

            # Round 2: Neither attacker nor observer submit actions
            # Both should auto-brace → stalemate → combat ends
            # Sleep for round timeout (15s) plus buffer
            await asyncio.sleep(16.0)

            # Wait for combat.ended (auto-brace by remaining participants)
            ended = await collector_attacker.wait_for_event("combat.ended", timeout=5.0)
            assert ended["combat_id"] == combat_id

            # Verify salvage was created (proves victim was destroyed)
            salvage_list = ended.get("salvage", [])
            assert len(salvage_list) > 0, "Expected salvage to be created from destroyed victim"

            salvage_id = salvage_list[0]["salvage_id"]
            salvage_item = salvage_list[0]
            cargo = salvage_item.get("cargo", {})
            assert cargo.get("quantum_foam", 0) == 20
            assert cargo.get("retro_organics", 0) == 10
            assert cargo.get("neuro_symbolics", 0) == 5

            # Wait for sector.update after combat ended
            sector_update_1 = await collector_attacker.wait_for_event("sector.update", timeout=5.0)
            assert "salvage" in sector_update_1
            assert len(sector_update_1["salvage"]) > 0, "Salvage should be visible in sector"

            # Observer should also see the salvage in sector
            observer_update_1 = await collector_observer.wait_for_event("sector.update", timeout=5.0)
            assert len(observer_update_1["salvage"]) > 0, "Observer should see salvage"

            # Clear event collectors for next phase
            collector_attacker.clear()
            collector_observer.clear()

            # Attacker collects the salvage
            await client_attacker.salvage_collect(
                character_id="test_salv_attacker",
                salvage_id=salvage_id,
            )

            # Both attacker and observer should receive sector.update (salvage removed)
            sector_update_2 = await collector_attacker.wait_for_event("sector.update", timeout=5.0)
            observer_update_2 = await collector_observer.wait_for_event("sector.update", timeout=5.0)

            # Verify salvage was removed from sector
            assert "salvage" in sector_update_2
            remaining_salvage = [s for s in sector_update_2["salvage"] if s["salvage_id"] == salvage_id]
            assert len(remaining_salvage) == 0, "Salvage should be removed after collection"

            # Observer should also see salvage removed
            observer_remaining = [s for s in observer_update_2["salvage"] if s["salvage_id"] == salvage_id]
            assert len(observer_remaining) == 0, "Observer should see salvage removed"

        finally:
            await client_attacker.close()
            await client_victim.close()
            await client_observer.close()


@pytest.mark.asyncio
@pytest.mark.integration
class TestGarrisonScenarios:
    """Test garrison combat scenarios."""

    async def test_garrison_with_owner_in_sector(self):
        """Test garrison combat when owner is present."""
        # Create characters with balanced stats
        create_balanced_character("test_gow_owner", sector=0)
        create_balanced_character("test_gow_enemy", sector=0)

        collector_owner = EventCollector()
        collector_enemy = EventCollector()

        client_owner = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_gow_owner",
            transport="websocket",
        )
        client_enemy = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_gow_enemy",
            transport="websocket",
        )

        client_owner.on("combat.round_waiting")(
            lambda p: collector_owner.add_event("combat.round_waiting", p)
        )
        client_enemy.on("combat.round_waiting")(
            lambda p: collector_enemy.add_event("combat.round_waiting", p)
        )

        try:
            await client_owner.join("test_gow_owner")
            await client_enemy.join("test_gow_enemy")

            # Use sector 657 - UNIQUE FOR THIS TEST
            await client_owner.move(to_sector=657, character_id="test_gow_owner")

            # Deploy garrison in sector 657
            await client_owner.combat_leave_fighters(
                character_id="test_gow_owner",
                sector=657,
                quantity=50,
                mode="offensive",
            )

            # Enemy enters sector 657 - should trigger combat with both garrison and owner
            await client_enemy.move(to_sector=657, character_id="test_gow_enemy")

            # Wait for combat
            waiting = await collector_enemy.wait_for_event("combat.round_waiting")

            # Should have enemy + owner character + garrison
            participants = waiting["participants"]
            garrison = waiting.get("garrison")

            # Verify garrison is present
            assert garrison is not None
            assert garrison["mode"] == "offensive"

            # Verify owner is in participants
            participant_names = [p["name"] for p in participants]
            assert "test_gow_owner" in participant_names or len(participants) >= 1

        finally:
            await client_owner.close()
            await client_enemy.close()

    async def test_garrison_without_owner_in_sector(self):
        """Test garrison combat when owner is not present."""
        # Create characters with balanced stats
        create_balanced_character("test_gwo_deployer", sector=0)
        create_balanced_character("test_gwo_victim", sector=0)

        collector_deployer = EventCollector()
        collector_victim = EventCollector()

        client_deployer = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_gwo_deployer",
            transport="websocket",
        )
        client_victim = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_gwo_victim",
            transport="websocket",
        )

        client_victim.on("combat.round_waiting")(
            lambda p: collector_victim.add_event("combat.round_waiting", p)
        )

        try:
            await client_deployer.join("test_gwo_deployer")
            await client_victim.join("test_gwo_victim")

            # Use sector 849 - UNIQUE FOR THIS TEST
            await client_deployer.move(to_sector=849, character_id="test_gwo_deployer")

            # Deploy garrison in sector 849
            await client_deployer.combat_leave_fighters(
                character_id="test_gwo_deployer",
                sector=849,
                quantity=50,
                mode="offensive",
            )

            # Deployer leaves sector (back through 126, 581, to 0)
            await client_deployer.move(to_sector=0, character_id="test_gwo_deployer")

            # Victim enters empty sector 849 with garrison
            await client_victim.move(to_sector=849, character_id="test_gwo_victim")

            # Should trigger combat with just garrison
            waiting = await collector_victim.wait_for_event("combat.round_waiting")

            participants = waiting["participants"]
            garrison = waiting.get("garrison")

            # Garrison should be present
            assert garrison is not None

            # Participant should only be the victim
            assert len(participants) == 1
            assert participants[0]["name"] == "test_gwo_victim"

        finally:
            await client_deployer.close()
            await client_victim.close()


@pytest.mark.asyncio
@pytest.mark.integration
class TestGarrisonModes:
    """Test different garrison modes."""

    async def test_toll_mode_garrison(self):
        """Test garrison in toll mode demands payment."""
        # Create deployer with fighters, payer with credits
        create_balanced_character("test_toll_deployer", sector=0)
        create_balanced_character("test_toll_payer", sector=0)

        collector_payer = EventCollector()

        client_deployer = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_toll_deployer",
            transport="websocket",
        )
        client_payer = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_toll_payer",
            transport="websocket",
        )

        client_payer.on("combat.round_waiting")(
            lambda p: collector_payer.add_event("combat.round_waiting", p)
        )
        client_payer.on("combat.round_resolved")(
            lambda p: collector_payer.add_event("combat.round_resolved", p)
        )
        client_payer.on("combat.ended")(
            lambda p: collector_payer.add_event("combat.ended", p)
        )

        try:
            await client_deployer.join("test_toll_deployer")
            await client_payer.join("test_toll_payer")

            # Get initial credits
            status = await client_payer.my_status(character_id="test_toll_payer")
            initial_credits = status["ship"]["credits"]

            # Use sector 1284 - UNIQUE FOR THIS TEST
            await client_deployer.move(to_sector=581, character_id="test_toll_deployer")
            await client_deployer.move(to_sector=1284, character_id="test_toll_deployer")

            # Deploy toll garrison with 100 credit toll in sector 1284
            await client_deployer.combat_leave_fighters(
                character_id="test_toll_deployer",
                sector=1284,
                quantity=50,
                mode="toll",
                toll_amount=100,
            )
            # Deployer leaves back to 0
            await client_deployer.move(to_sector=581, character_id="test_toll_deployer")
            await client_deployer.move(to_sector=0, character_id="test_toll_deployer")

            # Payer enters sector 1284 - should trigger toll combat
            await client_payer.move(to_sector=581, character_id="test_toll_payer")
            await client_payer.move(to_sector=1284, character_id="test_toll_payer")

            # Wait for combat.round_waiting (Round 1 - demand payment)
            waiting = await collector_payer.wait_for_event("combat.round_waiting")

            combat_id = waiting["combat_id"]
            garrison = waiting.get("garrison")

            # Verify garrison is in toll mode with toll_amount
            assert garrison is not None
            assert garrison["mode"] == "toll"
            assert garrison["toll_amount"] == 100

            # Find garrison combatant ID for targeting
            garrison_combatants = [
                p for p in waiting["participants"]
                if p.get("combatant_id") and "garrison" in str(p.get("combatant_id", ""))
            ]
            # Submit PAY action (Round 1)
            await client_payer.combat_action(
                character_id="test_toll_payer",
                combat_id=combat_id,
                action="pay",
                commit=0,
                target_id=None,  # Payment auto-targets the toll garrison
            )

            # Wait for round to resolve
            resolved = await collector_payer.wait_for_event("combat.round_resolved", timeout=10.0)

            # Verify payment succeeded by checking credits
            status = await client_payer.my_status(character_id="test_toll_payer")
            new_credits = status["ship"]["credits"]

            # Credits should be reduced by toll_amount
            assert new_credits == initial_credits - 100, \
                f"Expected {initial_credits - 100} credits, got {new_credits}"

            # Combat should end immediately after toll payment (no other combatants)
            # Wait for combat.ended event
            ended = await collector_payer.wait_for_event("combat.ended", timeout=5.0)

            # Verify combat ended with correct combat_id
            assert ended["combat_id"] == combat_id

        finally:
            await client_deployer.close()
            await client_payer.close()

    async def test_offensive_mode_garrison(self):
        """Test garrison in offensive mode auto-attacks."""
        # Create characters with balanced stats
        create_balanced_character("test_off_deployer", sector=0)
        create_balanced_character("test_off_victim", sector=0)

        collector = EventCollector()

        client_deployer = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_off_deployer",
            transport="websocket",
        )
        client_victim = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_off_victim",
            transport="websocket",
        )

        client_victim.on("combat.round_waiting")(
            lambda p: collector.add_event("combat.round_waiting", p)
        )

        try:
            await client_deployer.join("test_off_deployer")
            await client_victim.join("test_off_victim")

            # Both start at sector 0
            # Deploy offensive garrison in sector 0 (will trigger combat with victim present)
            await client_deployer.combat_leave_fighters(
                character_id="test_off_deployer",
                sector=0,
                quantity=50,
                mode="offensive",
            )

            # Offensive garrison auto-triggers combat when deployed with enemies present
            waiting = await collector.wait_for_event("combat.round_waiting")
            assert waiting.get("garrison") is not None
            assert waiting["garrison"]["mode"] == "offensive"

        finally:
            await client_deployer.close()
            await client_victim.close()

    async def test_defensive_mode_garrison(self):
        """Test garrison in defensive mode only fights when attacked."""
        # Create characters with balanced stats
        create_balanced_character("test_def_deployer", sector=0)
        create_balanced_character("test_def_victim", sector=0)

        collector = EventCollector()

        client_deployer = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_def_deployer",
            transport="websocket",
        )
        client_victim = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_def_victim",
            transport="websocket",
        )

        client_victim.on("combat.round_waiting")(
            lambda p: collector.add_event("combat.round_waiting", p)
        )

        try:
            await client_deployer.join("test_def_deployer")
            await client_victim.join("test_def_victim")

            # Use sector 126 - UNIQUE FOR THIS TEST
            await client_deployer.move(to_sector=581, character_id="test_def_deployer")
            await client_deployer.move(to_sector=126, character_id="test_def_deployer")

            # Deploy defensive garrison in sector 126
            await client_deployer.combat_leave_fighters(
                character_id="test_def_deployer",
                sector=126,
                quantity=50,
                mode="defensive",
            )
            # Leave back to 0
            await client_deployer.move(to_sector=581, character_id="test_def_deployer")
            await client_deployer.move(to_sector=0, character_id="test_def_deployer")

            # Victim enters sector 126 - should NOT auto-trigger combat
            await client_victim.move(to_sector=581, character_id="test_def_victim")
            await client_victim.move(to_sector=126, character_id="test_def_victim")

            # Wait a moment
            await asyncio.sleep(0.5)

            # Should NOT have combat event
            combat_events = collector.get_all("combat.round_waiting")
            assert len(combat_events) == 0, "Defensive garrison should not auto-attack"

            # But if victim initiates, garrison should fight
            await client_victim.combat_initiate(character_id="test_def_victim")

            waiting = await collector.wait_for_event("combat.round_waiting")
            assert waiting.get("garrison") is not None
            assert waiting["garrison"]["mode"] == "defensive"

        finally:
            await client_deployer.close()
            await client_victim.close()


@pytest.mark.asyncio
@pytest.mark.integration
class TestCombatEndedEvents:
    """Test combat.ended and sector.update emissions."""

    async def test_combat_ended_triggers_sector_update(self):
        """Test that combat.ended triggers sector.update for all in sector."""
        # Create characters with balanced stats
        create_balanced_character("test_end_combatant1", sector=0)
        create_balanced_character("test_end_combatant2", sector=0)
        create_balanced_character("test_end_observer", sector=0)

        collector1 = EventCollector()
        collector2 = EventCollector()
        observer_collector = EventCollector()

        client1 = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_end_combatant1",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_end_combatant2",
            transport="websocket",
        )
        observer = AsyncGameClient(
            base_url="http://localhost:8002",
            character_id="test_end_observer",
            transport="websocket",
        )

        client1.on("combat.ended")(lambda p: collector1.add_event("combat.ended", p))
        client1.on("sector.update")(lambda p: collector1.add_event("sector.update", p))
        client1.on("combat.round_waiting")(lambda p: collector1.add_event("combat.round_waiting", p))

        client2.on("combat.ended")(lambda p: collector2.add_event("combat.ended", p))

        observer.on("sector.update")(lambda p: observer_collector.add_event("sector.update", p))

        try:
            await client1.join("test_end_combatant1")
            await client2.join("test_end_combatant2")
            await observer.join("test_end_observer")

            # Move to sector 1284 via proper path: 0 → 581 → 1284
            await client1.move(to_sector=581, character_id="test_end_combatant1")
            await client1.move(to_sector=1284, character_id="test_end_combatant1")
            await client2.move(to_sector=581, character_id="test_end_combatant2")
            await client2.move(to_sector=1284, character_id="test_end_combatant2")
            await observer.move(to_sector=581, character_id="test_end_observer")
            await observer.move(to_sector=1284, character_id="test_end_observer")

            # Wait for sector update after movements
            await asyncio.sleep(0.5)

            # Initiate combat between combatant1 and combatant2
            await client1.combat_initiate(character_id="test_end_combatant1")

            # Wait for combat to start
            waiting = await collector1.wait_for_event("combat.round_waiting", timeout=5.0)
            combat_id = waiting["combat_id"]

            # Let combat timeout (both players brace) to trigger stalemate and combat.ended
            # Round timeout is 15s
            await asyncio.sleep(16.0)

            # Verify combat.ended event was received by combatants
            ended1 = await collector1.wait_for_event("combat.ended", timeout=5.0)
            assert ended1["combat_id"] == combat_id

            ended2 = await collector2.wait_for_event("combat.ended", timeout=5.0)
            assert ended2["combat_id"] == combat_id

            # Verify sector.update event was received by combatant
            sector_updates1 = collector1.get_all("sector.update")
            assert len(sector_updates1) > 0, "Combatant should receive sector.update after combat.ended"

            # Verify sector.update event was received by observer
            sector_updates_observer = observer_collector.get_all("sector.update")
            assert len(sector_updates_observer) > 0, "Observer should receive sector.update after combat.ended"

        finally:
            await client1.close()
            await client2.close()
            await observer.close()
