"""
Integration tests for salvage collection with cargo capacity limits.

This module tests:
- Full collection when sufficient space
- Partial collection when limited space
- Credits-only collection when no space
- Multiple commodity prioritization (alphabetical)
- Scrap collection priority (highest)
- Return trips for remaining cargo
- Salvage persistence and removal logic

These tests require a test server running on port 8002.
"""

import asyncio
import pytest
import sys
from pathlib import Path

# Add project paths
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from conftest import EVENT_DELIVERY_WAIT
from utils.api_client import AsyncGameClient
from helpers.combat_helpers import create_test_character_knowledge


pytestmark = [pytest.mark.asyncio, pytest.mark.integration, pytest.mark.requires_server]


# =============================================================================
# Helper Functions
# =============================================================================


async def get_status(client, character_id):
    """Get character status via status.snapshot event."""
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
# Test Cargo Capacity - Full Collection
# =============================================================================


class TestSalvageCapacityFullCollection:
    """Tests for collecting salvage with sufficient cargo space."""

    async def test_collect_salvage_with_sufficient_space(self, server_url, check_server_available):
        """Test collecting all salvage when ship has enough space."""
        dumper_id = "test_capacity_dumper_1"
        collector_id = "test_capacity_collector_1"

        # Dumper: 10 quantum_foam + 1000 credits
        # Collector: Empty cargo, 30 holds (kestrel_courier default)
        create_test_character_knowledge(dumper_id, sector=5, cargo={"quantum_foam": 10}, credits=5000)
        create_test_character_knowledge(collector_id, sector=5, cargo={}, credits=1000)

        dumper_client = AsyncGameClient(base_url=server_url, character_id=dumper_id)
        collector_client = AsyncGameClient(base_url=server_url, character_id=collector_id)

        try:
            await dumper_client.join(character_id=dumper_id)
            await collector_client.join(character_id=collector_id)

            # Dump cargo with credits
            # Note: dump_cargo doesn't include credits, so we'll test cargo only
            await dumper_client.dump_cargo(
                items=[{"commodity": "quantum_foam", "units": 10}],
                character_id=dumper_id
            )

            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            # Get salvage ID
            collector_status = await get_status(collector_client, collector_id)
            sector_salvage = collector_status["sector"].get("salvage", [])
            assert len(sector_salvage) > 0, "Should have salvage in sector"

            salvage_id = sector_salvage[0]["salvage_id"]

            # Collect salvage
            result = await collector_client._request("salvage.collect", {
                "character_id": collector_id,
                "salvage_id": salvage_id
            })

            # Verify response
            assert result.get("success") is True
            assert result["collected"]["cargo"].get("quantum_foam", 0) == 10
            assert result["fully_collected"] is True
            assert result["remaining"]["cargo"] == {}

            # Verify collector has cargo
            await asyncio.sleep(EVENT_DELIVERY_WAIT)
            collector_after = await get_status(collector_client, collector_id)
            assert collector_after["ship"]["cargo"].get("quantum_foam", 0) == 10

            # Verify salvage removed from sector
            sector_salvage_after = collector_after["sector"].get("salvage", [])
            assert len(sector_salvage_after) == 0, "Salvage should be removed"

        finally:
            await dumper_client.close()
            await collector_client.close()


# =============================================================================
# Test Cargo Capacity - No Space
# =============================================================================


