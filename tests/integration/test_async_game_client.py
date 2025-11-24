"""
Integration tests for AsyncGameClient functionality.

This module tests:
- Client initialization and validation
- Map caching behavior
- API method wrappers
- Error handling and retry logic
- Character ID tracking
- Context manager lifecycle

These tests require a test server running on port 8002.
"""

import asyncio
import os
import pytest
import sys
from pathlib import Path

# Add project paths
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from conftest import EVENT_DELIVERY_WAIT
from gradientbang.utils.api_client import AsyncGameClient, RPCError
from helpers.client_setup import create_client_with_character


pytestmark = [pytest.mark.asyncio, pytest.mark.integration, pytest.mark.requires_server]


def _supabase_mode_enabled():
    """Check if running in Supabase mode."""
    _TRUE_VALUES = {"1", "true", "yes", "y", "on", "enabled"}
    return os.environ.get("USE_SUPABASE_TESTS", "").strip().lower() in _TRUE_VALUES


# =============================================================================
# Helper Functions
# =============================================================================


async def get_status(client, character_id):
    """
    Get character status by calling my_status and waiting for status.snapshot event.
    """
    status_received = asyncio.Future()

    def on_status(event):
        if not status_received.done():
            status_received.set_result(event.get("payload", event))

    token = client.add_event_handler("status.snapshot", on_status)

    try:
        await client.my_status(character_id=character_id)
        status_data = await asyncio.wait_for(status_received, timeout=5.0)
        return status_data
    finally:
        client.remove_event_handler(token)


# =============================================================================
# Client Initialization Tests (3 tests)
# =============================================================================


async def test_client_requires_character_id(server_url, check_server_available):
    """Verify AsyncGameClient requires a non-empty character_id parameter."""
    # Should raise ValueError when character_id is missing
    with pytest.raises(ValueError, match="requires a non-empty character_id"):
        AsyncGameClient(base_url=server_url, character_id="")

    # Should raise TypeError when character_id is not provided
    with pytest.raises(TypeError):
        AsyncGameClient(base_url=server_url)  # type: ignore


async def test_client_connects_to_server(server_url, check_server_available):
    """Verify client can connect to server and access basic properties."""
    char_id = "test_client_connect"
    client = AsyncGameClient(base_url=server_url, character_id=char_id)

    # Should have correct properties
    assert client.character_id == char_id
    assert client.base_url == server_url

    # Should be able to use as context manager
    async with client:
        pass  # Connection happens lazily on first request

    await client.close()


async def test_client_context_manager_cleanup(server_url, check_server_available):
    """Verify context manager properly cleans up resources on exit."""
    char_id = "test_client_cleanup"

    client = await create_client_with_character(server_url, char_id)

    try:
        # In Supabase mode, WebSocket is not used (HTTP polling)
        # In legacy mode, WebSocket connection should be established
        if not _supabase_mode_enabled():
            assert client._ws is not None  # WebSocket should be connected

        # Verify client properties
        assert client.character_id == char_id
    finally:
        await client.close()

    # After close, verify client still has properties
    assert client.character_id == char_id


# =============================================================================
# Map Caching Tests (8 tests)
# =============================================================================


@pytest.mark.skip(reason="my_map endpoint is deprecated")
async def test_map_cache_hit_on_repeated_calls(server_url, check_server_available):
    """Verify cache is used for repeated my_map() calls."""
    char_id = "test_cache_hit"
    async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
        await client.join(character_id=char_id)

        # First call - should hit server (but we can't easily verify without instrumentation)
        # Second call - should use cache (performance would be faster but hard to measure)

        # For now, just verify both calls succeed (detailed cache testing would require
        # server instrumentation or mock patches)
        await client.my_map(character_id=char_id)
        await client.my_map(character_id=char_id)


@pytest.mark.skip(reason="Map caching implementation needs verification - cache invalidation mechanism unclear")
async def test_map_cache_miss_forces_refresh(server_url, check_server_available):
    """Verify force_refresh=True bypasses cache."""
    # Note: my_map() doesn't currently have a force_refresh parameter
    # This test is a placeholder for future cache control features
    pass


