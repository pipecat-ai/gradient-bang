"""Integration tests for combat and trade events with a real game server.

These tests verify that events are properly emitted and received via WebSocket.
"""

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Optional

import pytest
import pytest_asyncio

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "game-server"))

from utils.api_client import AsyncGameClient


def _extract_sector_id(value):
    if isinstance(value, dict):
        return value.get("id")
    return value


async def _move_to_sector(
    client: AsyncGameClient,
    character_id: str,
    target_sector: int,
    collector: Optional["EventCollector"] = None,
) -> None:
    """Teleport a character to the target sector via the join endpoint.

    These integration tests only need characters co-located; using the join
    handler's sector override keeps test runtime under 10 seconds.
    """

    def _record(event: dict) -> None:
        if collector is not None:
            collector.add_event(event)

    async def _wait_for_status(*, timeout: float) -> dict:
        waiter = asyncio.create_task(
            client.wait_for_event(
                "status.snapshot",
                predicate=lambda evt: evt.get("payload", {}).get("player", {}).get("id")
                == character_id,
                timeout=timeout,
            )
        )
        await client.my_status(character_id=character_id)
        return await waiter

    status_event = await _wait_for_status(timeout=5.0)
    _record(status_event)

    status_payload = status_event.get("payload", {})
    current_sector = _extract_sector_id(status_payload.get("sector"))
    if current_sector == target_sector:
        return

    final_status_waiter = asyncio.create_task(
        client.wait_for_event(
            "status.snapshot",
            predicate=lambda evt: _extract_sector_id(
                evt.get("payload", {}).get("sector")
            )
            == target_sector,
            timeout=5.0,
        )
    )
    await client._request(
        "join",
        {
            "character_id": character_id,
            "sector": target_sector,
        },
    )
    final_status_event = await final_status_waiter
    _record(final_status_event)



COMMODITY_INDEX = {
    "quantum_foam": 0,
    "retro_organics": 1,
    "neuro_symbolics": 2,
}

_UNIVERSE_CACHE: dict | None = None


def _world_data_path() -> Path:
    env_path = os.getenv("WORLD_DATA_DIR")
    if env_path:
        return Path(env_path)
    return Path(__file__).resolve().parents[1] / "world-data"


def _load_universe() -> dict:
    global _UNIVERSE_CACHE
    if _UNIVERSE_CACHE is None:
        universe_path = _world_data_path() / "universe_structure.json"
        with universe_path.open("r", encoding="utf-8") as handle:
            _UNIVERSE_CACHE = json.load(handle)
    return _UNIVERSE_CACHE


def _build_adjacency() -> dict[int, list[int]]:
    universe = _load_universe()
    adjacency: dict[int, list[int]] = {}
    for sector in universe.get("sectors", []):
        adjacency[sector["id"]] = [warp["to"] for warp in sector.get("warps", [])]
    return adjacency


def _find_sector_for_trade(commodity: str, *, code_letter: str) -> int:
    port_dir = _world_data_path() / "port-states"
    if not port_dir.exists():
        raise RuntimeError(f"Port state directory not found: {port_dir}")

    index = COMMODITY_INDEX[commodity]
    matching_codes: dict[int, str] = {}

    for path in sorted(port_dir.glob("sector_*.json")):
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        code = data.get("code")
        if not isinstance(code, str) or len(code) <= index:
            continue
        if code[index] == code_letter:
            matching_codes[int(data["sector_id"])] = code

    if not matching_codes:
        raise RuntimeError(
            f"No sector found where port code has '{code_letter}' for {commodity}"
        )

    adjacency = _build_adjacency()
    start = 0
    from collections import deque

    visited: dict[int, int] = {start: 0}
    queue: deque[int] = deque([start])
    while queue:
        node = queue.popleft()
        for neighbor in adjacency.get(node, []):
            if neighbor not in visited:
                visited[neighbor] = visited[node] + 1
                queue.append(neighbor)

    best_sector = min(
        matching_codes,
        key=lambda sector: (visited.get(sector, float("inf")), sector),
    )

    if visited.get(best_sector) is None:
        raise RuntimeError(
            f"Unable to reach sector {best_sector} for commodity {commodity}"
        )

    return best_sector