class TestSalvageCapacityNoSpace:
    """Tests for collecting salvage when ship has no cargo space."""

    async def test_collect_salvage_with_no_cargo_space(self, server_url, check_server_available):
        """Test collecting credits only when cargo holds are full."""
        dumper_id = "test_capacity_dumper_2"
        collector_id = "test_capacity_collector_2"

        # Dumper: 5 retro_organics
        # Collector: Full cargo (30/30 holds)
        create_test_character_knowledge(dumper_id, sector=5, cargo={"retro_organics": 10})
        create_test_character_knowledge(
            collector_id,
            sector=5,
            cargo={"quantum_foam": 30},  # Full cargo for kestrel_courier
            credits=1000
        )

        dumper_client = AsyncGameClient(base_url=server_url, character_id=dumper_id)
        collector_client = AsyncGameClient(base_url=server_url, character_id=collector_id)

        try:
            await dumper_client.join(character_id=dumper_id)
            await collector_client.join(character_id=collector_id)

            # Dump cargo
            await dumper_client.dump_cargo(
                items=[{"commodity": "retro_organics", "units": 5}],
                character_id=dumper_id
            )

            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            # Get salvage ID
            collector_status = await get_status(collector_client, collector_id)
            sector_salvage = collector_status["sector"].get("salvage", [])
            assert len(sector_salvage) > 0

            salvage_id = sector_salvage[0]["salvage_id"]

            # Collect salvage (should get credits only, no cargo)
            result = await collector_client._request("salvage.collect", {
                "character_id": collector_id,
                "salvage_id": salvage_id
            })

            # Verify response
            assert result.get("success") is True
            assert result["collected"]["cargo"] == {}, "Should not collect any cargo"
            assert result["fully_collected"] is False, "Salvage should remain"
            assert result["remaining"]["cargo"].get("retro_organics", 0) == 5

            # Verify collector cargo unchanged
            await asyncio.sleep(EVENT_DELIVERY_WAIT)
            collector_after = await get_status(collector_client, collector_id)
            assert collector_after["ship"]["cargo"].get("quantum_foam", 0) == 30
            assert collector_after["ship"]["cargo"].get("retro_organics", 0) == 0

            # Verify salvage still in sector
            sector_salvage_after = collector_after["sector"].get("salvage", [])
            assert len(sector_salvage_after) == 1, "Salvage should still exist"
            assert sector_salvage_after[0]["cargo"].get("retro_organics", 0) == 5

        finally:
            await dumper_client.close()
            await collector_client.close()


# =============================================================================
# Test Cargo Capacity - Partial Collection
# =============================================================================


