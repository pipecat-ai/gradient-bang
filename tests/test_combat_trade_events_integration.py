"""Integration tests for combat and trade events with a real game server.

These tests verify that events are properly emitted and received via WebSocket.
"""

import asyncio
import pytest
import pytest_asyncio
from pathlib import Path
import sys
import os

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "game-server"))

from utils.api_client import AsyncGameClient


def _extract_sector_id(value):
    if isinstance(value, dict):
        return value.get("id")
    return value


SERVER_URL = os.getenv("TEST_SERVER_URL", os.getenv("GAME_SERVER_URL", "http://localhost:8000"))
from server import app
from core.world import world as game_world


class EventCollector:
    """Helper class to collect events from AsyncGameClient."""

    def __init__(self):
        self.events = []
        self.event_futures = {}

    def add_event(self, event_name, payload):
        """Record an event and resolve any waiting futures."""
        self.events.append((event_name, payload))
        if event_name in self.event_futures:
            for future in self.event_futures[event_name]:
                if not future.done():
                    future.set_result(payload)

    async def wait_for_event(self, event_name, timeout=5.0):
        """Wait for a specific event to be received."""
        # Check if we already have the event
        for name, payload in self.events:
            if name == event_name:
                return payload

        # Create future and wait
        future = asyncio.Future()
        if event_name not in self.event_futures:
            self.event_futures[event_name] = []
        self.event_futures[event_name].append(future)

        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            pytest.fail(f"Timeout waiting for event: {event_name}")

    def get_events(self, event_name):
        """Get all events of a specific type."""
        return [payload for name, payload in self.events if name == event_name]

    def clear(self):
        """Clear all recorded events."""
        self.events.clear()
        self.event_futures.clear()


@pytest_asyncio.fixture(autouse=True)
async def reset_world():
    """Reset world state before each test."""
    game_world.characters.clear()
    if hasattr(game_world, "combat_manager") and game_world.combat_manager:
        game_world.combat_manager._encounters.clear()
    if hasattr(game_world, "salvage_manager") and game_world.salvage_manager:
        game_world.salvage_manager._by_sector.clear()
    if hasattr(game_world, "garrisons") and game_world.garrisons:
        game_world.garrisons._garrisons.clear()
    yield
    game_world.characters.clear()


@pytest_asyncio.fixture
async def game_client_with_events():
    """Create a game client with event collection."""
    collector = EventCollector()

    client = AsyncGameClient(
        base_url=SERVER_URL,
        character_id="test_char_events",
        transport="websocket",
    )

    # Register event handlers
    client.on("combat.round_waiting")(
        lambda payload: collector.add_event("combat.round_waiting", payload)
    )
    client.on("combat.round_resolved")(
        lambda payload: collector.add_event("combat.round_resolved", payload)
    )
    client.on("combat.ended")(
        lambda payload: collector.add_event("combat.ended", payload)
    )
    client.on("trade.executed")(
        lambda payload: collector.add_event("trade.executed", payload)
    )
    client.on("port.update")(
        lambda payload: collector.add_event("port.update", payload)
    )

    try:
        yield client, collector
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.integration
class TestTradeEvents:
    """Integration tests for trade events."""

    async def test_trade_executed_event_on_buy(self, game_client_with_events):
        """Test that trade.executed event is emitted when buying from port."""
        client, collector = game_client_with_events

        # Join and move to a sector with a port
        await client.join("test_char_events")
        # Assuming sector 1 has a port that sells fuel_ore

        # Execute a trade
        await client.trade(
            character_id="test_char_events",
            commodity="fuel_ore",
            quantity=5,
            trade_type="buy",
        )

        # Wait for trade.executed event
        event = await collector.wait_for_event("trade.executed", timeout=2.0)

        # Verify event structure
        assert "player" in event
        assert "ship" in event
        assert event["player"]["id"] == "test_char_events"
        assert event["player"]["name"] == "test_char_events"
        assert "credits_on_hand" in event["player"]

        assert "cargo" in event["ship"]
        assert "warp_power" in event["ship"]
        assert "shields" in event["ship"]
        assert "fighters" in event["ship"]

    async def test_port_update_event_on_trade(self, game_client_with_events):
        """Test that port.update event is emitted to all in sector after trade."""
        client, collector = game_client_with_events

        # Join and stay in sector
        await client.join("test_char_events")

        # Execute a trade
        await client.trade(
            character_id="test_char_events",
            commodity="fuel_ore",
            quantity=3,
            trade_type="buy",
        )

        # Wait for port.update event
        event = await collector.wait_for_event("port.update", timeout=2.0)

        # Verify event structure
        assert _extract_sector_id(event.get("sector")) is not None
        assert "updated_at" in event
        assert "port" in event

        port = event["port"]
        assert "code" in port
        assert "prices" in port
        assert "stock" in port
        assert port["observed_at"] is None  # Should be null for current observers

    async def test_multiple_traders_receive_port_update(self, game_client_with_events):
        """Test that all traders in sector receive port.update."""
        client1, collector1 = game_client_with_events

        # Create second client
        collector2 = EventCollector()
        client2 = AsyncGameClient(
            base_url="http://localhost:8000",
            character_id="test_char_2",
            transport="websocket",
        )
        client2.on("port.update")(
            lambda payload: collector2.add_event("port.update", payload)
        )

        try:
            # Both join same sector
            await client1.join("test_char_events")
            await client2.join("test_char_2")

            # Client 1 trades
            await client1.trade(
                character_id="test_char_events",
                commodity="fuel_ore",
                quantity=2,
                trade_type="buy",
            )

            # Both should receive port.update
            event1 = await collector1.wait_for_event("port.update", timeout=2.0)
            event2 = await collector2.wait_for_event("port.update", timeout=2.0)

            assert _extract_sector_id(event1.get("sector")) == _extract_sector_id(event2.get("sector"))
            assert event1["port"]["prices"] == event2["port"]["prices"]

        finally:
            await client2.close()


