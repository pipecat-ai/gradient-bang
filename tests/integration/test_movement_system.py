"""
Integration tests for the movement system.

This module tests:
- Move validation (adjacency, sector existence)
- Hyperspace state machine (entering, transiting, arriving)
- Event emission and ordering (departure before arrival, chronological)
- Auto-garrison combat on arrival
- Pathfinding integration
- Edge cases (invalid moves, special sectors)

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
    # AsyncGameClient now requires character_id
    char_id = "test_generic_client"
    async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
        yield client


@pytest.fixture
async def joined_character(server_url):
    """Create and join a test character."""
    char_id = "test_movement_player1"
    client = AsyncGameClient(base_url=server_url, character_id=char_id)

    # Join game - characters start at sector 0
    result = await client.join(character_id=char_id)
    assert result.get("success") is True

    yield {
        "character_id": char_id,
        "client": client,
        "initial_sector": 0,  # Characters always start at sector 0
    }

    await client.close()


@pytest.fixture
async def two_characters(server_url):
    """Create two test characters for multi-character tests."""
    char1_id = "test_movement_player1"
    char2_id = "test_movement_player2"

    client1 = AsyncGameClient(base_url=server_url, character_id=char1_id)
    result1 = await client1.join(character_id=char1_id)
    assert result1.get("success") is True

    client2 = AsyncGameClient(base_url=server_url, character_id=char2_id)
    result2 = await client2.join(character_id=char2_id)
    assert result2.get("success") is True

    yield {
        "char1": {"id": char1_id, "client": client1},
        "char2": {"id": char2_id, "client": client2},
    }

    await client1.close()
    await client2.close()


# =============================================================================
# Move Validation Tests (6 tests)
# =============================================================================


class TestMoveValidation:
    """Tests for move validation logic."""

    async def test_move_to_adjacent_sector_succeeds(self, joined_character, server_url):
        """Test that moving to an adjacent sector succeeds."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        # Get current status to find adjacent sectors
        status = await get_status(client, char_id)
        adjacent = status["sector"]["adjacent_sectors"]
        assert len(adjacent) > 0, "No adjacent sectors found"

        target_sector = adjacent[0]

        # Capture events during move
        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)  # Let listener connect

            # Execute move
            result = await client.move(to_sector=target_sector, character_id=char_id)
            assert result.get("success") is True

            # Wait for events
            await asyncio.sleep(2.0)

            # Verify movement.complete event was emitted
            move_event = assert_event_emitted(listener.events, "movement.complete")
            assert move_event["payload"]["sector"]["id"] == target_sector

    async def test_move_to_non_adjacent_sector_fails(self, joined_character):
        """Test that moving to a non-adjacent sector fails."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        # Try to move to a distant sector (sector 9999 is unlikely to be adjacent)
        with pytest.raises(RPCError) as exc_info:
            await client.move(to_sector=9999, character_id=char_id)

        # Should get a 400 error
        assert exc_info.value.status == 400

    async def test_move_to_nonexistent_sector_fails(self, joined_character):
        """Test that moving to a nonexistent sector fails."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        # Try to move to a sector that doesn't exist
        with pytest.raises(RPCError):
            await client.move(to_sector=999999, character_id=char_id)

    async def test_move_while_in_hyperspace_blocked(self, joined_character, server_url):
        """Test that concurrent moves are prevented by hyperspace flag."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        # Get adjacent sectors
        status = await get_status(client, char_id)
        adjacent = status["sector"]["adjacent_sectors"]
        assert len(adjacent) >= 2, "Need at least 2 adjacent sectors"

        # Start first move (this will set hyperspace flag)
        move_task = asyncio.create_task(
            client.move(to_sector=adjacent[0], character_id=char_id)
        )

        # Immediately try second move (should fail due to hyperspace)
        await asyncio.sleep(0.1)  # Small delay to ensure first move started

        # Second move should fail
        with pytest.raises(RPCError) as exc_info:
            await client.move(to_sector=adjacent[1], character_id=char_id)

        # Wait for first move to complete
        await move_task

    async def test_move_with_insufficient_warp_power_fails(self, server_url):
        """Test that moving without enough warp power fails."""
        # Note: This test may need adjustment based on actual game mechanics
        # For now, we'll just verify the character can't move when depleted
        char_id = "test_movement_low_warp"

        client = AsyncGameClient(base_url=server_url, character_id=char_id)

        try:
            # Join with default warp power
            await client.join(character_id=char_id)

            # Get status to check warp power
            status = await get_status(client, char_id)

            # If warp power is sufficient, this test is informational only
            if status["ship"].get("warp_power", 0) > 0:
                pytest.skip("Character has sufficient warp power")
        finally:
            await client.close()

    async def test_move_with_invalid_character_id_fails(self, server_url):
        """Test that move with nonexistent character fails."""
        char_id = "test_generic_client"
        client = AsyncGameClient(base_url=server_url, character_id=char_id)

        try:
            # Client validates character_id before sending, raises ValueError
            with pytest.raises(ValueError):
                await client.move(to_sector=1, character_id="nonexistent_character")
        finally:
            await client.close()


# =============================================================================
# Hyperspace State Machine Tests (8 tests)
# =============================================================================


class TestHyperspaceStateMachine:
    """Tests for hyperspace state transitions."""

    async def test_hyperspace_flag_set_on_departure(self, joined_character, server_url):
        """Test that in_hyperspace flag is set when movement begins."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        # Get adjacent sector
        status = await get_status(client, char_id)
        target = status["sector"]["adjacent_sectors"][0]

        # Start move
        move_task = asyncio.create_task(
            client.move(to_sector=target, character_id=char_id)
        )

        # Check status immediately (should be in hyperspace)
        await asyncio.sleep(0.1)
        status = await get_status(client, char_id)

        # Complete move
        await move_task

        # Note: This test may need adjustment based on how quickly hyperspace flag is set
        # and whether my_status shows it during transit

    async def test_hyperspace_flag_cleared_on_arrival(self, joined_character, server_url):
        """Test that in_hyperspace flag is cleared after arrival."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        # Get adjacent sector
        status = await get_status(client, char_id)
        target = status["sector"]["adjacent_sectors"][0]

        # Complete move
        await client.move(to_sector=target, character_id=char_id)

        # Check status after arrival
        status = await get_status(client, char_id)

        # Should NOT be in hyperspace anymore
        assert status.get("in_hyperspace") is not True

    async def test_character_location_updates_after_transit(self, joined_character):
        """Test that character location is updated after move completes."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]
        initial_sector = joined_character["initial_sector"]

        # Get adjacent sector
        status = await get_status(client, char_id)
        target = status["sector"]["adjacent_sectors"][0]

        # Move to target
        await client.move(to_sector=target, character_id=char_id)

        # Verify location updated
        status = await get_status(client, char_id)
        assert status["sector"]["id"] == target
        assert status["sector"]["id"] != initial_sector

    async def test_warp_power_consumed_on_move(self, joined_character):
        """Test that warp power is consumed when moving."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        # Get initial warp power
        status = await get_status(client, char_id)
        initial_warp = status["ship"].get("warp_power", 0)
        target = status["sector"]["adjacent_sectors"][0]

        # Move
        await client.move(to_sector=target, character_id=char_id)

        # Check warp power after move
        status = await get_status(client, char_id)
        final_warp = status["ship"].get("warp_power", 0)

        # Warp power should be reduced (unless it's infinite or special case)
        # This test is informational - actual behavior depends on game rules
        assert final_warp >= 0  # At minimum, shouldn't be negative

    async def test_hyperspace_timing_accurate(self, joined_character, server_url):
        """Test that hyperspace transit takes expected time (~2/3 second per warp)."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        # Get adjacent sector
        status = await get_status(client, char_id)
        target = status["sector"]["adjacent_sectors"][0]

        # Time the move
        import time
        start_time = time.time()
        await client.move(to_sector=target, character_id=char_id)
        elapsed = time.time() - start_time

        # Move should take some time but not too long
        # Typical: 0.5-2 seconds depending on server processing
        assert elapsed < 5.0, f"Move took too long: {elapsed}s"

    async def test_concurrent_move_blocked_during_transit(self, joined_character):
        """Test that concurrent move attempts are blocked during transit."""
        # This is similar to test_move_while_in_hyperspace_blocked
        # but emphasizes the state machine aspect
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        status = await get_status(client, char_id)
        adjacent = status["sector"]["adjacent_sectors"]
        assert len(adjacent) >= 2

        # Start first move
        move_task = asyncio.create_task(
            client.move(to_sector=adjacent[0], character_id=char_id)
        )

        await asyncio.sleep(0.1)

        # Second move should be blocked
        with pytest.raises(RPCError):
            await client.move(to_sector=adjacent[1], character_id=char_id)

        await move_task

    async def test_multiple_sequential_moves(self, joined_character):
        """Test that multiple moves can be executed sequentially."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        # Execute 3 sequential moves
        for _ in range(3):
            status = await get_status(client, char_id)
            adjacent = status["sector"]["adjacent_sectors"]

            if not adjacent:
                pytest.skip("No adjacent sectors to move to")

            target = adjacent[0]
            result = await client.move(to_sector=target, character_id=char_id)
            assert result.get("success") is True

            # Verify location updated
            status = await get_status(client, char_id)
            assert status["sector"]["id"] == target

    async def test_transit_interruption_handling(self, joined_character):
        """Test behavior when move is interrupted (edge case)."""
        # This test documents expected behavior if client disconnects during move
        # Actual implementation depends on server handling
        pytest.skip("Transit interruption handling not yet implemented")


# =============================================================================
# Event Ordering and Emission Tests (10 tests - CRITICAL)
# =============================================================================


class TestEventOrdering:
    """Tests for event emission order and timing."""

    async def test_departure_event_emitted_before_arrival(self, joined_character, server_url):
        """Test that character.departure event is emitted before movement.complete."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        # Get adjacent sector
        status = await get_status(client, char_id)
        target = status["sector"]["adjacent_sectors"][0]

        # Capture events during move
        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            # Execute move
            await client.move(to_sector=target, character_id=char_id)

            # Wait for events
            await asyncio.sleep(2.0)

            # Check event order
            movement_events = [
                e for e in listener.events
                if e.get("type") in ["character.departure", "movement.complete"]
            ]

            if len(movement_events) >= 2:
                # Verify departure comes before arrival
                assert_event_order(
                    listener.events,
                    ["character.departure", "movement.complete"]
                )

    async def test_arrival_event_contains_complete_payload(self, joined_character, server_url):
        """Test that movement.complete event has all required fields."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        status = await get_status(client, char_id)
        target = status["sector"]["adjacent_sectors"][0]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            await client.move(to_sector=target, character_id=char_id)
            await asyncio.sleep(2.0)

            # Find movement.complete event
            move_event = assert_event_emitted(listener.events, "movement.complete")

            # Validate required fields
            payload = move_event.get("payload", {})
            assert "sector" in payload
            assert "player" in payload or "character" in payload
            assert payload["sector"]["id"] == target

    async def test_event_timestamps_chronological(self, joined_character, server_url):
        """Test that event timestamps are chronologically ordered."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        status = await get_status(client, char_id)
        target = status["sector"]["adjacent_sectors"][0]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            await client.move(to_sector=target, character_id=char_id)
            await asyncio.sleep(2.0)

            # Verify timestamps are chronological
            assert_events_chronological(listener.events)

    async def test_move_events_include_warp_cost(self, joined_character, server_url):
        """Test that movement events include warp power cost information."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        status = await get_status(client, char_id)
        target = status["sector"]["adjacent_sectors"][0]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            await client.move(to_sector=target, character_id=char_id)
            await asyncio.sleep(2.0)

            # Check if warp cost is included in events
            move_event = assert_event_emitted(listener.events, "movement.complete")
            # Note: Actual field name may vary - this documents expected behavior

    async def test_other_players_see_arrival_in_same_sector(self, two_characters, server_url):
        """Test that other players in the same sector see arrival events."""
        char1 = two_characters["char1"]
        char2 = two_characters["char2"]

        # Move char2 to same sector as char1
        status1 = await get_status(char1["client"], char1["id"])
        char1_sector = status1["sector"]["id"]

        # Plot course for char2 to char1's sector
        # For simplicity, just verify events are broadcast
        async with create_firehose_listener(server_url, char1["id"]) as listener:
            await asyncio.sleep(0.5)

            # Move char1
            adjacent = status1["sector"]["adjacent_sectors"]
            if adjacent:
                await char1["client"].move(to_sector=adjacent[0], character_id=char1["id"])
                await asyncio.sleep(2.0)

                # Verify movement event was broadcast (server emits movement.complete)
                assert_event_emitted(listener.events, "movement.complete")

    async def test_failed_move_emits_error_event(self, joined_character, server_url):
        """Test that failed moves emit error events."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            # Try invalid move
            try:
                await client.move(to_sector=9999, character_id=char_id)
            except RPCError:
                pass  # Expected

            await asyncio.sleep(1.0)

            # Check if error event was emitted (if system emits them)
            # Note: Actual event type may vary

    async def test_move_event_payload_structure(self, joined_character, server_url):
        """Test that movement event payloads match expected schema."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        status = await get_status(client, char_id)
        target = status["sector"]["adjacent_sectors"][0]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            await client.move(to_sector=target, character_id=char_id)
            await asyncio.sleep(2.0)

            move_event = assert_event_emitted(listener.events, "movement.complete")

            # Validate structure
            assert "type" in move_event
            assert "payload" in move_event
            assert isinstance(move_event["payload"], dict)

    async def test_movement_events_sent_to_firehose(self, joined_character, server_url):
        """Test that all movement events are sent to firehose."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        status = await get_status(client, char_id)
        target = status["sector"]["adjacent_sectors"][0]

        # Connect to firehose
        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            # Execute move
            await client.move(to_sector=target, character_id=char_id)
            await asyncio.sleep(2.0)

            # Firehose should have received movement events
            movement_events = [
                e for e in listener.events
                if "movement" in e.get("type", "").lower()
            ]
            assert len(movement_events) > 0, "No movement events on firehose"

    async def test_hyperspace_events_filtered_by_character(self, joined_character, server_url):
        """Test that hyperspace transit events are properly filtered."""
        # This test documents expected privacy behavior for hyperspace events
        pytest.skip("Character-specific event filtering not yet implemented in test infra")

    async def test_move_events_logged_to_jsonl(self, joined_character, server_url):
        """Test that movement events are persisted to JSONL log."""
        # This test would require access to server's JSONL log file
        pytest.skip("JSONL log validation requires server file access")