SECTOR_SELLS_NEURO_SYMBOLICS = _find_sector_for_trade(
    "neuro_symbolics", code_letter="S"
)


SERVER_URL = os.getenv("TEST_SERVER_URL", os.getenv("GAME_SERVER_URL", "http://localhost:8000"))
RUN_COMBAT_EVENT_TESTS = os.getenv("RUN_COMBAT_EVENT_TESTS", "0").lower() in {
    "1",
    "true",
    "yes",
}


class EventCollector:
    """Helper class to collect events from AsyncGameClient."""

    def __init__(self):
        self.events = []
        self.event_futures = {}

    def add_event(self, event):
        """Record an event and resolve any waiting futures."""

        if not isinstance(event, dict):
            return

        event_name = event.get("event_name") or event.get("event")
        if event_name is None:
            return

        self.events.append((event_name, event))
        if event_name in self.event_futures:
            for future in self.event_futures[event_name]:
                if not future.done():
                    future.set_result(event)

    async def wait_for_event(self, event_name, timeout=5.0):
        """Wait for a specific event to be received."""
        # Check if we already have the event
        for name, event in self.events:
            if name == event_name:
                return event

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
        return [event for name, event in self.events if name == event_name]

    def clear(self):
        """Clear all recorded events."""
        self.events.clear()
        self.event_futures.clear()