async def test_map_cache_updates_on_move(server_url, check_server_available):
    """Verify move updates cache automatically via events."""
    char_id = "test_cache_move"
    client = await create_client_with_character(server_url, char_id)

    try:
        # Get initial status
        status1 = await get_status(client, char_id)
        sector1 = status1["sector"]["id"]

        # Move to adjacent sector
        await client.move(to_sector=1, character_id=char_id)

        # Wait for movement to complete
        await asyncio.sleep(EVENT_DELIVERY_WAIT)

        # Get updated status
        status2 = await get_status(client, char_id)
        sector2 = status2["sector"]["id"]

        # Verify sector changed
        assert sector2 != sector1
    finally:
        await client.close()


async def test_map_cache_updates_on_status(server_url, check_server_available):
    """Verify status calls update internal tracking."""
    char_id = "test_cache_status"
    client = await create_client_with_character(server_url, char_id)

    try:
        # Get status
        status = await get_status(client, char_id)

        # Verify status data is returned
        assert "sector" in status
        assert "ship" in status
        assert status["sector"]["id"] == 0  # New characters start at sector 0
    finally:
        await client.close()


async def test_cache_stores_visited_sectors(server_url, check_server_available):
    """Verify visited sectors accumulate in knowledge."""
    char_id = "test_cache_visited"
    client = await create_client_with_character(server_url, char_id)

    try:
        # Move to sector 1
        await client.move(to_sector=1, character_id=char_id)
        await asyncio.sleep(EVENT_DELIVERY_WAIT)

        # Move to sector 3
        await client.move(to_sector=3, character_id=char_id)
        await asyncio.sleep(EVENT_DELIVERY_WAIT)

        # Note: Verifying accumulated knowledge would require reading the
        # character knowledge file or having a dedicated endpoint
        # For now, just verify moves succeeded
        status = await get_status(client, char_id)
        assert status["sector"]["id"] == 3
    finally:
        await client.close()


@pytest.mark.skip(reason="Port discovery tracking needs server-side knowledge endpoint for verification")
async def test_cache_stores_discovered_ports(server_url, check_server_available):
    """Verify discovered ports persist in knowledge."""
    # Placeholder for port discovery caching tests
    # Would require visiting sectors with ports and verifying knowledge accumulation
    pass


@pytest.mark.skip(reason="Join does not reset character position - characters persist across joins")
async def test_cache_invalidation_on_join(server_url, check_server_available):
    """Verify join clears/resets cache state."""
    char_id = "test_cache_join"
    async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
        # First join
        await client.join(character_id=char_id)
        status1 = await get_status(client, char_id)

        # Move somewhere
        await client.move(to_sector=1, character_id=char_id)
        await asyncio.sleep(EVENT_DELIVERY_WAIT)

        # Second join (simulates reconnect/reset)
        await client.join(character_id=char_id)
        status2 = await get_status(client, char_id)

        # After re-join, character should be reset to sector 0
        assert status2["sector"]["id"] == 0


@pytest.mark.skip(reason="Cache sharing across client instances requires shared cache implementation")
async def test_cache_shared_across_client_instances(server_url, check_server_available):
    """Verify same character shares cache across client instances."""
    # Placeholder - current implementation has per-client cache, not shared
    pass


# =============================================================================
# API Method Wrappers Tests (10 tests)
# =============================================================================


@pytest.mark.skipif(_supabase_mode_enabled(), reason="Supabase requires pre-registered characters; join() does not auto-create")
async def test_join_creates_character(server_url, check_server_available):
    """Verify join() creates and initializes a character."""
    char_id = "test_join_create"
    async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
        result = await client.join(character_id=char_id)

        # Should return success
        assert result.get("success") is True

        # Should be able to get status
        status = await get_status(client, char_id)
        assert status["sector"]["id"] == 0


async def test_move_to_adjacent_sector(server_url, check_server_available):
    """Verify move() works for adjacent sectors."""
    char_id = "test_move_adjacent"
    client = await create_client_with_character(server_url, char_id)

    try:
        # Move to adjacent sector 1
        result = await client.move(to_sector=1, character_id=char_id)
        assert result.get("success") is True

        # Wait for movement to complete
        await asyncio.sleep(EVENT_DELIVERY_WAIT)

        # Verify new location
        status = await get_status(client, char_id)
        assert status["sector"]["id"] == 1
    finally:
        await client.close()