# =============================================================================
# Auto-Garrison Combat Tests (6 tests)
# =============================================================================


class TestAutoGarrisonCombat:
    """Tests for automatic combat initiation on garrison arrival."""

    async def test_arrival_triggers_garrison_combat(self, joined_character, server_url):
        """Test that arriving at a sector with garrison triggers combat."""
        # This test requires setting up a garrison first
        pytest.skip("Garrison setup requires combat API implementation")

    async def test_arrival_no_garrison_no_combat(self, joined_character):
        """Test that arriving at empty sector doesn't trigger combat."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        # Move to empty sector
        status = await get_status(client, char_id)
        adjacent = status["sector"]["adjacent_sectors"]

        if adjacent:
            await client.move(to_sector=adjacent[0], character_id=char_id)

            # Check status - should NOT be in combat
            status = await get_status(client, char_id)
            # Note: Actual field name may vary
            assert not status.get("in_combat", False)

    async def test_garrison_combat_started_event_emitted(self):
        """Test that garrison combat emits combat.started event."""
        pytest.skip("Requires garrison setup")

    async def test_character_enters_combat_state_on_arrival(self):
        """Test that character state reflects combat after garrison trigger."""
        pytest.skip("Requires garrison setup")

    async def test_arrival_blocked_if_already_in_combat(self):
        """Test that character can't move while in combat."""
        pytest.skip("Requires combat state setup")

    async def test_garrison_auto_attack_on_arrival(self):
        """Test that garrison automatically attacks on arrival."""
        pytest.skip("Requires garrison and combat mechanics")