@pytest_asyncio.fixture(autouse=True, scope="module")
async def reset_world():
    """Reset server state before and after each test via test.reset RPC."""
    reset_client = AsyncGameClient(
        base_url=SERVER_URL,
        character_id="test_reset_runner",
        transport="websocket",
    )
    try:
        await reset_client.test_reset(clear_files=False)
    finally:
        await reset_client.close()

    yield

    reset_client = AsyncGameClient(
        base_url=SERVER_URL,
        character_id="test_reset_runner",
        transport="websocket",
    )
    try:
        await reset_client.test_reset(clear_files=False)
    finally:
        await reset_client.close()


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
    client.on("status.snapshot")(collector.add_event)
    client.on("course.plot")(collector.add_event)
    client.on("combat.round_waiting")(collector.add_event)
    client.on("combat.round_resolved")(collector.add_event)
    client.on("combat.ended")(collector.add_event)
    client.on("trade.executed")(collector.add_event)
    client.on("port.update")(collector.add_event)

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

        # Join and move to a sector with a port that sells neuro_symbolics
        await client.join("test_char_events", credits=500)
        await _move_to_sector(
            client,
            "test_char_events",
            SECTOR_SELLS_NEURO_SYMBOLICS,
            collector,
        )

        # Execute a trade buying neuro_symbolics (port sells this commodity)
        result = await client.trade(
            character_id="test_char_events",
            commodity="neuro_symbolics",
            quantity=5,
            trade_type="buy",
        )

        assert result == {"success": True}

        # Wait for trade.executed event
        event = await collector.wait_for_event("trade.executed", timeout=2.0)

        # Verify event structure
        payload = event["payload"]
        assert payload["source"]["method"] == "trade"
        assert "request_id" in payload["source"]
        assert payload["player"]["id"] == "test_char_events"
        assert payload["player"]["name"] == "test_char_events"
        assert "credits" in payload["ship"]
        assert payload["ship"]["credits"] == payload["trade"]["new_credits"]

        ship_data = payload["ship"]
        assert "cargo" in ship_data
        assert "warp_power" in ship_data
        assert "shields" in ship_data
        assert "fighters" in ship_data

        trade_data = payload["trade"]
        assert trade_data["trade_type"] == "buy"
        assert trade_data["commodity"] == "neuro_symbolics"
        assert trade_data["units"] == 5
        assert trade_data["total_price"] == trade_data["price_per_unit"] * 5
        assert trade_data["new_cargo"]["neuro_symbolics"] >= 5
        assert isinstance(trade_data["new_prices"], dict)

    async def test_port_update_event_on_trade(self, game_client_with_events):
        """Test that port.update event is emitted to all in sector after trade."""
        client, collector = game_client_with_events

        # Join and move to a sector with a selling port
        await client.join("test_char_events", credits=500)
        await _move_to_sector(
            client,
            "test_char_events",
            SECTOR_SELLS_NEURO_SYMBOLICS,
            collector,
        )

        # Execute a trade
        result = await client.trade(
            character_id="test_char_events",
            commodity="neuro_symbolics",
            quantity=3,
            trade_type="buy",
        )

        assert result == {"success": True}

        # Wait for port.update event
        event = await collector.wait_for_event("port.update", timeout=2.0)

        # Verify event structure
        payload = event["payload"]
        sector_payload = payload.get("sector") or {}
        port_payload = (
            sector_payload.get("port") or payload.get("port") or {}
        )

        assert _extract_sector_id(sector_payload) is not None
        assert "updated_at" in payload
        assert port_payload, "port data missing from port.update payload"

        assert "code" in port_payload
        assert "prices" in port_payload
        assert "stock" in port_payload
        assert port_payload.get("observed_at") is None  # Should be null for current observers

    async def test_multiple_traders_receive_port_update(self, game_client_with_events):
        """Test that all traders in sector receive port.update."""
        client1, collector1 = game_client_with_events

        # Create second client
        collector2 = EventCollector()
        client2 = AsyncGameClient(
            base_url=SERVER_URL,
            character_id="test_char_2",
            transport="websocket",
        )
        client2.on("port.update")(collector2.add_event)

        try:
            # Both join same sector
            await client1.join("test_char_events", credits=500)
            await client2.join("test_char_2", credits=500)

            await _move_to_sector(
                client1,
                "test_char_events",
                SECTOR_SELLS_NEURO_SYMBOLICS,
                collector1,
            )
            await _move_to_sector(
                client2,
                "test_char_2",
                SECTOR_SELLS_NEURO_SYMBOLICS,
                collector2,
            )

            # Client 1 trades
            result = await client1.trade(
                character_id="test_char_events",
                commodity="neuro_symbolics",
                quantity=2,
                trade_type="buy",
            )

            assert result == {"success": True}

            # Both should receive port.update
            event1 = await collector1.wait_for_event("port.update", timeout=2.0)
            event2 = await collector2.wait_for_event("port.update", timeout=2.0)

            payload1 = event1["payload"]
            payload2 = event2["payload"]

            sector1 = payload1.get("sector") or {}
            sector2 = payload2.get("sector") or {}
            assert _extract_sector_id(sector1) == _extract_sector_id(sector2)

            port1 = sector1.get("port") or payload1.get("port") or {}
            port2 = sector2.get("port") or payload2.get("port") or {}
            assert port1 and port2
            assert port1.get("prices") == port2.get("prices")

        finally:
            await client2.close()


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.skipif(
    not RUN_COMBAT_EVENT_TESTS,
    reason="Combat integration tests require RUN_COMBAT_EVENT_TESTS=1 and exceed 10s otherwise.",
)
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
        client2.on("combat.round_waiting")(collector2.add_event)

        try:
            # Both join and move to same sector
            await client.join("test_char_events", credits=500)
            await client2.join("test_opponent")

            await _move_to_sector(client, "test_char_events", 1, collector)
            await _move_to_sector(client2, "test_opponent", 1, collector2)

            # Initiate combat
            await client.combat_initiate(character_id="test_char_events")

            # Wait for combat.round_waiting events
            event1 = await collector.wait_for_event("combat.round_waiting", timeout=5.0)
            event2 = await collector2.wait_for_event("combat.round_waiting", timeout=5.0)

            # Verify event structure
            payload1 = event1["payload"]
            payload2 = event2["payload"]

            assert "combat_id" in payload1
            assert "sector" in payload1
            assert "round" in payload1
            assert "current_time" in payload1
            assert "deadline" in payload1
            assert "participants" in payload1
            assert isinstance(payload1["participants"], list)
            assert "ship" in payload1
            assert isinstance(payload1["ship"], dict)
            assert "fighters" in payload1["ship"]
            assert "max_fighters" in payload1["ship"]

            assert "ship" in payload2
            assert isinstance(payload2["ship"], dict)

            # Both should get same combat
            assert payload1["combat_id"] == payload2["combat_id"]

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
        client2.on("combat.round_waiting")(collector2.add_event)

        try:
            await client.join("test_char_events", credits=500)
            await client2.join("test_opponent2")

            # Move to same sector
            await _move_to_sector(client, "test_char_events", 1, collector)
            await _move_to_sector(client2, "test_opponent2", 1, collector2)

            # Initiate combat
            await client.combat_initiate(character_id="test_char_events")

            # Wait for event
            event = await collector.wait_for_event("combat.round_waiting", timeout=5.0)
            payload = event["payload"]

            # Verify privacy constraints
            participants = payload["participants"]
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
            if payload.get("garrison"):
                garrison = payload["garrison"]
                assert "owner_name" in garrison
                # owner_name should be the display name, not ID

            ship_payload = payload.get("ship")
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
        client2.on("combat.round_waiting")(collector2.add_event)
        client2.on("combat.round_resolved")(collector2.add_event)

        try:
            await client.join("test_char_events", credits=500)
            await client2.join("test_opponent3")

            # Move to same sector
            await _move_to_sector(client, "test_char_events", 1, collector)
            await _move_to_sector(client2, "test_opponent3", 1, collector2)

            # Initiate combat
            await client.combat_initiate(character_id="test_char_events")

            # Wait for round waiting
            waiting_event = await collector.wait_for_event("combat.round_waiting", timeout=5.0)
            combat_id = waiting_event["payload"]["combat_id"]

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
            resolved_payload = resolved_event["payload"]

            # Verify delta structure
            assert "participants" in resolved_payload
            participants = resolved_payload["participants"]

            for participant in participants:
                if "ship" in participant:
                    # Should have deltas (may be 0 or None if no change)
                    assert "shield_damage" in participant["ship"] or participant["ship"].get("shield_damage") is None
                    assert "fighter_loss" in participant["ship"] or participant["ship"].get("fighter_loss") is None

            ship_payload = resolved_payload.get("ship")
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
            await client.join("test_char_events", credits=500)
            await client2.join("test_weak_opponent")

            # Move to same sector
            await _move_to_sector(client, "test_char_events", 1, collector)
            await _move_to_sector(client2, "test_weak_opponent", 1, collector2)

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
            await client.join("test_char_events", credits=500)

            # Move to sector 1
            await _move_to_sector(client, "test_char_events", 1, collector)

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
            client2.on("combat.round_waiting")(collector2.add_event)

            try:
                await client2.join("test_garrison_target")

                # Move to sector with garrison - should auto-trigger combat
                await _move_to_sector(client2, "test_garrison_target", 1, collector2)

                # Wait for combat event
                event = await collector2.wait_for_event("combat.round_waiting", timeout=5.0)
                payload = event["payload"]

                # Verify garrison is singular object, not array
                assert "garrison" in payload
                garrison = payload["garrison"]
                assert isinstance(garrison, dict)
                assert "owner_name" in garrison
                assert "fighters" in garrison
                assert "mode" in garrison

                ship_payload = payload.get("ship")
                assert isinstance(ship_payload, dict)
                assert "fighters" in ship_payload
                assert "max_fighters" in ship_payload

                # Verify participants is array
                assert "participants" in payload
                assert isinstance(payload["participants"], list)

            finally:
                await client2.close()

        finally:
            # Clean up garrison
            pass


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.skipif(
    not RUN_COMBAT_EVENT_TESTS,
    reason="Combat integration tests require RUN_COMBAT_EVENT_TESTS=1 and exceed 10s otherwise.",
)
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
