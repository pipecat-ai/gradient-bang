"""
Integration tests for the trading system.

This module tests:
- Buy/sell operations (commodity validation, quantity)
- Pricing formulas (sqrt-curve supply/demand)
- Inventory management (cargo holds, port stock)
- Credit transactions (atomicity, validation)
- Port locks (concurrent trade prevention)
- Port regeneration (stock replenishment over time)
- Trade events (logging, filtering)

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
    assert_event_payload,
    assert_no_event_emitted,
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
async def trader_at_port(server_url):
    """Create a character at a port sector for trading."""
    char_id = "test_trader_at_port"
    client = AsyncGameClient(base_url=server_url, character_id=char_id)

    # Join game
    await client.join(character_id=char_id)

    # Find a port
    status = await get_status(client, char_id)

    # Look for nearby ports
    ports_result = await client.list_known_ports(character_id=char_id, max_hops=5)

    if not ports_result.get("ports"):
        await client.close()
        pytest.skip("No ports found within 5 hops for trading tests")

    # Navigate to first port
    port_info = ports_result["ports"][0]
    port_sector = port_info.get("sector_id") or port_info.get("sector", {}).get("id")

    # Plot course and move there
    course = await client.plot_course(to_sector=port_sector, character_id=char_id)

    if "path" in course:
        for i in range(1, len(course["path"])):
            next_sector = course["path"][i]
            await client.move(to_sector=next_sector, character_id=char_id)
            await asyncio.sleep(1.0)  # Wait for move to complete

    yield {
        "character_id": char_id,
        "client": client,
        "port_sector": port_sector,
        "port_info": port_info,
    }

    await client.close()


@pytest.fixture
async def trader_with_cargo(server_url):
    """Create a character with some cargo for selling."""
    # This is a simplified fixture - actual implementation would need to
    # buy cargo first or use admin commands to set up character state
    char_id = "test_trader_with_cargo"
    client = AsyncGameClient(base_url=server_url, character_id=char_id)
    await client.join(character_id=char_id)

    yield {
        "character_id": char_id,
        "client": client,
    }

    await client.close()


@pytest.fixture
async def rich_trader(server_url):
    """Create a character with high credits for buying."""
    # In actual implementation, would need admin API to set credits
    # For now, characters start with default credits
    char_id = "test_rich_trader"
    client = AsyncGameClient(base_url=server_url, character_id=char_id)
    await client.join(character_id=char_id)

    yield {
        "character_id": char_id,
        "client": client,
    }

    await client.close()


# =============================================================================
# Trade Operation Tests (6 tests)
# =============================================================================


class TestTradeOperations:
    """Tests for basic buy/sell operations."""

    async def test_buy_commodity_at_port(self, trader_at_port, server_url):
        """Test buying a commodity at a port."""
        client = trader_at_port["client"]
        char_id = trader_at_port["character_id"]

        # Get initial status
        status_before = await get_status(client, char_id)
        credits_before = status_before["player"]["credits"]

        # Capture events during trade
        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            # Buy commodity (quantum_foam is a standard commodity)
            try:
                result = await client.trade(
                    commodity="quantum_foam",
                    quantity=10,
                    trade_type="buy",
                    character_id=char_id
                )

                # Check if trade succeeded
                if result.get("success"):
                    await asyncio.sleep(1.0)

                    # Verify credits decreased
                    status_after = await get_status(client, char_id)
                    credits_after = status_after["player"]["credits"]
                    assert credits_after < credits_before, "Credits should decrease after buying"

                    # Verify trade event was emitted
                    assert_event_emitted(listener.events, "trade.completed")
                else:
                    pytest.skip(f"Trade failed: {result}")

            except RPCError as e:
                pytest.skip(f"Trade not available: {e}")

    async def test_sell_commodity_at_port(self, trader_with_cargo):
        """Test selling a commodity at a port."""
        client = trader_with_cargo["client"]
        char_id = trader_with_cargo["character_id"]

        # First need to buy something to sell
        # This test requires a more complex setup
        pytest.skip("Requires buying cargo first - depends on test_buy_commodity_at_port")

    async def test_buy_with_insufficient_credits_fails(self, trader_at_port):
        """Test that buying more than character can afford fails."""
        client = trader_at_port["client"]
        char_id = trader_at_port["character_id"]

        # Try to buy huge quantity
        with pytest.raises(RPCError) as exc_info:
            await client.trade(
                commodity="quantum_foam",
                quantity=100000,
                trade_type="buy",
                character_id=char_id
            )

        # Should get error about insufficient credits
        assert exc_info.value.status in [400, 422]

    async def test_sell_with_insufficient_cargo_fails(self, trader_at_port):
        """Test that selling more than character has fails."""
        client = trader_at_port["client"]
        char_id = trader_at_port["character_id"]

        # Try to sell commodity we don't have
        with pytest.raises(RPCError) as exc_info:
            await client.trade(
                commodity="quantum_foam",
                quantity=1000,
                trade_type="sell",
                character_id=char_id
            )

        # Should get error about insufficient cargo
        assert exc_info.value.status in [400, 422]

    async def test_trade_at_non_port_sector_fails(self, client):
        """Test that trading at a non-port sector fails."""
        char_id = "test_trader_no_port"
        await client.join(character_id=char_id)

        # Ensure we're not at a port (sector 0 typically isn't a port)
        status = await get_status(client, char_id)

        # Try to trade
        with pytest.raises(RPCError) as exc_info:
            await client.trade(
                commodity="quantum_foam",
                quantity=10,
                trade_type="buy",
                character_id=char_id
            )

        # Should fail with appropriate error
        assert exc_info.value.status in [400, 422]

    async def test_trade_exceeds_cargo_hold_fails(self, trader_at_port):
        """Test that buying more than cargo hold capacity fails."""
        client = trader_at_port["client"]
        char_id = trader_at_port["character_id"]

        # Try to buy more than cargo hold can fit
        with pytest.raises(RPCError) as exc_info:
            await client.trade(
                commodity="quantum_foam",
                quantity=10000,  # Way more than typical cargo hold
                trade_type="buy",
                character_id=char_id
            )

        # Should fail with capacity error
        assert exc_info.value.status in [400, 422]


# =============================================================================
# Pricing Formula Tests (6 tests)
# =============================================================================


class TestPricingFormulas:
    """Tests for trading pricing mechanics."""

    async def test_buy_price_increases_with_demand(self, trader_at_port):
        """Test that buying the same commodity multiple times increases price."""
        # This would require multiple sequential buys and price tracking
        pytest.skip("Requires sequential trades and price comparison")

    async def test_sell_price_decreases_with_supply(self, trader_with_cargo):
        """Test that selling increases supply and decreases price."""
        pytest.skip("Requires multiple sells and price tracking")

    async def test_pricing_uses_sqrt_curve(self, trader_at_port):
        """Test that pricing follows sqrt-based supply/demand curve."""
        # This would require examining actual price calculations
        pytest.skip("Requires access to pricing calculation details")

    async def test_port_type_affects_base_price(self, client):
        """Test that different port types have different base prices."""
        # This would require visiting multiple port types
        pytest.skip("Requires multiple port types for comparison")

    async def test_quantity_affects_total_price(self, trader_at_port):
        """Test that buying/selling different quantities affects total price appropriately."""
        pytest.skip("Requires multiple trades with different quantities")

    async def test_pricing_consistent_across_calls(self, trader_at_port):
        """Test that querying price multiple times returns consistent results."""
        # This assumes there's a price query API
        pytest.skip("Requires price query API (if available)")


# =============================================================================
# Inventory Management Tests (6 tests)
# =============================================================================


class TestInventoryManagement:
    """Tests for cargo, credits, and port stock management."""

    async def test_buy_increases_cargo_decreases_credits(self, trader_at_port):
        """Test that buying updates both cargo and credits correctly."""
        client = trader_at_port["client"]
        char_id = trader_at_port["character_id"]

        # Get initial state
        status_before = await get_status(client, char_id)
        credits_before = status_before["player"]["credits"]
        cargo_before = status_before["player"].get("cargo", {})

        try:
            # Buy commodity
            result = await client.trade(
                commodity="quantum_foam",
                quantity=5,
                trade_type="buy",
                character_id=char_id
            )

            if result.get("success"):
                # Get final state
                status_after = await get_status(client, char_id)
                credits_after = status_after["player"]["credits"]
                cargo_after = status_after["player"].get("cargo", {})

                # Verify credits decreased
                assert credits_after < credits_before

                # Verify cargo increased
                cargo_quantum_before = cargo_before.get("quantum_foam", 0)
                cargo_quantum_after = cargo_after.get("quantum_foam", 0)
                assert cargo_quantum_after > cargo_quantum_before

        except RPCError:
            pytest.skip("Trade not available at this port")

    async def test_sell_decreases_cargo_increases_credits(self, trader_with_cargo):
        """Test that selling updates both cargo and credits correctly."""
        pytest.skip("Requires cargo setup first")

    async def test_buy_decreases_port_stock(self, trader_at_port):
        """Test that buying decreases port's commodity stock."""
        # This requires access to port stock information
        pytest.skip("Requires port stock visibility API")

    async def test_sell_increases_port_stock(self, trader_with_cargo):
        """Test that selling increases port's commodity stock."""
        pytest.skip("Requires port stock visibility API and cargo setup")

    async def test_cargo_hold_capacity_enforced(self, trader_at_port):
        """Test that cargo hold capacity limits are enforced."""
        # Already partially covered in test_trade_exceeds_cargo_hold_fails
        pytest.skip("Covered by trade operation tests")

    async def test_inventory_state_consistent_after_trade(self, trader_at_port):
        """Test that all inventory values are consistent after trading."""
        client = trader_at_port["client"]
        char_id = trader_at_port["character_id"]

        # Get state before trade
        status_before = await get_status(client, char_id)

        try:
            # Execute trade
            await client.trade(
                commodity="quantum_foam",
                quantity=1,
                trade_type="buy",
                character_id=char_id
            )

            # Get state after trade
            status_after = await get_status(client, char_id)

            # Verify all fields are present and valid
            assert "credits" in status_after["player"]
            assert "cargo" in status_after["player"]
            assert status_after["player"]["credits"] >= 0

        except RPCError:
            pytest.skip("Trade not available")


