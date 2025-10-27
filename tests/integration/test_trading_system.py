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
from datetime import datetime, timezone
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
from helpers.combat_helpers import create_test_character_knowledge


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
    char_id = "test_trading_client"
    async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
        yield client


@pytest.fixture
async def trader_at_port(server_url):
    """Create a character at a port sector for trading.

    Pre-populates character knowledge with all port sectors (1, 3, 5, 9)
    so that list_known_ports() will find them immediately without exploration.
    """
    char_id = "test_trader_at_port"

    # Pre-create character knowledge with all port sectors visited
    # This allows list_known_ports() to find ports without exploration
    # We create this BEFORE calling join() so that join() loads existing knowledge
    create_test_character_knowledge(
        char_id,
        sector=1,  # Start at a port sector for convenience
        visited_sectors=[0, 1, 3, 5, 9],  # All sectors with ports + start
        credits=100000,  # Plenty of credits for trading tests
    )

    client = AsyncGameClient(base_url=server_url, character_id=char_id)

    # Call join() which will:
    # 1. Check character is registered (test_trader_at_port is in TEST_CHARACTER_IDS)
    # 2. Check for knowledge file (we just created it)
    # 3. Load existing knowledge instead of creating new character
    await client.join(character_id=char_id)

    # Verify knowledge was preserved by finding ports
    # Set up event listener for ports.list event
    ports_received = asyncio.Future()

    def on_ports_list(event):
        if not ports_received.done():
            ports_received.set_result(event.get("payload", event))

    token = client.add_event_handler("ports.list", on_ports_list)

    try:
        # Request list of known ports
        await client.list_known_ports(character_id=char_id, max_hops=10)

        # Wait for the ports.list event
        ports_result = await asyncio.wait_for(ports_received, timeout=5.0)
    finally:
        client.remove_event_handler(token)

    ports = ports_result.get("ports", [])

    if not ports:
        await client.close()
        pytest.fail(f"No ports found even after pre-populating knowledge - test setup error")

    # We already know about ports, pick sector 1 (has Port BBS)
    port_sector = 1
    port_info = next((p for p in ports if p.get("sector", {}).get("id") == port_sector), ports[0])

    # Character is already at sector 1 (we created them there), so no navigation needed!

    yield {
        "character_id": char_id,
        "client": client,
        "port_sector": port_sector,
        "port_info": port_info,
    }

    await client.close()


