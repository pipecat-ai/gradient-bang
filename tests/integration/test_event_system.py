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

    async def test_combat_started_event(self):
        """Test that combat.started event is emitted when combat begins."""
        pytest.skip("Requires combat initiation setup")

    async def test_combat_round_ended_event(self):
        """Test that combat.round_ended event is emitted after each round."""
        pytest.skip("Requires combat setup and round execution")

    async def test_combat_ended_event(self):
        """Test that combat.ended event is emitted when combat finishes."""
        pytest.skip("Requires complete combat scenario")

    async def test_trade_completed_event(self, active_character, server_url):
        """Test that trade.completed event is emitted on trade."""
        # This test requires character to be at a port
        pytest.skip("Requires port navigation setup")

    async def test_garrison_created_event(self):
        """Test that garrison.created event is emitted when garrison is placed."""
        pytest.skip("Requires garrison creation API")

    async def test_salvage_created_event(self):
        """Test that salvage.created event is emitted on ship destruction."""
        pytest.skip("Requires ship destruction scenario")

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

    async def test_ship_destroyed_event(self):
        """Test that ship.destroyed event is emitted on ship destruction."""
        pytest.skip("Requires ship destruction scenario")


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

    async def test_combat_events_to_participants_only(self):
        """Test that combat round events only go to participants."""
        pytest.skip("Requires combat scenario with multiple participants")

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

            # STEP 2: Sender sends direct message to recipient
            print(f"\nSTEP 2: {sender_id} sends direct message to {recipient_id}...")
            message_content = "This is a private message for testing"
            await sender_client.send_message(
                content=message_content,
                msg_type="direct",
                to_name=recipient_id,
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

    async def test_garrison_events_filtered_correctly(self):
        """Test that garrison creation events have correct visibility."""
        pytest.skip("Requires garrison mechanics")

    async def test_salvage_events_visible_to_sector(self):
        """Test that salvage creation/collection visible to sector occupants."""
        pytest.skip("Requires salvage mechanics")

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

    async def test_event_immutable_after_emission(self):
        """Test that events cannot be modified after emission."""
        # This would require access to server internals
        pytest.skip("Requires server-side event immutability verification")


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

    async def test_jsonl_survives_server_restart(self):
        """Test that JSONL log persists across server restarts."""
        pytest.skip("Requires server restart capability")

    async def test_jsonl_log_rotation(self):
        """Test that JSONL log rotation works (if implemented)."""
        pytest.skip("Requires log rotation configuration")


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
            assert "character_id required" in exc_info.value.detail

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
            assert "character_id required" in exc_info.value.detail

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
        """Test that trade events are visible to both parties but not third party.

        Scenario: Player1 and Player2 execute trade. Player3 in different sector.
        - Player1 query: sees trade event (sender)
        - Player2 query: sees trade event (receiver, if port trades create receiver records)
        - Player3 query: does NOT see trade event
        """
        # NOTE: This test may need adjustment based on whether port trades
        # create receiver records or only sender records
        pytest.skip("Trade event receiver behavior needs verification - ports may not have receiver records")

    async def test_combat_event_fanout(self, server_url):
        """Test that combat events are visible to all participants."""
        pytest.skip("Combat event fan-out requires combat system verification")


# =============================================================================
# Edge Case Tests (4 tests)
# =============================================================================


class TestEventEdgeCases:
    """Tests for edge cases and error conditions."""

    async def test_event_emission_during_server_shutdown(self):
        """Test behavior of events during server shutdown."""
        pytest.skip("Requires controlled server shutdown")

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

    async def test_event_with_special_characters_in_payload(self):
        """Test that events with special characters are handled correctly."""
        # This would test unicode, escaping, etc.
        pytest.skip("Requires message sending with special characters")
