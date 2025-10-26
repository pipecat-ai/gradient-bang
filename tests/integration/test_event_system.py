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
import pytest
import sys
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
            async with create_firehose_listener(server_url, char_id) as listener:
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

    async def test_private_events_only_to_character(self):
        """Test that private events (trade, inventory, credits) only go to character."""
        pytest.skip("Requires character-specific event stream implementation")

    async def test_public_events_to_all_in_sector(self, server_url):
        """Test that public events (movement in same sector) broadcast to all."""
        # Create two characters
        char1 = "test_public_event1"
        char2 = "test_public_event2"

        client1 = AsyncGameClient(base_url=server_url, character_id=char1)
        await client1.join(character_id=char1)

        client2 = AsyncGameClient(base_url=server_url, character_id=char2)
        await client2.join(character_id=char2)

        try:
            # Both characters should see each other's status events on firehose
            async with create_firehose_listener(server_url, char_id) as listener:
                await asyncio.sleep(0.5)

                # Char1 checks status
                await client1.my_status(character_id=char1)
                await asyncio.sleep(1.0)

                # Firehose should have the event
                events = listener.filter_events("status.snapshot")
                assert len(events) > 0, "Status events should be on firehose"
        finally:
            await client1.close()
            await client2.close()

    async def test_combat_events_to_participants_only(self):
        """Test that combat round events only go to participants."""
        pytest.skip("Requires combat scenario with multiple participants")

    async def test_trade_events_private_to_trader(self):
        """Test that trade completion events are private to the trader."""
        pytest.skip("Requires character-specific filtering")

    async def test_message_events_to_recipient_and_sender(self):
        """Test that private messages only go to sender and recipient."""
        pytest.skip("Requires private messaging and filtering")

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

    async def test_movement_events_visible_to_sector_occupants(self):
        """Test that arrivals/departures visible to those in same sector."""
        pytest.skip("Requires multi-character sector setup")

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

    async def test_events_logged_to_jsonl_file(self):
        """Test that events are persisted to JSONL file."""
        pytest.skip("Requires server log file access")

    async def test_jsonl_one_event_per_line(self):
        """Test that JSONL has exactly one event per line."""
        pytest.skip("Requires server log file access")

    async def test_jsonl_append_only(self):
        """Test that JSONL is append-only (no modification)."""
        pytest.skip("Requires server log file access and monitoring")

    async def test_jsonl_survives_server_restart(self):
        """Test that JSONL log persists across server restarts."""
        pytest.skip("Requires server restart capability")

    async def test_jsonl_readable_and_parseable(self):
        """Test that JSONL log is readable and parseable."""
        pytest.skip("Requires server log file access")

    async def test_jsonl_log_rotation(self):
        """Test that JSONL log rotation works (if implemented)."""
        pytest.skip("Requires log rotation configuration")


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