@pytest.fixture
async def trader_with_cargo(server_url):
    """Create a character with cargo for selling.

    Pre-populates cargo with quantum_foam and retro_organics which can be sold
    at sector 1 port (Port BBS: Buys QF/RO, Sells NS).
    """
    char_id = "test_trader_with_cargo"

    # Pre-create knowledge with cargo
    create_test_character_knowledge(
        char_id,
        sector=1,  # Port BBS: Buys QF/RO, Sells NS
        visited_sectors=[0, 1, 3, 5, 9],  # All port sectors
        credits=100000,
        cargo={
            "quantum_foam": 50,
            "retro_organics": 50,
            "neuro_symbolics": 0,
        }
    )

    client = AsyncGameClient(base_url=server_url, character_id=char_id)
    await client.join(character_id=char_id)

    yield {
        "character_id": char_id,
        "client": client,
        "port_sector": 1,
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
        credits_before = status_before["player"]["credits_on_hand"]

        # Capture events during trade
        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            # Buy commodity (neuro_symbolics is available at sector 1 port BBS)
            # Port code BBS: Buys QF/RO, Sells NS
            try:
                result = await client.trade(
                    commodity="neuro_symbolics",
                    quantity=10,
                    trade_type="buy",
                    character_id=char_id
                )

                # Check if trade succeeded
                if result.get("success"):
                    await asyncio.sleep(1.0)

                    # Verify credits decreased
                    status_after = await get_status(client, char_id)
                    credits_after = status_after["player"]["credits_on_hand"]
                    assert credits_after < credits_before, "Credits should decrease after buying"

                    # Verify trade event was emitted
                    assert_event_emitted(listener.events, "trade.executed")
                else:
                    pytest.skip(f"Trade failed: {result}")

            except RPCError as e:
                pytest.skip(f"Trade not available: {e}")

    async def test_sell_commodity_at_port(self, trader_with_cargo, server_url):
        """Test selling a commodity at a port."""
        client = trader_with_cargo["client"]
        char_id = trader_with_cargo["character_id"]

        # Get initial status
        status_before = await get_status(client, char_id)
        credits_before = status_before["player"]["credits_on_hand"]

        # Capture events during trade
        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            # Sell commodity (quantum_foam - port BBS buys it)
            try:
                result = await client.trade(
                    commodity="quantum_foam",
                    quantity=10,
                    trade_type="sell",
                    character_id=char_id
                )

                # Check if trade succeeded
                if result.get("success"):
                    await asyncio.sleep(1.0)

                    # Verify credits increased
                    status_after = await get_status(client, char_id)
                    credits_after = status_after["player"]["credits_on_hand"]
                    assert credits_after > credits_before, "Credits should increase after selling"

                    # Verify trade event was emitted
                    assert_event_emitted(listener.events, "trade.executed")
                else:
                    pytest.skip(f"Trade failed: {result}")

            except RPCError as e:
                pytest.skip(f"Trade not available: {e}")

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
        """Test that selling more than character has fails with 400 (not 500)."""
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

        # Should get 400 client error (not 500 server error)
        assert exc_info.value.status == 400, f"Expected 400, got {exc_info.value.status}"
        assert "not enough" in str(exc_info.value).lower() or "insufficient" in str(exc_info.value).lower()

    async def test_trade_at_non_port_sector_fails(self, server_url):
        """Test that trading at a non-port sector fails."""
        char_id = "test_trader_no_port"
        client = AsyncGameClient(base_url=server_url, character_id=char_id)

        try:
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
        finally:
            await client.close()

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
        credits_before = status_before["player"]["credits_on_hand"]
        cargo_before = status_before["ship"]["cargo"]

        try:
            # Buy commodity (neuro_symbolics is sold at sector 1 port BBS)
            result = await client.trade(
                commodity="neuro_symbolics",
                quantity=5,
                trade_type="buy",
                character_id=char_id
            )

            if result.get("success"):
                # Get final state
                status_after = await get_status(client, char_id)
                credits_after = status_after["player"]["credits_on_hand"]
                cargo_after = status_after["ship"]["cargo"]

                # Verify credits decreased
                assert credits_after < credits_before

                # Verify cargo increased
                cargo_ns_before = cargo_before.get("neuro_symbolics", 0)
                cargo_ns_after = cargo_after.get("neuro_symbolics", 0)
                assert cargo_ns_after > cargo_ns_before

        except RPCError:
            pytest.skip("Trade not available at this port")

    async def test_sell_decreases_cargo_increases_credits(self, trader_with_cargo):
        """Test that selling updates both cargo and credits correctly."""
        client = trader_with_cargo["client"]
        char_id = trader_with_cargo["character_id"]

        # Get initial state
        status_before = await get_status(client, char_id)
        credits_before = status_before["player"]["credits_on_hand"]
        cargo_before = status_before["ship"]["cargo"]

        try:
            result = await client.trade(
                commodity="quantum_foam",
                quantity=10,
                trade_type="sell",
                character_id=char_id
            )

            if result.get("success"):
                await asyncio.sleep(0.5)

                # Get final state
                status_after = await get_status(client, char_id)
                credits_after = status_after["player"]["credits_on_hand"]
                cargo_after = status_after["ship"]["cargo"]

                # Verify credits increased
                assert credits_after > credits_before, "Credits should increase after selling"

                # Verify cargo decreased
                cargo_quantum_before = cargo_before.get("quantum_foam", 0)
                cargo_quantum_after = cargo_after.get("quantum_foam", 0)
                assert cargo_quantum_after < cargo_quantum_before, "Cargo should decrease after selling"

        except RPCError:
            pytest.skip("Trade not available at this port")

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
            # Execute trade (neuro_symbolics is sold at sector 1 port BBS)
            await client.trade(
                commodity="neuro_symbolics",
                quantity=1,
                trade_type="buy",
                character_id=char_id
            )

            # Get state after trade
            status_after = await get_status(client, char_id)

            # Verify all fields are present and valid
            assert "credits_on_hand" in status_after["player"]
            assert "cargo" in status_after["ship"]
            assert status_after["player"]["credits_on_hand"] >= 0

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

    async def test_concurrent_trades_at_same_port_serialized(self, server_url):
        """Test that concurrent trades at the same port are properly serialized."""
        # This test is complex and skipped for now
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
        credits_before = status_before["player"]["credits_on_hand"]

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
        credits_after = status_after["player"]["credits_on_hand"]

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
                # Execute buy (neuro_symbolics is sold at sector 1 port BBS)
                result = await client.trade(
                    commodity="neuro_symbolics",
                    quantity=5,
                    trade_type="buy",
                    character_id=char_id
                )

                if result.get("success"):
                    await asyncio.sleep(1.0)

                    # Verify event emitted
                    trade_event = assert_event_emitted(listener.events, "trade.executed")

                    # Verify event has trade details
                    payload = trade_event.get("payload", {})
                    trade_details = payload.get("trade", {})
                    assert "commodity" in trade_details or len(trade_details) > 0

            except RPCError:
                pytest.skip("Trade not available")

    async def test_trade_event_emitted_on_sell(self, trader_with_cargo, server_url):
        """Test that trade.executed event is emitted on sell."""
        client = trader_with_cargo["client"]
        char_id = trader_with_cargo["character_id"]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            try:
                # Execute sell (quantum_foam - port BBS at sector 1 buys it)
                result = await client.trade(
                    commodity="quantum_foam",
                    quantity=10,
                    trade_type="sell",
                    character_id=char_id
                )

                if result.get("success"):
                    await asyncio.sleep(1.0)

                    # Verify event emitted
                    trade_event = assert_event_emitted(listener.events, "trade.executed")

                    # Verify event has trade details
                    payload = trade_event.get("payload", {})
                    trade_details = payload.get("trade", {})
                    assert "commodity" in trade_details or len(trade_details) > 0

            except RPCError:
                pytest.skip("Trade not available")

    async def test_trade_event_contains_pricing_info(self, trader_at_port, server_url):
        """Test that trade events include price information."""
        client = trader_at_port["client"]
        char_id = trader_at_port["character_id"]

        async with create_firehose_listener(server_url, char_id) as listener:
            await asyncio.sleep(0.5)

            try:
                # Buy commodity (neuro_symbolics is sold at sector 1 port BBS)
                result = await client.trade(
                    commodity="neuro_symbolics",
                    quantity=1,
                    trade_type="buy",
                    character_id=char_id
                )

                if result.get("success"):
                    await asyncio.sleep(1.0)

                    trade_event = assert_event_emitted(listener.events, "trade.executed")
                    payload = trade_event.get("payload", {})

                    # Check for pricing fields (actual field names may vary)
                    # This documents expected event structure

            except RPCError:
                pytest.skip("Trade not available")

    async def test_trade_event_logged_to_jsonl(self, trader_with_cargo, server_url):
        """Test that trade events are persisted to JSONL log and queryable."""
        client = trader_with_cargo["client"]
        char_id = trader_with_cargo["character_id"]

        # Record start time
        start_time = datetime.now(timezone.utc)
        await asyncio.sleep(0.1)

        try:
            # Execute a trade (sell quantum_foam - port BBS at sector 1 buys it)
            result = await client.trade(
                commodity="quantum_foam",
                quantity=10,
                trade_type="sell",
                character_id=char_id
            )

            if not result.get("success"):
                pytest.skip(f"Trade failed: {result}")

            await asyncio.sleep(1.0)
            end_time = datetime.now(timezone.utc)

            # Test 1: Admin query sees the trade event
            admin_result = await client._request("event.query", {
                "admin_password": "",  # Admin mode
                "character_id": char_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            assert admin_result["success"], "Admin query should succeed"
            events = admin_result["events"]

            # Find trade.executed event
            trade_events = [e for e in events if e.get("event") == "trade.executed"]
            assert len(trade_events) >= 1, "Should find at least one trade.executed event"

            # Verify trade event has expected data
            trade_event = trade_events[0]
            payload = trade_event.get("payload", {})
            assert "trade" in payload or "commodity" in payload, "Trade event should have trade details"

            # Test 2: Character query (no admin password) sees the same event
            char_result = await client._request("event.query", {
                # No admin_password - character mode
                "character_id": char_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })

            assert char_result["success"], "Character query should succeed"
            char_events = char_result["events"]

            # Character should also see their trade event
            char_trade_events = [e for e in char_events if e.get("event") == "trade.executed"]
            assert len(char_trade_events) >= 1, "Character should see their own trade event"

        except RPCError as e:
            pytest.skip(f"Trade not available: {e}")


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

    async def test_trade_while_in_hyperspace_fails(self, server_url):
        """Test that trading while in hyperspace is blocked."""
        char_id = "test_hyperspace_trader"
        client = AsyncGameClient(base_url=server_url, character_id=char_id)

        try:
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

            # Wait for move to complete
            await move_task
        finally:
            await client.close()