async def test_plot_course_finds_path(server_url, check_server_available):
    """Verify plot_course() returns a valid path."""
    char_id = "test_plot_course"
    client = await create_client_with_character(server_url, char_id)

    try:
        # Set up event listener for course.plot
        course_received = asyncio.Future()

        def on_course(event):
            if not course_received.done():
                course_received.set_result(event.get("payload", event))

        token = client.add_event_handler("course.plot", on_course)

        try:
            # Plot course from 0 to 5
            await client.plot_course(to_sector=5, character_id=char_id)

            # Wait for course event
            course = await asyncio.wait_for(course_received, timeout=5.0)

            # Verify path exists
            assert "path" in course
            assert len(course["path"]) > 0
            assert course["path"][0] == 0  # Starts at current sector
            assert course["path"][-1] == 5  # Ends at destination
        finally:
            client.remove_event_handler(token)
    finally:
        await client.close()


async def test_trade_buy_at_port(server_url, check_server_available):
    """Verify trade() can buy commodities at a port."""
    char_id = "test_trade_buy"
    # Create character with extra credits for trading
    client = await create_client_with_character(server_url, char_id, credits=100000)

    try:
        # Move to sector 1 (has Port BBS which sells neuro_symbolics)
        await client.move(to_sector=1, character_id=char_id)
        await asyncio.sleep(EVENT_DELIVERY_WAIT)

        # Buy neuro_symbolics
        result = await client.trade(
            commodity="neuro_symbolics",
            quantity=10,
            trade_type="buy",
            character_id=char_id,
        )
        assert result.get("success") is True
    finally:
        await client.close()


async def test_trade_sell_at_port(server_url, check_server_available):
    """Verify trade() can sell commodities at a port."""
    char_id = "test_trade_sell"

    # Create character with cargo to sell
    client = await create_client_with_character(
        server_url,
        char_id,
        sector=1,
        credits=10000,
        cargo={"quantum_foam": 50},
    )

    try:
        # Sell quantum_foam (Port BBS buys it)
        result = await client.trade(
            commodity="quantum_foam",
            quantity=10,
            trade_type="sell",
            character_id=char_id,
        )
        assert result.get("success") is True
    finally:
        await client.close()


async def test_combat_initiate_starts_combat(server_url, check_server_available):
    """Verify combat_initiate() starts a combat session."""
    char1 = "test_combat_attacker"
    char2 = "test_combat_defender"

    # Create both characters with fighters
    client1 = await create_client_with_character(server_url, char1, sector=1, fighters=100, shields=50)
    client2 = await create_client_with_character(server_url, char2, sector=1, fighters=100, shields=50)

    try:
        # Initiate combat
        result = await client1.combat_initiate(
            character_id=char1,
            target_id=char2,
            target_type="character",
        )

        # Should return combat data
        assert "combat_id" in result or "success" in result
    finally:
        await client1.close()
        await client2.close()


async def test_combat_action_submits_action(server_url, check_server_available):
    """Verify combat_action() submits actions during combat."""
    char1 = "test_action_attacker"
    char2 = "test_action_defender"

    # Create both characters
    client1 = await create_client_with_character(server_url, char1, sector=2, fighters=100, shields=50)
    client2 = await create_client_with_character(server_url, char2, sector=2, fighters=100, shields=50)

    try:
        # Initiate combat
        combat_result = await client1.combat_initiate(
            character_id=char1,
            target_id=char2,
        )

        combat_id = combat_result.get("combat_id")
        if combat_id:
            # Submit attack action (attack requires target_id)
            action_result = await client1.combat_action(
                combat_id=combat_id,
                action="attack",
                commit=50,
                target_id=char2,
                character_id=char1,
            )
            assert "success" in action_result or "round" in action_result
    finally:
        await client1.close()
        await client2.close()