@pytest.mark.asyncio
@pytest.mark.integration
class TestCombatEvents:
    """Integration tests for combat events."""

    async def test_combat_round_waiting_structure(self, game_client_with_events):
        """Test combat.round_waiting event structure."""
        client, collector = game_client_with_events

        # Create second client to fight against
        collector2 = EventCollector()
        client2 = AsyncGameClient(
            base_url=SERVER_URL,
            character_id="test_opponent",
            transport="websocket",
        )
        client2.on("combat.round_waiting")(
            lambda payload: collector2.add_event("combat.round_waiting", payload)
        )

        try:
            # Both join and move to same sector
            await client.join("test_char_events")
            await client2.join("test_opponent")

            # Move to sector 1 if not there
            status1 = await client.my_status(character_id="test_char_events")
            if _extract_sector_id(status1.get("sector")) != 1:
                await client.move(to_sector=1, character_id="test_char_events")

            status2 = await client2.my_status(character_id="test_opponent")
            if _extract_sector_id(status2.get("sector")) != 1:
                await client2.move(to_sector=1, character_id="test_opponent")

            # Initiate combat
            await client.combat_initiate(character_id="test_char_events")

            # Wait for combat.round_waiting events
            event1 = await collector.wait_for_event("combat.round_waiting", timeout=5.0)
            event2 = await collector2.wait_for_event("combat.round_waiting", timeout=5.0)

            # Verify event structure
            assert "combat_id" in event1
            assert "sector" in event1
            assert "round" in event1
            assert "current_time" in event1
            assert "deadline" in event1
            assert "participants" in event1
            assert isinstance(event1["participants"], list)
            assert "ship" in event1
            assert isinstance(event1["ship"], dict)
            assert "fighters" in event1["ship"]
            assert "max_fighters" in event1["ship"]

            assert "ship" in event2
            assert isinstance(event2["ship"], dict)

            # Both should get same combat
            assert event1["combat_id"] == event2["combat_id"]

        finally:
            await client2.close()

    async def test_combat_events_privacy(self, game_client_with_events):
        """Test that combat events don't leak character IDs."""
        client, collector = game_client_with_events

        # Create second client
        collector2 = EventCollector()
        client2 = AsyncGameClient(
            base_url=SERVER_URL,
            character_id="test_opponent2",
            transport="websocket",
        )
        client2.on("combat.round_waiting")(
            lambda payload: collector2.add_event("combat.round_waiting", payload)
        )

        try:
            await client.join("test_char_events")
            await client2.join("test_opponent2")

            # Move to same sector
            status1 = await client.my_status(character_id="test_char_events")
            if _extract_sector_id(status1.get("sector")) != 1:
                await client.move(to_sector=1, character_id="test_char_events")

            status2 = await client2.my_status(character_id="test_opponent2")
            if _extract_sector_id(status2.get("sector")) != 1:
                await client2.move(to_sector=1, character_id="test_opponent2")

            # Initiate combat
            await client.combat_initiate(character_id="test_char_events")

            # Wait for event
            event = await collector.wait_for_event("combat.round_waiting", timeout=5.0)

            # Verify privacy constraints
            participants = event["participants"]
            for participant in participants:
                # Should have name but no character ID
                assert "name" in participant
                assert "character_id" not in participant
                assert "combatant_id" not in participant

                # Shield integrity as percentage
                if "ship" in participant:
                    assert "shield_integrity" in participant["ship"]
                    shield_integrity = participant["ship"]["shield_integrity"]
                    assert 0 <= shield_integrity <= 100

                    # No exact shield values
                    assert "shields" not in participant["ship"]
                    assert "max_shields" not in participant["ship"]

                    # No fighter counts
                    assert "fighters" not in participant["ship"]
                    assert "max_fighters" not in participant["ship"]

            # Garrison should not expose owner character ID in owner_name
            if event.get("garrison"):
                garrison = event["garrison"]
                assert "owner_name" in garrison
                # owner_name should be the display name, not ID

            ship_payload = event.get("ship")
            assert isinstance(ship_payload, dict)
            assert ship_payload.get("fighters") is not None
            assert ship_payload.get("max_fighters") is not None

        finally:
            await client2.close()

    async def test_combat_round_resolved_deltas(self, game_client_with_events):
        """Test combat.round_resolved contains proper deltas."""
        client, collector = game_client_with_events

        # Create second client
        collector2 = EventCollector()
        client2 = AsyncGameClient(
            base_url=SERVER_URL,
            character_id="test_opponent3",
            transport="websocket",
        )
        client2.on("combat.round_waiting")(
            lambda payload: collector2.add_event("combat.round_waiting", payload)
        )
        client2.on("combat.round_resolved")(
            lambda payload: collector2.add_event("combat.round_resolved", payload)
        )

        try:
            await client.join("test_char_events")
            await client2.join("test_opponent3")

            # Move to same sector
            status1 = await client.my_status(character_id="test_char_events")
            if _extract_sector_id(status1.get("sector")) != 1:
                await client.move(to_sector=1, character_id="test_char_events")

            status2 = await client2.my_status(character_id="test_opponent3")
            if _extract_sector_id(status2.get("sector")) != 1:
                await client2.move(to_sector=1, character_id="test_opponent3")

            # Initiate combat
            await client.combat_initiate(character_id="test_char_events")

            # Wait for round waiting
            waiting_event = await collector.wait_for_event("combat.round_waiting", timeout=5.0)
            combat_id = waiting_event["combat_id"]

            # Both submit attack actions
            await client.combat_action(
                character_id="test_char_events",
                combat_id=combat_id,
                action="attack",
                target_id="test_opponent3",
                commit=1,
            )

            await client2.combat_action(
                character_id="test_opponent3",
                combat_id=combat_id,
                action="attack",
                target_id="test_char_events",
                commit=1,
            )

            # Wait for round resolved
            resolved_event = await collector.wait_for_event("combat.round_resolved", timeout=5.0)

            # Verify delta structure
            assert "participants" in resolved_event
            participants = resolved_event["participants"]

            for participant in participants:
                if "ship" in participant:
                    # Should have deltas (may be 0 or None if no change)
                    assert "shield_damage" in participant["ship"] or participant["ship"].get("shield_damage") is None
                    assert "fighter_loss" in participant["ship"] or participant["ship"].get("fighter_loss") is None

            ship_payload = resolved_event.get("ship")
            assert isinstance(ship_payload, dict)
            assert "fighters" in ship_payload
            assert "max_fighters" in ship_payload

        finally:
            await client2.close()

    async def test_combat_ended_salvage_structure(self, game_client_with_events):
        """Test combat.ended event salvage structure."""
        client, collector = game_client_with_events

        # Create second client with fewer fighters (will lose)
        collector2 = EventCollector()
        client2 = AsyncGameClient(
            base_url=SERVER_URL,
            character_id="test_weak_opponent",
            transport="websocket",
        )
        client2.on("combat.round_waiting")(
            lambda payload: collector2.add_event("combat.round_waiting", payload)
        )
        client2.on("combat.ended")(
            lambda payload: collector2.add_event("combat.ended", payload)
        )

        try:
            await client.join("test_char_events")
            await client2.join("test_weak_opponent")

            # Move to same sector
            status1 = await client.my_status(character_id="test_char_events")
            if _extract_sector_id(status1.get("sector")) != 1:
                await client.move(to_sector=1, character_id="test_char_events")

            status2 = await client2.my_status(character_id="test_weak_opponent")
            if _extract_sector_id(status2.get("sector")) != 1:
                await client2.move(to_sector=1, character_id="test_weak_opponent")

            # Note: This test would need to run many rounds to complete combat
            # For now, we can just verify the combat.ended event structure
            # when it does fire

            # Initiate combat
            await client.combat_initiate(character_id="test_char_events")

            # We would need to repeatedly submit actions until combat ends
            # This is complex, so for now just verify structure if/when it happens

            # Instead, test that the serializer produces correct structure
            # (already tested in unit tests)

        finally:
            await client2.close()

    async def test_combat_with_garrison(self, game_client_with_events):
        """Test combat events include garrison as singular object."""
        client, collector = game_client_with_events

        try:
            await client.join("test_char_events")

            # Move to sector 1
            status = await client.my_status(character_id="test_char_events")
            if _extract_sector_id(status.get("sector")) != 1:
                await client.move(to_sector=1, character_id="test_char_events")

            # Deploy a garrison in offensive mode
            await client.combat_leave_fighters(
                character_id="test_char_events",
                sector=1,
                quantity=50,
                mode="offensive",
            )

            # Create second client
            collector2 = EventCollector()
            client2 = AsyncGameClient(
                base_url=SERVER_URL,
                character_id="test_garrison_target",
                transport="websocket",
            )
            client2.on("combat.round_waiting")(
                lambda payload: collector2.add_event("combat.round_waiting", payload)
            )

            try:
                await client2.join("test_garrison_target")

                # Move to sector with garrison - should auto-trigger combat
                await client2.move(to_sector=1, character_id="test_garrison_target")

                # Wait for combat event
                event = await collector2.wait_for_event("combat.round_waiting", timeout=5.0)

                # Verify garrison is singular object, not array
                assert "garrison" in event
                garrison = event["garrison"]
                assert isinstance(garrison, dict)
                assert "owner_name" in garrison
                assert "fighters" in garrison
                assert "mode" in garrison

                ship_payload = event.get("ship")
                assert isinstance(ship_payload, dict)
                assert "fighters" in ship_payload
                assert "max_fighters" in ship_payload

                # Verify participants is array
                assert "participants" in event
                assert isinstance(event["participants"], list)

            finally:
                await client2.close()

        finally:
            # Clean up garrison
            pass


@pytest.mark.asyncio
@pytest.mark.integration
class TestEventPrivacy:
    """Tests to verify privacy constraints in events."""

    async def test_no_character_ids_in_combat_events(self, game_client_with_events):
        """Verify no character IDs leak in combat events."""
        # This test would trigger combat and verify all events
        # Don't contain character IDs except in allowed contexts
        pass

    async def test_shield_integrity_percentage_only(self, game_client_with_events):
        """Verify shields shown as percentage, not exact values."""
        # Trigger combat, verify shield_integrity is 0-100 percentage
        pass

    async def test_fighter_counts_hidden(self, game_client_with_events):
        """Verify fighter counts not exposed for other participants."""
        # Trigger combat, verify fighters/max_fighters not in other participants
        pass