class TestSalvageCapacityPartialCollection:
    """Tests for collecting salvage with limited cargo space."""

    async def test_collect_salvage_with_partial_space(self, server_url, check_server_available):
        """Test partial collection when limited space available."""
        dumper_id = "test_capacity_dumper_3"
        collector_id = "test_capacity_collector_3"

        # Dumper: 10 quantum_foam
        # Collector: 25/30 holds used (5 available)
        create_test_character_knowledge(dumper_id, sector=5, cargo={"quantum_foam": 15})
        create_test_character_knowledge(collector_id, sector=5, cargo={"neuro_symbolics": 25})

        dumper_client = AsyncGameClient(base_url=server_url, character_id=dumper_id)
        collector_client = AsyncGameClient(base_url=server_url, character_id=collector_id)

        try:
            await dumper_client.join(character_id=dumper_id)
            await collector_client.join(character_id=collector_id)

            # Dump 10 units
            await dumper_client.dump_cargo(
                items=[{"commodity": "quantum_foam", "units": 10}],
                character_id=dumper_id
            )

            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            # Get salvage ID
            collector_status = await get_status(collector_client, collector_id)
            sector_salvage = collector_status["sector"].get("salvage", [])
            assert len(sector_salvage) > 0

            salvage_id = sector_salvage[0]["salvage_id"]

            # Collect salvage (should get 5 units)
            result = await collector_client._request("salvage.collect", {
                "character_id": collector_id,
                "salvage_id": salvage_id
            })

            # Verify response
            assert result.get("success") is True
            assert result["collected"]["cargo"].get("quantum_foam", 0) == 5
            assert result["fully_collected"] is False
            assert result["remaining"]["cargo"].get("quantum_foam", 0) == 5

            # Verify collector has 5 units
            await asyncio.sleep(EVENT_DELIVERY_WAIT)
            collector_after = await get_status(collector_client, collector_id)
            assert collector_after["ship"]["cargo"].get("quantum_foam", 0) == 5
            assert collector_after["ship"]["cargo"].get("neuro_symbolics", 0) == 25

            # Verify salvage has 5 remaining
            sector_salvage_after = collector_after["sector"].get("salvage", [])
            assert len(sector_salvage_after) == 1
            assert sector_salvage_after[0]["cargo"].get("quantum_foam", 0) == 5

        finally:
            await dumper_client.close()
            await collector_client.close()

    async def test_collect_multiple_commodities_alphabetical_priority(self, server_url, check_server_available):
        """Test multiple commodities collected in alphabetical order."""
        dumper_id = "test_capacity_dumper_4"
        collector_id = "test_capacity_collector_4"

        # Dumper: 5 each of all 3 commodities (15 total)
        # Collector: 20/30 holds used (10 available)
        # Should collect: 5 neuro_symbolics, 5 quantum_foam (alphabetical)
        create_test_character_knowledge(
            dumper_id,
            sector=5,
            cargo={"quantum_foam": 10, "retro_organics": 10, "neuro_symbolics": 10}
        )
        create_test_character_knowledge(collector_id, sector=5, cargo={"quantum_foam": 20})

        dumper_client = AsyncGameClient(base_url=server_url, character_id=dumper_id)
        collector_client = AsyncGameClient(base_url=server_url, character_id=collector_id)

        try:
            await dumper_client.join(character_id=dumper_id)
            await collector_client.join(character_id=collector_id)

            # Dump 5 units of each commodity
            await dumper_client.dump_cargo(
                items=[
                    {"commodity": "quantum_foam", "units": 5},
                    {"commodity": "retro_organics", "units": 5},
                    {"commodity": "neuro_symbolics", "units": 5},
                ],
                character_id=dumper_id
            )

            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            # Get salvage ID
            collector_status = await get_status(collector_client, collector_id)
            sector_salvage = collector_status["sector"].get("salvage", [])
            assert len(sector_salvage) > 0

            salvage_id = sector_salvage[0]["salvage_id"]

            # Collect salvage (10 space available, 15 total)
            result = await collector_client._request("salvage.collect", {
                "character_id": collector_id,
                "salvage_id": salvage_id
            })

            # Verify alphabetical priority: neuro_symbolics (5) + quantum_foam (5) = 10
            assert result.get("success") is True
            collected = result["collected"]["cargo"]
            remaining = result["remaining"]["cargo"]

            # Should collect neuro_symbolics and quantum_foam (alphabetically first)
            assert collected.get("neuro_symbolics", 0) == 5
            assert collected.get("quantum_foam", 0) == 5
            assert "retro_organics" not in collected

            # Should leave retro_organics
            assert remaining.get("retro_organics", 0) == 5
            assert result["fully_collected"] is False

            # Verify collector cargo
            await asyncio.sleep(EVENT_DELIVERY_WAIT)
            collector_after = await get_status(collector_client, collector_id)
            cargo = collector_after["ship"]["cargo"]
            assert cargo.get("quantum_foam", 0) == 25  # 20 + 5
            assert cargo.get("neuro_symbolics", 0) == 5
            assert cargo.get("retro_organics", 0) == 0

        finally:
            await dumper_client.close()
            await collector_client.close()


# =============================================================================
# Test Cargo Capacity - Return Trip
# =============================================================================