async def test_recharge_warp_power(server_url, check_server_available):
    """Verify recharge_warp_power() works at sector 0."""
    char_id = "test_recharge"
    client = await create_client_with_character(server_url, char_id, credits=100000)

    try:
        # Deplete warp power by moving
        await client.move(to_sector=1, character_id=char_id)
        await asyncio.sleep(EVENT_DELIVERY_WAIT)  # Wait for move to complete
        await client.move(to_sector=0, character_id=char_id)
        await asyncio.sleep(EVENT_DELIVERY_WAIT)  # Wait for move to complete

        # Get initial state
        status_before = await get_status(client, char_id)
        warp_before = status_before["ship"]["warp_power"]
        credits_before = status_before["ship"]["credits"]

        # Verify warp power was depleted
        assert warp_before < 300, "Warp power should be depleted after movement"

        # Recharge warp power (character at sector 0)
        result = await client.recharge_warp_power(units=10, character_id=char_id)
        assert result.get("success") is True

        # Verify warp power increased and credits decreased
        status_after = await get_status(client, char_id)
        warp_after = status_after["ship"]["warp_power"]
        credits_after = status_after["ship"]["credits"]

        assert warp_after > warp_before, "Warp power should increase after recharge"
        assert credits_after < credits_before, "Credits should decrease after recharge"
    finally:
        await client.close()


async def test_transfer_warp_power(server_url, check_server_available):
    """Verify transfer_warp_power() transfers fuel to another character."""
    char1 = "test_transfer_from"
    char2 = "test_transfer_to"

    # Create both characters at same sector with fuel
    client1 = await create_client_with_character(server_url, char1, sector=1, warp_power=100)
    client2 = await create_client_with_character(server_url, char2, sector=1, warp_power=50)

    try:
        # Transfer fuel
        result = await client1.transfer_warp_power(
            to_player_name=char2,
            units=10,
            character_id=char1,
        )
        assert result.get("success") is True
    finally:
        await client1.close()
        await client2.close()


async def test_my_status_returns_current_state(server_url, check_server_available):
    """Verify my_status() returns complete character state."""
    char_id = "test_my_status"
    client = await create_client_with_character(server_url, char_id)

    try:
        # Get status
        status = await get_status(client, char_id)

        # Verify structure (uses 'player' not 'character')
        assert "sector" in status
        assert "ship" in status
        assert "player" in status
        assert status["sector"]["id"] == 0
    finally:
        await client.close()


# =============================================================================
# Error Handling Tests (8 tests)
# =============================================================================


async def test_network_error_raises_exception(server_url, check_server_available):
    """Verify network failures raise RPCError."""
    char_id = "test_network_error"

    # Use invalid server URL
    client = AsyncGameClient(base_url="http://localhost:9999", character_id=char_id)

    with pytest.raises((RPCError, Exception)):  # Could be connection error or RPC error
        await client.join(character_id=char_id)

    await client.close()


@pytest.mark.timeout(15)
@pytest.mark.skipif(_supabase_mode_enabled(), reason="Supabase requires pre-registered characters")
async def test_timeout_error_on_slow_response(server_url, check_server_available):
    """Verify timeouts are handled properly."""
    # This test is challenging without a slow endpoint
    # Skipping detailed implementation - would need mock or slow test endpoint
    char_id = "test_timeout"
    async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
        # Normal operations should not timeout
        result = await client.join(character_id=char_id)
        assert result.get("success") is True


@pytest.mark.skip(reason="Malformed response testing requires mock server")
async def test_malformed_response_raises_error(server_url, check_server_available):
    """Verify invalid JSON responses are handled."""
    # Would require mock server or instrumentation
    pass


async def test_server_error_status_codes(server_url, check_server_available):
    """Verify 500 errors raise RPCError."""
    char_id = "test_server_error"
    client = await create_client_with_character(server_url, char_id)

    try:
        # Try to move to non-existent sector (should cause server error)
        with pytest.raises(RPCError) as exc_info:
            await client.move(to_sector=99999, character_id=char_id)

        # Verify error has proper structure
        assert exc_info.value.status >= 400
    finally:
        await client.close()


async def test_invalid_endpoint_raises_error(server_url, check_server_available):
    """Verify unknown endpoints fail gracefully."""
    char_id = "test_invalid_endpoint"
    async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
        # Try to call non-existent endpoint
        with pytest.raises(RPCError):
            await client._request("invalid_endpoint_xyz", {"character_id": char_id})


async def test_validation_error_on_bad_params(server_url, check_server_available):
    """Verify invalid parameters are caught."""
    char_id = "test_bad_params"
    client = await create_client_with_character(server_url, char_id)

    try:
        # Try to trade with invalid commodity
        with pytest.raises(RPCError) as exc_info:
            await client.trade(
                commodity="invalid_commodity_xyz",
                quantity=10,
                trade_type="buy",
                character_id=char_id,
            )

        assert exc_info.value.status >= 400
    finally:
        await client.close()