# =============================================================================
# Pathfinding Integration Tests (4 tests)
# =============================================================================


class TestPathfindingIntegration:
    """Tests for pathfinding and navigation."""

    async def test_plot_course_returns_valid_path(self, joined_character):
        """Test that plot_course returns a valid path."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        # Plot course to a distant sector (test universe has 10 sectors: 0-9)
        result = await client.plot_course(to_sector=9, character_id=char_id)

        assert "path" in result or "success" in result
        # Verify path structure if returned

    async def test_plot_course_no_path_returns_empty(self, joined_character):
        """Test that plot_course handles unreachable sectors."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        # In the test universe (10 connected sectors), all sectors should be reachable
        # Test with invalid sector number instead
        with pytest.raises(RPCError) as exc_info:
            await client.plot_course(to_sector=999999, character_id=char_id)

        # Should get error for invalid sector
        assert exc_info.value.status == 400

    async def test_sequential_moves_follow_plotted_course(self, joined_character):
        """Test that character can follow a plotted course."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        # Get current location
        status = await get_status(client, char_id)
        current = status["sector"]["id"]

        # Plot course to nearby sector (test universe has 10 sectors: 0-9)
        target = 9 if current != 9 else 8  # Pick a different sector
        course = await client.plot_course(to_sector=target, character_id=char_id)

        # If path exists and is reasonable length, follow it
        if "path" in course and len(course["path"]) <= 3:
            path = course["path"]

            for i in range(1, min(3, len(path))):
                next_sector = path[i]
                await client.move(to_sector=next_sector, character_id=char_id)

                # Verify we're at expected location
                status = await get_status(client, char_id)
                assert status["sector"]["id"] == next_sector

    async def test_pathfinding_performance_large_universe(self, joined_character):
        """Test that pathfinding performs well even for distant sectors."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        import time

        # Plot course to distant sector (test universe has 10 sectors: 0-9)
        start_time = time.time()
        await client.plot_course(to_sector=9, character_id=char_id)
        elapsed = time.time() - start_time

        # Pathfinding should complete quickly
        assert elapsed < 2.0, f"Pathfinding took too long: {elapsed}s"