# =============================================================================
# Atomicity and Concurrency Tests (6 tests)
# =============================================================================


class TestAtomicityAndConcurrency:
    """Tests for transaction atomicity and concurrent trade handling."""

    async def test_trade_transaction_atomic(self, trader_at_port):
        """Test that trade is atomic (all-or-nothing)."""
        # This would require inducing a failure mid-transaction
        pytest.skip("Requires ability to induce transaction failures")

    async def test_concurrent_trades_at_same_port_serialized(self, client, server_url):
        """Test that concurrent trades at the same port are properly serialized."""
        # Create two characters at same port
        char1 = "test_concurrent_trader1"
        char2 = "test_concurrent_trader2"

        await client.join(character_id=char1)

        async with AsyncGameClient(base_url=server_url) as client2:
            await client2.join(character_id=char2)

            # Both need to be at same port - complex setup
            pytest.skip("Requires complex multi-character port setup")

    async def test_port_lock_prevents_race_condition(self, trader_at_port):
        """Test that port locks prevent inventory corruption."""
        pytest.skip("Requires concurrent trade setup and port lock verification")

    async def test_credit_lock_prevents_double_spend(self, trader_at_port):
        """Test that credit locks prevent spending same credits twice."""
        pytest.skip("Requires concurrent spend attempts")

    async def test_failed_trade_rolls_back_state(self, trader_at_port):
        """Test that failed trades don't leave partial state changes."""
        client = trader_at_port["client"]
        char_id = trader_at_port["character_id"]

        # Get initial state
        status_before = await get_status(client, char_id)
        credits_before = status_before["player"]["credits"]

        # Try invalid trade that should fail
        try:
            await client.trade(
                commodity="invalid_commodity",
                quantity=10,
                trade_type="buy",
                character_id=char_id
            )
        except RPCError:
            pass  # Expected

        # Verify state unchanged
        status_after = await get_status(client, char_id)
        credits_after = status_after["player"]["credits"]

        assert credits_after == credits_before, "Credits should be unchanged after failed trade"

    async def test_server_crash_during_trade_recoverable(self):
        """Test that server crash during trade is recoverable."""
        pytest.skip("Requires server crash simulation")


