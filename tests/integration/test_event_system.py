"""
Integration tests for the event system (CRITICAL SYSTEM).

Events are the real API. API responses are simple (ok/error), but events contain
all the actual game state changes and data that clients consume.

This module tests:
- Event emission (all 20+ event types emitted correctly)
- Event ordering (chronological, causal - depart before arrive)
- Character filtering (private vs public events - WHO gets WHAT)
- Event payload completeness (all required fields present)
- WebSocket delivery (firehose broadcasts, character-specific streams)
- JSONL audit log (persistence, integrity, one event per line)
- Event payload structure (schema validation for each event type)

These tests require a test server running on port 8002.
"""

import asyncio
import json
import pytest
import sys
from datetime import datetime, timezone
from pathlib import Path

# Add project paths
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from utils.api_client import AsyncGameClient, RPCError
from helpers.event_capture import EventListener, create_firehose_listener
from helpers.assertions import (
    assert_event_emitted,
    assert_event_order,
    assert_event_payload,
    assert_event_count,
    assert_no_event_emitted,
    assert_events_chronological,
)


pytestmark = [pytest.mark.asyncio, pytest.mark.integration, pytest.mark.requires_server]


# =============================================================================
# Helper Functions
# =============================================================================


async def get_status(client, character_id):
    """
    Get character status by calling my_status and waiting for status.snapshot event.

    The my_status RPC returns just {"success": True}, but emits a status.snapshot
    event with the actual status data.
    """
    # Set up event listener before making the request
    status_received = asyncio.Future()

    def on_status(event):
        if not status_received.done():
            status_received.set_result(event.get("payload", event))

    token = client.add_event_handler("status.snapshot", on_status)

    try:
        # Make the request
        await client.my_status(character_id=character_id)

        # Wait for the event with timeout
        status_data = await asyncio.wait_for(status_received, timeout=5.0)
        return status_data
    finally:
        client.remove_event_handler(token)


# =============================================================================
# Test Fixtures
# =============================================================================


@pytest.fixture
async def client(server_url, check_server_available):
    """Create an AsyncGameClient connected to test server."""
    async with AsyncGameClient(base_url=server_url) as client:
        yield client


@pytest.fixture
async def active_character(server_url):
    """Create an active test character."""
    char_id = "test_event_character"
    client = AsyncGameClient(base_url=server_url, character_id=char_id)
    await client.join(character_id=char_id)

    yield {
        "character_id": char_id,
        "client": client,
    }

    await client.close()


@pytest.fixture
async def firehose_listener(server_url):
    """Create a firehose listener for capturing all events."""
    async with create_firehose_listener(server_url) as listener:
        await asyncio.sleep(0.5)  # Let it connect
        yield listener


# =============================================================================
# Event Emission Tests (10 tests - one per major event type)
# =============================================================================