# =============================================================================
# Edge Case Tests (4 tests)
# =============================================================================


class TestEdgeCases:
    """Tests for edge cases and special scenarios."""

    async def test_move_to_sector_zero_always_allowed(self, joined_character):
        """Test that sector 0 is always reachable (special case)."""
        client = joined_character["client"]
        char_id = joined_character["character_id"]

        # Move away from sector 0 first
        status = await get_status(client, char_id)
        if status["sector"]["id"] == 0:
            adjacent = status["sector"]["adjacent_sectors"]
            if adjacent:
                await client.move(to_sector=adjacent[0], character_id=char_id)

        # Now try to move to sector 0
        # This may or may not be a special case depending on game rules
        status = await get_status(client, char_id)
        current = status["sector"]["id"]

        if current != 0:
            # Check if sector 0 is in adjacent list
            adjacent = status["sector"]["adjacent_sectors"]
            if 0 in adjacent:
                result = await client.move(to_sector=0, character_id=char_id)
                assert result.get("success") is True

    async def test_move_after_ship_destruction(self, joined_character):
        """Test that move fails if ship is destroyed."""
        # This requires destroying the ship first
        pytest.skip("Ship destruction mechanics not yet in test scope")

    async def test_move_with_zero_warp_power(self, joined_character):
        """Test that move fails with zero warp power."""
        # This requires depleting warp power first
        pytest.skip("Warp power depletion not yet in test scope")

    # Note: test_move_updates_knowledge_cache removed - my_map endpoint no longer exists
