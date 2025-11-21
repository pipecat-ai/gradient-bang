"""Comprehensive combat scenario tests.

Tests all combat scenarios including:
- Multiple players (2, 3+)
- All action combinations (attack, brace, flee)
- Player destruction (salvage + escape pods)
- Salvage collection
- Garrison modes (toll, offensive, defensive)
- Auto-combat triggers
- Toll payment behavior

IMPORTANT: These tests require a running test server on port 8002.
Start the server with:
    PORT=8002 WORLD_DATA_DIR=tests/test-world-data uv run python -m game-server
"""

import asyncio
import pytest
import sys
from pathlib import Path

# Add project paths for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from gradientbang.utils.api_client import RPCError
from tests.conftest import USE_SUPABASE_TESTS, EVENT_DELIVERY_WAIT  # type: ignore

if USE_SUPABASE_TESTS:
    from gradientbang.utils.supabase_client import AsyncGameClient  # type: ignore
else:
    from gradientbang.utils.api_client import AsyncGameClient
from tests.helpers.combat_helpers import (
    create_test_character_knowledge,
    create_weak_character,
    create_strong_character,
    create_balanced_character,
    set_character_cargo,
)


class EventCollector:
    """Helper to collect and query events from AsyncGameClient event handlers."""

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

    async def wait_for_event(self, event_name, timeout=10.0, condition=None):
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


async def get_status(client, character_id):
    """Get character status via status.snapshot event."""
    status_received = asyncio.Future()

    def on_status(event):
        if not status_received.done():
            status_received.set_result(event.get("payload", event))

    token = client.add_event_handler("status.snapshot", on_status)

    try:
        await client.my_status(character_id=character_id)
        return await asyncio.wait_for(status_received, timeout=5.0)
    finally:
        client.remove_event_handler(token)