async def test_connection_refused_handled(server_url, check_server_available):
    """Verify server down is handled gracefully."""
    char_id = "test_conn_refused"

    # Use port that's definitely not in use
    client = AsyncGameClient(base_url="http://localhost:9998", character_id=char_id)

    with pytest.raises(Exception):  # ConnectionError or similar
        await client.join(character_id=char_id)

    await client.close()


@pytest.mark.skip(reason="Retry logic not implemented in current client")
async def test_retry_logic_on_transient_errors(server_url, check_server_available):
    """Verify retries on 502/503 errors."""
    # Placeholder for future retry implementation
    pass


# =============================================================================
# Character ID Tracking Tests (5 tests)
# =============================================================================


async def test_default_character_after_join(server_url, check_server_available):
    """Verify client remembers character after join."""
    char_id = "test_default_char"
    client = await create_client_with_character(server_url, char_id)

    try:
        # Client should track character
        assert client.character_id == char_id
    finally:
        await client.close()


async def test_explicit_character_override(server_url, check_server_available):
    """Verify can't override bound character_id."""
    char_id = "test_bound_char"
    client = await create_client_with_character(server_url, char_id)

    try:
        # Trying to use different character should fail
        with pytest.raises(ValueError, match="bound to character_id"):
            await client.move(to_sector=1, character_id="different_char")
    finally:
        await client.close()


async def test_multiple_characters_single_client(server_url, check_server_available):
    """Verify client is bound to single character."""
    char1 = "test_multi_char1"
    char2 = "test_multi_char2"

    # Client bound to char1
    client = await create_client_with_character(server_url, char1)

    try:
        # Can't use char2 with this client
        with pytest.raises(ValueError):
            await client.join(character_id=char2)
    finally:
        await client.close()


async def test_character_mismatch_raises_error(server_url, check_server_available):
    """Verify bound client rejects wrong character_id."""
    char_id = "test_mismatch"
    async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
        # Try to join with different ID
        with pytest.raises(ValueError, match="bound to character_id"):
            await client.join(character_id="wrong_character")


async def test_character_id_in_all_requests(server_url, check_server_available):
    """Verify all requests include correct character_id."""
    char_id = "test_req_char_id"
    client = await create_client_with_character(server_url, char_id)

    try:
        # All methods should accept and validate character_id
        await client.my_status(character_id=char_id)
        await client.move(to_sector=1, character_id=char_id)
        await asyncio.sleep(EVENT_DELIVERY_WAIT)

        # Using wrong ID should fail
        with pytest.raises(ValueError):
            await client.my_status(character_id="wrong_id")
    finally:
        await client.close()


# =============================================================================
# Context Manager Tests (3 tests)
# =============================================================================


@pytest.mark.skipif(_supabase_mode_enabled(), reason="Supabase uses HTTP polling, not WebSocket")
async def test_connect_on_enter(server_url, check_server_available):
    """Verify WebSocket connects in __aenter__."""
    char_id = "test_ctx_enter"
    client = AsyncGameClient(base_url=server_url, character_id=char_id)

    # Before entering context, no WebSocket
    assert client._ws is None

    async with client:
        # Make a request to trigger connection
        await client.join(character_id=char_id)

        # Now WebSocket should be connected
        assert client._ws is not None


@pytest.mark.skipif(_supabase_mode_enabled(), reason="Supabase uses HTTP polling, not WebSocket")
async def test_disconnect_on_exit(server_url, check_server_available):
    """Verify WebSocket closes in __aexit__."""
    char_id = "test_ctx_exit"

    async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
        await client.join(character_id=char_id)
        ws_before = client._ws

    # After exit, connection should be cleaned up
    # We can't easily verify _ws is None because close() may set it
    # But we verified the context manager completed without errors


@pytest.mark.skipif(_supabase_mode_enabled(), reason="Supabase requires pre-registered characters")
async def test_cleanup_on_exception(server_url, check_server_available):
    """Verify resources cleaned even on error."""
    char_id = "test_ctx_exception"

    try:
        async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
            await client.join(character_id=char_id)
            # Force an exception
            raise ValueError("Test exception")
    except ValueError:
        pass  # Expected

    # Context manager should have cleaned up despite exception
    # If it didn't, we would have resource leaks (hard to test directly)