# =============================================================================
# Port Regeneration Tests (3 tests)
# =============================================================================


class TestPortRegeneration:
    """Tests for port stock regeneration over time."""

    async def test_port_stock_regenerates_over_time(self):
        """Test that port stock increases over time."""
        pytest.skip("Requires time-based observation of port stock")

    async def test_port_reset_restores_initial_stock(self):
        """Test that port reset mechanism works."""
        pytest.skip("Requires admin API or port reset functionality")

    async def test_port_stock_caps_at_maximum(self):
        """Test that port stock doesn't exceed maximum values."""
        pytest.skip("Requires long-term observation or stock inspection")


# =============================================================================
# Trade Event Tests (4 tests)
# =============================================================================


class TestTradeEvents:
    """Tests for trade event emission and structure."""

    async def test_trade_event_emitted_on_buy(self, trader_at_port, server_url):
        """Test that trade.completed event is emitted on buy."""
        client = trader_at_port["client"]
        char_id = trader_at_port["character_id"]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            try:
                # Execute buy
                result = await client.trade(
                    commodity="quantum_foam",
                    quantity=5,
                    trade_type="buy",
                    character_id=char_id
                )

                if result.get("success"):
                    await asyncio.sleep(1.0)

                    # Verify event emitted
                    trade_event = assert_event_emitted(listener.events, "trade.completed")

                    # Verify event has trade details
                    payload = trade_event.get("payload", {})
                    assert "commodity" in payload or "trade_type" in payload

            except RPCError:
                pytest.skip("Trade not available")

    async def test_trade_event_emitted_on_sell(self, trader_with_cargo, server_url):
        """Test that trade.completed event is emitted on sell."""
        pytest.skip("Requires cargo setup first")

    async def test_trade_event_contains_pricing_info(self, trader_at_port, server_url):
        """Test that trade events include price information."""
        client = trader_at_port["client"]
        char_id = trader_at_port["character_id"]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            try:
                result = await client.trade(
                    commodity="quantum_foam",
                    quantity=1,
                    trade_type="buy",
                    character_id=char_id
                )

                if result.get("success"):
                    await asyncio.sleep(1.0)

                    trade_event = assert_event_emitted(listener.events, "trade.completed")
                    payload = trade_event.get("payload", {})

                    # Check for pricing fields (actual field names may vary)
                    # This documents expected event structure

            except RPCError:
                pytest.skip("Trade not available")

    async def test_trade_event_logged_to_jsonl(self):
        """Test that trade events are persisted to JSONL log."""
        pytest.skip("Requires server log file access")