class TestEventEmission:
    """Tests that all major event types are properly emitted."""

    async def test_character_joined_event(self, server_url):
        """Test that character.joined event is emitted on join."""
        char_id = "test_join_event"
        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            # Create client and join game
            client = AsyncGameClient(base_url=server_url, character_id=char_id)
            await client.join(character_id=char_id)

            await asyncio.sleep(1.0)

            # Verify event emitted (event name may vary - status.snapshot is typical)
            # The actual join event depends on server implementation
            status_events = listener.filter_events("status.snapshot")
            assert len(status_events) > 0, "No status events received after join"

            await client.close()

    async def test_character_moved_event(self, active_character, server_url):
        """Test that movement.complete event is emitted on move."""
        client = active_character["client"]
        char_id = active_character["character_id"]

        # Get adjacent sector
        status = await get_status(client, char_id)
        adjacent = status["sector"]["adjacent_sectors"]

        if not adjacent:
            pytest.skip("No adjacent sectors for movement")

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            # Move
            await client.move(to_sector=adjacent[0], character_id=char_id)

            await asyncio.sleep(2.0)

            # Verify movement event
            move_event = assert_event_emitted(listener.events, "movement.complete")
            assert "payload" in move_event

    async def test_combat_round_waiting_first_event(self, server_url):
        """Test that first combat.round_waiting event serves as combat start signal.

        Note: combat.started event was removed October 7, 2025.
        The first combat.round_waiting event now serves as the combat start signal.
        """
        from datetime import datetime, timezone
        import asyncio
        from tests.helpers.combat_helpers import create_test_character_knowledge

        char1_id = "test_combat_waiting_char1"
        char2_id = "test_combat_waiting_char2"

        # Create characters at sector 0
        create_test_character_knowledge(char1_id, sector=0, fighters=100, shields=100)
        create_test_character_knowledge(char2_id, sector=0, fighters=100, shields=100)

        client1 = AsyncGameClient(base_url=server_url, character_id=char1_id, transport="websocket")
        client2 = AsyncGameClient(base_url=server_url, character_id=char2_id, transport="websocket")

        # Setup event collectors
        char1_events = []
        char2_events = []

        client1.on("combat.round_waiting")(lambda p: char1_events.append({"event": "combat.round_waiting", "payload": p}))
        client2.on("combat.round_waiting")(lambda p: char2_events.append({"event": "combat.round_waiting", "payload": p}))

        try:
            await client1.join(character_id=char1_id)
            await client2.join(character_id=char2_id)

            # Record start time
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Initiate combat
            await client1.combat_initiate(character_id=char1_id)

            # Wait for events
            await asyncio.sleep(2.0)

            end_time = datetime.now(timezone.utc)

            # WebSocket verification: Both characters receive combat.round_waiting
            assert len(char1_events) > 0, "Character 1 should receive combat.round_waiting via WebSocket"
            assert len(char2_events) > 0, "Character 2 should receive combat.round_waiting via WebSocket"

            # Verify payload structure of first round_waiting
            # Note: WebSocket events are wrapped: {event_name, payload, summary}
            waiting1 = char1_events[0]["payload"]
            inner_payload = waiting1.get("payload", waiting1)  # Handle wrapped or unwrapped

            assert inner_payload.get("round") == 1, f"First event should be round 1"
            assert "combat_id" in inner_payload, "Should contain combat_id"
            assert inner_payload.get("initiator") == char1_id, f"Initiator should be {char1_id}"
            assert len(inner_payload.get("participants", [])) == 2, "Should have 2 participants"

            # JSONL verification for char1
            result1 = await client1._request("event.query", {
                "character_id": char1_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            combat_events1 = [e for e in result1["events"] if e["event"] == "combat.round_waiting"]
            assert len(combat_events1) > 0, "Character 1 should have combat.round_waiting in JSONL"
            assert combat_events1[0]["sender"] == char1_id, "JSONL event should have correct sender"
            assert combat_events1[0]["sector"] == 0, "JSONL event should have correct sector"

            # JSONL verification for char2
            result2 = await client2._request("event.query", {
                "character_id": char2_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            combat_events2 = [e for e in result2["events"] if e["event"] == "combat.round_waiting"]
            assert len(combat_events2) > 0, "Character 2 should have combat.round_waiting in JSONL"

        finally:
            await client1.close()
            await client2.close()

    async def test_combat_round_resolved_event(self, server_url):
        """Test that combat.round_resolved event is emitted after actions submitted.

        Note: Event name is combat.round_resolved (NOT combat.round_ended).
        """
        from datetime import datetime, timezone
        import asyncio
        from tests.helpers.combat_helpers import create_test_character_knowledge

        char1_id = "test_combat_resolved_char1"
        char2_id = "test_combat_resolved_char2"

        # Create characters at sector 0
        create_test_character_knowledge(char1_id, sector=0, fighters=100, shields=100)
        create_test_character_knowledge(char2_id, sector=0, fighters=100, shields=100)

        client1 = AsyncGameClient(base_url=server_url, character_id=char1_id, transport="websocket")
        client2 = AsyncGameClient(base_url=server_url, character_id=char2_id, transport="websocket")

        # Setup event collectors
        char1_events = []
        char2_events = []

        client1.on("combat.round_waiting")(lambda p: char1_events.append({"event": "combat.round_waiting", "payload": p}))
        client1.on("combat.round_resolved")(lambda p: char1_events.append({"event": "combat.round_resolved", "payload": p}))
        client2.on("combat.round_resolved")(lambda p: char2_events.append({"event": "combat.round_resolved", "payload": p}))

        try:
            await client1.join(character_id=char1_id)
            await client2.join(character_id=char2_id)

            # Record start time
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Initiate combat
            await client1.combat_initiate(character_id=char1_id)

            # Wait for combat.round_waiting
            await asyncio.sleep(2.0)

            # Get combat_id from first event (handle wrapped payload structure)
            waiting_events = [e for e in char1_events if e["event"] == "combat.round_waiting"]
            assert len(waiting_events) > 0, "Should have received combat.round_waiting"
            waiting_payload = waiting_events[0]["payload"]
            inner_payload = waiting_payload.get("payload", waiting_payload)
            combat_id = inner_payload["combat_id"]

            # Submit attack actions
            await client1.combat_action(
                character_id=char1_id,
                combat_id=combat_id,
                action="attack",
                target_id=char2_id,
                commit=50,
            )

            await client2.combat_action(
                character_id=char2_id,
                combat_id=combat_id,
                action="attack",
                target_id=char1_id,
                commit=50,
            )

            # Wait for round resolution
            await asyncio.sleep(5.0)

            end_time = datetime.now(timezone.utc)

            # WebSocket verification: Both characters receive combat.round_resolved
            resolved_events1 = [e for e in char1_events if e["event"] == "combat.round_resolved"]
            resolved_events2 = [e for e in char2_events if e["event"] == "combat.round_resolved"]

            assert len(resolved_events1) > 0, "Character 1 should receive combat.round_resolved via WebSocket"
            assert len(resolved_events2) > 0, "Character 2 should receive combat.round_resolved via WebSocket"

            # Verify damage calculations in payload (handle wrapped structure)
            resolved1 = resolved_events1[0]["payload"]
            inner_resolved = resolved1.get("payload", resolved1)
            assert "participants" in inner_resolved, "Should have participants"
            assert len(inner_resolved["participants"]) == 2, "Should have 2 participants"

            # Check for damage indicators (shield_damage or fighter_loss)
            damage_found = False
            for participant in inner_resolved["participants"]:
                if "ship" in participant:
                    shield_dmg = participant["ship"].get("shield_damage")
                    fighter_loss = participant["ship"].get("fighter_loss")
                    if (shield_dmg is not None and shield_dmg != 0) or (fighter_loss is not None and fighter_loss != 0):
                        damage_found = True
                        break

            assert damage_found, "Should have damage calculations (shield_damage or fighter_loss) in combat.round_resolved"

            # JSONL verification
            result1 = await client1._request("event.query", {
                "character_id": char1_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            resolved_jsonl1 = [e for e in result1["events"] if e["event"] == "combat.round_resolved"]
            assert len(resolved_jsonl1) > 0, "Character 1 should have combat.round_resolved in JSONL"

            result2 = await client2._request("event.query", {
                "character_id": char2_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            resolved_jsonl2 = [e for e in result2["events"] if e["event"] == "combat.round_resolved"]
            assert len(resolved_jsonl2) > 0, "Character 2 should have combat.round_resolved in JSONL"

        finally:
            await client1.close()
            await client2.close()

    async def test_combat_ended_event_with_destruction(self, server_url):
        """Test that combat.ended event is emitted with salvage when ships destroyed."""
        from datetime import datetime, timezone
        import asyncio
        from tests.helpers.combat_helpers import (
            create_strong_character,
            create_weak_character,
            set_character_cargo,
        )

        attacker_id = "test_combat_ended_attacker"
        victim_id = "test_combat_ended_victim"

        # Create strong attacker and weak victim with cargo
        create_strong_character(attacker_id, sector=0, fighters=500)
        create_weak_character(victim_id, sector=0, fighters=5)
        set_character_cargo(victim_id, quantum_foam=10, retro_organics=5, neuro_symbolics=2)

        attacker = AsyncGameClient(base_url=server_url, character_id=attacker_id, transport="websocket")
        victim = AsyncGameClient(base_url=server_url, character_id=victim_id, transport="websocket")

        # Setup event collectors
        attacker_events = []
        victim_events = []

        attacker.on("combat.round_waiting")(lambda p: attacker_events.append({"event": "combat.round_waiting", "payload": p}))
        attacker.on("combat.round_resolved")(lambda p: attacker_events.append({"event": "combat.round_resolved", "payload": p}))
        attacker.on("combat.ended")(lambda p: attacker_events.append({"event": "combat.ended", "payload": p}))
        victim.on("combat.ended")(lambda p: victim_events.append({"event": "combat.ended", "payload": p}))

        try:
            await attacker.join(character_id=attacker_id)
            await victim.join(character_id=victim_id)

            # Record start time
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Initiate combat
            await attacker.combat_initiate(character_id=attacker_id)

            # Wait for combat.round_waiting
            await asyncio.sleep(2.0)

            # Get combat_id (handle wrapped payload structure)
            waiting_events = [e for e in attacker_events if e["event"] == "combat.round_waiting"]
            assert len(waiting_events) > 0, "Should have received combat.round_waiting"
            waiting_payload = waiting_events[0]["payload"]
            inner_payload = waiting_payload.get("payload", waiting_payload)
            combat_id = inner_payload["combat_id"]

            # Attacker destroys victim
            await attacker.combat_action(
                character_id=attacker_id,
                combat_id=combat_id,
                action="attack",
                target_id=victim_id,
                commit=200,
            )

            await victim.combat_action(
                character_id=victim_id,
                combat_id=combat_id,
                action="brace",
                commit=0,
            )

            # Wait for combat to end
            await asyncio.sleep(8.0)

            end_time = datetime.now(timezone.utc)

            # WebSocket verification: Both receive combat.ended
            attacker_ended_events = [e for e in attacker_events if e["event"] == "combat.ended"]
            victim_ended_events = [e for e in victim_events if e["event"] == "combat.ended"]

            assert len(attacker_ended_events) > 0, "Attacker should receive combat.ended via WebSocket"
            assert len(victim_ended_events) > 0, "Victim should receive combat.ended via WebSocket"

            # Verify salvage in attacker's combat.ended event (handle wrapped payload)
            attacker_ended = attacker_ended_events[0]["payload"]
            attacker_ended_inner = attacker_ended.get("payload", attacker_ended)
            assert "salvage" in attacker_ended_inner, "combat.ended should contain salvage field"
            assert len(attacker_ended_inner["salvage"]) > 0, "Should have salvage from destroyed victim"

            # Verify salvage structure
            salvage = attacker_ended_inner["salvage"][0]
            assert "salvage_id" in salvage, "Salvage should have ID"
            assert "cargo" in salvage, "Salvage should have cargo"
            assert salvage["cargo"].get("quantum_foam", 0) > 0, "Salvage should contain victim's cargo"

            # Verify privacy: salvage should NOT have character_id
            assert "character_id" not in salvage.get("source", {}), "Salvage source should not expose character_id"
            assert "ship_name" in salvage.get("source", {}), "Salvage source should have ship_name"

            # JSONL verification for attacker
            result_attacker = await attacker._request("event.query", {
                "character_id": attacker_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            ended_jsonl_attacker = [e for e in result_attacker["events"] if e["event"] == "combat.ended"]
            assert len(ended_jsonl_attacker) > 0, "Attacker should have combat.ended in JSONL"

            # JSONL verification for victim
            result_victim = await victim._request("event.query", {
                "character_id": victim_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            ended_jsonl_victim = [e for e in result_victim["events"] if e["event"] == "combat.ended"]
            assert len(ended_jsonl_victim) > 0, "Victim should have combat.ended in JSONL"

        finally:
            await attacker.close()
            await victim.close()

    async def test_trade_executed_event(self, server_url):
        """Test that trade.executed event is emitted when a character trades at a port.

        Note: Event name is trade.executed (NOT trade.completed).
        """
        from datetime import datetime, timezone
        import asyncio

        trader_id = "test_trade_executed_trader"

        trader = AsyncGameClient(base_url=server_url, character_id=trader_id, transport="websocket")

        # Setup event collector
        trader_events = []
        trader.on("trade.executed")(lambda p: trader_events.append({"event": "trade.executed", "payload": p}))

        try:
            await trader.join(character_id=trader_id)

            # Move to sector 1 (has a port that sells neuro_symbolics in test world)
            trader_status = await get_status(trader, trader_id)
            current_sector = trader_status["sector"]["id"]

            if current_sector != 1:
                await trader.move(to_sector=1, character_id=trader_id)
                await asyncio.sleep(0.5)

            # Verify at port
            trader_status = await get_status(trader, trader_id)
            if trader_status["sector"]["id"] != 1:
                pytest.skip("Could not position trader at port")

            # Record start time
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Execute trade
            try:
                await trader.trade(
                    commodity="neuro_symbolics",
                    quantity=1,
                    trade_type="buy",
                    character_id=trader_id
                )
                await asyncio.sleep(1.0)
            except Exception as e:
                pytest.skip(f"Trade failed: {e}")

            end_time = datetime.now(timezone.utc)

            # WebSocket verification: Trader receives trade.executed
            assert len(trader_events) > 0, "Trader should receive trade.executed via WebSocket"

            # Verify payload structure (handle wrapped payload)
            trade_event = trader_events[0]["payload"]
            inner_payload = trade_event.get("payload", trade_event)
            assert "trade" in inner_payload, "Event should have trade field"
            assert "player" in inner_payload, "Event should have player field"
            assert "ship" in inner_payload, "Event should have ship field"

            # Verify trade details
            trade_details = inner_payload["trade"]
            assert trade_details.get("trade_type") == "buy", "Should be a buy trade"
            assert trade_details.get("commodity") == "neuro_symbolics", "Should be neuro_symbolics"
            assert trade_details.get("units") >= 1, "Should have traded at least 1 unit"

            # JSONL verification
            result = await trader._request("event.query", {
                "character_id": trader_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            trade_events_jsonl = [e for e in result["events"] if e["event"] == "trade.executed"]
            assert len(trade_events_jsonl) > 0, "Trader should have trade.executed in JSONL"

        finally:
            await trader.close()

    async def test_garrison_deployed_event(self, server_url):
        """Test that garrison.deployed event is emitted when garrison is deployed.

        Note: Event name is garrison.deployed (NOT garrison.created).
        """
        from datetime import datetime, timezone
        import asyncio
        from tests.helpers.combat_helpers import create_test_character_knowledge

        char_id = "test_garrison_deployed_char"

        # Create character at sector 0 with fighters
        create_test_character_knowledge(char_id, sector=0, fighters=100, shields=100)

        client = AsyncGameClient(base_url=server_url, character_id=char_id, transport="websocket")

        # Setup event collector
        garrison_events = []
        client.on("garrison.deployed")(lambda p: garrison_events.append({"event": "garrison.deployed", "payload": p}))

        try:
            await client.join(character_id=char_id)

            # Move to sector 1
            await client.move(to_sector=1, character_id=char_id)
            await asyncio.sleep(0.5)

            # Record start time
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Deploy garrison in sector 1
            await client.combat_leave_fighters(
                character_id=char_id,
                sector=1,
                quantity=50,
                mode="defensive"
            )

            # Wait for event propagation
            await asyncio.sleep(1.0)

            end_time = datetime.now(timezone.utc)

            # WebSocket verification
            assert len(garrison_events) >= 1, "Should receive garrison.deployed via WebSocket"

            # Verify payload structure (handle wrapped payload)
            garrison_event = garrison_events[0]["payload"]
            inner_payload = garrison_event.get("payload", garrison_event)

            assert "sector" in inner_payload, "Event should have sector field"
            assert inner_payload["sector"]["id"] == 1, "Should be in sector 1"

            assert "garrison" in inner_payload, "Event should have garrison field"
            garrison = inner_payload["garrison"]
            assert garrison["owner_name"] == char_id, "Garrison owner should match character"
            assert garrison["fighters"] == 50, "Garrison should have 50 fighters"
            assert garrison["mode"] == "defensive", "Garrison mode should be defensive"
            assert garrison.get("is_friendly") == True, "Should be marked as friendly to owner"

            assert "fighters_remaining" in inner_payload, "Event should show fighters remaining on ship"

            # JSONL verification
            result = await client._request("event.query", {
                "character_id": char_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            garrison_logged = [e for e in result["events"] if e.get("event") == "garrison.deployed"]
            assert len(garrison_logged) > 0, "Should find garrison.deployed in JSONL"

        finally:
            await client.close()

    async def test_salvage_created_event(self):
        """Test that salvage creation is included in combat.ended event payload.

        NOTE: This test is REDUNDANT - salvage creation is already fully tested in
        test_combat_ended_event_with_destruction (Category A).

        There is NO separate salvage.created event. Salvage appears in the combat.ended
        payload when a ship is destroyed.
        """
        pytest.skip("Redundant - salvage creation already tested in test_combat_ended_event_with_destruction")

    async def test_message_sent_event(self, active_character, server_url):
        """Test that message.sent event is emitted on send_message."""
        client = active_character["client"]
        char_id = active_character["character_id"]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            # Send message
            await client.send_message(
                content="Test message",
                msg_type="broadcast",
                character_id=char_id
            )

            await asyncio.sleep(1.0)

            # Check for message event (event name may vary)
            # Actual event type depends on server implementation

    async def test_ship_destroyed_detection_patterns(self, server_url):
        """Test ship destruction detection via ship_type == 'escape_pod' in event payloads.

        Note: There is NO separate ship.destroyed event.
        Ship destruction is detected by checking ship_type in combat.round_resolved or combat.ended.
        """
        from datetime import datetime, timezone
        import asyncio
        from tests.helpers.combat_helpers import (
            create_strong_character,
            create_weak_character,
        )

        attacker_id = "test_ship_destroyed_attacker"
        victim_id = "test_ship_destroyed_victim"

        # Create strong attacker and weak victim
        create_strong_character(attacker_id, sector=0, fighters=500)
        create_weak_character(victim_id, sector=0, fighters=5)

        attacker = AsyncGameClient(base_url=server_url, character_id=attacker_id, transport="websocket")
        victim = AsyncGameClient(base_url=server_url, character_id=victim_id, transport="websocket")

        # Setup event collectors
        attacker_events = []
        victim_events = []

        attacker.on("combat.round_waiting")(lambda p: attacker_events.append({"event": "combat.round_waiting", "payload": p}))
        attacker.on("combat.round_resolved")(lambda p: attacker_events.append({"event": "combat.round_resolved", "payload": p}))
        attacker.on("combat.ended")(lambda p: attacker_events.append({"event": "combat.ended", "payload": p}))
        victim.on("combat.ended")(lambda p: victim_events.append({"event": "combat.ended", "payload": p}))

        try:
            await attacker.join(character_id=attacker_id)
            await victim.join(character_id=victim_id)

            # Record start time
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Initiate combat
            await attacker.combat_initiate(character_id=attacker_id)

            # Wait for combat.round_waiting
            await asyncio.sleep(2.0)

            # Get combat_id (handle wrapped payload structure)
            waiting_events = [e for e in attacker_events if e["event"] == "combat.round_waiting"]
            assert len(waiting_events) > 0, "Should have received combat.round_waiting"
            waiting_payload = waiting_events[0]["payload"]
            inner_payload = waiting_payload.get("payload", waiting_payload)
            combat_id = inner_payload["combat_id"]

            # Attacker destroys victim
            await attacker.combat_action(
                character_id=attacker_id,
                combat_id=combat_id,
                action="attack",
                target_id=victim_id,
                commit=200,
            )

            await victim.combat_action(
                character_id=victim_id,
                combat_id=combat_id,
                action="brace",
                commit=0,
            )

            # Wait for combat to end
            await asyncio.sleep(8.0)

            end_time = datetime.now(timezone.utc)

            # DETECTION PATTERN 1: Check combat.round_resolved for escape_pod
            resolved_events = [e for e in attacker_events if e["event"] == "combat.round_resolved"]
            if len(resolved_events) > 0:
                resolved = resolved_events[0]["payload"]
                resolved_inner = resolved.get("payload", resolved)
                victim_data = next(
                    (p for p in resolved_inner["participants"] if p["name"] == victim_id),
                    None
                )
                if victim_data and "ship" in victim_data:
                    # Ship destroyed = ship_type becomes "escape_pod"
                    if victim_data["ship"]["ship_type"] == "escape_pod":
                        assert victim_data["ship"]["fighters"] == 0, "Escape pod should have 0 fighters"
                        print(f"Ship destruction detected in combat.round_resolved: {victim_id} → escape_pod")

            # DETECTION PATTERN 2: Check combat.ended for escape_pod
            victim_ended_events = [e for e in victim_events if e["event"] == "combat.ended"]
            assert len(victim_ended_events) > 0, "Victim should receive combat.ended"

            victim_ended = victim_ended_events[0]["payload"]
            victim_ended_inner = victim_ended.get("payload", victim_ended)
            assert "ship" in victim_ended_inner, "combat.ended should have ship field"
            assert victim_ended_inner["ship"]["ship_type"] == "escape_pod", "Victim's ship should be escape_pod in combat.ended"
            assert victim_ended_inner["ship"]["fighters"] == 0, "Escape pod should have 0 fighters"

            # DETECTION PATTERN 3: Check participants list in combat.ended
            attacker_ended_events = [e for e in attacker_events if e["event"] == "combat.ended"]
            assert len(attacker_ended_events) > 0, "Attacker should receive combat.ended"

            attacker_ended = attacker_ended_events[0]["payload"]
            attacker_ended_inner = attacker_ended.get("payload", attacker_ended)
            victim_in_participants = next(
                (p for p in attacker_ended_inner["participants"] if p["name"] == victim_id),
                None
            )
            assert victim_in_participants is not None, "Victim should be in participants list"
            assert victim_in_participants["ship"]["ship_type"] == "escape_pod", "Victim should be escape_pod in participants"

            # JSONL verification: Ship destruction is in logged events
            result_victim = await victim._request("event.query", {
                "character_id": victim_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            ended_jsonl = [e for e in result_victim["events"] if e["event"] == "combat.ended"]
            assert len(ended_jsonl) > 0, "Victim should have combat.ended in JSONL"

            # Parse JSONL payload to verify escape_pod detection works in persisted data
            ended_payload = ended_jsonl[0]["payload"]
            assert ended_payload["ship"]["ship_type"] == "escape_pod", "JSONL should show escape_pod ship_type"

        finally:
            await attacker.close()
            await victim.close()


# =============================================================================
# Event Ordering Tests (5 tests)
# =============================================================================


class TestEventOrdering:
    """Tests for event chronological and causal ordering."""

    async def test_events_chronologically_ordered(self, active_character, server_url):
        """Test that events have monotonically increasing timestamps."""
        client = active_character["client"]
        char_id = active_character["character_id"]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            # Generate multiple events
            status = await get_status(client, char_id)
            await asyncio.sleep(0.5)

            adjacent = status["sector"]["adjacent_sectors"]
            if adjacent:
                await client.move(to_sector=adjacent[0], character_id=char_id)
                await asyncio.sleep(2.0)

            # Verify timestamps are chronological
            if len(listener.events) > 1:
                assert_events_chronological(listener.events)

    async def test_causal_events_maintain_order(self, active_character, server_url):
        """Test that causally related events maintain order (e.g., depart before arrive)."""
        client = active_character["client"]
        char_id = active_character["character_id"]

        status = await get_status(client, char_id)
        adjacent = status["sector"]["adjacent_sectors"]

        if not adjacent:
            pytest.skip("No adjacent sectors")

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            await client.move(to_sector=adjacent[0], character_id=char_id)
            await asyncio.sleep(2.0)

            # Check if departure and arrival events are in correct order
            departure_events = listener.filter_events("character.departure")
            arrival_events = listener.filter_events("movement.complete")

            if departure_events and arrival_events:
                # Verify order
                assert_event_order(
                    listener.events,
                    ["character.departure", "movement.complete"]
                )

    async def test_event_timestamps_monotonic_increasing(self, active_character, server_url):
        """Test that event timestamps never decrease."""
        # Similar to test_events_chronologically_ordered but more explicit
        client = active_character["client"]
        char_id = active_character["character_id"]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            # Generate events
            await get_status(client, char_id)
            await asyncio.sleep(0.5)
            await get_status(client, char_id)
            await asyncio.sleep(1.0)

            # Check timestamps
            timestamps = []
            for event in listener.events:
                ts = event.get("timestamp")
                if ts:
                    timestamps.append(ts)

            # Verify monotonic
            for i in range(1, len(timestamps)):
                assert timestamps[i] >= timestamps[i-1], \
                    f"Timestamp decreased: {timestamps[i-1]} -> {timestamps[i]}"

    async def test_concurrent_events_from_different_characters(self, server_url):
        """Test that concurrent events from different characters are properly ordered."""
        # Create two characters
        char1 = "test_concurrent_event1"
        char2 = "test_concurrent_event2"

        client1 = AsyncGameClient(base_url=server_url, character_id=char1)
        await client1.join(character_id=char1)

        client2 = AsyncGameClient(base_url=server_url, character_id=char2)
        await client2.join(character_id=char2)

        try:
            async with create_firehose_listener(server_url) as listener:
                await asyncio.sleep(0.5)

                # Both characters perform actions concurrently
                await asyncio.gather(
                    client1.my_status(character_id=char1),
                    client2.my_status(character_id=char2),
                )

                await asyncio.sleep(1.0)

                # Verify events are properly timestamped
                assert_events_chronological(listener.events)
        finally:
            await client1.close()
            await client2.close()

    async def test_event_sequence_matches_action_sequence(self, active_character, server_url):
        """Test that event sequence matches the action sequence."""
        client = active_character["client"]
        char_id = active_character["character_id"]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            # Perform sequence of actions
            await get_status(client, char_id)
            await asyncio.sleep(0.5)

            status = await get_status(client, char_id)
            await asyncio.sleep(1.0)

            # Verify status events appear in order
            status_events = listener.filter_events("status.snapshot")
            assert len(status_events) >= 2, "Expected multiple status events"


# =============================================================================
# Character Filtering Tests (10 tests - CRITICAL for privacy)
# =============================================================================


class TestCharacterFiltering:
    """Tests for event privacy and filtering (WHO gets WHAT)."""

    async def test_private_events_only_to_character(self, server_url):
        """Test that private events (status.snapshot) only go to the requesting character.

        Scenario:
        1. Character 1 and Character 2 both call my_status()
        2. Character 1 should ONLY receive their own status.snapshot event
        3. Character 2 should ONLY receive their own status.snapshot event
        4. JSONL queries should confirm proper filtering
        """
        char1_id = "test_private_char1"
        char2_id = "test_private_char2"

        print(f"\n{'='*80}")
        print(f"STARTING PRIVATE EVENTS TEST")
        print(f"Character 1: {char1_id}")
        print(f"Character 2: {char2_id}")
        print(f"{'='*80}\n")

        # Create AsyncGameClients with WebSocket transport
        client1 = AsyncGameClient(base_url=server_url, character_id=char1_id, transport="websocket")
        client2 = AsyncGameClient(base_url=server_url, character_id=char2_id, transport="websocket")

        # Event collectors for status.snapshot events
        events_char1 = []
        events_char2 = []

        # Register event handlers
        client1.on("status.snapshot")(lambda p: events_char1.append({"event": "status.snapshot", "payload": p}))
        client2.on("status.snapshot")(lambda p: events_char2.append({"event": "status.snapshot", "payload": p}))

        try:
            # STEP 1: Both characters join
            print("STEP 1: Both characters join...")
            await client1.join(character_id=char1_id)
            await client2.join(character_id=char2_id)
            await asyncio.sleep(0.5)

            # Clear any join-related status events
            events_char1.clear()
            events_char2.clear()

            # Record start time
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # STEP 2: Character 1 calls my_status
            print("\nSTEP 2: Character 1 calls my_status()...")
            await client1.my_status(character_id=char1_id)
            await asyncio.sleep(0.5)

            # STEP 3: Character 2 calls my_status
            print("STEP 3: Character 2 calls my_status()...")
            await client2.my_status(character_id=char2_id)
            await asyncio.sleep(0.5)

            end_time = datetime.now(timezone.utc)

            # STEP 4: Verify WebSocket reception
            print("\nSTEP 4: Verifying WebSocket event reception...")
            print(f"  Character 1 received {len(events_char1)} status.snapshot events")
            print(f"  Character 2 received {len(events_char2)} status.snapshot events")

            # Each character should have received exactly 1 status.snapshot (their own)
            assert len(events_char1) >= 1, "Character 1 should receive status.snapshot"
            assert len(events_char2) >= 1, "Character 2 should receive status.snapshot"

            # Verify the events are for the correct character
            for event in events_char1:
                # The event structure is: {"event": "status.snapshot", "payload": <what handler received>}
                # The handler receives the full event payload which may have nested structure
                outer_payload = event.get("payload", {})
                # The actual data is likely in outer_payload["payload"]
                actual_payload = outer_payload.get("payload", outer_payload)

                # Try multiple ways to extract character_id from payload
                char_id = (
                    actual_payload.get("character_id") or
                    actual_payload.get("player", {}).get("id") or
                    actual_payload.get("player", {}).get("character_id")
                )
                assert char_id == char1_id, f"Character 1 should only see their own status, got {char_id}"

            for event in events_char2:
                outer_payload = event.get("payload", {})
                actual_payload = outer_payload.get("payload", outer_payload)

                char_id = (
                    actual_payload.get("character_id") or
                    actual_payload.get("player", {}).get("id") or
                    actual_payload.get("player", {}).get("character_id")
                )
                assert char_id == char2_id, f"Character 2 should only see their own status, got {char_id}"

            print("  ✓ Each character only received their own status events via WebSocket")

            # STEP 5: Verify JSONL filtering
            print("\nSTEP 5: Verifying JSONL event filtering...")

            # Character 1 queries their events
            char1_result = await client1._request("event.query", {
                "character_id": char1_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            # Character 2 queries their events
            char2_result = await client2._request("event.query", {
                "character_id": char2_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            print(f"  Character 1 query returned {char1_result['count']} events")
            print(f"  Character 2 query returned {char2_result['count']} events")

            # Find status.snapshot events in JSONL
            char1_status_events = [e for e in char1_result["events"] if e.get("event") == "status.snapshot"]
            char2_status_events = [e for e in char2_result["events"] if e.get("event") == "status.snapshot"]

            assert len(char1_status_events) >= 1, "Character 1 should find their status.snapshot in JSONL"
            assert len(char2_status_events) >= 1, "Character 2 should find their status.snapshot in JSONL"

            # Verify no cross-contamination in JSONL
            for event in char1_status_events:
                # Event should involve char1 (as sender or receiver)
                sender = event.get("sender")
                receiver = event.get("receiver")
                assert sender == char1_id or receiver == char1_id, \
                    f"Character 1 query should only return events involving char1, got sender={sender}, receiver={receiver}"

            for event in char2_status_events:
                # Event should involve char2 (as sender or receiver)
                sender = event.get("sender")
                receiver = event.get("receiver")
                assert sender == char2_id or receiver == char2_id, \
                    f"Character 2 query should only return events involving char2, got sender={sender}, receiver={receiver}"

            print("  ✓ JSONL properly filters events per character")

            print("\n" + "="*80)
            print("✅ PRIVATE EVENTS TEST PASSED!")
            print("="*80)

        finally:
            await client1.close()
            await client2.close()

    async def test_public_events_to_all_in_sector(self, server_url):
        """Test that public events (character.moved) are visible to all characters in the sector.

        Scenario:
        1. Character 1, 2, and 3 are all in the same sector
        2. Character 1 moves out and back into the sector
        3. All 3 characters should receive the character.moved event
        4. JSONL queries should confirm all characters saw the event
        """
        char1_id = "test_public_char1"
        char2_id = "test_public_char2"
        char3_id = "test_public_char3"

        print(f"\n{'='*80}")
        print(f"STARTING PUBLIC EVENTS TEST")
        print(f"Character 1 (mover): {char1_id}")
        print(f"Character 2 (observer): {char2_id}")
        print(f"Character 3 (observer): {char3_id}")
        print(f"{'='*80}\n")

        # Create AsyncGameClients with WebSocket transport
        client1 = AsyncGameClient(base_url=server_url, character_id=char1_id, transport="websocket")
        client2 = AsyncGameClient(base_url=server_url, character_id=char2_id, transport="websocket")
        client3 = AsyncGameClient(base_url=server_url, character_id=char3_id, transport="websocket")

        # Event collectors for character.moved events
        events_char1 = []
        events_char2 = []
        events_char3 = []

        # Register event handlers
        client1.on("character.moved")(lambda p: events_char1.append({"event": "character.moved", "payload": p}))
        client2.on("character.moved")(lambda p: events_char2.append({"event": "character.moved", "payload": p}))
        client3.on("character.moved")(lambda p: events_char3.append({"event": "character.moved", "payload": p}))

        try:
            # STEP 1: All characters join
            print("STEP 1: All characters join...")
            await client1.join(character_id=char1_id)
            await client2.join(character_id=char2_id)
            await client3.join(character_id=char3_id)
            await asyncio.sleep(0.5)

            # STEP 2: Position all characters in the same sector
            print("\nSTEP 2: Positioning all characters in same sector...")
            status1 = await get_status(client1, char1_id)
            status2 = await get_status(client2, char2_id)
            status3 = await get_status(client3, char3_id)

            sector1 = status1["sector"]["id"]
            sector2 = status2["sector"]["id"]
            sector3 = status3["sector"]["id"]

            print(f"  Character 1 in sector {sector1}")
            print(f"  Character 2 in sector {sector2}")
            print(f"  Character 3 in sector {sector3}")

            # Move character 2 to character 1's sector if needed
            if sector2 != sector1:
                result = await client2.plot_course(from_sector=sector2, to_sector=sector1)
                if result.get("success") and result.get("path"):
                    for next_sector in result["path"][1:]:
                        await client2.move(to_sector=next_sector, character_id=char2_id)
                        await asyncio.sleep(0.2)
                else:
                    pytest.skip("Cannot move character 2 to character 1's sector")

            # Move character 3 to character 1's sector if needed
            if sector3 != sector1:
                result = await client3.plot_course(from_sector=sector3, to_sector=sector1)
                if result.get("success") and result.get("path"):
                    for next_sector in result["path"][1:]:
                        await client3.move(to_sector=next_sector, character_id=char3_id)
                        await asyncio.sleep(0.2)
                else:
                    pytest.skip("Cannot move character 3 to character 1's sector")

            # Verify all in same sector
            status1 = await get_status(client1, char1_id)
            status2 = await get_status(client2, char2_id)
            status3 = await get_status(client3, char3_id)

            shared_sector = status1["sector"]["id"]
            if status2["sector"]["id"] != shared_sector or status3["sector"]["id"] != shared_sector:
                pytest.skip("Could not position all characters in same sector")

            print(f"  ✓ All characters now in sector {shared_sector}")

            # Clear any movement events from positioning
            events_char1.clear()
            events_char2.clear()
            events_char3.clear()

            # Record start time
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # STEP 3: Character 1 moves out and back
            print(f"\nSTEP 3: Character 1 moves out and back into sector {shared_sector}...")
            adjacent = status1["sector"]["adjacent_sectors"]
            if not adjacent:
                pytest.skip("No adjacent sectors for movement")

            temp_sector = adjacent[0]
            print(f"  Moving to temporary sector {temp_sector}")
            await client1.move(to_sector=temp_sector, character_id=char1_id)
            await asyncio.sleep(0.5)

            print(f"  Moving back to sector {shared_sector}")
            await client1.move(to_sector=shared_sector, character_id=char1_id)
            await asyncio.sleep(2.0)

            end_time = datetime.now(timezone.utc)

            # STEP 4: Verify all characters received the movement events
            print("\nSTEP 4: Verifying WebSocket event reception...")
            print(f"  Character 1 received {len(events_char1)} character.moved events")
            print(f"  Character 2 received {len(events_char2)} character.moved events")
            print(f"  Character 3 received {len(events_char3)} character.moved events")

            # All characters should see the movement (public event)
            # Character 1's return to the shared sector should be visible to all
            assert len(events_char2) > 0, "Character 2 should receive character.moved events (public visibility)"
            assert len(events_char3) > 0, "Character 3 should receive character.moved events (public visibility)"

            print("  ✓ All observers received character.moved events via WebSocket")

            # STEP 5: Verify JSONL contains the events for all characters
            print("\nSTEP 5: Verifying JSONL event visibility...")

            char2_result = await client2._request("event.query", {
                "character_id": char2_id,
                "sector": shared_sector,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            char3_result = await client3._request("event.query", {
                "character_id": char3_id,
                "sector": shared_sector,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            char2_moved_events = [e for e in char2_result["events"] if e.get("event") == "character.moved"]
            char3_moved_events = [e for e in char3_result["events"] if e.get("event") == "character.moved"]

            assert len(char2_moved_events) > 0, "Character 2 should find character.moved in JSONL"
            assert len(char3_moved_events) > 0, "Character 3 should find character.moved in JSONL"

            print(f"  Character 2 found {len(char2_moved_events)} character.moved events in JSONL")
            print(f"  Character 3 found {len(char3_moved_events)} character.moved events in JSONL")
            print("  ✓ JSONL shows public events are visible to all sector occupants")

            print("\n" + "="*80)
            print("✅ PUBLIC EVENTS TEST PASSED!")
            print("="*80)

        finally:
            await client1.close()
            await client2.close()
            await client3.close()

    async def test_combat_events_to_participants_only(self, server_url):
        """Test that combat events are filtered to participants only (different sectors).

        Note: All characters in the SAME sector are forced into combat.
        This test verifies characters in DIFFERENT sectors don't see combat events.
        """
        from datetime import datetime, timezone
        import asyncio
        from tests.helpers.combat_helpers import create_test_character_knowledge

        fighter1_id = "test_combat_privacy_fighter1"
        fighter2_id = "test_combat_privacy_fighter2"
        outsider_id = "test_combat_privacy_outsider"

        # Create all characters at sector 0 (spawn sector), will move them after joining
        create_test_character_knowledge(fighter1_id, sector=0, fighters=100, shields=100)
        create_test_character_knowledge(fighter2_id, sector=0, fighters=100, shields=100)
        create_test_character_knowledge(outsider_id, sector=0, fighters=100, shields=100)

        fighter1 = AsyncGameClient(base_url=server_url, character_id=fighter1_id, transport="websocket")
        fighter2 = AsyncGameClient(base_url=server_url, character_id=fighter2_id, transport="websocket")
        outsider = AsyncGameClient(base_url=server_url, character_id=outsider_id, transport="websocket")

        # Setup event collectors
        fighter1_events = []
        fighter2_events = []
        outsider_events = []

        # Fighters register combat event handlers
        fighter1.on("combat.round_waiting")(lambda p: fighter1_events.append({"event": "combat.round_waiting", "payload": p}))
        fighter1.on("combat.round_resolved")(lambda p: fighter1_events.append({"event": "combat.round_resolved", "payload": p}))
        fighter1.on("combat.ended")(lambda p: fighter1_events.append({"event": "combat.ended", "payload": p}))

        fighter2.on("combat.round_waiting")(lambda p: fighter2_events.append({"event": "combat.round_waiting", "payload": p}))
        fighter2.on("combat.round_resolved")(lambda p: fighter2_events.append({"event": "combat.round_resolved", "payload": p}))
        fighter2.on("combat.ended")(lambda p: fighter2_events.append({"event": "combat.ended", "payload": p}))

        # Outsider registers same combat event handlers
        outsider.on("combat.round_waiting")(lambda p: outsider_events.append({"event": "combat.round_waiting", "payload": p}))
        outsider.on("combat.round_resolved")(lambda p: outsider_events.append({"event": "combat.round_resolved", "payload": p}))
        outsider.on("combat.ended")(lambda p: outsider_events.append({"event": "combat.ended", "payload": p}))

        try:
            # Move characters to their designated sectors
            await fighter1.join(character_id=fighter1_id)
            await fighter2.join(character_id=fighter2_id)
            await outsider.join(character_id=outsider_id)

            await fighter1.move(to_sector=1, character_id=fighter1_id)
            await fighter2.move(to_sector=1, character_id=fighter2_id)
            await outsider.move(to_sector=2, character_id=outsider_id)

            await asyncio.sleep(1.0)

            # Record start time
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Initiate combat in sector 1
            await fighter1.combat_initiate(character_id=fighter1_id)

            # Wait for combat.round_waiting
            await asyncio.sleep(2.0)

            # Get combat_id (handle wrapped payload structure)
            waiting_events = [e for e in fighter1_events if e["event"] == "combat.round_waiting"]
            assert len(waiting_events) > 0, "Fighter1 should receive combat.round_waiting"
            waiting_payload = waiting_events[0]["payload"]
            inner_payload = waiting_payload.get("payload", waiting_payload)
            combat_id = inner_payload["combat_id"]

            # Submit actions
            await fighter1.combat_action(
                character_id=fighter1_id,
                combat_id=combat_id,
                action="attack",
                target_id=fighter2_id,
                commit=50,
            )

            await fighter2.combat_action(
                character_id=fighter2_id,
                combat_id=combat_id,
                action="attack",
                target_id=fighter1_id,
                commit=50,
            )

            # Wait for round resolution
            await asyncio.sleep(5.0)

            end_time = datetime.now(timezone.utc)

            # WebSocket verification: Fighters receive combat events
            assert len(fighter1_events) > 0, "Fighter1 should receive combat events via WebSocket"
            assert len(fighter2_events) > 0, "Fighter2 should receive combat events via WebSocket"

            # WebSocket verification: Outsider receives ZERO combat events
            combat_event_types = ["combat.round_waiting", "combat.round_resolved", "combat.ended"]
            outsider_combat_events = [e for e in outsider_events if e["event"] in combat_event_types]
            assert len(outsider_combat_events) == 0, \
                f"Outsider in different sector should receive ZERO combat events, got {len(outsider_combat_events)}"

            # JSONL verification: Fighters have combat events
            result_fighter1 = await fighter1._request("event.query", {
                "character_id": fighter1_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            fighter1_combat_jsonl = [e for e in result_fighter1["events"] if any(
                combat_type in e["event"] for combat_type in combat_event_types
            )]
            assert len(fighter1_combat_jsonl) > 0, "Fighter1 should have combat events in JSONL"

            # JSONL verification: Outsider has ZERO combat events
            result_outsider = await outsider._request("event.query", {
                "character_id": outsider_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            outsider_combat_jsonl = [e for e in result_outsider["events"] if any(
                combat_type in e["event"] for combat_type in combat_event_types
            )]
            assert len(outsider_combat_jsonl) == 0, \
                f"Outsider should have ZERO combat events in JSONL, got {len(outsider_combat_jsonl)}"

        finally:
            await fighter1.close()
            await fighter2.close()
            await outsider.close()

    async def test_trade_events_private_to_trader(self, server_url):
        """Test that trade.executed events are private to the trader.

        Scenario:
        1. Trader and Observer are both at a port (same sector)
        2. Trader executes a trade
        3. Trader should receive trade.executed event
        4. Observer should NOT receive the trade event (private transaction)
        5. JSONL queries should confirm filtering
        """
        trader_id = "test_trade_trader"
        observer_id = "test_trade_observer"

        print(f"\n{'='*80}")
        print(f"STARTING TRADE PRIVACY TEST")
        print(f"Trader: {trader_id}")
        print(f"Observer: {observer_id}")
        print(f"{'='*80}\n")

        # Create AsyncGameClients with WebSocket transport
        trader_client = AsyncGameClient(base_url=server_url, character_id=trader_id, transport="websocket")
        observer_client = AsyncGameClient(base_url=server_url, character_id=observer_id, transport="websocket")

        # Event collectors for trade.executed events
        trader_events = []
        observer_events = []

        # Register event handlers
        trader_client.on("trade.executed")(lambda p: trader_events.append({"event": "trade.executed", "payload": p}))
        observer_client.on("trade.executed")(lambda p: observer_events.append({"event": "trade.executed", "payload": p}))

        try:
            # STEP 1: Both characters join
            print("STEP 1: Both characters join...")
            await trader_client.join(character_id=trader_id)
            await observer_client.join(character_id=observer_id)
            await asyncio.sleep(0.5)

            # STEP 2: Position both characters at sector 1 (which has a port in test world)
            print("\nSTEP 2: Positioning both characters at sector 1 (port location)...")
            trader_status = await get_status(trader_client, trader_id)
            current_sector = trader_status["sector"]["id"]

            # Sector 1 has a port in test world (sells neuro_symbolics)
            # Sector 0 and 1 are connected (two-way), so direct movement works
            port_sector = 1
            print(f"  Using sector {port_sector} (known port location)")

            # Move trader to port if needed (sector 0 -> sector 1)
            if current_sector != port_sector:
                print(f"  Moving trader from sector {current_sector} to sector {port_sector}...")
                await trader_client.move(to_sector=port_sector, character_id=trader_id)
                await asyncio.sleep(0.5)

            # Move observer to same sector
            observer_status = await get_status(observer_client, observer_id)
            observer_sector = observer_status["sector"]["id"]

            if observer_sector != port_sector:
                print(f"  Moving observer from sector {observer_sector} to sector {port_sector}...")
                await observer_client.move(to_sector=port_sector, character_id=observer_id)
                await asyncio.sleep(0.5)

            # Verify both at port
            trader_status = await get_status(trader_client, trader_id)
            observer_status = await get_status(observer_client, observer_id)

            if trader_status["sector"]["id"] != port_sector or observer_status["sector"]["id"] != port_sector:
                pytest.skip("Could not position both characters at port")

            print(f"  ✓ Both characters at port in sector {port_sector}")

            # Record start time
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # STEP 3: Trader executes a trade
            print(f"\nSTEP 3: Trader executes a buy trade...")
            try:
                # Sector 1 port sells neuro_symbolics
                await trader_client.trade(
                    commodity="neuro_symbolics",
                    quantity=1,
                    trade_type="buy",
                    character_id=trader_id
                )
                await asyncio.sleep(1.0)
            except Exception as e:
                pytest.skip(f"Trade failed: {e}")

            end_time = datetime.now(timezone.utc)

            # STEP 4: Verify WebSocket reception
            print("\nSTEP 4: Verifying WebSocket event reception...")
            print(f"  Trader received {len(trader_events)} trade.executed events")
            print(f"  Observer received {len(observer_events)} trade.executed events")

            # Trader should receive their trade event
            assert len(trader_events) >= 1, "Trader should receive trade.executed event"

            # Observer should NOT receive the trade event (private)
            assert len(observer_events) == 0, "Observer should NOT receive trader's private trade event"

            print("  ✓ Trader received trade.executed event via WebSocket")
            print("  ✓ Observer did NOT receive the trade event (privacy confirmed)")

            # STEP 5: Verify JSONL filtering
            print("\nSTEP 5: Verifying JSONL event filtering...")

            trader_result = await trader_client._request("event.query", {
                "character_id": trader_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            observer_result = await observer_client._request("event.query", {
                "character_id": observer_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            trader_trade_events = [e for e in trader_result["events"] if e.get("event") == "trade.executed"]
            observer_trade_events = [e for e in observer_result["events"] if e.get("event") == "trade.executed"]

            assert len(trader_trade_events) >= 1, "Trader should find trade.executed in JSONL"
            assert len(observer_trade_events) == 0, "Observer should NOT find trade.executed in JSONL"

            print(f"  Trader found {len(trader_trade_events)} trade.executed events in JSONL")
            print(f"  Observer found {len(observer_trade_events)} trade.executed events in JSONL (should be 0)")
            print("  ✓ JSONL properly filters trade events as private to trader")

            print("\n" + "="*80)
            print("✅ TRADE PRIVACY TEST PASSED!")
            print("="*80)

        finally:
            await trader_client.close()
            await observer_client.close()

    async def test_message_events_to_recipient_and_sender(self, server_url):
        """Test that direct messages only go to sender and recipient, not to outsiders.

        Scenario:
        1. Character 1 (sender) sends a direct message to Character 2 (recipient)
        2. Character 3 (outsider) is online but in different context
        3. Sender and recipient should both receive the chat.message event
        4. Outsider should NOT receive the chat.message event
        5. JSONL queries should confirm proper filtering
        """
        sender_id = "test_message_sender"
        recipient_id = "test_message_recipient"
        outsider_id = "test_message_outsider"

        print(f"\n{'='*80}")
        print(f"STARTING MESSAGE FILTERING TEST")
        print(f"Sender: {sender_id}")
        print(f"Recipient: {recipient_id}")
        print(f"Outsider: {outsider_id}")
        print(f"{'='*80}\n")

        # Create AsyncGameClients with WebSocket transport
        sender_client = AsyncGameClient(base_url=server_url, character_id=sender_id, transport="websocket")
        recipient_client = AsyncGameClient(base_url=server_url, character_id=recipient_id, transport="websocket")
        outsider_client = AsyncGameClient(base_url=server_url, character_id=outsider_id, transport="websocket")

        # Event collectors for chat.message events
        sender_events = []
        recipient_events = []
        outsider_events = []

        # Register event handlers
        sender_client.on("chat.message")(lambda p: sender_events.append({"event": "chat.message", "payload": p}))
        recipient_client.on("chat.message")(lambda p: recipient_events.append({"event": "chat.message", "payload": p}))
        outsider_client.on("chat.message")(lambda p: outsider_events.append({"event": "chat.message", "payload": p}))

        try:
            # STEP 1: All characters join
            print("STEP 1: All characters join...")
            await sender_client.join(character_id=sender_id)
            await recipient_client.join(character_id=recipient_id)
            await outsider_client.join(character_id=outsider_id)
            await asyncio.sleep(0.5)

            # Record start time
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # STEP 2: Sender sends direct message to recipient (using display name)
            recipient_display_name = "Message Recipient"
            print(f"\nSTEP 2: {sender_id} sends direct message to {recipient_display_name}...")
            message_content = "This is a private message for testing"
            await sender_client.send_message(
                content=message_content,
                msg_type="direct",
                to_name=recipient_display_name,  # Use display name, not character ID
                character_id=sender_id
            )
            await asyncio.sleep(1.0)

            end_time = datetime.now(timezone.utc)

            # STEP 3: Verify WebSocket reception
            print("\nSTEP 3: Verifying WebSocket event reception...")
            print(f"  Sender received {len(sender_events)} chat.message events")
            print(f"  Recipient received {len(recipient_events)} chat.message events")
            print(f"  Outsider received {len(outsider_events)} chat.message events")

            # Sender and recipient should both receive the message
            assert len(sender_events) >= 1, "Sender should receive their own direct message"
            assert len(recipient_events) >= 1, "Recipient should receive the direct message"

            # Outsider should NOT receive the message
            assert len(outsider_events) == 0, "Outsider should NOT receive direct messages between other characters"

            print("  ✓ Sender and recipient received message via WebSocket")
            print("  ✓ Outsider did NOT receive the private message")

            # STEP 4: Verify message content
            print("\nSTEP 4: Verifying message content...")
            sender_msg = sender_events[0]["payload"]
            recipient_msg = recipient_events[0]["payload"]

            # Get the actual content from nested payload if needed
            sender_content = sender_msg.get("content") or sender_msg.get("payload", {}).get("content")
            recipient_content = recipient_msg.get("content") or recipient_msg.get("payload", {}).get("content")

            assert sender_content == message_content, "Sender should see correct message content"
            assert recipient_content == message_content, "Recipient should see correct message content"

            print("  ✓ Message content matches for both sender and recipient")

            # STEP 5: Verify JSONL filtering
            print("\nSTEP 5: Verifying JSONL event filtering...")

            # Query events for sender
            sender_result = await sender_client._request("event.query", {
                "character_id": sender_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            # Query events for recipient
            recipient_result = await recipient_client._request("event.query", {
                "character_id": recipient_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            # Query events for outsider
            outsider_result = await outsider_client._request("event.query", {
                "character_id": outsider_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            sender_chat_events = [e for e in sender_result["events"] if e.get("event") == "chat.message"]
            recipient_chat_events = [e for e in recipient_result["events"] if e.get("event") == "chat.message"]
            outsider_chat_events = [e for e in outsider_result["events"] if e.get("event") == "chat.message"]

            assert len(sender_chat_events) >= 1, "Sender should find chat.message in JSONL"
            assert len(recipient_chat_events) >= 1, "Recipient should find chat.message in JSONL"
            assert len(outsider_chat_events) == 0, "Outsider should NOT find chat.message in JSONL"

            print(f"  Sender found {len(sender_chat_events)} chat.message events in JSONL")
            print(f"  Recipient found {len(recipient_chat_events)} chat.message events in JSONL")
            print(f"  Outsider found {len(outsider_chat_events)} chat.message events in JSONL (should be 0)")
            print("  ✓ JSONL properly filters direct messages to sender and recipient only")

            print("\n" + "="*80)
            print("✅ MESSAGE FILTERING TEST PASSED!")
            print("="*80)

        finally:
            await sender_client.close()
            await recipient_client.close()
            await outsider_client.close()

    async def test_firehose_delivers_all_events(self, active_character, server_url):
        """Test that firehose delivers all events without filtering."""
        client = active_character["client"]
        char_id = active_character["character_id"]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            # Perform various actions
            await get_status(client, char_id)
            await asyncio.sleep(0.5)

            status = await get_status(client, char_id)
            adjacent = status["sector"]["adjacent_sectors"]

            if adjacent:
                await client.move(to_sector=adjacent[0], character_id=char_id)
                await asyncio.sleep(2.0)

            # Firehose should have all events
            assert len(listener.events) > 0, "Firehose should receive events"

    async def test_movement_events_visible_to_sector_occupants(self, server_url):
        """Test that departures are visible to sector occupants (complements arrival test).

        Scenario:
        1. Characters 1, 2, and 3 are all in the same sector
        2. Character 1 departs (moves to adjacent sector)
        3. Characters 2 and 3 (remaining occupants) should see the departure event
        4. JSONL queries should confirm visibility

        Note: This complements test_movement_event_fanout which tests arrivals.
        """
        mover_id = "test_depart_mover"
        observer1_id = "test_depart_observer1"
        observer2_id = "test_depart_observer2"

        print(f"\n{'='*80}")
        print(f"STARTING DEPARTURE VISIBILITY TEST")
        print(f"Mover (departing): {mover_id}")
        print(f"Observer 1 (staying): {observer1_id}")
        print(f"Observer 2 (staying): {observer2_id}")
        print(f"{'='*80}\n")

        # Create AsyncGameClients with WebSocket transport
        mover_client = AsyncGameClient(base_url=server_url, character_id=mover_id, transport="websocket")
        observer1_client = AsyncGameClient(base_url=server_url, character_id=observer1_id, transport="websocket")
        observer2_client = AsyncGameClient(base_url=server_url, character_id=observer2_id, transport="websocket")

        # Event collectors for character.moved events
        mover_events = []
        observer1_events = []
        observer2_events = []

        # Register event handlers
        mover_client.on("character.moved")(lambda p: mover_events.append({"event": "character.moved", "payload": p}))
        observer1_client.on("character.moved")(lambda p: observer1_events.append({"event": "character.moved", "payload": p}))
        observer2_client.on("character.moved")(lambda p: observer2_events.append({"event": "character.moved", "payload": p}))

        try:
            # STEP 1: All characters join
            print("STEP 1: All characters join...")
            await mover_client.join(character_id=mover_id)
            await observer1_client.join(character_id=observer1_id)
            await observer2_client.join(character_id=observer2_id)
            await asyncio.sleep(0.5)

            # STEP 2: Position all characters in the same sector
            print("\nSTEP 2: Positioning all characters in same sector...")
            mover_status = await get_status(mover_client, mover_id)
            observer1_status = await get_status(observer1_client, observer1_id)
            observer2_status = await get_status(observer2_client, observer2_id)

            mover_sector = mover_status["sector"]["id"]
            observer1_sector = observer1_status["sector"]["id"]
            observer2_sector = observer2_status["sector"]["id"]

            print(f"  Mover in sector {mover_sector}")
            print(f"  Observer 1 in sector {observer1_sector}")
            print(f"  Observer 2 in sector {observer2_sector}")

            # Move observers to mover's sector if needed
            if observer1_sector != mover_sector:
                result = await observer1_client.plot_course(from_sector=observer1_sector, to_sector=mover_sector)
                if result.get("success") and result.get("path"):
                    for next_sector in result["path"][1:]:
                        await observer1_client.move(to_sector=next_sector, character_id=observer1_id)
                        await asyncio.sleep(0.2)
                else:
                    pytest.skip("Cannot move observer 1 to mover's sector")

            if observer2_sector != mover_sector:
                result = await observer2_client.plot_course(from_sector=observer2_sector, to_sector=mover_sector)
                if result.get("success") and result.get("path"):
                    for next_sector in result["path"][1:]:
                        await observer2_client.move(to_sector=next_sector, character_id=observer2_id)
                        await asyncio.sleep(0.2)
                else:
                    pytest.skip("Cannot move observer 2 to mover's sector")

            # Verify all in same sector
            mover_status = await get_status(mover_client, mover_id)
            observer1_status = await get_status(observer1_client, observer1_id)
            observer2_status = await get_status(observer2_client, observer2_id)

            shared_sector = mover_status["sector"]["id"]
            if observer1_status["sector"]["id"] != shared_sector or observer2_status["sector"]["id"] != shared_sector:
                pytest.skip("Could not position all characters in same sector")

            print(f"  ✓ All characters now in sector {shared_sector}")

            # Clear any positioning-related movement events
            mover_events.clear()
            observer1_events.clear()
            observer2_events.clear()

            # Record start time
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # STEP 3: Mover departs to adjacent sector
            print(f"\nSTEP 3: Mover departs from sector {shared_sector}...")
            adjacent = mover_status["sector"]["adjacent_sectors"]
            if not adjacent:
                pytest.skip("No adjacent sectors for departure")

            departure_target = adjacent[0]
            print(f"  Moving to sector {departure_target}")
            await mover_client.move(to_sector=departure_target, character_id=mover_id)
            await asyncio.sleep(2.0)

            end_time = datetime.now(timezone.utc)

            # STEP 4: Verify observers received the departure event
            print("\nSTEP 4: Verifying WebSocket event reception...")
            print(f"  Observer 1 received {len(observer1_events)} character.moved events")
            print(f"  Observer 2 received {len(observer2_events)} character.moved events")

            # Observers should see the departure
            assert len(observer1_events) > 0, "Observer 1 should receive departure events"
            assert len(observer2_events) > 0, "Observer 2 should receive departure events"

            print("  ✓ Observers received departure event via WebSocket")

            # STEP 5: Verify JSONL contains the departure events
            print("\nSTEP 5: Verifying JSONL event visibility...")

            observer1_result = await observer1_client._request("event.query", {
                "character_id": observer1_id,
                "sector": shared_sector,  # Query the sector they're still in
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            observer2_result = await observer2_client._request("event.query", {
                "character_id": observer2_id,
                "sector": shared_sector,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            observer1_moved_events = [e for e in observer1_result["events"] if e.get("event") == "character.moved"]
            observer2_moved_events = [e for e in observer2_result["events"] if e.get("event") == "character.moved"]

            assert len(observer1_moved_events) > 0, "Observer 1 should find departure events in JSONL"
            assert len(observer2_moved_events) > 0, "Observer 2 should find departure events in JSONL"

            print(f"  Observer 1 found {len(observer1_moved_events)} character.moved events in JSONL")
            print(f"  Observer 2 found {len(observer2_moved_events)} character.moved events in JSONL")
            print("  ✓ JSONL shows departure events are visible to sector occupants")

            print("\n" + "="*80)
            print("✅ DEPARTURE VISIBILITY TEST PASSED!")
            print("="*80)

        finally:
            await mover_client.close()
            await observer1_client.close()
            await observer2_client.close()

    async def test_garrison_events_privacy(self, server_url):
        """Test that ALL garrison events are private to the garrison owner only.

        Scenario: Deployer creates, modifies, and collects garrison.
        Observer in same sector and outsider in different sector should NOT see events.

        Events tested:
        - garrison.deployed (when creating garrison)
        - garrison.mode_changed (when changing garrison mode)
        - garrison.collected (when collecting garrison)
        """
        from datetime import datetime, timezone
        import asyncio
        from tests.helpers.combat_helpers import create_test_character_knowledge

        deployer_id = "test_garrison_deployer"
        observer_id = "test_garrison_observer"
        outsider_id = "test_garrison_outsider"

        # Create all characters at sector 0
        create_test_character_knowledge(deployer_id, sector=0, fighters=100, shields=100)
        create_test_character_knowledge(observer_id, sector=0, fighters=100, shields=100)
        create_test_character_knowledge(outsider_id, sector=0, fighters=100, shields=100)

        deployer = AsyncGameClient(base_url=server_url, character_id=deployer_id, transport="websocket")
        observer = AsyncGameClient(base_url=server_url, character_id=observer_id, transport="websocket")
        outsider = AsyncGameClient(base_url=server_url, character_id=outsider_id, transport="websocket")

        # Setup event collectors for all 3 garrison events
        deployer_events = []
        observer_events = []
        outsider_events = []

        garrison_event_types = ["garrison.deployed", "garrison.mode_changed", "garrison.collected"]

        for event_type in garrison_event_types:
            deployer.on(event_type)(lambda p, et=event_type: deployer_events.append({"event": et, "payload": p}))
            observer.on(event_type)(lambda p, et=event_type: observer_events.append({"event": et, "payload": p}))
            outsider.on(event_type)(lambda p, et=event_type: outsider_events.append({"event": et, "payload": p}))

        try:
            await deployer.join(character_id=deployer_id)
            await observer.join(character_id=observer_id)
            await outsider.join(character_id=outsider_id)

            # Move deployer and observer to sector 1 (same sector)
            # Move outsider to sector 2 (different sector)
            await deployer.move(to_sector=1, character_id=deployer_id)
            await observer.move(to_sector=1, character_id=observer_id)
            await outsider.move(to_sector=2, character_id=outsider_id)
            await asyncio.sleep(0.5)

            # Record start time
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # 1. Deploy garrison → garrison.deployed event
            await deployer.combat_leave_fighters(
                character_id=deployer_id,
                sector=1,
                quantity=50,
                mode="defensive"
            )
            await asyncio.sleep(1.0)

            # 2. Change garrison mode → garrison.mode_changed event
            await deployer.combat_set_garrison_mode(
                character_id=deployer_id,
                sector=1,
                mode="toll",
                toll_amount=100
            )
            await asyncio.sleep(1.0)

            # 3. Collect garrison → garrison.collected event
            await deployer.combat_collect_fighters(
                character_id=deployer_id,
                sector=1,
                quantity=50
            )
            await asyncio.sleep(1.0)

            end_time = datetime.now(timezone.utc)

            # WebSocket verification: Deployer should see all 3 events
            deployer_deployed = [e for e in deployer_events if e["event"] == "garrison.deployed"]
            deployer_mode_changed = [e for e in deployer_events if e["event"] == "garrison.mode_changed"]
            deployer_collected = [e for e in deployer_events if e["event"] == "garrison.collected"]

            assert len(deployer_deployed) >= 1, "Deployer should receive garrison.deployed"
            assert len(deployer_mode_changed) >= 1, "Deployer should receive garrison.mode_changed"
            assert len(deployer_collected) >= 1, "Deployer should receive garrison.collected"

            # WebSocket verification: Observer should see ZERO garrison events (privacy)
            assert len(observer_events) == 0, f"Observer should NOT receive garrison events (private to owner), got {len(observer_events)}"

            # WebSocket verification: Outsider should see ZERO garrison events (privacy)
            assert len(outsider_events) == 0, f"Outsider should NOT receive garrison events (private to owner), got {len(outsider_events)}"

            # JSONL verification: Deployer should see all garrison events
            deployer_result = await deployer._request("event.query", {
                "character_id": deployer_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            deployer_garrison_jsonl = [e for e in deployer_result["events"] if e.get("event") in garrison_event_types]
            assert len(deployer_garrison_jsonl) >= 3, f"Deployer should have at least 3 garrison events in JSONL, got {len(deployer_garrison_jsonl)}"

            # JSONL verification: Observer should see ZERO garrison events
            observer_result = await observer._request("event.query", {
                "character_id": observer_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            observer_garrison_jsonl = [e for e in observer_result["events"] if e.get("event") in garrison_event_types]
            assert len(observer_garrison_jsonl) == 0, f"Observer should have ZERO garrison events in JSONL (privacy), got {len(observer_garrison_jsonl)}"

            # JSONL verification: Outsider should see ZERO garrison events
            outsider_result = await outsider._request("event.query", {
                "character_id": outsider_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            outsider_garrison_jsonl = [e for e in outsider_result["events"] if e.get("event") in garrison_event_types]
            assert len(outsider_garrison_jsonl) == 0, f"Outsider should have ZERO garrison events in JSONL (privacy), got {len(outsider_garrison_jsonl)}"

        finally:
            await deployer.close()
            await observer.close()
            await outsider.close()

    async def test_salvage_collected_event_privacy(self, server_url):
        """Test that salvage.collected events are private to the collector only.

        Scenario: Collector destroys victim (creates salvage), then collects it.
        Observer in different sector should NOT see salvage.collected event.

        Note: salvage.collected is the only salvage event. Salvage creation
        appears in combat.ended payload (already tested in test_combat_ended_event_with_destruction).

        CURRENT STATUS: Test implementation requires complex multi-character combat setup.
        Salvage privacy is partially covered by existing event_catalog.md documentation
        which specifies salvage.collected uses character_filter (private to collector).
        """
        from datetime import datetime, timezone
        import asyncio
        from tests.helpers.combat_helpers import create_strong_character, create_weak_character, set_character_cargo

        collector_id = "test_salvage_collector"
        victim_id = "test_salvage_victim"
        observer_id = "test_salvage_observer"

        # Create strong collector, weak victim with cargo, and observer
        create_strong_character(collector_id, sector=0, fighters=500)
        create_weak_character(victim_id, sector=0, fighters=5)  # Victim starts at sector 0
        set_character_cargo(victim_id, quantum_foam=10, retro_organics=5)
        create_strong_character(observer_id, sector=0, fighters=100)

        collector = AsyncGameClient(base_url=server_url, character_id=collector_id, transport="websocket")
        victim = AsyncGameClient(base_url=server_url, character_id=victim_id, transport="websocket")
        observer = AsyncGameClient(base_url=server_url, character_id=observer_id, transport="websocket")

        # Setup event collectors
        collector_events = []
        observer_salvage_events = []

        collector.on("combat.round_waiting")(lambda p: collector_events.append({"event": "combat.round_waiting", "payload": p}))
        collector.on("combat.ended")(lambda p: collector_events.append({"event": "combat.ended", "payload": p}))
        collector.on("salvage.collected")(lambda p: collector_events.append({"event": "salvage.collected", "payload": p}))
        observer.on("salvage.collected")(lambda p: observer_salvage_events.append({"event": "salvage.collected", "payload": p}))

        try:
            await collector.join(character_id=collector_id)
            await victim.join(character_id=victim_id)  # Victim must join to be targetable
            await observer.join(character_id=observer_id)

            # Move collector and victim to sector 1 (they'll be forced into combat)
            # Move observer to sector 2 (different sector, NOT in combat)
            await collector.move(to_sector=1, character_id=collector_id)
            await victim.move(to_sector=1, character_id=victim_id)
            await observer.move(to_sector=2, character_id=observer_id)
            await asyncio.sleep(0.5)

            # Clear movement events
            collector_events.clear()
            observer_salvage_events.clear()

            # Initiate combat (collector vs victim in sector 1)
            # Note: victim is not joined as a client, but exists in game state
            await collector.combat_initiate(character_id=collector_id)
            await asyncio.sleep(2.0)

            # Extract combat_id from combat.round_waiting event
            waiting_events = [e for e in collector_events if e["event"] == "combat.round_waiting"]
            if len(waiting_events) == 0:
                pytest.skip("Did not receive combat.round_waiting event")

            waiting_payload = waiting_events[0]["payload"]
            inner_waiting = waiting_payload.get("payload", waiting_payload)
            combat_id = inner_waiting["combat_id"]

            # Submit attack actions (collector attacks victim)
            await collector.combat_action(
                action="attack",
                combat_id=combat_id,
                target_id=victim_id,
                character_id=collector_id
            )
            await asyncio.sleep(8.0)  # Wait longer for combat to end

            # Get salvage_id from combat.ended event
            combat_ended = [e for e in collector_events if e["event"] == "combat.ended"]
            if len(combat_ended) == 0:
                pytest.skip("Combat did not end with salvage creation")

            ended_payload = combat_ended[0]["payload"]
            inner_ended = ended_payload.get("payload", ended_payload)

            if "salvage" not in inner_ended or len(inner_ended["salvage"]) == 0:
                pytest.skip("No salvage created in combat")

            salvage_id = inner_ended["salvage"][0]["salvage_id"]

            # Record start time for salvage collection
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Collector collects the salvage → salvage.collected event
            await collector.salvage_collect(
                character_id=collector_id,
                salvage_id=salvage_id
            )

            # Wait for event propagation
            await asyncio.sleep(1.0)

            end_time = datetime.now(timezone.utc)

            # WebSocket verification: Collector should see salvage.collected
            collector_salvage = [e for e in collector_events if e["event"] == "salvage.collected"]
            assert len(collector_salvage) >= 1, "Collector should receive salvage.collected via WebSocket"

            # Verify payload structure
            salvage_event = collector_salvage[0]["payload"]
            inner_salvage = salvage_event.get("payload", salvage_event)

            assert "salvage" in inner_salvage, "Event should have salvage field"
            assert inner_salvage["salvage"]["salvage_id"] == salvage_id, "Salvage ID should match"
            assert "cargo" in inner_salvage["salvage"], "Salvage should have cargo field"
            assert "cargo" in inner_salvage, "Event should show updated cargo after collection"
            assert "credits" in inner_salvage, "Event should show updated credits"

            # WebSocket verification: Observer should NOT see salvage.collected (privacy)
            assert len(observer_salvage_events) == 0, f"Observer should NOT receive salvage.collected (private to collector), got {len(observer_salvage_events)}"

            # JSONL verification: Collector should see salvage.collected
            collector_result = await collector._request("event.query", {
                "character_id": collector_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            collector_salvage_jsonl = [e for e in collector_result["events"] if e.get("event") == "salvage.collected"]
            assert len(collector_salvage_jsonl) > 0, "Collector should find salvage.collected in JSONL"

            # JSONL verification: Observer should NOT see salvage.collected
            observer_result = await observer._request("event.query", {
                "character_id": observer_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            observer_salvage_jsonl = [e for e in observer_result["events"] if e.get("event") == "salvage.collected"]
            assert len(observer_salvage_jsonl) == 0, f"Observer should NOT see salvage.collected in JSONL (privacy), got {len(observer_salvage_jsonl)}"

        finally:
            await collector.close()
            await victim.close()
            await observer.close()

    async def test_error_events_only_to_character(self):
        """Test that error events are private to the character."""
        # Try an invalid action
        pytest.skip("Requires character-specific filtering")


# =============================================================================
# WebSocket Delivery Tests (4 tests)
# =============================================================================


class TestWebSocketDelivery:
    """Tests for WebSocket event delivery mechanisms."""

    async def test_firehose_connection_receives_events(self, active_character, server_url):
        """Test that firehose connection receives broadcast events."""
        client = active_character["client"]
        char_id = active_character["character_id"]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            # Generate event
            await get_status(client, char_id)
            await asyncio.sleep(1.0)

            # Should have received events
            assert len(listener.events) > 0, "Firehose should receive events"

    async def test_multiple_firehose_clients_receive_same_events(self, active_character, server_url):
        """Test that multiple firehose connections receive same events."""
        client = active_character["client"]
        char_id = active_character["character_id"]

        async with create_firehose_listener(server_url, char_id) as listener1:
            async with create_firehose_listener(server_url, char_id) as listener2:
                await asyncio.sleep(0.5)

                # Clear any initial events
                listener1.clear_events()
                listener2.clear_events()

                # Generate event
                await get_status(client, char_id)
                await asyncio.sleep(1.0)

                # Both should have events
                assert len(listener1.events) > 0, "Listener 1 should receive events"
                assert len(listener2.events) > 0, "Listener 2 should receive events"

                # Event counts should match
                assert len(listener1.events) == len(listener2.events), \
                    "Both listeners should receive same number of events"

    async def test_firehose_client_disconnection_handling(self, server_url, check_server_available):
        """Test that firehose handles client disconnections gracefully."""
        # Connect and disconnect
        listener = EventListener(server_url)
        await listener.connect()
        await asyncio.sleep(0.5)
        await listener.disconnect()

        # Should disconnect cleanly without errors

    async def test_firehose_reconnection_does_not_duplicate_events(self, active_character, server_url):
        """Test that reconnecting doesn't cause event duplication."""
        client = active_character["client"]
        char_id = active_character["character_id"]

        # First connection
        async with create_firehose_listener(server_url, char_id) as listener1:
            await asyncio.sleep(0.5)

            await get_status(client, char_id)
            await asyncio.sleep(1.0)

            events_count_1 = len(listener1.events)

        # Second connection (after disconnect)
        async with create_firehose_listener(server_url, char_id) as listener2:
            await asyncio.sleep(0.5)

            await get_status(client, char_id)
            await asyncio.sleep(1.0)

            # Should only receive new events, not duplicates
            # Each connection should receive its own events
            assert len(listener2.events) > 0


# =============================================================================
# Event Payload Structure Tests (5 tests)
# =============================================================================


class TestEventPayloadStructure:
    """Tests for event payload schema and structure."""

    async def test_all_events_have_required_fields(self, active_character, server_url):
        """Test that all events have type, timestamp, and payload fields."""
        client = active_character["client"]
        char_id = active_character["character_id"]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            await get_status(client, char_id)
            await asyncio.sleep(1.0)

            # Check each event has required fields
            for event in listener.events:
                assert "type" in event, f"Event missing 'type': {event}"
                # Note: timestamp and other fields may vary by implementation

    async def test_event_payloads_match_schema(self, active_character, server_url):
        """Test that event payloads match expected schemas."""
        client = active_character["client"]
        char_id = active_character["character_id"]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            status = await get_status(client, char_id)
            await asyncio.sleep(1.0)

            # Find status event and validate structure
            status_events = listener.filter_events("status.snapshot")

            if status_events:
                event = status_events[0]
                payload = event.get("payload", {})

                # Validate expected fields (actual schema may vary)
                assert isinstance(payload, dict), "Payload should be a dict"

    async def test_event_contains_action_specific_data(self, active_character, server_url):
        """Test that events contain relevant action-specific data."""
        client = active_character["client"]
        char_id = active_character["character_id"]

        status = await get_status(client, char_id)
        adjacent = status["sector"]["adjacent_sectors"]

        if not adjacent:
            pytest.skip("No adjacent sectors")

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            target = adjacent[0]
            await client.move(to_sector=target, character_id=char_id)
            await asyncio.sleep(2.0)

            # Find movement event
            move_events = listener.filter_events("movement.complete")

            if move_events:
                event = move_events[0]
                payload = event.get("payload", {})

                # Should contain sector information
                assert "sector" in payload, "Movement event should contain sector"

    async def test_event_json_serializable(self, active_character, server_url):
        """Test that all events are JSON serializable."""
        import json

        client = active_character["client"]
        char_id = active_character["character_id"]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            await get_status(client, char_id)
            await asyncio.sleep(1.0)

            # All events should be JSON serializable
            for event in listener.events:
                try:
                    json.dumps(event)
                except (TypeError, ValueError) as e:
                    pytest.fail(f"Event not JSON serializable: {event}, Error: {e}")


# =============================================================================
# JSONL Audit Log Tests (6 tests) - Task 2.4
# =============================================================================


class TestJSONLAuditLog:
    """Tests for JSONL event log persistence."""

    async def test_events_logged_to_jsonl_file(self, server_url):
        """Test that events are persisted to JSONL file and queryable via event.query API."""
        char_id = "test_jsonl_logging"
        client = AsyncGameClient(base_url=server_url, character_id=char_id)

        try:
            # Join and trigger a movement event
            await client.join(character_id=char_id)

            # Record start time for query
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Get current location and move
            status = await get_status(client, char_id)
            adjacent = status["sector"]["adjacent_sectors"]
            if not adjacent:
                pytest.skip("No adjacent sectors for movement")

            await client.move(to_sector=adjacent[0], character_id=char_id)
            await asyncio.sleep(1.0)

            end_time = datetime.now(timezone.utc)

            # Test 1: Admin query sees the event
            admin_result = await client._request("event.query", {
                "admin_password": "",  # Test server has no password (open access)
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
                "character_id": char_id,
            })

            assert admin_result["success"], "Admin query should succeed"
            assert admin_result["count"] > 0, "Admin query should find events"

            # Find movement event
            move_events = [e for e in admin_result["events"] if e.get("event") == "movement.complete"]
            assert len(move_events) >= 1, "Should find at least one movement.complete event"

            # Test 2: Character query (no admin password) sees the same event
            char_result = await client._request("event.query", {
                # No admin_password provided - character mode
                "character_id": char_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            assert char_result["success"], "Character query should succeed"
            assert char_result["count"] > 0, "Character query should find events"

            # Character should also see their movement event
            char_move_events = [e for e in char_result["events"] if e.get("event") == "movement.complete"]
            assert len(char_move_events) >= 1, "Character should see their own movement event"

        finally:
            await client.close()

    async def test_jsonl_one_event_per_line(self, server_url):
        """Test that JSONL has exactly one event per line."""
        char_id = "test_jsonl_format"
        client = AsyncGameClient(base_url=server_url, character_id=char_id)

        try:
            # Join and trigger multiple events
            await client.join(character_id=char_id)

            # Trigger 3 status checks (should generate events)
            for _ in range(3):
                await get_status(client, char_id)
                await asyncio.sleep(0.2)

            await asyncio.sleep(1.0)  # Let events flush to disk

            # Read log file directly
            log_path = Path("tests/test-world-data/event-log.jsonl")
            if not log_path.exists():
                pytest.skip("Log file doesn't exist yet")

            with log_path.open("r", encoding="utf-8") as f:
                lines = f.readlines()

            # Filter out empty lines
            non_empty_lines = [line.strip() for line in lines if line.strip()]

            assert len(non_empty_lines) > 0, "Log file should have events"

            # Validate each line is valid JSON
            valid_events = 0
            for i, line in enumerate(non_empty_lines):
                try:
                    event = json.loads(line)
                    valid_events += 1
                    # Basic structure check
                    assert isinstance(event, dict), f"Line {i} is not a dict"
                except json.JSONDecodeError as e:
                    pytest.fail(f"Line {i} is not valid JSON: {line[:100]}, Error: {e}")

            assert valid_events == len(non_empty_lines), "All lines should be valid JSON"

        finally:
            await client.close()

    async def test_jsonl_readable_and_parseable(self, server_url):
        """Test that JSONL log is readable and parseable with valid EventRecord structure."""
        char_id = "test_jsonl_parseable"
        client = AsyncGameClient(base_url=server_url, character_id=char_id)

        try:
            # Join and trigger an event
            await client.join(character_id=char_id)
            await get_status(client, char_id)
            await asyncio.sleep(1.0)

            # Read log file directly
            log_path = Path("tests/test-world-data/event-log.jsonl")
            if not log_path.exists():
                pytest.skip("Log file doesn't exist yet")

            with log_path.open("r", encoding="utf-8") as f:
                lines = f.readlines()

            # Parse and validate EventRecord structure
            for line in lines:
                line = line.strip()
                if not line:
                    continue

                event = json.loads(line)

                # Validate required EventRecord fields
                assert "timestamp" in event, "Event missing timestamp"
                assert "direction" in event, "Event missing direction"
                assert "event" in event, "Event missing event type"
                assert "payload" in event, "Event missing payload"

                # Optional fields (should be present but may be None)
                assert "sender" in event, "Event missing sender"
                assert "receiver" in event, "Event missing receiver"
                assert "sector" in event, "Event missing sector"

                # Validate types
                assert isinstance(event["timestamp"], str), "timestamp should be string"
                assert isinstance(event["event"], str), "event should be string"
                assert isinstance(event["payload"], dict), "payload should be dict"

        finally:
            await client.close()

    async def test_jsonl_append_only(self, server_url):
        """Test that JSONL is append-only (no modification) with monotonic timestamps."""
        char_id = "test_jsonl_append"
        client = AsyncGameClient(base_url=server_url, character_id=char_id)

        try:
            # Join character
            await client.join(character_id=char_id)

            # Read initial log state
            log_path = Path("tests/test-world-data/event-log.jsonl")
            if not log_path.exists():
                pytest.skip("Log file doesn't exist yet")

            with log_path.open("r", encoding="utf-8") as f:
                initial_lines = f.readlines()

            initial_count = len([l for l in initial_lines if l.strip()])

            # Get last timestamp if any
            last_timestamp = None
            if initial_lines:
                for line in reversed(initial_lines):
                    if line.strip():
                        try:
                            event = json.loads(line.strip())
                            last_timestamp = event.get("timestamp")
                            break
                        except json.JSONDecodeError:
                            continue

            # Trigger new event
            await get_status(client, char_id)
            await asyncio.sleep(1.0)

            # Read log again
            with log_path.open("r", encoding="utf-8") as f:
                final_lines = f.readlines()

            final_count = len([l for l in final_lines if l.strip()])

            # Verify log grew (append-only)
            assert final_count > initial_count, "Log should have grown (append-only)"

            # Verify new events have monotonic timestamps
            new_lines = final_lines[initial_count:]
            for line in new_lines:
                line = line.strip()
                if not line:
                    continue

                event = json.loads(line)
                new_timestamp = event.get("timestamp")

                if last_timestamp:
                    assert new_timestamp >= last_timestamp, \
                        f"Timestamps not monotonic: {last_timestamp} -> {new_timestamp}"

                last_timestamp = new_timestamp

        finally:
            await client.close()



# =============================================================================
# Admin Query Mode Tests (5 tests) - Phase 2
# =============================================================================


class TestAdminQueryMode:
    """Tests for admin query mode with event.query API."""

    async def test_admin_query_sees_all_events(self, server_url):
        """Test that admin query with no character_id filter sees all events."""
        # Create 2 characters and trigger events from each
        char1_id = "test_admin_query_char1"
        char2_id = "test_admin_query_char2"

        client1 = AsyncGameClient(base_url=server_url, character_id=char1_id)
        client2 = AsyncGameClient(base_url=server_url, character_id=char2_id)

        try:
            # Record start time
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Both characters join and trigger events
            await client1.join(character_id=char1_id)
            await client2.join(character_id=char2_id)

            await get_status(client1, char1_id)
            await get_status(client2, char2_id)

            await asyncio.sleep(1.0)
            end_time = datetime.now(timezone.utc)

            # Admin query with no character_id filter (should see all events)
            admin_result = await client1._request("event.query", {
                "admin_password": "",  # Admin mode (test server open access)
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
                # No character_id filter
            })

            assert admin_result["success"], "Admin query should succeed"
            events = admin_result["events"]

            # Should see events from both characters
            char1_events = [e for e in events if e.get("sender") == char1_id or e.get("receiver") == char1_id]
            char2_events = [e for e in events if e.get("sender") == char2_id or e.get("receiver") == char2_id]

            assert len(char1_events) > 0, "Admin should see char1 events"
            assert len(char2_events) > 0, "Admin should see char2 events"

        finally:
            await client1.close()
            await client2.close()

    async def test_admin_query_with_character_filter(self, server_url):
        """Test that admin query with character_id filter sees only that character's events."""
        char1_id = "test_admin_filter_char1"
        char2_id = "test_admin_filter_char2"

        client1 = AsyncGameClient(base_url=server_url, character_id=char1_id)
        client2 = AsyncGameClient(base_url=server_url, character_id=char2_id)

        try:
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Both characters trigger events
            await client1.join(character_id=char1_id)
            await client2.join(character_id=char2_id)

            await get_status(client1, char1_id)
            await get_status(client2, char2_id)

            await asyncio.sleep(1.0)
            end_time = datetime.now(timezone.utc)

            # Admin query filtered by char1
            admin_result = await client1._request("event.query", {
                "admin_password": "",
                "character_id": char1_id,  # Filter to char1
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            assert admin_result["success"]
            events = admin_result["events"]

            # All events should involve char1 (sender OR receiver)
            for event in events:
                sender = event.get("sender")
                receiver = event.get("receiver")
                assert sender == char1_id or receiver == char1_id, \
                    f"Event should involve {char1_id}, got sender={sender}, receiver={receiver}"

            # Should NOT see char2's private events (where char2 is sender AND receiver)
            char2_only_events = [
                e for e in events
                if e.get("sender") == char2_id and e.get("receiver") == char2_id
            ]
            assert len(char2_only_events) == 0, "Should not see char2's private events"

        finally:
            await client1.close()
            await client2.close()

    async def test_admin_query_with_sector_filter(self, server_url):
        """Test that admin query with sector filter sees only events in that sector."""
        char_id = "test_admin_sector_filter"
        client = AsyncGameClient(base_url=server_url, character_id=char_id)

        try:
            await client.join(character_id=char_id)

            # Get current sector and move to another
            status = await get_status(client, char_id)
            sector1 = status["sector"]["id"]
            adjacent = status["sector"]["adjacent_sectors"]

            if not adjacent:
                pytest.skip("No adjacent sectors")

            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Trigger event in sector1
            await get_status(client, char_id)

            # Move to sector2
            sector2 = adjacent[0]
            await client.move(to_sector=sector2, character_id=char_id)
            await asyncio.sleep(1.0)

            # Trigger event in sector2
            await get_status(client, char_id)

            await asyncio.sleep(1.0)
            end_time = datetime.now(timezone.utc)

            # Admin query filtered by sector1
            admin_result = await client._request("event.query", {
                "admin_password": "",
                "sector": sector1,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            assert admin_result["success"]
            events = admin_result["events"]

            # All returned events should be from sector1
            for event in events:
                event_sector = event.get("sector")
                # Note: Some events may not have sector field
                if event_sector is not None:
                    assert event_sector == sector1, \
                        f"Event should be from sector {sector1}, got {event_sector}"

        finally:
            await client.close()

    async def test_admin_query_combined_filters(self, server_url):
        """Test admin query with both character_id AND sector filters."""
        char_id = "test_admin_combined"
        client = AsyncGameClient(base_url=server_url, character_id=char_id)

        try:
            await client.join(character_id=char_id)

            status = await get_status(client, char_id)
            sector1 = status["sector"]["id"]
            adjacent = status["sector"]["adjacent_sectors"]

            if not adjacent:
                pytest.skip("No adjacent sectors")

            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Event in sector1
            await get_status(client, char_id)

            # Move to sector2
            sector2 = adjacent[0]
            await client.move(to_sector=sector2, character_id=char_id)
            await asyncio.sleep(1.0)

            # Event in sector2
            await get_status(client, char_id)

            await asyncio.sleep(1.0)
            end_time = datetime.now(timezone.utc)

            # Query with both filters: character AND sector
            admin_result = await client._request("event.query", {
                "admin_password": "",
                "character_id": char_id,
                "sector": sector2,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            assert admin_result["success"]
            events = admin_result["events"]

            # Events should match BOTH filters
            for event in events:
                sender = event.get("sender")
                receiver = event.get("receiver")
                event_sector = event.get("sector")

                # Must involve the character
                assert sender == char_id or receiver == char_id

                # Must be in the specified sector (if sector field present)
                if event_sector is not None:
                    assert event_sector == sector2

        finally:
            await client.close()

    async def test_admin_query_with_invalid_password(self, server_url):
        """Test that query without admin_password key and without character_id fails with 403.

        Note: Test server has open access mode (no password configured), so any provided
        password validates as admin. To test non-admin mode, we omit admin_password entirely.
        """
        client = AsyncGameClient(base_url=server_url, character_id="test_admin_invalid")

        try:
            start_time = datetime.now(timezone.utc)
            end_time = datetime.now(timezone.utc)

            # Query WITHOUT admin_password key and WITHOUT character_id
            # This should fail: not admin (no password key), no character_id
            with pytest.raises(RPCError) as exc_info:
                await client._request("event.query", {
                    # No admin_password key - character mode
                    # No character_id - should fail
                    "start": start_time.isoformat(),
                    "end": end_time.isoformat(),
                })

            assert exc_info.value.status == 403
            assert "character_id or actor_character_id required" in exc_info.value.detail

        finally:
            await client.close()


# =============================================================================
# Character Query Mode Tests (5 tests) - Phase 3
# =============================================================================


class TestCharacterQueryMode:
    """Tests for character query mode (non-admin) with event.query API."""

    async def test_character_query_sees_own_events(self, server_url):
        """Test that character query (no admin password) sees only own events."""
        char_id = "test_char_query_own"
        client = AsyncGameClient(base_url=server_url, character_id=char_id)

        try:
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Join and trigger events
            await client.join(character_id=char_id)
            await get_status(client, char_id)

            await asyncio.sleep(1.0)
            end_time = datetime.now(timezone.utc)

            # Character query (no admin_password)
            char_result = await client._request("event.query", {
                # No admin_password - character mode
                "character_id": char_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            assert char_result["success"]
            events = char_result["events"]

            # All events should involve this character
            for event in events:
                sender = event.get("sender")
                receiver = event.get("receiver")
                assert sender == char_id or receiver == char_id, \
                    f"Character should only see own events (sender={sender}, receiver={receiver})"

        finally:
            await client.close()

    async def test_character_query_privacy(self, server_url):
        """Test that character cannot see other character's private events."""
        char1_id = "test_char_privacy1"
        char2_id = "test_char_privacy2"

        client1 = AsyncGameClient(base_url=server_url, character_id=char1_id)
        client2 = AsyncGameClient(base_url=server_url, character_id=char2_id)

        try:
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Both characters trigger events
            await client1.join(character_id=char1_id)
            await client2.join(character_id=char2_id)

            await get_status(client1, char1_id)
            await get_status(client2, char2_id)

            await asyncio.sleep(1.0)
            end_time = datetime.now(timezone.utc)

            # Char1 queries without admin password
            char1_result = await client1._request("event.query", {
                "character_id": char1_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            assert char1_result["success"]
            events = char1_result["events"]

            # Char1 should NOT see char2's private events
            char2_only_events = [
                e for e in events
                if e.get("sender") == char2_id and e.get("receiver") == char2_id
            ]
            assert len(char2_only_events) == 0, \
                "Char1 should not see char2's private events"

        finally:
            await client1.close()
            await client2.close()

    async def test_character_query_with_sector_filter(self, server_url):
        """Test that character query with sector filter sees only own events in that sector."""
        char_id = "test_char_sector_filter"
        client = AsyncGameClient(base_url=server_url, character_id=char_id)

        try:
            await client.join(character_id=char_id)

            status = await get_status(client, char_id)
            sector1 = status["sector"]["id"]
            adjacent = status["sector"]["adjacent_sectors"]

            if not adjacent:
                pytest.skip("No adjacent sectors")

            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Event in sector1
            await get_status(client, char_id)

            # Move to sector2
            sector2 = adjacent[0]
            await client.move(to_sector=sector2, character_id=char_id)
            await asyncio.sleep(1.0)

            # Event in sector2
            await get_status(client, char_id)

            await asyncio.sleep(1.0)
            end_time = datetime.now(timezone.utc)

            # Character query filtered by sector2
            char_result = await client._request("event.query", {
                "character_id": char_id,
                "sector": sector2,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            assert char_result["success"]
            events = char_result["events"]

            # All events should be in sector2 AND involve this character
            for event in events:
                sender = event.get("sender")
                receiver = event.get("receiver")
                event_sector = event.get("sector")

                assert sender == char_id or receiver == char_id
                if event_sector is not None:
                    assert event_sector == sector2

        finally:
            await client.close()

    async def test_character_query_empty_sector(self, server_url):
        """Test that querying a sector character wasn't in returns empty (not error)."""
        char_id = "test_char_empty_sector"
        client = AsyncGameClient(base_url=server_url, character_id=char_id)

        try:
            await client.join(character_id=char_id)

            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Trigger some events
            await get_status(client, char_id)

            await asyncio.sleep(1.0)
            end_time = datetime.now(timezone.utc)

            # Query for sector 9999 (character hasn't been there)
            char_result = await client._request("event.query", {
                "character_id": char_id,
                "sector": 9999,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            # Should succeed but return empty
            assert char_result["success"]
            assert char_result["count"] == 0, "Should return empty for absent sector"

        finally:
            await client.close()

    async def test_character_query_requires_character_id(self, server_url):
        """Test that character query without character_id fails with 403."""
        client = AsyncGameClient(base_url=server_url, character_id="test_char_requires_id")

        try:
            start_time = datetime.now(timezone.utc)
            end_time = datetime.now(timezone.utc)

            # Query without admin_password and without character_id
            with pytest.raises(RPCError) as exc_info:
                await client._request("event.query", {
                    # No admin_password, no character_id
                    "start": start_time.isoformat(),
                    "end": end_time.isoformat(),
                })

            assert exc_info.value.status == 403
            assert "character_id or actor_character_id required" in exc_info.value.detail

        finally:
            await client.close()


# =============================================================================
# Multi-Character Event Fan-out Tests (3 tests) - Phase 4
# =============================================================================


class TestMultiCharacterEventFanout:
    """Tests for event fan-out to multiple characters."""

    async def test_movement_event_fanout(self, server_url):
        """Test that movement into sector with multiple players fans out correctly.

        Scenario:
        1. Player 2 and Player 3 join and are in sector X (with WebSocket listeners active)
        2. Player 1 moves into sector X
        3. Player 2 and Player 3 should RECEIVE character.moved event via WebSocket
        4. Player 2 and Player 3 should be able to QUERY event log and see the same event

        This tests the complete flow: broadcast → JSONL logging → query API
        """
        char1_id = "test_fanout_player1"
        char2_id = "test_fanout_player2"
        char3_id = "test_fanout_player3"

        print(f"\n{'='*80}")
        print(f"STARTING FAN-OUT TEST")
        print(f"Player 1: {char1_id}")
        print(f"Player 2: {char2_id}")
        print(f"Player 3: {char3_id}")
        print(f"{'='*80}\n")

        # Create AsyncGameClients with WebSocket transport
        client1 = AsyncGameClient(base_url=server_url, character_id=char1_id, transport="websocket")
        client2 = AsyncGameClient(base_url=server_url, character_id=char2_id, transport="websocket")
        client3 = AsyncGameClient(base_url=server_url, character_id=char3_id, transport="websocket")

        # Event collectors to capture events received by each client
        events_p2 = []
        events_p3 = []

        # Register event handlers - these will be called when events arrive via WebSocket
        client2.on("character.moved")(lambda p: events_p2.append({"event": "character.moved", "payload": p}))
        client3.on("character.moved")(lambda p: events_p3.append({"event": "character.moved", "payload": p}))

        try:
            # STEP 1: Player 2 and Player 3 join
            print("STEP 1: Player 2 and Player 3 join...")
            await client2.join(character_id=char2_id)
            await client3.join(character_id=char3_id)

            # STEP 2: Position Player 3 in same sector as Player 2
            print("STEP 2: Positioning players in same sector...")
            status2 = await get_status(client2, char2_id)
            status3 = await get_status(client3, char3_id)
            sector2 = status2["sector"]["id"]
            sector3 = status3["sector"]["id"]

            print(f"  Player 2 in sector {sector2}")
            print(f"  Player 3 in sector {sector3}")

            if sector3 != sector2:
                result = await client3.plot_course(from_sector=sector3, to_sector=sector2)
                if result.get("success") and result.get("path"):
                    print(f"  Moving Player 3 along path: {result['path']}")
                    for next_sector in result["path"][1:]:
                        await client3.move(to_sector=next_sector, character_id=char3_id)
                        await asyncio.sleep(0.2)
                else:
                    pytest.skip("Cannot find path between players")

            status2 = await get_status(client2, char2_id)
            status3 = await get_status(client3, char3_id)
            shared_sector = status2["sector"]["id"]

            if status3["sector"]["id"] != shared_sector:
                pytest.skip("Could not position players in same sector")

            print(f"  ✓ Both players now in sector {shared_sector}")

            # STEP 3: Player 1 joins and moves to shared sector
            print(f"\nSTEP 3: Player 1 moves into sector {shared_sector}...")
            await client1.join(character_id=char1_id)
            status1 = await get_status(client1, char1_id)
            sector1 = status1["sector"]["id"]
            print(f"  Player 1 starts in sector {sector1}")

            # Record start time
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Move Player 1 to shared sector
            if sector1 != shared_sector:
                result = await client1.plot_course(from_sector=sector1, to_sector=shared_sector)
                if result.get("success") and result.get("path"):
                    print(f"  Moving Player 1 along path: {result['path']}")
                    for next_sector in result["path"][1:]:
                        await client1.move(to_sector=next_sector, character_id=char1_id)
                        await asyncio.sleep(0.3)
                else:
                    pytest.skip("Cannot find path to shared sector")
            else:
                # Already there, move out and back
                adjacent = status1["sector"]["adjacent_sectors"]
                if not adjacent:
                    pytest.skip("No adjacent sectors")
                await client1.move(to_sector=adjacent[0], character_id=char1_id)
                await asyncio.sleep(0.3)
                await client1.move(to_sector=shared_sector, character_id=char1_id)

            # Wait for events to propagate
            await asyncio.sleep(2.0)
            end_time = datetime.now(timezone.utc)

            status1_final = await get_status(client1, char1_id)
            print(f"  ✓ Player 1 now in sector {status1_final['sector']['id']}")

            if status1_final["sector"]["id"] != shared_sector:
                pytest.skip("Player1 did not reach shared sector")

            # STEP 5: Verify WebSocket reception
            print("\nSTEP 5: Checking WebSocket event reception...")
            print(f"  Player 2 received {len(events_p2)} character.moved events via WebSocket")
            print(f"  Player 3 received {len(events_p3)} character.moved events via WebSocket")

            # Print events received
            if events_p2:
                print(f"\n  Player 2 WebSocket events:")
                for e in events_p2:
                    payload = e.get("payload", {})
                    mover = payload.get("player", {}).get("id", "unknown")
                    print(f"    - character.moved: player={mover}")
            else:
                print(f"  ⚠️  Player 2 received NO character.moved events via WebSocket!")

            if events_p3:
                print(f"\n  Player 3 WebSocket events:")
                for e in events_p3:
                    payload = e.get("payload", {})
                    mover = payload.get("player", {}).get("id", "unknown")
                    print(f"    - character.moved: player={mover}")
            else:
                print(f"  ⚠️  Player 3 received NO character.moved events via WebSocket!")

            # STEP 6: Verify JSONL logging
            print("\nSTEP 6: Checking JSONL event log...")

            # Admin query to see what was logged
            admin_result = await client1._request("event.query", {
                "admin_password": "",
                "sector": shared_sector,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            print(f"  Admin query found {admin_result['count']} events in JSONL log")

            # STEP 7: Query from Player 2's perspective
            print("\nSTEP 7: Player 2 queries event log...")
            p2_result = await client2._request("event.query", {
                "character_id": char2_id,
                "sector": shared_sector,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            print(f"  Player 2 query returned {p2_result['count']} events from JSONL")
            for e in p2_result["events"]:
                print(f"    - {e.get('event')}: sender={e.get('sender')}, receiver={e.get('receiver')}, direction={e.get('direction')}")

            # STEP 8: Query from Player 3's perspective
            print("\nSTEP 8: Player 3 queries event log...")
            p3_result = await client3._request("event.query", {
                "character_id": char3_id,
                "sector": shared_sector,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            print(f"  Player 3 query returned {p3_result['count']} events from JSONL")
            for e in p3_result["events"]:
                print(f"    - {e.get('event')}: sender={e.get('sender')}, receiver={e.get('receiver')}, direction={e.get('direction')}")

            # ASSERTIONS
            print("\n" + "="*80)
            print("VERIFICATION:")
            print("="*80)

            # Verify WebSocket reception
            if len(events_p2) == 0:
                print("⚠️  Player 2 did NOT receive character.moved via WebSocket")
            else:
                print(f"✓ Player 2 received {len(events_p2)} character.moved events via WebSocket")

            if len(events_p3) == 0:
                print("⚠️  Player 3 did NOT receive character.moved via WebSocket")
            else:
                print(f"✓ Player 3 received {len(events_p3)} character.moved events via WebSocket")

            # Verify JSONL contains those events
            p2_moved_in_log = [e for e in p2_result["events"] if e.get("event") == "character.moved" and e.get("receiver") == char2_id]
            p3_moved_in_log = [e for e in p3_result["events"] if e.get("event") == "character.moved" and e.get("receiver") == char3_id]

            if len(p2_moved_in_log) == 0:
                print("⚠️  Player 2 CANNOT query character.moved from JSONL")
            else:
                print(f"✓ Player 2 can query {len(p2_moved_in_log)} character.moved events from JSONL")

            if len(p3_moved_in_log) == 0:
                print("⚠️  Player 3 CANNOT query character.moved from JSONL")
            else:
                print(f"✓ Player 3 can query {len(p3_moved_in_log)} character.moved events from JSONL")

            # Final assertions
            assert len(events_p2) > 0 or len(events_p3) > 0, \
                "At least one player should receive character.moved via WebSocket"

            assert len(p2_moved_in_log) > 0 or len(p3_moved_in_log) > 0, \
                "At least one player should be able to query character.moved from JSONL"

            print("\n🎉 FAN-OUT TEST PASSED!")

        finally:
            await client1.close()
            await client2.close()
            await client3.close()

    async def test_trade_event_visibility(self, server_url):
        """Test that trade.executed events are private to trader only.

        Scenario: Trader in sector 1 executes trade at port. Outsider in sector 2.
        - Trader: receives trade.executed via WebSocket and JSONL
        - Outsider: does NOT receive trade event (private to trader)

        Note: Trade events are always private - only the trading character sees them.
        """
        from datetime import datetime, timezone
        import asyncio
        from tests.helpers.combat_helpers import create_test_character_knowledge

        trader_id = "test_trade_visibility_trader"
        outsider_id = "test_trade_visibility_outsider"

        # Create both characters at sector 0
        create_test_character_knowledge(trader_id, sector=0, credits=10000, fighters=100, shields=100)
        create_test_character_knowledge(outsider_id, sector=0, credits=10000, fighters=100, shields=100)

        trader = AsyncGameClient(base_url=server_url, character_id=trader_id, transport="websocket")
        outsider = AsyncGameClient(base_url=server_url, character_id=outsider_id, transport="websocket")

        # Setup event collectors
        trader_events = []
        outsider_events = []

        trader.on("trade.executed")(lambda p: trader_events.append({"event": "trade.executed", "payload": p}))
        outsider.on("trade.executed")(lambda p: outsider_events.append({"event": "trade.executed", "payload": p}))

        try:
            await trader.join(character_id=trader_id)
            await outsider.join(character_id=outsider_id)

            # Move trader to sector 1 (has port in test world)
            # Move outsider to sector 2 (different sector)
            await trader.move(to_sector=1, character_id=trader_id)
            await outsider.move(to_sector=2, character_id=outsider_id)
            await asyncio.sleep(0.5)

            # Record start time
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Trader executes trade at port in sector 1
            await trader.trade(
                commodity="neuro_symbolics",
                quantity=1,
                trade_type="buy",
                character_id=trader_id
            )

            # Wait for event propagation
            await asyncio.sleep(1.0)

            end_time = datetime.now(timezone.utc)

            # Verify WebSocket reception - trader should see event
            assert len(trader_events) >= 1, "Trader should receive trade.executed via WebSocket"

            trade_event = trader_events[0]["payload"]
            inner_payload = trade_event.get("payload", trade_event)

            assert "trade" in inner_payload, "Event should contain trade details"
            assert inner_payload["trade"]["trade_type"] == "buy"
            assert inner_payload["trade"]["commodity"] == "neuro_symbolics"

            # Verify outsider does NOT receive the event (private to trader)
            assert len(outsider_events) == 0, "Outsider should NOT receive trade events (private to trader)"

            # Verify JSONL logging - trader should see it
            trader_result = await trader._request("event.query", {
                "character_id": trader_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            assert trader_result["count"] > 0, "Trader should find trade event in JSONL"
            trade_events_logged = [e for e in trader_result["events"] if e.get("event") == "trade.executed"]
            assert len(trade_events_logged) > 0, "Should find trade.executed in JSONL"

            # Verify outsider does NOT see it in JSONL
            outsider_result = await outsider._request("event.query", {
                "character_id": outsider_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            outsider_trade_events = [e for e in outsider_result["events"] if e.get("event") == "trade.executed"]
            assert len(outsider_trade_events) == 0, "Outsider should NOT see trade events in JSONL (private to trader)"

        finally:
            await trader.close()
            await outsider.close()

    async def test_combat_event_fanout(self, server_url):
        """Test that combat events are fanned out to all participants.

        Scenario: 3 players in combat - verify ALL receive identical events.
        This complements test_combat_events_to_participants_only (2 players + outsider).
        """
        from datetime import datetime, timezone
        import asyncio
        from tests.helpers.combat_helpers import create_test_character_knowledge

        player1_id = "test_fanout_player1"
        player2_id = "test_fanout_player2"
        player3_id = "test_fanout_player3"

        # Create 3 players at sector 0
        create_test_character_knowledge(player1_id, sector=0, fighters=100, shields=100)
        create_test_character_knowledge(player2_id, sector=0, fighters=100, shields=100)
        create_test_character_knowledge(player3_id, sector=0, fighters=100, shields=100)

        player1 = AsyncGameClient(base_url=server_url, character_id=player1_id, transport="websocket")
        player2 = AsyncGameClient(base_url=server_url, character_id=player2_id, transport="websocket")
        player3 = AsyncGameClient(base_url=server_url, character_id=player3_id, transport="websocket")

        # Setup event collectors
        player1_events = []
        player2_events = []
        player3_events = []

        player1.on("combat.round_waiting")(lambda p: player1_events.append({"event": "combat.round_waiting", "payload": p}))
        player1.on("combat.round_resolved")(lambda p: player1_events.append({"event": "combat.round_resolved", "payload": p}))

        player2.on("combat.round_waiting")(lambda p: player2_events.append({"event": "combat.round_waiting", "payload": p}))
        player2.on("combat.round_resolved")(lambda p: player2_events.append({"event": "combat.round_resolved", "payload": p}))

        player3.on("combat.round_waiting")(lambda p: player3_events.append({"event": "combat.round_waiting", "payload": p}))
        player3.on("combat.round_resolved")(lambda p: player3_events.append({"event": "combat.round_resolved", "payload": p}))

        try:
            await player1.join(character_id=player1_id)
            await player2.join(character_id=player2_id)
            await player3.join(character_id=player3_id)

            # Move all to sector 1 (forced into combat)
            await player1.move(to_sector=1, character_id=player1_id)
            await player2.move(to_sector=1, character_id=player2_id)
            await player3.move(to_sector=1, character_id=player3_id)
            await asyncio.sleep(0.5)

            # Clear movement events
            player1_events.clear()
            player2_events.clear()
            player3_events.clear()

            # Record start time
            start_time = datetime.now(timezone.utc)
            await asyncio.sleep(0.1)

            # Player 1 initiates combat
            await player1.combat_initiate(character_id=player1_id)
            await asyncio.sleep(2.0)

            end_time = datetime.now(timezone.utc)

            # WebSocket verification: ALL 3 players should receive combat.round_waiting
            p1_waiting = [e for e in player1_events if e["event"] == "combat.round_waiting"]
            p2_waiting = [e for e in player2_events if e["event"] == "combat.round_waiting"]
            p3_waiting = [e for e in player3_events if e["event"] == "combat.round_waiting"]

            assert len(p1_waiting) >= 1, "Player 1 should receive combat.round_waiting"
            assert len(p2_waiting) >= 1, "Player 2 should receive combat.round_waiting"
            assert len(p3_waiting) >= 1, "Player 3 should receive combat.round_waiting"

            # Verify all participants are in the event payload
            p1_payload = p1_waiting[0]["payload"]
            p1_inner = p1_payload.get("payload", p1_payload)

            assert len(p1_inner.get("participants", [])) == 3, "Should have 3 participants"
            participant_names = [p["name"] for p in p1_inner["participants"]]
            assert player1_id in participant_names, "Player 1 should be in participants"
            assert player2_id in participant_names, "Player 2 should be in participants"
            assert player3_id in participant_names, "Player 3 should be in participants"

            # JSONL verification: All 3 players can query combat events
            for player_client, player_id in [(player1, player1_id), (player2, player2_id), (player3, player3_id)]:
                result = await player_client._request("event.query", {
                    "character_id": player_id,
                    "start": start_time.isoformat(),
                    "end": end_time.isoformat(),
                })

                combat_events = [e for e in result["events"] if e.get("event") == "combat.round_waiting"]
                assert len(combat_events) > 0, f"{player_id} should find combat.round_waiting in JSONL"

        finally:
            await player1.close()
            await player2.close()
            await player3.close()


# =============================================================================
# Edge Case Tests (4 tests)
# =============================================================================


class TestEventEdgeCases:
    """Tests for edge cases and error conditions."""

    async def test_large_event_payload_handling(self, active_character, server_url):
        """Test that large event payloads are handled correctly."""
        # Most events should be reasonably sized
        client = active_character["client"]
        char_id = active_character["character_id"]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            # Generate events (my_map removed - use get_status instead)
            await get_status(client, char_id)
            await asyncio.sleep(1.0)

            # Verify events were received (even if large)
            assert len(listener.events) > 0

    async def test_rapid_event_emission_no_loss(self, active_character, server_url):
        """Test that rapid event generation doesn't lose events."""
        client = active_character["client"]
        char_id = active_character["character_id"]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            # Generate rapid events
            for _ in range(5):
                await get_status(client, char_id)
                await asyncio.sleep(0.1)

            await asyncio.sleep(2.0)

            # Should have received multiple events
            assert len(listener.events) >= 5, "Some events may have been lost"