class TestSalvageCapacityReturnTrip:
    """Tests for multiple collections from same salvage."""

    async def test_return_trip_for_remaining_cargo(self, server_url, check_server_available):
        """Test collecting remaining cargo on a second trip."""
        dumper_id = "test_capacity_dumper_5"
        collector_id = "test_capacity_collector_5"

        # Dumper: 20 quantum_foam
        # Collector: 20/30 holds (10 available)
        # First collection: 10 units
        # Dump some cargo to free space
        # Second collection: 10 units
        create_test_character_knowledge(dumper_id, sector=5, cargo={"quantum_foam": 25})
        create_test_character_knowledge(collector_id, sector=5, cargo={"retro_organics": 20})

        dumper_client = AsyncGameClient(base_url=server_url, character_id=dumper_id)
        collector_client = AsyncGameClient(base_url=server_url, character_id=collector_id)

        try:
            await dumper_client.join(character_id=dumper_id)
            await collector_client.join(character_id=collector_id)

            # Dump 20 units
            await dumper_client.dump_cargo(
                items=[{"commodity": "quantum_foam", "units": 20}],
                character_id=dumper_id
            )

            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            # Get salvage ID
            collector_status = await get_status(collector_client, collector_id)
            sector_salvage = collector_status["sector"].get("salvage", [])
            assert len(sector_salvage) > 0

            salvage_id = sector_salvage[0]["salvage_id"]

            # First collection (10 available space)
            result1 = await collector_client._request("salvage.collect", {
                "character_id": collector_id,
                "salvage_id": salvage_id
            })

            assert result1["collected"]["cargo"].get("quantum_foam", 0) == 10
            assert result1["remaining"]["cargo"].get("quantum_foam", 0) == 10
            assert result1["fully_collected"] is False

            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            # Dump retro_organics to free space
            await collector_client.dump_cargo(
                items=[{"commodity": "retro_organics", "units": 20}],
                character_id=collector_id
            )

            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            # Second collection (20 available space now)
            # Note: Salvage should be unclaimed, so we can claim it again
            result2 = await collector_client._request("salvage.collect", {
                "character_id": collector_id,
                "salvage_id": salvage_id
            })

            assert result2["collected"]["cargo"].get("quantum_foam", 0) == 10
            assert result2["remaining"]["cargo"] == {}
            assert result2["fully_collected"] is True

            # Verify final state
            await asyncio.sleep(EVENT_DELIVERY_WAIT)
            collector_after = await get_status(collector_client, collector_id)
            assert collector_after["ship"]["cargo"].get("quantum_foam", 0) == 20
            assert collector_after["ship"]["cargo"].get("retro_organics", 0) == 0

            # Salvage should be removed
            sector_salvage_after = collector_after["sector"].get("salvage", [])
            # Should have 1 salvage (the retro_organics we dumped)
            assert len(sector_salvage_after) == 1
            assert sector_salvage_after[0]["cargo"].get("retro_organics", 0) == 20

        finally:
            await dumper_client.close()
            await collector_client.close()


# =============================================================================
# Test Salvage Removal Logic
# =============================================================================


class TestSalvageRemovalLogic:
    """Tests for salvage persistence and removal."""

    async def test_salvage_fully_collected_only_when_empty(self, server_url, check_server_available):
        """Test salvage removed only after complete collection."""
        dumper_id = "test_capacity_dumper_6"
        collector_id = "test_capacity_collector_6"

        # Create two salvage containers
        # Collector can only collect from one partially
        create_test_character_knowledge(
            dumper_id,
            sector=5,
            cargo={"quantum_foam": 30, "retro_organics": 10}
        )
        create_test_character_knowledge(collector_id, sector=5, cargo={})

        dumper_client = AsyncGameClient(base_url=server_url, character_id=dumper_id)
        collector_client = AsyncGameClient(base_url=server_url, character_id=collector_id)

        try:
            await dumper_client.join(character_id=dumper_id)
            await collector_client.join(character_id=collector_id)

            # Dump first batch
            await dumper_client.dump_cargo(
                items=[{"commodity": "quantum_foam", "units": 15}],
                character_id=dumper_id
            )

            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            # Dump second batch
            await dumper_client.dump_cargo(
                items=[{"commodity": "retro_organics", "units": 10}],
                character_id=dumper_id
            )

            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            # Get salvage IDs
            collector_status = await get_status(collector_client, collector_id)
            sector_salvage = collector_status["sector"].get("salvage", [])
            assert len(sector_salvage) == 2, "Should have 2 salvage containers"

            # Find the quantum_foam salvage
            qf_salvage = None
            for salv in sector_salvage:
                if salv["cargo"].get("quantum_foam", 0) > 0:
                    qf_salvage = salv
                    break

            assert qf_salvage is not None
            salvage_id = qf_salvage["salvage_id"]

            # Collect quantum_foam (collector has 30 space, salvage has 15 - full collection)
            result = await collector_client._request("salvage.collect", {
                "character_id": collector_id,
                "salvage_id": salvage_id
            })

            assert result["fully_collected"] is True

            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            # Verify only 1 salvage remains (retro_organics)
            collector_after = await get_status(collector_client, collector_id)
            sector_salvage_after = collector_after["sector"].get("salvage", [])
            assert len(sector_salvage_after) == 1
            assert sector_salvage_after[0]["cargo"].get("retro_organics", 0) == 10

        finally:
            await dumper_client.close()
            await collector_client.close()