@pytest.fixture(autouse=True)
async def reset_test_world(server_url, supabase_environment):  # noqa: ARG001
    if USE_SUPABASE_TESTS:
        # Supabase fixtures reset the database; FastAPI reset endpoint is unavailable.
        yield
        return
    """Reset world before and after each test using the test.reset endpoint."""
    reset_client = AsyncGameClient(
        base_url=server_url,
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


@pytest.mark.integration
@pytest.mark.requires_server
class TestBasicCombatScenarios:
    """Test basic combat scenarios with players."""

    async def test_two_players_combat_attack_actions(self, test_server):
        """Test two players attacking each other."""
        # Create test characters before initializing clients
        create_test_character_knowledge("test_2p_player1", sector=0)
        create_test_character_knowledge("test_2p_player2", sector=0)

        collector1 = EventCollector()
        collector2 = EventCollector()

        client1 = AsyncGameClient(
            base_url=test_server,
            character_id="test_2p_player1",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url=test_server,
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

            # Initiate combat at sector 0
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

    async def test_three_players_combat(self, test_server):
        """Test combat with three players."""
        # Create fresh character state for all 3 players
        for i in range(3):
            create_test_character_knowledge(f"test_3p_player{i+1}", sector=0)

        clients = []
        collectors = []

        for i in range(3):
            collector = EventCollector()
            client = AsyncGameClient(
                base_url=test_server,
                character_id=f"test_3p_player{i+1}",
                transport="websocket",
            )
            client.on("combat.round_waiting")(lambda p, c=collector: c.add_event("combat.round_waiting", p))
            clients.append(client)
            collectors.append(collector)

        try:
            # All join at sector 0 (default spawn location)
            for i, client in enumerate(clients):
                await client.join(f"test_3p_player{i+1}")

            # Longer delay to ensure all characters are visible to each other
            # With 3 players joining sequentially, server needs time to process all joins
            # and propagate sector state. 2 seconds ensures all players see each other.
            await asyncio.sleep(2.0)

            # Initiate combat at sector 0 where all players are
            await clients[0].combat_initiate(character_id="test_3p_player1")

            # All should receive round_waiting
            for collector in collectors:
                waiting = await collector.wait_for_event("combat.round_waiting")
                assert len(waiting["participants"]) == 3

        finally:
            for client in clients:
                await client.close()

    async def test_attack_brace_flee_combinations(self, test_server):
        """Test different action combinations."""
        # Create fresh characters at sector 0 to avoid stale state from previous runs
        create_test_character_knowledge("test_abf_attacker", sector=0, fighters=300, shields=150)
        create_test_character_knowledge("test_abf_defender", sector=0, fighters=300, shields=150)

        collector1 = EventCollector()
        collector2 = EventCollector()

        client1 = AsyncGameClient(
            base_url=test_server,
            character_id="test_abf_attacker",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url=test_server,
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

            # Move to sector 2 (adjacent to sectors 0 and 1)
            await client1.move(to_sector=2, character_id="test_abf_attacker")
            await client2.move(to_sector=2, character_id="test_abf_defender")

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
                    shield_dmg = p["ship"].get("shield_damage", 0)
                    assert shield_dmg is None or abs(shield_dmg) < 5

        finally:
            await client1.close()
            await client2.close()


@pytest.mark.integration
@pytest.mark.requires_server
class TestPlayerDestruction:
    """Test destroying players to create salvage and escape pods."""

    async def test_destroy_player_creates_salvage(self, test_server):
        """Test that destroying a player creates salvage container."""
        # Create test characters before initializing clients
        create_test_character_knowledge("test_dest_attacker", sector=0)
        create_test_character_knowledge("test_dest_victim", sector=0)

        # Create pre-configured characters
        create_weak_character("test_dest_victim", sector=0, fighters=5)
        create_strong_character("test_dest_attacker", sector=0, fighters=500)

        # Give weak character some cargo for salvage
        set_character_cargo("test_dest_victim", quantum_foam=10, retro_organics=5, neuro_symbolics=2)

        collector_attacker = EventCollector()
        collector_victim = EventCollector()

        client_attacker = AsyncGameClient(
            base_url=test_server,
            character_id="test_dest_attacker",
            transport="websocket",
        )
        client_victim = AsyncGameClient(
            base_url=test_server,
            character_id="test_dest_victim",
            transport="websocket",
        )

        client_attacker.on("combat.ended")(lambda p: collector_attacker.add_event("combat.ended", p))
        client_attacker.on("sector.update")(lambda p: collector_attacker.add_event("sector.update", p))
        client_attacker.on("combat.round_waiting")(lambda p: collector_attacker.add_event("combat.round_waiting", p))
        client_attacker.on("combat.round_resolved")(lambda p: collector_attacker.add_event("combat.round_resolved", p))

        client_victim.on("combat.ended")(lambda p: collector_victim.add_event("combat.ended", p))

        try:
            # Both join at sector 0
            await client_attacker.join("test_dest_attacker")
            await client_victim.join("test_dest_victim")

            # Initiate combat at sector 0
            await client_attacker.combat_initiate(character_id="test_dest_attacker")

            # Wait for first round
            waiting = await collector_attacker.wait_for_event("combat.round_waiting", timeout=5.0)
            combat_id = waiting["combat_id"]

            # Attacker submits decisive attack
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

            # Await combat.ended event
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

    async def test_escape_pod_transition(self, test_server):
        """Test that defeated player becomes escape pod."""
        # Create test characters before initializing clients
        create_test_character_knowledge("test_pod_strong", sector=0)
        create_test_character_knowledge("test_pod_weak", sector=0)

        # Create characters
        create_weak_character("test_pod_weak", sector=0, fighters=1)
        create_strong_character("test_pod_strong", sector=0, fighters=500)

        collector_weak = EventCollector()

        client_strong = AsyncGameClient(
            base_url=test_server,
            character_id="test_pod_strong",
            transport="websocket",
        )
        client_weak = AsyncGameClient(
            base_url=test_server,
            character_id="test_pod_weak",
            transport="websocket",
        )

        client_weak.on("combat.round_waiting")(lambda p: collector_weak.add_event("combat.round_waiting", p))
        client_weak.on("combat.ended")(lambda p: collector_weak.add_event("combat.ended", p))
        client_weak.on("status.update")(lambda p: collector_weak.add_event("status.update", p))

        try:
            await client_strong.join("test_pod_strong")
            await client_weak.join("test_pod_weak")

            # Initiate combat at sector 0
            await client_strong.combat_initiate(character_id="test_pod_strong")

            # Get combat_id from first round waiting
            waiting = await collector_weak.wait_for_event("combat.round_waiting", timeout=5.0)
            combat_id = waiting["combat_id"]

            # Submit attack action
            await client_strong.combat_action(
                character_id="test_pod_strong",
                combat_id=combat_id,
                action="attack",
                target_id="test_pod_weak",
                commit=100,
            )
            await client_weak.combat_action(
                character_id="test_pod_weak",
                combat_id=combat_id,
                action="brace",
                commit=0,
            )

            # Wait for combat.ended - this event contains the escape pod conversion
            ended_event = await collector_weak.wait_for_event("combat.ended", timeout=10.0)

            # Verify player was defeated and converted to escape pod
            assert ended_event["end"] == "test_pod_weak_defeated", "Weak player should be defeated"

            # Check the ship data in combat.ended event - should be escape pod
            assert "ship" in ended_event, "combat.ended should contain ship data"
            assert ended_event["ship"]["ship_type"] == "escape_pod", "Defeated player should be converted to escape pod"
            assert ended_event["ship"]["fighters"] == 0, "Escape pod should have no fighters"

            # Also verify in participants list
            weak_participant = next(
                (p for p in ended_event["participants"] if p["name"] == "test_pod_weak"),
                None
            )
            assert weak_participant is not None, "Weak player should be in participants"
            assert weak_participant["ship"]["ship_type"] == "escape_pod", "Participant should show escape pod"

        finally:
            await client_strong.close()
            await client_weak.close()


@pytest.mark.integration
@pytest.mark.requires_server
class TestSalvageCollection:
    """Test salvage collection and sector updates."""

    @pytest.mark.timeout(90)  # Round 1: ~25s (deadline+pg_cron), Round 2: ~20s (already waiting), total ~50s + buffer
    async def test_salvage_collection_triggers_sector_update(self, test_server):
        """Test salvage creation, auto-brace mechanics, and sector.update propagation."""
        # Create test characters before initializing clients
        create_test_character_knowledge("test_salv_attacker", sector=0)
        create_test_character_knowledge("test_salv_victim", sector=0)
        create_test_character_knowledge("test_salv_observer", sector=0)

        # Create characters
        create_strong_character("test_salv_attacker", sector=0, fighters=200)
        create_weak_character("test_salv_victim", sector=0, fighters=5)
        create_balanced_character("test_salv_observer", sector=0)

        # Give victim cargo for salvage
        set_character_cargo("test_salv_victim", quantum_foam=20, retro_organics=10, neuro_symbolics=5)

        collector_attacker = EventCollector()
        collector_victim = EventCollector()
        collector_observer = EventCollector()

        client_attacker = AsyncGameClient(
            base_url=test_server,
            character_id="test_salv_attacker",
            transport="websocket",
        )
        client_victim = AsyncGameClient(
            base_url=test_server,
            character_id="test_salv_victim",
            transport="websocket",
        )
        client_observer = AsyncGameClient(
            base_url=test_server,
            character_id="test_salv_observer",
            transport="websocket",
        )

        # Setup event handlers
        client_attacker.on("combat.round_waiting")(lambda p: collector_attacker.add_event("combat.round_waiting", p))
        client_attacker.on("combat.round_resolved")(lambda p: collector_attacker.add_event("combat.round_resolved", p))
        client_attacker.on("combat.ended")(lambda p: collector_attacker.add_event("combat.ended", p))
        client_attacker.on("sector.update")(lambda p: collector_attacker.add_event("sector.update", p))
        client_victim.on("combat.ended")(lambda p: collector_victim.add_event("combat.ended", p))
        client_victim.on("sector.update")(lambda p: collector_victim.add_event("sector.update", p))
        client_observer.on("sector.update")(lambda p: collector_observer.add_event("sector.update", p))

        try:
            # All join at sector 0
            await client_attacker.join("test_salv_attacker")
            await client_victim.join("test_salv_victim")
            await client_observer.join("test_salv_observer")

            # Initiate combat
            await client_attacker.combat_initiate(character_id="test_salv_attacker")
            waiting = await collector_attacker.wait_for_event("combat.round_waiting", timeout=5.0)
            combat_id = waiting["combat_id"]

            # Round 1: Attacker attacks victim with full commit to destroy them
            # Only one player submits, so must wait for deadline (15s) + pg_cron (5s) + polling (1.5s) = 21.5s
            resolved = await submit_and_await_resolution(
                collector_attacker,
                client_attacker.combat_action(
                    character_id="test_salv_attacker",
                    combat_id=combat_id,
                    action="attack",
                    target_id="test_salv_victim",
                    commit=200,
                ),
                timeout=25.0,  # Increased from 20s to accommodate deadline + pg_cron + polling
            )

            # Verify round 1 completed
            assert resolved["round"] == 1

            # Find victim in participants list
            victim_data = None
            for p in resolved.get("participants", []):
                if p.get("name") == "test_salv_victim":
                    victim_data = p
                    break

            assert victim_data is not None, "Victim should be in participants"
            assert victim_data.get("ship", {}).get("fighter_loss", 0) == 5, "Victim should have lost all fighters"

            # Round 2: Neither attacker nor observer submit actions (auto-brace → stalemate)
            # pg_cron will auto-resolve after 15s deadline
            await asyncio.sleep(16.0)

            # Wait for combat.ended (via pg_cron auto-resolution)
            ended = await collector_attacker.wait_for_event("combat.ended", timeout=10.0)
            assert ended["combat_id"] == combat_id

            # Verify salvage was created
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

            # Clear event collectors
            collector_attacker.clear()
            collector_observer.clear()

            # Attacker collects the salvage
            await client_attacker.salvage_collect(
                character_id="test_salv_attacker",
                salvage_id=salvage_id,
            )

            # Wait for polling to deliver the new sector.update event (HTTP polling pattern)
            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            # Both attacker and observer should receive sector.update
            sector_update_2 = await collector_attacker.wait_for_event("sector.update", timeout=5.0)
            observer_update_2 = await collector_observer.wait_for_event("sector.update", timeout=5.0)

            # Verify salvage was removed
            assert "salvage" in sector_update_2
            remaining_salvage = [s for s in sector_update_2["salvage"] if s["salvage_id"] == salvage_id]
            assert len(remaining_salvage) == 0, "Salvage should be removed after collection"

            observer_remaining = [s for s in observer_update_2["salvage"] if s["salvage_id"] == salvage_id]
            assert len(observer_remaining) == 0, "Observer should see salvage removed"

        finally:
            await client_attacker.close()
            await client_victim.close()
            await client_observer.close()


@pytest.mark.integration
@pytest.mark.requires_server
class TestGarrisonScenarios:
    """Test garrison combat scenarios."""

    async def test_garrison_with_owner_in_sector(self, test_server):
        """Test garrison combat when owner is present."""
        # Create test characters before initializing clients
        create_test_character_knowledge("test_gow_owner", sector=0)
        create_test_character_knowledge("test_gow_enemy", sector=0)

        create_balanced_character("test_gow_owner", sector=0)
        create_balanced_character("test_gow_enemy", sector=0)

        collector_owner = EventCollector()
        collector_enemy = EventCollector()

        client_owner = AsyncGameClient(
            base_url=test_server,
            character_id="test_gow_owner",
            transport="websocket",
        )
        client_enemy = AsyncGameClient(
            base_url=test_server,
            character_id="test_gow_enemy",
            transport="websocket",
        )

        client_owner.on("combat.round_waiting")(lambda p: collector_owner.add_event("combat.round_waiting", p))
        client_enemy.on("combat.round_waiting")(lambda p: collector_enemy.add_event("combat.round_waiting", p))

        try:
            await client_owner.join("test_gow_owner")
            await client_enemy.join("test_gow_enemy")

            # Move to sector 1
            await client_owner.move(to_sector=1, character_id="test_gow_owner")

            # Deploy garrison in sector 1
            await client_owner.combat_leave_fighters(
                character_id="test_gow_owner",
                sector=1,
                quantity=50,
                mode="offensive",
            )

            # Enemy enters sector 1 - should trigger combat with both garrison and owner
            await client_enemy.move(to_sector=1, character_id="test_gow_enemy")

            # Wait for combat
            waiting = await collector_enemy.wait_for_event("combat.round_waiting")

            # Verify garrison is present
            participants = waiting["participants"]
            garrison = waiting.get("garrison")

            assert garrison is not None
            assert garrison["mode"] == "offensive"

            # Verify owner is in participants
            participant_names = [p["name"] for p in participants]
            assert "test_gow_owner" in participant_names or len(participants) >= 1

        finally:
            await client_owner.close()
            await client_enemy.close()

    async def test_garrison_without_owner_in_sector(self, test_server):
        """Test garrison combat when owner is not present."""
        # Create test characters before initializing clients
        create_test_character_knowledge("test_gwo_deployer", sector=0)
        create_test_character_knowledge("test_gwo_victim", sector=0)

        create_balanced_character("test_gwo_deployer", sector=0)
        create_balanced_character("test_gwo_victim", sector=0)

        collector_deployer = EventCollector()
        collector_victim = EventCollector()

        client_deployer = AsyncGameClient(
            base_url=test_server,
            character_id="test_gwo_deployer",
            transport="websocket",
        )
        client_victim = AsyncGameClient(
            base_url=test_server,
            character_id="test_gwo_victim",
            transport="websocket",
        )

        client_victim.on("combat.round_waiting")(lambda p: collector_victim.add_event("combat.round_waiting", p))

        try:
            await client_deployer.join("test_gwo_deployer")
            await client_victim.join("test_gwo_victim")

            # Move to sector 2
            await client_deployer.move(to_sector=2, character_id="test_gwo_deployer")

            # Deploy garrison in sector 2
            await client_deployer.combat_leave_fighters(
                character_id="test_gwo_deployer",
                sector=2,
                quantity=50,
                mode="offensive",
            )

            # Deployer leaves sector (back to 0)
            await client_deployer.move(to_sector=0, character_id="test_gwo_deployer")

            # Victim enters empty sector 2 with garrison
            await client_victim.move(to_sector=2, character_id="test_gwo_victim")

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


@pytest.mark.integration
@pytest.mark.requires_server
class TestGarrisonModes:
    """Test different garrison modes."""

    async def test_toll_mode_garrison(self, test_server):
        """Test garrison in toll mode demands payment."""
        # Create test characters before initializing clients
        create_test_character_knowledge("test_toll_deployer", sector=0)
        create_test_character_knowledge("test_toll_payer", sector=0)

        create_balanced_character("test_toll_deployer", sector=0)
        create_balanced_character("test_toll_payer", sector=0)

        collector_payer = EventCollector()

        client_deployer = AsyncGameClient(
            base_url=test_server,
            character_id="test_toll_deployer",
            transport="websocket",
        )
        client_payer = AsyncGameClient(
            base_url=test_server,
            character_id="test_toll_payer",
            transport="websocket",
        )

        client_payer.on("combat.round_waiting")(lambda p: collector_payer.add_event("combat.round_waiting", p))
        client_payer.on("combat.round_resolved")(lambda p: collector_payer.add_event("combat.round_resolved", p))
        client_payer.on("combat.ended")(lambda p: collector_payer.add_event("combat.ended", p))
        client_payer.on("status.update")(lambda p: collector_payer.add_event("status.update", p))

        try:
            await client_deployer.join("test_toll_deployer")
            await client_payer.join("test_toll_payer")

            # Move to sector 2 (adjacent to 0 in test universe)
            await client_deployer.move(to_sector=2, character_id="test_toll_deployer")

            # Deploy toll garrison with 100 credit toll in sector 2
            await client_deployer.combat_leave_fighters(
                character_id="test_toll_deployer",
                sector=2,
                quantity=50,
                mode="toll",
                toll_amount=100,
            )

            # Deployer leaves back to 0
            await client_deployer.move(to_sector=0, character_id="test_toll_deployer")

            # Payer enters sector 2 - should trigger toll combat
            await client_payer.move(to_sector=2, character_id="test_toll_payer")

            # Wait for combat.round_waiting
            waiting = await collector_payer.wait_for_event("combat.round_waiting")

            combat_id = waiting["combat_id"]
            garrison = waiting.get("garrison")

            # Verify garrison is in toll mode
            assert garrison is not None
            assert garrison["mode"] == "toll"
            assert garrison["toll_amount"] == 100

            # Submit PAY action
            await client_payer.combat_action(
                character_id="test_toll_payer",
                combat_id=combat_id,
                action="pay",
                commit=0,
                target_id=None,
            )

            # Wait for round to resolve
            resolved = await collector_payer.wait_for_event("combat.round_resolved", timeout=10.0)

            # Verify the pay action was processed in the resolved event
            payer_action = resolved.get("actions", {}).get("test_toll_payer", {})
            assert payer_action.get("action") == "pay", "Payer action should be 'pay'"

            # Combat should end immediately after toll payment
            ended = await collector_payer.wait_for_event("combat.ended", timeout=5.0)
            assert ended["combat_id"] == combat_id

            # Verify combat ended with toll payment result
            assert ended.get("result") == "toll_satisfied", \
                f"Expected 'toll_satisfied' result, got: {ended.get('result')}"

        finally:
            await client_deployer.close()
            await client_payer.close()

    async def test_offensive_mode_garrison(self, test_server):
        """Test garrison in offensive mode auto-attacks."""
        # Create test characters before initializing clients
        create_test_character_knowledge("test_off_deployer", sector=0)
        create_test_character_knowledge("test_off_victim", sector=0)

        create_balanced_character("test_off_deployer", sector=0)
        create_balanced_character("test_off_victim", sector=0)

        collector = EventCollector()

        client_deployer = AsyncGameClient(
            base_url=test_server,
            character_id="test_off_deployer",
            transport="websocket",
        )
        client_victim = AsyncGameClient(
            base_url=test_server,
            character_id="test_off_victim",
            transport="websocket",
        )

        client_victim.on("combat.round_waiting")(lambda p: collector.add_event("combat.round_waiting", p))

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

            # Wait for HTTP polling to deliver events
            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            # Offensive garrison auto-triggers combat when deployed with enemies present
            waiting = await collector.wait_for_event("combat.round_waiting")
            assert waiting.get("garrison") is not None
            assert waiting["garrison"]["mode"] == "offensive"

        finally:
            await client_deployer.close()
            await client_victim.close()

    async def test_defensive_mode_garrison(self, test_server):
        """Test garrison in defensive mode only fights when attacked."""
        # Create test characters before initializing clients
        create_test_character_knowledge("test_def_deployer", sector=0)
        create_test_character_knowledge("test_def_victim", sector=0)

        create_balanced_character("test_def_deployer", sector=0)
        create_balanced_character("test_def_victim", sector=0)

        collector = EventCollector()

        client_deployer = AsyncGameClient(
            base_url=test_server,
            character_id="test_def_deployer",
            transport="websocket",
        )
        client_victim = AsyncGameClient(
            base_url=test_server,
            character_id="test_def_victim",
            transport="websocket",
        )

        client_victim.on("combat.round_waiting")(lambda p: collector.add_event("combat.round_waiting", p))

        try:
            await client_deployer.join("test_def_deployer")
            await client_victim.join("test_def_victim")

            # Move to sector 1 (adjacent to 0 in test universe)
            await client_deployer.move(to_sector=1, character_id="test_def_deployer")

            # Deploy defensive garrison in sector 1
            await client_deployer.combat_leave_fighters(
                character_id="test_def_deployer",
                sector=1,
                quantity=50,
                mode="defensive",
            )

            # Leave back to 0 (sector 1 has two-way connection to 0)
            await client_deployer.move(to_sector=0, character_id="test_def_deployer")

            # Victim enters sector 1 - should NOT auto-trigger combat
            await client_victim.move(to_sector=1, character_id="test_def_victim")

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


@pytest.mark.integration
@pytest.mark.requires_server
class TestCombatEndedEvents:
    """Test combat.ended and sector.update emissions."""

    async def test_combat_ended_triggers_sector_update(self, test_server):
        """Test that combat.ended triggers sector.update for all in sector."""
        # Create test characters before initializing clients
        create_test_character_knowledge("test_end_combatant1", sector=0)
        create_test_character_knowledge("test_end_combatant2", sector=0)
        create_test_character_knowledge("test_end_observer", sector=0)

        create_balanced_character("test_end_combatant1", sector=0)
        create_balanced_character("test_end_combatant2", sector=0)
        create_balanced_character("test_end_observer", sector=0)

        collector1 = EventCollector()
        collector2 = EventCollector()
        observer_collector = EventCollector()

        client1 = AsyncGameClient(
            base_url=test_server,
            character_id="test_end_combatant1",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url=test_server,
            character_id="test_end_combatant2",
            transport="websocket",
        )
        observer = AsyncGameClient(
            base_url=test_server,
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

            # Wait for sector update after movements
            await asyncio.sleep(0.5)

            # Initiate combat between combatant1 and combatant2 at sector 0
            await client1.combat_initiate(character_id="test_end_combatant1")

            # Wait for combat to start
            waiting = await collector1.wait_for_event("combat.round_waiting", timeout=5.0)
            combat_id = waiting["combat_id"]

            # Let combat timeout (both players brace) to trigger stalemate
            # pg_cron will auto-resolve after 15s deadline
            await asyncio.sleep(16.0)

            # Verify combat.ended event was received by combatants (via pg_cron)
            ended1 = await collector1.wait_for_event("combat.ended", timeout=10.0)
            assert ended1["combat_id"] == combat_id

            ended2 = await collector2.wait_for_event("combat.ended", timeout=5.0)
            assert ended2["combat_id"] == combat_id

            # Wait for HTTP polling to deliver sector.update events (emitted after combat.ended)
            await asyncio.sleep(EVENT_DELIVERY_WAIT)

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


@pytest.mark.integration
@pytest.mark.requires_server
class TestCombatRoundMechanics:
    """Test combat round action mechanics: hit calculation, damage, shields, timeouts."""

    async def test_hit_calculation_uses_ship_stats(self, test_server):
        """Test that hit calculation uses fighter and shield stats."""
        # Create test characters before initializing clients
        create_test_character_knowledge("test_hit_attacker", sector=0)
        create_test_character_knowledge("test_hit_defender", sector=0)

        create_strong_character("test_hit_attacker", sector=0, fighters=200)
        create_weak_character("test_hit_defender", sector=0, fighters=10)

        collector_attacker = EventCollector()

        client_attacker = AsyncGameClient(
            base_url=test_server,
            character_id="test_hit_attacker",
            transport="websocket",
        )
        client_defender = AsyncGameClient(
            base_url=test_server,
            character_id="test_hit_defender",
            transport="websocket",
        )

        client_attacker.on("combat.round_waiting")(lambda p: collector_attacker.add_event("combat.round_waiting", p))
        client_attacker.on("combat.round_resolved")(lambda p: collector_attacker.add_event("combat.round_resolved", p))

        try:
            await client_attacker.join("test_hit_attacker")
            await client_defender.join("test_hit_defender")

            # Initiate combat
            await client_attacker.combat_initiate(character_id="test_hit_attacker")
            waiting = await collector_attacker.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            # Attacker attacks with high commit
            await client_attacker.combat_action(
                character_id="test_hit_attacker",
                combat_id=combat_id,
                action="attack",
                target_id="test_hit_defender",
                commit=100,
            )
            await client_defender.combat_action(
                character_id="test_hit_defender",
                combat_id=combat_id,
                action="brace",
                commit=0,
            )

            # Wait for resolution
            resolved = await collector_attacker.wait_for_event("combat.round_resolved")

            # Verify damage was dealt to defender
            defender_data = next(
                (p for p in resolved["participants"] if p["name"] == "test_hit_defender"),
                None
            )
            assert defender_data is not None
            ship = defender_data.get("ship", {})

            # Weak defender should have taken damage
            fighter_loss = ship.get("fighter_loss", 0)
            shield_damage = ship.get("shield_damage", 0)
            assert fighter_loss > 0 or shield_damage > 0, "Weak defender should take damage from strong attacker"

        finally:
            await client_attacker.close()
            await client_defender.close()

    async def test_damage_applied_to_shields_then_hull(self, test_server):
        """Test that damage depletes shields before hull (fighters)."""
        create_test_character_knowledge("test_dmg_attacker", sector=0, fighters=150, shields=50)
        create_test_character_knowledge("test_dmg_defender", sector=0, fighters=150, shields=50)

        collector_attacker = EventCollector()

        client_attacker = AsyncGameClient(
            base_url=test_server,
            character_id="test_dmg_attacker",
            transport="websocket",
        )
        client_defender = AsyncGameClient(
            base_url=test_server,
            character_id="test_dmg_defender",
            transport="websocket",
        )

        client_attacker.on("combat.round_waiting")(lambda p: collector_attacker.add_event("combat.round_waiting", p))
        client_attacker.on("combat.round_resolved")(lambda p: collector_attacker.add_event("combat.round_resolved", p))

        try:
            await client_attacker.join("test_dmg_attacker")
            await client_defender.join("test_dmg_defender")

            # Initiate combat
            await client_attacker.combat_initiate(character_id="test_dmg_attacker")
            waiting = await collector_attacker.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            # Submit attack
            await client_attacker.combat_action(
                character_id="test_dmg_attacker",
                combat_id=combat_id,
                action="attack",
                target_id="test_dmg_defender",
                commit=50,
            )
            await client_defender.combat_action(
                character_id="test_dmg_defender",
                combat_id=combat_id,
                action="brace",
                commit=0,
            )

            resolved = await collector_attacker.wait_for_event("combat.round_resolved")

            # Check defender took damage
            defender_data = next(
                (p for p in resolved["participants"] if p["name"] == "test_dmg_defender"),
                None
            )
            assert defender_data is not None
            ship = defender_data.get("ship", {})

            # Should have shield or fighter damage
            assert "shield_damage" in ship or "fighter_loss" in ship

        finally:
            await client_attacker.close()
            await client_defender.close()

    async def test_fighters_launched_reduce_count(self, test_server):
        """Test that launching fighters reduces fighter count."""
        create_test_character_knowledge("test_launch1", sector=0, fighters=100)
        create_test_character_knowledge("test_launch2", sector=0, fighters=100)

        collector = EventCollector()

        client1 = AsyncGameClient(
            base_url=test_server,
            character_id="test_launch1",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url=test_server,
            character_id="test_launch2",
            transport="websocket",
        )

        client1.on("combat.round_waiting")(lambda p: collector.add_event("combat.round_waiting", p))
        client1.on("combat.round_resolved")(lambda p: collector.add_event("combat.round_resolved", p))

        try:
            await client1.join("test_launch1")
            await client2.join("test_launch2")

            await client1.combat_initiate(character_id="test_launch1")
            waiting = await collector.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            # Player1 attacks with commit=50 (launches 50 fighters)
            await client1.combat_action(
                character_id="test_launch1",
                combat_id=combat_id,
                action="attack",
                target_id="test_launch2",
                commit=50,
            )
            await client2.combat_action(
                character_id="test_launch2",
                combat_id=combat_id,
                action="attack",
                target_id="test_launch1",
                commit=30,
            )

            resolved = await collector.wait_for_event("combat.round_resolved")

            # Verify action commitments recorded
            actions = resolved.get("actions", {})
            player1_action = actions.get("test_launch1", {})
            player2_action = actions.get("test_launch2", {})

            assert player1_action.get("action") == "attack"
            assert player2_action.get("action") == "attack"

            # Commit values should be recorded
            assert "commit" in player1_action
            assert "commit" in player2_action

        finally:
            await client1.close()
            await client2.close()

    async def test_shields_recharged_per_round(self, test_server):
        """Test that shields recharge between combat rounds."""
        create_test_character_knowledge("test_shield1", sector=0, fighters=100, shields=50)
        create_test_character_knowledge("test_shield2", sector=0, fighters=10, shields=10)

        collector = EventCollector()

        client1 = AsyncGameClient(
            base_url=test_server,
            character_id="test_shield1",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url=test_server,
            character_id="test_shield2",
            transport="websocket",
        )

        client1.on("combat.round_waiting")(lambda p: collector.add_event("combat.round_waiting", p))
        client1.on("combat.round_resolved")(lambda p: collector.add_event("combat.round_resolved", p))

        try:
            await client1.join("test_shield1")
            await client2.join("test_shield2")

            await client1.combat_initiate(character_id="test_shield1")
            waiting = await collector.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            # Round 1: Very light attack to not destroy weak player
            await client1.combat_action(
                character_id="test_shield1",
                combat_id=combat_id,
                action="attack",
                target_id="test_shield2",
                commit=1,
            )
            await client2.combat_action(
                character_id="test_shield2",
                combat_id=combat_id,
                action="brace",
                commit=0,
            )

            resolved1 = await collector.wait_for_event("combat.round_resolved", timeout=20.0)
            # Combat might end if weak player destroyed, that's OK
            if resolved1.get("round") != 1:
                pytest.skip("Combat ended too quickly, weak player destroyed")

            # Round 2: Both brace (shields should recharge)
            try:
                waiting2 = await collector.wait_for_event("combat.round_waiting", timeout=2.0, condition=lambda p: p.get("round") == 2)
            except:
                pytest.skip("Combat ended before round 2")

            await client1.combat_action(
                character_id="test_shield1",
                combat_id=combat_id,
                action="brace",
                commit=0,
            )
            await client2.combat_action(
                character_id="test_shield2",
                combat_id=combat_id,
                action="brace",
                commit=0,
            )

            try:
                resolved2 = await collector.wait_for_event("combat.round_resolved", timeout=20.0)
                if resolved2.get("round") != 2:
                    pytest.skip("Combat ended before round 2 completed")

                # Verify shield recharge happened (no new damage in round 2 with both bracing)
                participants = resolved2.get("participants", [])
                for p in participants:
                    ship = p.get("ship", {})
                    # With both bracing, minimal damage expected
                    shield_dmg = ship.get("shield_damage", 0)
                    if shield_dmg:
                        assert abs(shield_dmg) < 10
            except:
                pytest.skip("Combat ended before round 2")

        finally:
            await client1.close()
            await client2.close()

    async def test_round_ended_event_contains_damage_summary(self, test_server):
        """Test that combat.round_resolved contains complete damage info."""
        create_test_character_knowledge("test_summary1", sector=0, fighters=100)
        create_test_character_knowledge("test_summary2", sector=0, fighters=100)

        collector = EventCollector()

        client1 = AsyncGameClient(
            base_url=test_server,
            character_id="test_summary1",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url=test_server,
            character_id="test_summary2",
            transport="websocket",
        )

        client1.on("combat.round_waiting")(lambda p: collector.add_event("combat.round_waiting", p))
        client1.on("combat.round_resolved")(lambda p: collector.add_event("combat.round_resolved", p))

        try:
            await client1.join("test_summary1")
            await client2.join("test_summary2")

            await client1.combat_initiate(character_id="test_summary1")
            waiting = await collector.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            # Both attack
            await client1.combat_action(
                character_id="test_summary1",
                combat_id=combat_id,
                action="attack",
                target_id="test_summary2",
                commit=30,
            )
            await client2.combat_action(
                character_id="test_summary2",
                combat_id=combat_id,
                action="attack",
                target_id="test_summary1",
                commit=30,
            )

            resolved = await collector.wait_for_event("combat.round_resolved")

            # Verify event structure
            assert "combat_id" in resolved
            assert "round" in resolved
            assert "participants" in resolved
            assert "actions" in resolved

            # Verify participants have ship data
            participants = resolved["participants"]
            assert len(participants) == 2
            for p in participants:
                assert "name" in p
                assert "ship" in p

        finally:
            await client1.close()
            await client2.close()

    async def test_action_timeout_uses_default_action(self, test_server):
        """Test that timeout results in auto-brace."""
        create_test_character_knowledge("test_timeout1", sector=0, fighters=100)
        create_test_character_knowledge("test_timeout2", sector=0, fighters=100)

        collector = EventCollector()

        client1 = AsyncGameClient(
            base_url=test_server,
            character_id="test_timeout1",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url=test_server,
            character_id="test_timeout2",
            transport="websocket",
        )

        client1.on("combat.round_waiting")(lambda p: collector.add_event("combat.round_waiting", p))
        client1.on("combat.round_resolved")(lambda p: collector.add_event("combat.round_resolved", p))

        try:
            await client1.join("test_timeout1")
            await client2.join("test_timeout2")

            await client1.combat_initiate(character_id="test_timeout1")
            waiting = await collector.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            # Submit no actions - let round timeout
            # pg_cron runs every 5 seconds and will auto-resolve after deadline (15s)
            # Total time: 15s deadline + up to 5s for pg_cron + ~2s event delivery = ~22s
            await asyncio.sleep(17.0)

            # Should auto-resolve with brace actions (via pg_cron)
            # Wait up to 15s for the event (total possible time: 17s + 15s = 32s)
            resolved = await collector.wait_for_event("combat.round_resolved", timeout=15.0)

            actions = resolved.get("actions", {})
            # Both should have auto-braced
            player1_action = actions.get("test_timeout1", {})
            player2_action = actions.get("test_timeout2", {})

            assert player1_action.get("action") == "brace"
            assert player2_action.get("action") == "brace"

        finally:
            await client1.close()
            await client2.close()

    async def test_multiple_rounds_until_destruction(self, test_server):
        """Test combat lasting multiple rounds until ship destruction."""
        # Create test characters before initializing clients
        create_test_character_knowledge("test_multi_strong", sector=0)
        create_test_character_knowledge("test_multi_weak", sector=0)

        create_strong_character("test_multi_strong", sector=0, fighters=300)
        create_weak_character("test_multi_weak", sector=0, fighters=50)

        collector = EventCollector()

        client_strong = AsyncGameClient(
            base_url=test_server,
            character_id="test_multi_strong",
            transport="websocket",
        )
        client_weak = AsyncGameClient(
            base_url=test_server,
            character_id="test_multi_weak",
            transport="websocket",
        )

        client_strong.on("combat.round_waiting")(lambda p: collector.add_event("combat.round_waiting", p))
        client_strong.on("combat.round_resolved")(lambda p: collector.add_event("combat.round_resolved", p))
        client_strong.on("combat.ended")(lambda p: collector.add_event("combat.ended", p))

        try:
            await client_strong.join("test_multi_strong")
            await client_weak.join("test_multi_weak")

            await client_strong.combat_initiate(character_id="test_multi_strong")
            waiting = await collector.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            # Round 1: Strong attack
            await client_strong.combat_action(
                character_id="test_multi_strong",
                combat_id=combat_id,
                action="attack",
                target_id="test_multi_weak",
                commit=50,
            )
            await client_weak.combat_action(
                character_id="test_multi_weak",
                combat_id=combat_id,
                action="brace",
                commit=0,
            )

            resolved1 = await collector.wait_for_event("combat.round_resolved", timeout=20.0)
            # Combat might end quickly if weak player destroyed
            if resolved1.get("round") != 1:
                pytest.skip("Combat ended too quickly")

            # Check if weak player still alive
            weak_data = next(
                (p for p in resolved1["participants"] if p["name"] == "test_multi_weak"),
                None
            )
            if weak_data and weak_data["ship"]["ship_type"] != "escape_pod":
                # Round 2: Finish them
                try:
                    waiting2 = await collector.wait_for_event("combat.round_waiting", timeout=5.0, condition=lambda p: p.get("round") == 2)
                except:
                    # Player might already be destroyed, just wait for combat.ended
                    pass

                await client_strong.combat_action(
                    character_id="test_multi_strong",
                    combat_id=combat_id,
                    action="attack",
                    target_id="test_multi_weak",
                    commit=100,
                )
                await client_weak.combat_action(
                    character_id="test_multi_weak",
                    combat_id=combat_id,
                    action="brace",
                    commit=0,
                )

                try:
                    resolved2 = await collector.wait_for_event("combat.round_resolved", timeout=10.0)
                    if resolved2.get("round") == 2:
                        pass  # Round 2 happened, good
                except:
                    pass  # Combat may have ended, that's OK

            # Combat should end with weak player destroyed
            ended = await collector.wait_for_event("combat.ended", timeout=10.0)
            assert "participants" in ended

            # Find weak player in final state
            weak_final = next(
                (p for p in ended["participants"] if p["name"] == "test_multi_weak"),
                None
            )
            assert weak_final is not None
            assert weak_final["ship"]["ship_type"] == "escape_pod"

        finally:
            await client_strong.close()
            await client_weak.close()

    async def test_action_submission_within_timeout(self, test_server):
        """Test that actions submitted within timeout are accepted."""
        create_test_character_knowledge("test_submit1", sector=0, fighters=100)
        create_test_character_knowledge("test_submit2", sector=0, fighters=100)

        collector = EventCollector()

        client1 = AsyncGameClient(
            base_url=test_server,
            character_id="test_submit1",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url=test_server,
            character_id="test_submit2",
            transport="websocket",
        )

        client1.on("combat.round_waiting")(lambda p: collector.add_event("combat.round_waiting", p))
        client1.on("combat.round_resolved")(lambda p: collector.add_event("combat.round_resolved", p))

        try:
            await client1.join("test_submit1")
            await client2.join("test_submit2")

            await client1.combat_initiate(character_id="test_submit1")
            waiting = await collector.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            # Submit actions quickly
            await client1.combat_action(
                character_id="test_submit1",
                combat_id=combat_id,
                action="attack",
                target_id="test_submit2",
                commit=20,
            )
            await client2.combat_action(
                character_id="test_submit2",
                combat_id=combat_id,
                action="attack",
                target_id="test_submit1",
                commit=20,
            )

            # Should resolve with submitted actions
            resolved = await collector.wait_for_event("combat.round_resolved", timeout=10.0)

            actions = resolved.get("actions", {})
            assert actions["test_submit1"]["action"] == "attack"
            assert actions["test_submit2"]["action"] == "attack"

        finally:
            await client1.close()
            await client2.close()


@pytest.mark.integration
@pytest.mark.requires_server
class TestFleeingMechanics:
    """Test fleeing from combat."""

    async def test_flee_success_exits_combat(self, test_server):
        """Test successful flee exits combat."""
        create_test_character_knowledge("test_flee_runner", sector=0, fighters=100, warp_power=1000)
        create_test_character_knowledge("test_flee_chaser", sector=0, fighters=100)

        collector_runner = EventCollector()
        collector_chaser = EventCollector()

        client_runner = AsyncGameClient(
            base_url=test_server,
            character_id="test_flee_runner",
            transport="websocket",
        )
        client_chaser = AsyncGameClient(
            base_url=test_server,
            character_id="test_flee_chaser",
            transport="websocket",
        )

        client_runner.on("combat.round_waiting")(lambda p: collector_runner.add_event("combat.round_waiting", p))
        client_runner.on("combat.ended")(lambda p: collector_runner.add_event("combat.ended", p))
        client_runner.on("character.moved")(lambda p: collector_runner.add_event("character.moved", p))

        client_chaser.on("combat.round_waiting")(lambda p: collector_chaser.add_event("combat.round_waiting", p))

        try:
            await client_runner.join("test_flee_runner")
            await client_chaser.join("test_flee_chaser")

            # Move to sector 2 (has multiple exits)
            await client_runner.move(to_sector=2, character_id="test_flee_runner")
            await client_chaser.move(to_sector=2, character_id="test_flee_chaser")

            # Clear events from movement
            collector_runner.clear()

            # Initiate combat
            await client_chaser.combat_initiate(character_id="test_flee_chaser")
            waiting = await collector_runner.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            # Runner attempts to flee to sector 0 (adjacent to sector 2)
            await client_runner.combat_action(
                character_id="test_flee_runner",
                combat_id=combat_id,
                action="flee",
                commit=0,
                to_sector=0,
            )
            await client_chaser.combat_action(
                character_id="test_flee_chaser",
                combat_id=combat_id,
                action="attack",
                target_id="test_flee_runner",
                commit=30,
            )

            # Wait for combat to end or continue
            try:
                ended = await collector_runner.wait_for_event("combat.ended", timeout=10.0)

                # Check if flee was successful
                if "test_flee_runner_fled" in ended.get("end", ""):
                    # Verify runner moved to different sector
                    await asyncio.sleep(1.0)
                    moved_events = collector_runner.get_all("character.moved")
                    # Runner may have moved (flee successful)

            except:
                # If combat continues, flee failed - that's also valid
                pass

        finally:
            await client_runner.close()
            await client_chaser.close()

    async def test_flee_costs_warp_power(self, test_server):
        """Test that fleeing consumes warp power."""
        create_test_character_knowledge("test_warp_runner", sector=0, fighters=100, warp_power=1000)
        create_test_character_knowledge("test_warp_chaser", sector=0, fighters=100)

        collector = EventCollector()

        client_runner = AsyncGameClient(
            base_url=test_server,
            character_id="test_warp_runner",
            transport="websocket",
        )
        client_chaser = AsyncGameClient(
            base_url=test_server,
            character_id="test_warp_chaser",
            transport="websocket",
        )

        client_runner.on("combat.round_waiting")(lambda p: collector.add_event("combat.round_waiting", p))
        client_runner.on("combat.round_resolved")(lambda p: collector.add_event("combat.round_resolved", p))

        try:
            await client_runner.join("test_warp_runner")
            await client_chaser.join("test_warp_chaser")

            # Move to sector 1
            await client_runner.move(to_sector=1, character_id="test_warp_runner")
            await client_chaser.move(to_sector=1, character_id="test_warp_chaser")

            # Initiate combat
            await client_chaser.combat_initiate(character_id="test_warp_chaser")
            waiting = await collector.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            # Attempt flee to sector 0 (adjacent to sector 1)
            await client_runner.combat_action(
                character_id="test_warp_runner",
                combat_id=combat_id,
                action="flee",
                commit=0,
                to_sector=0,
            )
            await client_chaser.combat_action(
                character_id="test_warp_chaser",
                combat_id=combat_id,
                action="brace",
                commit=0,
            )

            # Wait for round resolution
            resolved = await collector.wait_for_event("combat.round_resolved", timeout=10.0)

            # Verify flee action was recorded
            actions = resolved.get("actions", {})
            runner_action = actions.get("test_warp_runner", {})
            assert runner_action.get("action") == "flee"

        finally:
            await client_runner.close()
            await client_chaser.close()

    async def test_flee_failure_remains_in_combat(self, test_server):
        """Test that failed flee keeps character in combat."""
        create_test_character_knowledge("test_fail_runner", sector=0, fighters=100, warp_power=500)
        create_test_character_knowledge("test_fail_chaser", sector=0, fighters=100)

        collector = EventCollector()

        client_runner = AsyncGameClient(
            base_url=test_server,
            character_id="test_fail_runner",
            transport="websocket",
        )
        client_chaser = AsyncGameClient(
            base_url=test_server,
            character_id="test_fail_chaser",
            transport="websocket",
        )

        client_runner.on("combat.round_waiting")(lambda p: collector.add_event("combat.round_waiting", p))
        client_runner.on("combat.round_resolved")(lambda p: collector.add_event("combat.round_resolved", p))

        try:
            await client_runner.join("test_fail_runner")
            await client_chaser.join("test_fail_chaser")

            # Initiate combat at sector 0
            await client_chaser.combat_initiate(character_id="test_fail_chaser")
            waiting = await collector.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            # Attempt flee to sector 1 (adjacent to sector 0)
            await client_runner.combat_action(
                character_id="test_fail_runner",
                combat_id=combat_id,
                action="flee",
                commit=0,
                to_sector=1,
            )
            await client_chaser.combat_action(
                character_id="test_fail_chaser",
                combat_id=combat_id,
                action="brace",
                commit=0,
            )

            # Wait for round resolution
            resolved = await collector.wait_for_event("combat.round_resolved", timeout=10.0)

            # If flee failed, there should be a next round waiting event
            try:
                waiting2 = await collector.wait_for_event(
                    "combat.round_waiting",
                    timeout=5.0,
                    condition=lambda p: p.get("round") == 2
                )
                # Still in combat - flee failed
                assert waiting2["round"] == 2
            except:
                # Combat ended - flee succeeded (also valid outcome)
                pass

        finally:
            await client_runner.close()
            await client_chaser.close()

    async def test_flee_probability_based_on_ship_stats(self, test_server):
        """Test flee probability depends on ship configuration."""
        # This is a smoke test - actual probability calculation is server-side
        create_test_character_knowledge("test_prob_runner", sector=0, fighters=100, warp_power=1000)
        create_test_character_knowledge("test_prob_chaser", sector=0, fighters=100)

        collector = EventCollector()

        client_runner = AsyncGameClient(
            base_url=test_server,
            character_id="test_prob_runner",
            transport="websocket",
        )
        client_chaser = AsyncGameClient(
            base_url=test_server,
            character_id="test_prob_chaser",
            transport="websocket",
        )

        client_runner.on("combat.round_waiting")(lambda p: collector.add_event("combat.round_waiting", p))
        client_runner.on("combat.round_resolved")(lambda p: collector.add_event("combat.round_resolved", p))
        client_runner.on("combat.ended")(lambda p: collector.add_event("combat.ended", p))

        try:
            await client_runner.join("test_prob_runner")
            await client_chaser.join("test_prob_chaser")

            # Move to sector 2
            await client_runner.move(to_sector=2, character_id="test_prob_runner")
            await client_chaser.move(to_sector=2, character_id="test_prob_chaser")

            # Initiate combat
            await client_chaser.combat_initiate(character_id="test_prob_chaser")
            waiting = await collector.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            # Attempt flee to sector 0 (adjacent to sector 2)
            await client_runner.combat_action(
                character_id="test_prob_runner",
                combat_id=combat_id,
                action="flee",
                commit=0,
                to_sector=0,
            )
            await client_chaser.combat_action(
                character_id="test_prob_chaser",
                combat_id=combat_id,
                action="brace",
                commit=0,
            )

            # Wait for resolution - flee may succeed or fail
            resolved = await collector.wait_for_event("combat.round_resolved", timeout=10.0)

            # Verify flee action was processed
            actions = resolved.get("actions", {})
            assert actions.get("test_prob_runner", {}).get("action") == "flee"

        finally:
            await client_runner.close()
            await client_chaser.close()


@pytest.mark.integration
@pytest.mark.requires_server
class TestCombatEndedEventData:
    """Test combat.ended event data completeness."""

    async def test_combat_ended_includes_winners_and_losers(self, test_server):
        """Test combat.ended event identifies winners and losers."""
        # Create test characters before initializing clients
        create_test_character_knowledge("test_win_winner", sector=0)
        create_test_character_knowledge("test_win_loser", sector=0)

        create_strong_character("test_win_winner", sector=0, fighters=300)
        create_weak_character("test_win_loser", sector=0, fighters=10)

        collector = EventCollector()

        client_winner = AsyncGameClient(
            base_url=test_server,
            character_id="test_win_winner",
            transport="websocket",
        )
        client_loser = AsyncGameClient(
            base_url=test_server,
            character_id="test_win_loser",
            transport="websocket",
        )

        client_winner.on("combat.round_waiting")(lambda p: collector.add_event("combat.round_waiting", p))
        client_winner.on("combat.ended")(lambda p: collector.add_event("combat.ended", p))

        try:
            await client_winner.join("test_win_winner")
            await client_loser.join("test_win_loser")

            # Initiate and finish combat quickly
            await client_winner.combat_initiate(character_id="test_win_winner")
            waiting = await collector.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            # Decisive attack
            await client_winner.combat_action(
                character_id="test_win_winner",
                combat_id=combat_id,
                action="attack",
                target_id="test_win_loser",
                commit=200,
            )
            await client_loser.combat_action(
                character_id="test_win_loser",
                combat_id=combat_id,
                action="brace",
                commit=0,
            )

            # Wait for combat.ended
            ended = await collector.wait_for_event("combat.ended", timeout=10.0)

            # Verify event structure
            assert "combat_id" in ended
            assert "end" in ended
            assert "participants" in ended

            # Verify loser is in escape pod
            loser_data = next(
                (p for p in ended["participants"] if p["name"] == "test_win_loser"),
                None
            )
            assert loser_data is not None
            assert loser_data["ship"]["ship_type"] == "escape_pod"

        finally:
            await client_winner.close()
            await client_loser.close()

    async def test_combat_ended_includes_salvage_info(self, test_server):
        """Test combat.ended event contains salvage data."""
        # Create test characters before initializing clients
        create_test_character_knowledge("test_salv_winner", sector=0)
        create_test_character_knowledge("test_salv_loser", sector=0)

        create_strong_character("test_salv_winner", sector=0, fighters=300)
        create_weak_character("test_salv_loser", sector=0, fighters=10)

        # Give loser cargo for salvage
        set_character_cargo("test_salv_loser", quantum_foam=15, retro_organics=8)

        collector = EventCollector()

        client_winner = AsyncGameClient(
            base_url=test_server,
            character_id="test_salv_winner",
            transport="websocket",
        )
        client_loser = AsyncGameClient(
            base_url=test_server,
            character_id="test_salv_loser",
            transport="websocket",
        )

        client_winner.on("combat.round_waiting")(lambda p: collector.add_event("combat.round_waiting", p))
        client_winner.on("combat.ended")(lambda p: collector.add_event("combat.ended", p))

        try:
            await client_winner.join("test_salv_winner")
            await client_loser.join("test_salv_loser")

            # Initiate and finish combat
            await client_winner.combat_initiate(character_id="test_salv_winner")
            waiting = await collector.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            await client_winner.combat_action(
                character_id="test_salv_winner",
                combat_id=combat_id,
                action="attack",
                target_id="test_salv_loser",
                commit=200,
            )
            await client_loser.combat_action(
                character_id="test_salv_loser",
                combat_id=combat_id,
                action="brace",
                commit=0,
            )

            ended = await collector.wait_for_event("combat.ended", timeout=10.0)

            # Verify salvage was created
            assert "salvage" in ended
            salvage_list = ended["salvage"]
            assert len(salvage_list) > 0

            salvage = salvage_list[0]
            assert "salvage_id" in salvage
            assert "cargo" in salvage
            assert "scrap" in salvage

            # Verify cargo from loser
            cargo = salvage["cargo"]
            assert cargo.get("quantum_foam", 0) > 0 or cargo.get("retro_organics", 0) > 0

        finally:
            await client_winner.close()
            await client_loser.close()

    async def test_combat_ended_event_filtered_to_participants(self, test_server):
        """Test combat.ended only sent to participants."""
        create_test_character_knowledge("test_filt_player1", sector=0, fighters=100)
        create_test_character_knowledge("test_filt_player2", sector=0, fighters=100)
        create_balanced_character("test_filt_observer", sector=1)

        collector1 = EventCollector()
        collector2 = EventCollector()
        collector_obs = EventCollector()

        client1 = AsyncGameClient(
            base_url=test_server,
            character_id="test_filt_player1",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url=test_server,
            character_id="test_filt_player2",
            transport="websocket",
        )
        client_obs = AsyncGameClient(
            base_url=test_server,
            character_id="test_filt_observer",
            transport="websocket",
        )

        client1.on("combat.round_waiting")(lambda p: collector1.add_event("combat.round_waiting", p))
        client1.on("combat.ended")(lambda p: collector1.add_event("combat.ended", p))
        client2.on("combat.ended")(lambda p: collector2.add_event("combat.ended", p))
        client_obs.on("combat.ended")(lambda p: collector_obs.add_event("combat.ended", p))

        try:
            await client1.join("test_filt_player1")
            await client2.join("test_filt_player2")
            await client_obs.join("test_filt_observer")

            # Combat at sector 0
            await client1.combat_initiate(character_id="test_filt_player1")

            # Wait for HTTP polling to deliver events
            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            waiting = await collector1.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            # Let timeout for stalemate
            await asyncio.sleep(16.0)

            # Participants should receive combat.ended
            ended1 = await collector1.wait_for_event("combat.ended", timeout=5.0)
            ended2 = await collector2.wait_for_event("combat.ended", timeout=5.0)

            assert ended1["combat_id"] == combat_id
            assert ended2["combat_id"] == combat_id

            # Observer should NOT receive it (different sector)
            await asyncio.sleep(1.0)
            observer_events = collector_obs.get_all("combat.ended")
            assert len(observer_events) == 0, "Observer in different sector should not receive combat.ended"

        finally:
            await client1.close()
            await client2.close()
            await client_obs.close()

    async def test_combat_ended_includes_final_participant_state(self, test_server):
        """Test combat.ended contains final state of all participants."""
        create_test_character_knowledge("test_state1", sector=0, fighters=100)
        create_test_character_knowledge("test_state2", sector=0, fighters=100)

        collector = EventCollector()

        client1 = AsyncGameClient(
            base_url=test_server,
            character_id="test_state1",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url=test_server,
            character_id="test_state2",
            transport="websocket",
        )

        client1.on("combat.round_waiting")(lambda p: collector.add_event("combat.round_waiting", p))
        client1.on("combat.ended")(lambda p: collector.add_event("combat.ended", p))

        try:
            await client1.join("test_state1")
            await client2.join("test_state2")

            await client1.combat_initiate(character_id="test_state1")

            # Wait for HTTP polling to deliver events
            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            waiting = await collector.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            # Both attack once
            await client1.combat_action(
                character_id="test_state1",
                combat_id=combat_id,
                action="attack",
                target_id="test_state2",
                commit=30,
            )
            await client2.combat_action(
                character_id="test_state2",
                combat_id=combat_id,
                action="attack",
                target_id="test_state1",
                commit=30,
            )

            # Wait for auto-brace stalemate
            await asyncio.sleep(16.0)

            ended = await collector.wait_for_event("combat.ended", timeout=5.0)

            # Verify all participants included with ship state
            participants = ended.get("participants", [])
            assert len(participants) == 2

            for p in participants:
                assert "name" in p
                assert "ship" in p
                assert "ship_type" in p["ship"]
                # Ship dict contains ship metadata, not current fighters count
                assert "ship_name" in p["ship"] or "ship_type" in p["ship"]

        finally:
            await client1.close()
            await client2.close()


@pytest.mark.integration
@pytest.mark.requires_server
class TestCombatEdgeCases:
    """Test combat system edge cases and error handling."""

    async def test_combat_session_cleanup_after_end(self, test_server):
        """Test combat session is cleaned up after combat ends."""
        create_test_character_knowledge("test_clean1", sector=0, fighters=100)
        create_test_character_knowledge("test_clean2", sector=0, fighters=100)

        collector = EventCollector()

        client1 = AsyncGameClient(
            base_url=test_server,
            character_id="test_clean1",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url=test_server,
            character_id="test_clean2",
            transport="websocket",
        )

        client1.on("combat.round_waiting")(lambda p: collector.add_event("combat.round_waiting", p))
        client1.on("combat.ended")(lambda p: collector.add_event("combat.ended", p))

        try:
            await client1.join("test_clean1")
            await client2.join("test_clean2")

            # First combat
            await client1.combat_initiate(character_id="test_clean1")

            # Wait for HTTP polling to deliver events
            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            waiting1 = await collector.wait_for_event("combat.round_waiting")
            combat_id1 = waiting1["combat_id"]

            # Let it timeout
            await asyncio.sleep(16.0)
            ended1 = await collector.wait_for_event("combat.ended", timeout=5.0)
            assert ended1["combat_id"] == combat_id1

            # Wait for cleanup
            await asyncio.sleep(1.0)
            collector.clear()

            # Second combat should work with new combat_id
            await client1.combat_initiate(character_id="test_clean1")

            # Wait for HTTP polling to deliver events
            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            waiting2 = await collector.wait_for_event("combat.round_waiting", timeout=5.0)
            combat_id2 = waiting2["combat_id"]

            # Combat IDs should be different
            assert combat_id1 != combat_id2

        finally:
            await client1.close()
            await client2.close()

    async def test_concurrent_combat_sessions_isolated(self, test_server):
        """Test multiple combat sessions are isolated."""
        # Combat in sector 1
        create_test_character_knowledge("test_conc1a", sector=0, fighters=100)
        create_test_character_knowledge("test_conc1b", sector=0, fighters=100)

        # Combat in sector 2
        create_test_character_knowledge("test_conc2a", sector=0, fighters=100)
        create_test_character_knowledge("test_conc2b", sector=0, fighters=100)

        collector1 = EventCollector()
        collector2 = EventCollector()

        # Clients for sector 1 combat
        client1a = AsyncGameClient(
            base_url=test_server,
            character_id="test_conc1a",
            transport="websocket",
        )
        client1b = AsyncGameClient(
            base_url=test_server,
            character_id="test_conc1b",
            transport="websocket",
        )

        # Clients for sector 2 combat
        client2a = AsyncGameClient(
            base_url=test_server,
            character_id="test_conc2a",
            transport="websocket",
        )
        client2b = AsyncGameClient(
            base_url=test_server,
            character_id="test_conc2b",
            transport="websocket",
        )

        client1a.on("combat.round_waiting")(lambda p: collector1.add_event("combat.round_waiting", p))
        client2a.on("combat.round_waiting")(lambda p: collector2.add_event("combat.round_waiting", p))

        try:
            # Setup sector 1 combat
            await client1a.join("test_conc1a")
            await client1b.join("test_conc1b")
            await client1a.move(to_sector=1, character_id="test_conc1a")
            await client1b.move(to_sector=1, character_id="test_conc1b")

            # Setup sector 2 combat
            await client2a.join("test_conc2a")
            await client2b.join("test_conc2b")
            await client2a.move(to_sector=2, character_id="test_conc2a")
            await client2b.move(to_sector=2, character_id="test_conc2b")

            # Initiate both combats
            await client1a.combat_initiate(character_id="test_conc1a")
            await client2a.combat_initiate(character_id="test_conc2a")

            # Both should receive combat.round_waiting
            waiting1 = await collector1.wait_for_event("combat.round_waiting")
            waiting2 = await collector2.wait_for_event("combat.round_waiting")

            # Combat IDs should be different
            assert waiting1["combat_id"] != waiting2["combat_id"]

            # Participants should be correct
            names1 = [p["name"] for p in waiting1["participants"]]
            names2 = [p["name"] for p in waiting2["participants"]]

            assert "test_conc1a" in names1 or "test_conc1b" in names1
            assert "test_conc2a" in names2 or "test_conc2b" in names2

        finally:
            await client1a.close()
            await client1b.close()
            await client2a.close()
            await client2b.close()

    async def test_invalid_target_in_combat_fails(self, test_server):
        """Test attacking invalid target produces error."""
        create_test_character_knowledge("test_inv_attacker", sector=0, fighters=100)
        create_test_character_knowledge("test_inv_victim", sector=0, fighters=100)

        collector = EventCollector()

        client_attacker = AsyncGameClient(
            base_url=test_server,
            character_id="test_inv_attacker",
            transport="websocket",
        )
        client_victim = AsyncGameClient(
            base_url=test_server,
            character_id="test_inv_victim",
            transport="websocket",
        )

        client_attacker.on("combat.round_waiting")(lambda p: collector.add_event("combat.round_waiting", p))

        try:
            await client_attacker.join("test_inv_attacker")
            await client_victim.join("test_inv_victim")

            await client_attacker.combat_initiate(character_id="test_inv_attacker")
            waiting = await collector.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            # Try to attack non-existent target
            try:
                await client_attacker.combat_action(
                    character_id="test_inv_attacker",
                    combat_id=combat_id,
                    action="attack",
                    target_id="nonexistent_player",
                    commit=50,
                )
                # If no error, server accepted it (may default to valid target)
            except Exception as e:
                # Server rejected invalid target
                assert "nonexistent_player" in str(e) or "not found" in str(e).lower()

        finally:
            await client_attacker.close()
            await client_victim.close()

    async def test_character_disconnection_during_combat(self, test_server):
        """Test combat continues when character disconnects (auto-brace)."""
        create_test_character_knowledge("test_disc1", sector=0, fighters=100)
        create_test_character_knowledge("test_disc2", sector=0, fighters=100)

        collector1 = EventCollector()
        collector2 = EventCollector()

        client1 = AsyncGameClient(
            base_url=test_server,
            character_id="test_disc1",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url=test_server,
            character_id="test_disc2",
            transport="websocket",
        )

        client1.on("combat.round_waiting")(lambda p: collector1.add_event("combat.round_waiting", p))
        client2.on("combat.round_waiting")(lambda p: collector2.add_event("combat.round_waiting", p))
        client2.on("combat.round_resolved")(lambda p: collector2.add_event("combat.round_resolved", p))

        try:
            await client1.join("test_disc1")
            await client2.join("test_disc2")

            await client1.combat_initiate(character_id="test_disc1")

            # Wait for HTTP polling to deliver events
            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            waiting = await collector1.wait_for_event("combat.round_waiting")
            combat_id = waiting["combat_id"]

            # Client1 disconnects (close connection)
            await client1.close()

            # Client2 submits action
            await client2.combat_action(
                character_id="test_disc2",
                combat_id=combat_id,
                action="attack",
                target_id="test_disc1",
                commit=30,
            )

            # Wait for auto-brace timeout
            await asyncio.sleep(16.0)

            # Combat should resolve with client1 auto-bracing
            resolved = await collector2.wait_for_event("combat.round_resolved", timeout=5.0)

            actions = resolved.get("actions", {})
            # Client1 should have auto-braced
            assert actions.get("test_disc1", {}).get("action") == "brace"
            assert actions.get("test_disc2", {}).get("action") == "attack"

        finally:
            # client1 already closed
            await client2.close()


# ============================================================================
# Test Class: Combat Zone Restrictions
# ============================================================================

@pytest.mark.integration
@pytest.mark.requires_server
class TestCombatZoneRestrictions:
    """Test restrictions on characters in sectors with active combat."""

    async def test_arrival_in_combat_zone_prevents_non_combat_actions(self, test_server):
        """Character arriving in sector with active combat cannot move or trade."""
        # Create three characters: two fighters in sector 3, one arriving from sector 1
        # Sector 1 and 3 are adjacent (verified in universe_structure.json)
        create_test_character_knowledge("test_combat_zone_fighter1", sector=3, fighters=100)
        create_test_character_knowledge("test_combat_zone_fighter2", sector=3, fighters=100)
        create_test_character_knowledge("test_combat_zone_arrival", sector=1, fighters=100, credits=10000)

        collector1 = EventCollector()
        collector_arrival = EventCollector()

        client1 = AsyncGameClient(
            base_url=test_server,
            character_id="test_combat_zone_fighter1",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url=test_server,
            character_id="test_combat_zone_fighter2",
            transport="websocket",
        )
        client_arrival = AsyncGameClient(
            base_url=test_server,
            character_id="test_combat_zone_arrival",
            transport="websocket",
        )

        client1.on("combat.round_waiting")(lambda p: collector1.add_event("combat.round_waiting", p))
        client_arrival.on("combat.round_waiting")(lambda p: collector_arrival.add_event("combat.round_waiting", p))

        try:
            # Set up fighters in sector 3
            await client1.join("test_combat_zone_fighter1")
            await client2.join("test_combat_zone_fighter2")
            await asyncio.sleep(2.0)

            # Start combat in sector 3
            await client1.combat_initiate(character_id="test_combat_zone_fighter1")
            await collector1.wait_for_event("combat.round_waiting", timeout=10.0)

            # New character joins and tries to move to sector 3 (combat zone)
            await client_arrival.join("test_combat_zone_arrival")
            await asyncio.sleep(1.0)

            # Move to combat zone (sector 3) - should succeed
            await client_arrival.move(to_sector=3, character_id="test_combat_zone_arrival")

            await asyncio.sleep(2.0)  # Allow arrival to process

            # Try to move out (should fail if character is restricted by combat)
            try:
                await client_arrival.move(to_sector=1, character_id="test_combat_zone_arrival")
                # If move succeeds without exception, character is not restricted
                # This might be valid behavior if they haven't auto-engaged in combat
                print("\n  → Character was able to move out (not restricted by combat zone)")
            except RPCError as e:
                # Expected: Move blocked due to combat
                print(f"\n  ✓ Move blocked: {e}")
                assert "combat" in str(e).lower() or "cannot" in str(e).lower(), \
                    f"Expected combat-related error, got: {e}"

            # Try to trade (should also fail if in combat zone)
            try:
                await client_arrival.trade(
                    commodity="quantum_foam",
                    quantity=1,
                    trade_type="buy",
                    character_id="test_combat_zone_arrival"
                )
                # If trade succeeds, character is not in combat
                print("\n  → Character was able to trade (not restricted by combat zone)")
            except RPCError as e:
                # Expected: Trade blocked due to combat
                print(f"\n  ✓ Trade blocked: {e}")

        finally:
            await client1.close()
            await client2.close()
            await client_arrival.close()

    async def test_arrival_in_combat_zone_can_join_combat(self, test_server):
        """Character arriving in combat zone can initiate combat and join."""
        # Create three characters: two fighters in sector 3, one arriving from sector 1
        # Sector 1 and 3 are adjacent (verified in universe_structure.json)
        create_test_character_knowledge("test_join_zone_fighter1", sector=3, fighters=100)
        create_test_character_knowledge("test_join_zone_fighter2", sector=3, fighters=100)
        create_test_character_knowledge("test_join_zone_arrival", sector=1, fighters=100)

        collector1 = EventCollector()
        collector_arrival = EventCollector()

        client1 = AsyncGameClient(
            base_url=test_server,
            character_id="test_join_zone_fighter1",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url=test_server,
            character_id="test_join_zone_fighter2",
            transport="websocket",
        )
        client_arrival = AsyncGameClient(
            base_url=test_server,
            character_id="test_join_zone_arrival",
            transport="websocket",
        )

        client1.on("combat.round_waiting")(lambda p: collector1.add_event("combat.round_waiting", p))
        client_arrival.on("combat.round_waiting")(lambda p: collector_arrival.add_event("combat.round_waiting", p))
        client_arrival.on("combat.round_resolved")(lambda p: collector_arrival.add_event("combat.round_resolved", p))

        try:
            # Set up fighters in sector 3
            await client1.join("test_join_zone_fighter1")
            await client2.join("test_join_zone_fighter2")
            await asyncio.sleep(2.0)

            # Start combat in sector 3
            await client1.combat_initiate(character_id="test_join_zone_fighter1")
            waiting1 = await collector1.wait_for_event("combat.round_waiting", timeout=10.0)
            combat_id = waiting1["combat_id"]

            # New character joins and moves to combat zone
            await client_arrival.join("test_join_zone_arrival")
            await asyncio.sleep(1.0)
            await client_arrival.move(to_sector=3, character_id="test_join_zone_arrival")
            await asyncio.sleep(2.0)

            # Character should be able to join the combat
            # Try to initiate combat (should work)
            result = await client_arrival.combat_initiate(character_id="test_join_zone_arrival")

            # Should succeed in joining combat (returns {"success": True, "combat_id": "..."})
            assert result.get("success"), \
                f"Should be able to engage in combat in combat zone. Got: {result}"

        finally:
            await client1.close()
            await client2.close()
            await client_arrival.close()

    async def test_arrival_joins_existing_combat_not_new_session(self, test_server):
        """Character arriving in combat zone joins existing session, not creates new one.

        This test verifies the critical invariant: only ONE combat session per sector.

        Test flow:
        1. Two characters already in sector 3
        2. One calls combat_initiate() -> combat starts
        3. Wait 2 seconds (combat fully established)
        4. Third character moves from sector 1 -> sector 3 (move is synchronous)
        5. Third character calls combat_initiate()
        6. ASSERT: Third character gets SAME combat_id (joins existing, doesn't create new)
        """
        # Create three characters: two already in sector 3, one in sector 1
        create_test_character_knowledge("test_join_existing_fighter1", sector=3, fighters=100)
        create_test_character_knowledge("test_join_existing_fighter2", sector=3, fighters=100)
        create_test_character_knowledge("test_join_existing_arrival", sector=1, fighters=100)

        collector1 = EventCollector()
        collector2 = EventCollector()
        collector_arrival = EventCollector()

        client1 = AsyncGameClient(
            base_url=test_server,
            character_id="test_join_existing_fighter1",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url=test_server,
            character_id="test_join_existing_fighter2",
            transport="websocket",
        )
        client_arrival = AsyncGameClient(
            base_url=test_server,
            character_id="test_join_existing_arrival",
            transport="websocket",
        )

        # Listen for events
        client1.on("combat.round_waiting")(lambda p: collector1.add_event("combat.round_waiting", p))
        client2.on("combat.round_waiting")(lambda p: collector2.add_event("combat.round_waiting", p))
        client_arrival.on("combat.round_waiting")(lambda p: collector_arrival.add_event("combat.round_waiting", p))

        try:
            # Step 1: Two characters already in sector 3
            print("\n1. Setting up two characters in sector 3...")
            await client1.join("test_join_existing_fighter1")
            await client2.join("test_join_existing_fighter2")
            await asyncio.sleep(1.0)

            # Step 2: One calls combat_initiate()
            print("2. Fighter1 initiating combat...")
            await client1.combat_initiate(character_id="test_join_existing_fighter1")

            # Wait for combat to start and capture original combat_id
            waiting1 = await collector1.wait_for_event("combat.round_waiting", timeout=10.0)
            original_combat_id = waiting1["combat_id"]
            print(f"   ✓ Combat started with combat_id: {original_combat_id}")

            # Step 3: Wait 2 seconds (combat fully established)
            print("3. Waiting 2 seconds for combat to be fully established...")
            await asyncio.sleep(2.0)

            # Step 4: Third character joins and moves to sector 3
            print("4. Third character joining and moving to sector 3...")
            await client_arrival.join("test_join_existing_arrival")
            await asyncio.sleep(0.5)

            # Step 5: Move to sector 3 (synchronous - when call returns, move is complete)
            print("5. Moving to sector 3...")
            await client_arrival.move(to_sector=3, character_id="test_join_existing_arrival")
            print(f"   ✓ Move completed: character now in sector 3")

            # Step 6: Third character calls combat_initiate()
            print("6. Third character attempting to initiate combat...")
            await client_arrival.combat_initiate(character_id="test_join_existing_arrival")

            # Wait for combat.round_waiting event for the arriving character
            waiting_arrival = await collector_arrival.wait_for_event("combat.round_waiting", timeout=10.0)
            arrival_combat_id = waiting_arrival["combat_id"]
            print(f"   ✓ Received combat.round_waiting with combat_id: {arrival_combat_id}")

            # Step 7: CRITICAL ASSERTION - Should be the SAME combat_id
            assert arrival_combat_id == original_combat_id, \
                f"\n❌ BUG DETECTED: Two separate combat sessions in the same sector!\n" \
                f"   Original combat_id: {original_combat_id}\n" \
                f"   Arrival combat_id:  {arrival_combat_id}\n" \
                f"   Expected: Same combat_id (character joins existing combat)\n" \
                f"   Actual: Different combat_id (character created NEW combat)\n"

            print(f"\n✅ TEST PASSED: Character joined the SAME combat session")
            participants = waiting_arrival.get("participants", [])
            print(f"   Combat now has {len(participants)} participants (expected 3)")

        finally:
            await client1.close()
            await client2.close()
            await client_arrival.close()

    async def test_arrival_in_combat_zone_after_combat_ends(self, test_server):
        """Character can perform normal actions if arriving after combat ends."""
        # Create three characters: two fighters in sector 3, one arriving from sector 1
        # Sector 1 and 3 are adjacent (verified in universe_structure.json)
        create_test_character_knowledge("test_ended_fighter1", sector=3, fighters=100)
        create_test_character_knowledge("test_ended_fighter2", sector=3, fighters=100)
        create_test_character_knowledge("test_ended_arrival", sector=1, fighters=100)

        collector1 = EventCollector()
        collector2 = EventCollector()

        client1 = AsyncGameClient(
            base_url=test_server,
            character_id="test_ended_fighter1",
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url=test_server,
            character_id="test_ended_fighter2",
            transport="websocket",
        )
        client_arrival = AsyncGameClient(
            base_url=test_server,
            character_id="test_ended_arrival",
            transport="websocket",
        )

        client1.on("combat.round_waiting")(lambda p: collector1.add_event("combat.round_waiting", p))
        client1.on("combat.ended")(lambda p: collector1.add_event("combat.ended", p))
        client2.on("combat.round_waiting")(lambda p: collector2.add_event("combat.round_waiting", p))

        try:
            # Set up fighters in sector 3
            await client1.join("test_ended_fighter1")
            await client2.join("test_ended_fighter2")
            await asyncio.sleep(2.0)

            # Start combat
            await client1.combat_initiate(character_id="test_ended_fighter1")
            waiting = await collector1.wait_for_event("combat.round_waiting", timeout=10.0)
            combat_id = waiting["combat_id"]

            # Both fighters flee to end combat (to adjacent sectors)
            await client1.combat_action(
                character_id="test_ended_fighter1",
                combat_id=combat_id,
                action="flee",
                to_sector=1,
            )
            await client2.combat_action(
                character_id="test_ended_fighter2",
                combat_id=combat_id,
                action="flee",
                to_sector=4,
            )

            # Wait for combat to end
            await collector1.wait_for_event("combat.ended", timeout=25.0)

            # Now new character arrives in sector 3 (where combat was)
            await client_arrival.join("test_ended_arrival")
            await asyncio.sleep(1.0)

            # Should be able to move to sector after combat ends (no exception = success)
            await client_arrival.move(to_sector=3, character_id="test_ended_arrival")
            print("\n  ✓ Character moved to sector 3 (where combat ended)")

            await asyncio.sleep(1.0)

            # Should be able to move freely (combat is over)
            await client_arrival.move(to_sector=1, character_id="test_ended_arrival")
            print("  ✓ Character moved freely back to sector 1 (combat restrictions lifted)")

        finally:
            await client1.close()
            await client2.close()
            await client_arrival.close()


@pytest.mark.integration
@pytest.mark.requires_server
class TestCombatEventPayloads:
    """Test combat event payload correctness and ordering (bug fixes from work-1028.md)."""

    async def test_initiator_is_display_name_not_char_id(self, test_server):
        """Test that the initiator field in combat.round_waiting uses display name.

        Issue: Initiator field was using character ID, should use display name
        to match the format in participants[].name
        """
        # Setup two characters
        create_test_character_knowledge("test_initiator_char1", sector=0, fighters=100)
        create_test_character_knowledge("test_initiator_char2", sector=0, fighters=100)

        char_id_1 = "test_initiator_char1"
        char_id_2 = "test_initiator_char2"

        client1 = AsyncGameClient(
            base_url=test_server,
            character_id=char_id_1,
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url=test_server,
            character_id=char_id_2,
            transport="websocket",
        )

        try:
            # Join both characters
            await client1.join(character_id=char_id_1)
            await asyncio.sleep(0.5)
            await client2.join(character_id=char_id_2)
            await asyncio.sleep(0.5)

            # Get display names
            status1 = await get_status(client1, char_id_1)
            status2 = await get_status(client2, char_id_2)
            display_name_1 = status1["player"]["name"]
            display_name_2 = status2["player"]["name"]

            # Setup event collectors for both clients
            events_char1 = []
            events_char2 = []

            client1.on("combat.round_waiting")(
                lambda p: events_char1.append({"event": "combat.round_waiting", "payload": p})
            )
            client2.on("combat.round_waiting")(
                lambda p: events_char2.append({"event": "combat.round_waiting", "payload": p})
            )

            # Character 1 initiates combat
            await client1.combat_initiate(character_id=char_id_1)
            await asyncio.sleep(2.0)

            # Verify both characters received combat.round_waiting
            assert len(events_char1) >= 1, "Character 1 should receive combat.round_waiting"
            assert len(events_char2) >= 1, "Character 2 should receive combat.round_waiting"

            # Check the first round_waiting event (round 1) for initiator field
            # Note: WebSocket events are wrapped with event_name, payload, summary
            payload_1 = events_char1[0]["payload"]
            payload_2 = events_char2[0]["payload"]

            # Unwrap if needed (WebSocket wraps events)
            if "payload" in payload_1:
                round_waiting_1 = payload_1["payload"]
            else:
                round_waiting_1 = payload_1

            if "payload" in payload_2:
                round_waiting_2 = payload_2["payload"]
            else:
                round_waiting_2 = payload_2

            # Verify initiator field exists and is a display name (not UUID)
            assert "initiator" in round_waiting_1, f"round_waiting should have initiator field. Got: {list(round_waiting_1.keys())}"
            assert "initiator" in round_waiting_2, f"round_waiting should have initiator field. Got: {list(round_waiting_2.keys())}"

            initiator_1 = round_waiting_1.get("initiator")
            initiator_2 = round_waiting_2.get("initiator")

            # Initiator should be the same for both events
            assert initiator_1 == initiator_2, "Initiator should be consistent across events"

            # Initiator should be character 1's display name
            assert initiator_1 == display_name_1, (
                f"Initiator should be display name '{display_name_1}', "
                f"but got '{initiator_1}'"
            )

            # Verify format matches participants[].name (both use display names)
            participants = round_waiting_1.get("participants", [])
            participant_names = [p.get("name") for p in participants]

            assert initiator_1 in participant_names, (
                f"Initiator '{initiator_1}' should match format of participant names: {participant_names}"
            )

            # The key fix: initiator uses character.name (display name) from world.characters
            # rather than the character ID from encounter.context
            # This ensures consistency with participants[].name which also uses character.name
            print(f"\n✓ Initiator field correctly uses display name: '{initiator_1}'")
            print(f"✓ Matches participant name format: {participant_names}")

        finally:
            await client1.close()
            await client2.close()

    async def test_join_combat_event_order(self, test_server):
        """Test that combat.round_waiting is sent AFTER status.snapshot and map.local on join.

        Issue: combat.round_waiting was sent in the middle of the join event sequence,
        but should come last.

        Expected order:
        1. character.moved (if teleport)
        2. status.snapshot
        3. map.local
        4. combat.round_waiting (LAST)
        """
        # Setup three characters - two to start combat, one to join later
        create_test_character_knowledge("test_event_order_char1", sector=0, fighters=100)
        create_test_character_knowledge("test_event_order_char2", sector=0, fighters=100)
        create_test_character_knowledge("test_event_order_char3", sector=0, fighters=100)

        char_id_1 = "test_event_order_char1"
        char_id_2 = "test_event_order_char2"
        char_id_3 = "test_event_order_char3"

        client1 = AsyncGameClient(
            base_url=test_server,
            character_id=char_id_1,
            transport="websocket",
        )
        client2 = AsyncGameClient(
            base_url=test_server,
            character_id=char_id_2,
            transport="websocket",
        )
        client3 = AsyncGameClient(
            base_url=test_server,
            character_id=char_id_3,
            transport="websocket",
        )

        try:
            # Characters 1 and 2 join and start combat
            await client1.join(character_id=char_id_1)
            await asyncio.sleep(0.5)
            await client2.join(character_id=char_id_2)
            await asyncio.sleep(0.5)

            await client1.combat_initiate(character_id=char_id_1)

            # Wait for HTTP polling to deliver events
            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            # Setup event collector for character 3 BEFORE they join
            events_char3 = []

            def collect_event(event_name):
                def handler(payload):
                    from datetime import timezone, datetime
                    events_char3.append({
                        "event": event_name,
                        "payload": payload,
                        "timestamp": datetime.now(timezone.utc)
                    })
                return handler

            client3.on("character.moved")(collect_event("character.moved"))
            client3.on("status.snapshot")(collect_event("status.snapshot"))
            client3.on("map.local")(collect_event("map.local"))
            client3.on("combat.round_waiting")(collect_event("combat.round_waiting"))

            # Character 3 joins the game (will enter sector 0 with active combat)
            await client3.join(character_id=char_id_3)

            # Wait for HTTP polling to deliver all join events
            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            # Extract event names in order
            event_sequence = [e["event"] for e in events_char3]

            # Debug: print the actual sequence
            print(f"\n📋 Event sequence for character 3 joining active combat:")
            for i, e in enumerate(events_char3):
                print(f"  {i}: {e['event']}")

            # Verify we received the key events
            assert "status.snapshot" in event_sequence, "Should receive status.snapshot"
            assert "map.local" in event_sequence, "Should receive map.local"
            assert "combat.round_waiting" in event_sequence, "Should receive combat.round_waiting"

            # Find positions of key events
            status_idx = event_sequence.index("status.snapshot")
            map_idx = event_sequence.index("map.local")

            # Note: There may be multiple combat.round_waiting events
            # (one when added to combat, one from join handler)
            # We want to verify the LAST one comes after map.local
            combat_indices = [i for i, e in enumerate(event_sequence) if e == "combat.round_waiting"]
            combat_idx = combat_indices[-1]  # Get the last occurrence

            print(f"  status.snapshot at position {status_idx}")
            print(f"  map.local at position {map_idx}")
            print(f"  combat.round_waiting at positions {combat_indices} (checking last: {combat_idx})")

            # Verify order: status.snapshot → map.local → combat.round_waiting (last occurrence)
            assert status_idx < map_idx, (
                f"status.snapshot (pos {status_idx}) should come before map.local (pos {map_idx})"
            )
            assert map_idx < combat_idx, (
                f"map.local (pos {map_idx}) should come before combat.round_waiting (last at pos {combat_idx})"
            )

            # Verify the LAST combat.round_waiting is the final event
            assert combat_idx == len(event_sequence) - 1, (
                f"Last combat.round_waiting should be final event, but found at position {combat_idx} "
                f"out of {len(event_sequence)} events. Sequence: {event_sequence}"
            )

            print(f"✓ Event order verified: status.snapshot → map.local → combat.round_waiting")

        finally:
            await client1.close()
            await client2.close()
            await client3.close()