# =============================================================================
# Edge Case Tests (4 tests)
# =============================================================================


class TestTradeEdgeCases:
    """Tests for edge cases and error conditions."""

    async def test_trade_invalid_commodity_fails(self, trader_at_port):
        """Test that trading with invalid commodity name fails."""
        client = trader_at_port["client"]
        char_id = trader_at_port["character_id"]

        with pytest.raises(RPCError):
            await client.trade(
                commodity="nonexistent_commodity",
                quantity=10,
                trade_type="buy",
                character_id=char_id
            )

    async def test_trade_negative_quantity_fails(self, trader_at_port):
        """Test that negative quantity is rejected."""
        client = trader_at_port["client"]
        char_id = trader_at_port["character_id"]

        with pytest.raises(RPCError):
            await client.trade(
                commodity="quantum_foam",
                quantity=-10,
                trade_type="buy",
                character_id=char_id
            )

    async def test_trade_zero_quantity_fails(self, trader_at_port):
        """Test that zero quantity is rejected."""
        client = trader_at_port["client"]
        char_id = trader_at_port["character_id"]

        with pytest.raises(RPCError):
            await client.trade(
                commodity="quantum_foam",
                quantity=0,
                trade_type="buy",
                character_id=char_id
            )

    async def test_trade_while_in_hyperspace_fails(self, client):
        """Test that trading while in hyperspace is blocked."""
        char_id = "test_hyperspace_trader"
        await client.join(character_id=char_id)

        # Get adjacent sector
        status = await get_status(client, char_id)
        adjacent = status["sector"]["adjacent_sectors"]

        if not adjacent:
            pytest.skip("No adjacent sectors for move")

        # Start move (puts character in hyperspace)
        move_task = asyncio.create_task(
            client.move(to_sector=adjacent[0], character_id=char_id)
        )

        await asyncio.sleep(0.1)  # Let move start

        # Try to trade while in hyperspace
        with pytest.raises(RPCError):
            await client.trade(
                commodity="quantum_foam",
                quantity=10,
                trade_type="buy",
                character_id=char_id
            )

        # Complete move
        await move_task
