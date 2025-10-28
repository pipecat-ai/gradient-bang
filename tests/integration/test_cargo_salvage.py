"""
Integration tests for cargo dump and salvage operations.

This module tests:
- Dump cargo as salvage in sector
- Retrieve own dumped cargo
- Another player retrieve salvage
- Late arrival sees available salvage
- Validation (insufficient cargo, combat restrictions)
- Event emissions (salvage.created, sector.update)

IMPORTANT: Tests use sector 5 (not sector 0) to avoid cluttering megaport.

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
# Test Cargo Salvage - Happy Path
# =============================================================================


class TestCargoSalvage:
    """Tests for cargo dump and salvage operations."""

    async def test_dump_cargo_creates_salvage(self, server_url, check_server_available):
        """Test dumping cargo creates salvage container."""
        char_id = "test_salvage_dumper"

        # Create character with cargo in sector 5 (not sector 0)
        create_test_character_knowledge(
            char_id,
            sector=5,
            cargo={"quantum_foam": 10, "retro_organics": 5}
        )

        async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
            await client.join(character_id=char_id)

            # Setup event listeners
            salvage_events = []
            sector_events = []

            client.on("salvage.created")(lambda p: salvage_events.append(p))
            client.on("sector.update")(lambda p: sector_events.append(p))

            # Get initial cargo
            status_before = await get_status(client, char_id)
            cargo_before = status_before["ship"]["cargo"]

            assert cargo_before.get("quantum_foam", 0) == 10
            assert cargo_before.get("retro_organics", 0) == 5

            # Dump some cargo
            result = await client.dump_cargo(
                items=[{"commodity": "quantum_foam", "units": 3}],
                character_id=char_id
            )

            assert result.get("success") is True

            # Wait for events
            await asyncio.sleep(0.5)

            # Verify salvage.created event
            assert len(salvage_events) >= 1, "Should receive salvage.created event"
            salvage_event = salvage_events[0]

            if "payload" in salvage_event:
                salvage_event = salvage_event["payload"]

            assert "salvage" in salvage_event
            salvage = salvage_event["salvage"]
            assert salvage["cargo"]["quantum_foam"] == 3
            assert salvage_event["dumped_cargo"]["quantum_foam"] == 3

            # Verify sector.update event
            assert len(sector_events) >= 1, "Should receive sector.update event"

            # Verify cargo reduced
            status_after = await get_status(client, char_id)
            cargo_after = status_after["ship"]["cargo"]

            assert cargo_after.get("quantum_foam", 0) == 7  # 10 - 3
            assert cargo_after.get("retro_organics", 0) == 5  # Unchanged

    async def test_retrieve_own_dumped_cargo(self, server_url, check_server_available):
        """Test retrieving own dumped cargo."""
        char_id = "test_salvage_collector_own"

        # Create character with cargo
        create_test_character_knowledge(
            char_id,
            sector=5,
            cargo={"quantum_foam": 10}
        )

        async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
            await client.join(character_id=char_id)

            # Dump cargo
            await client.dump_cargo(
                items=[{"commodity": "quantum_foam", "units": 5}],
                character_id=char_id
            )

            await asyncio.sleep(0.5)

            # Get sector status to find salvage ID
            status = await get_status(client, char_id)
            sector_salvage = status["sector"].get("salvage", [])

            assert len(sector_salvage) > 0, "Should have salvage in sector"

            salvage_id = sector_salvage[0]["salvage_id"]

            # Collect the salvage
            result = await client._request("salvage.collect", {
                "character_id": char_id,
                "salvage_id": salvage_id
            })

            assert result.get("success") is True

            # Verify cargo restored
            status_after = await get_status(client, char_id)
            cargo_after = status_after["ship"]["cargo"]

            assert cargo_after.get("quantum_foam", 0) == 10  # Back to original

    async def test_another_player_retrieve_salvage(self, server_url, check_server_available):
        """Test another player collecting salvage."""
        dumper_id = "test_salvage_dumper"
        collector_id = "test_salvage_collector_other"

        # Create both characters in same sector
        create_test_character_knowledge(dumper_id, sector=5, cargo={"retro_organics": 10})
        create_test_character_knowledge(collector_id, sector=5, cargo={})

        dumper_client = AsyncGameClient(base_url=server_url, character_id=dumper_id)
        collector_client = AsyncGameClient(base_url=server_url, character_id=collector_id)

        try:
            await dumper_client.join(character_id=dumper_id)
            await collector_client.join(character_id=collector_id)

            # Setup event listeners
            dumper_events = []
            collector_events = []

            dumper_client.on("sector.update")(lambda p: dumper_events.append(p))
            collector_client.on("sector.update")(lambda p: collector_events.append(p))

            # Dumper dumps cargo
            await dumper_client.dump_cargo(
                items=[{"commodity": "retro_organics", "units": 5}],
                character_id=dumper_id
            )

            await asyncio.sleep(0.5)

            # Collector should see sector.update with salvage
            assert len(collector_events) >= 1, "Collector should see sector update"

            # Get salvage ID from collector's view
            collector_status = await get_status(collector_client, collector_id)
            sector_salvage = collector_status["sector"].get("salvage", [])

            assert len(sector_salvage) > 0, "Collector should see salvage"

            # Find salvage with retro_organics
            retro_salvage = None
            for salv in sector_salvage:
                if salv.get("cargo", {}).get("retro_organics", 0) > 0:
                    retro_salvage = salv
                    break

            assert retro_salvage is not None, f"Should find salvage with retro_organics. Found: {sector_salvage}"
            salvage_id = retro_salvage["salvage_id"]

            # Collector collects salvage
            result = await collector_client._request("salvage.collect", {
                "character_id": collector_id,
                "salvage_id": salvage_id
            })

            assert result.get("success") is True

            # Wait for salvage collection to complete
            await asyncio.sleep(0.5)

            # Verify collector got cargo (force fresh status check)
            collector_status_after = await get_status(collector_client, collector_id)
            collector_cargo = collector_status_after["ship"]["cargo"]

            assert collector_cargo.get("retro_organics", 0) == 5, f"Expected 5 retro_organics, got: {collector_cargo}"

            # Verify dumper's cargo still reduced
            dumper_status_after = await get_status(dumper_client, dumper_id)
            dumper_cargo = dumper_status_after["ship"]["cargo"]

            assert dumper_cargo.get("retro_organics", 0) == 5  # Still 5 (dumped)

        finally:
            await dumper_client.close()
            await collector_client.close()

    async def test_dump_then_move_new_player_arrives(self, server_url, check_server_available):
        """Test late arrival sees available salvage."""
        dumper_id = "test_salvage_dumper"
        late_arrival_id = "test_salvage_late_arrival"

        # Create dumper in sector 5, late arrival in sector 6 (adjacent to 5)
        create_test_character_knowledge(dumper_id, sector=5, cargo={"neuro_symbolics": 10})
        create_test_character_knowledge(late_arrival_id, sector=6, cargo={})

        dumper_client = AsyncGameClient(base_url=server_url, character_id=dumper_id)
        arrival_client = AsyncGameClient(base_url=server_url, character_id=late_arrival_id)

        try:
            await dumper_client.join(character_id=dumper_id)
            await arrival_client.join(character_id=late_arrival_id)

            # Dumper dumps cargo
            await dumper_client.dump_cargo(
                items=[{"commodity": "neuro_symbolics", "units": 3}],
                character_id=dumper_id
            )

            await asyncio.sleep(0.5)

            # Late arrival moves into sector
            await arrival_client.move(
                to_sector=5,
                character_id=late_arrival_id
            )

            await asyncio.sleep(0.5)

            # Late arrival should see salvage
            arrival_status = await get_status(arrival_client, late_arrival_id)
            sector_salvage = arrival_status["sector"].get("salvage", [])

            assert len(sector_salvage) > 0, "Late arrival should see salvage"
            assert sector_salvage[0]["cargo"]["neuro_symbolics"] == 3

            # Late arrival can collect it
            salvage_id = sector_salvage[0]["salvage_id"]
            result = await arrival_client._request("salvage.collect", {
                "character_id": late_arrival_id,
                "salvage_id": salvage_id
            })

            assert result.get("success") is True

        finally:
            await dumper_client.close()
            await arrival_client.close()


# =============================================================================
# Test Cargo Salvage Validation
# =============================================================================


class TestCargoSalvageValidation:
    """Tests for cargo salvage validation and error conditions."""

    async def test_dump_more_cargo_than_available(self, server_url, check_server_available):
        """Test dumping more than available succeeds with partial dump."""
        char_id = "test_salvage_exceed_dumper"

        # Create character with limited cargo
        create_test_character_knowledge(
            char_id,
            sector=5,
            cargo={"quantum_foam": 5}
        )

        async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
            await client.join(character_id=char_id)

            # Request to dump 10 units when only 5 available (partial dump)
            result = await client.dump_cargo(
                items=[{"commodity": "quantum_foam", "units": 10}],
                character_id=char_id
            )

            # Should succeed with partial dump
            assert result.get("success") is True

            # Verify all 5 units were dumped (cargo now empty)
            status = await get_status(client, char_id)
            cargo = status["ship"]["cargo"]
            assert cargo.get("quantum_foam", 0) == 0

            # Verify salvage contains 5 units (not 10)
            sector_salvage = status["sector"].get("salvage", [])
            assert len(sector_salvage) > 0, "Should have salvage in sector"
            assert sector_salvage[0]["cargo"]["quantum_foam"] == 5

    async def test_dump_cargo_while_in_combat(self, server_url, check_server_available):
        """Test dumping cargo while in combat fails."""
        char_id = "test_salvage_combat_dumper"
        opponent_id = "test_salvage_combat_opponent"

        # Create two characters in sector 5 to trigger auto-combat
        create_test_character_knowledge(
            char_id,
            sector=5,
            cargo={"quantum_foam": 10},
            fighters=100
        )
        create_test_character_knowledge(
            opponent_id,
            sector=5,
            cargo={},
            fighters=100
        )

        char_client = AsyncGameClient(base_url=server_url, character_id=char_id)
        opponent_client = AsyncGameClient(base_url=server_url, character_id=opponent_id)

        try:
            await char_client.join(character_id=char_id)
            await opponent_client.join(character_id=opponent_id)

            # Deploy garrison to trigger auto-combat
            await char_client.combat_leave_fighters(
                sector=5,
                quantity=50,
                mode="offensive",
                character_id=char_id
            )

            # Wait for auto-combat to engage
            await asyncio.sleep(1.0)

            # Try to dump cargo while in combat
            with pytest.raises(RPCError) as exc_info:
                await char_client.dump_cargo(
                    items=[{"commodity": "quantum_foam", "units": 5}],
                    character_id=char_id
                )

            # Should return 409 conflict (combat in progress)
            assert exc_info.value.status == 409
            assert "combat" in str(exc_info.value).lower()

        finally:
            await char_client.close()
            await opponent_client.close()

    async def test_dump_zero_units(self, server_url, check_server_available):
        """Test dumping zero units fails."""
        char_id = "test_salvage_zero_dumper"

        create_test_character_knowledge(
            char_id,
            sector=5,
            cargo={"quantum_foam": 10}
        )

        async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
            await client.join(character_id=char_id)

            # Try to dump zero units
            with pytest.raises(RPCError) as exc_info:
                await client.dump_cargo(
                    items=[{"commodity": "quantum_foam", "units": 0}],
                    character_id=char_id
                )

            # Should return 400 client error
            assert exc_info.value.status == 400

    async def test_dump_invalid_commodity(self, server_url, check_server_available):
        """Test dumping invalid commodity fails."""
        char_id = "test_salvage_invalid_dumper"

        create_test_character_knowledge(
            char_id,
            sector=5,
            cargo={"quantum_foam": 10}
        )

        async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
            await client.join(character_id=char_id)

            # Try to dump invalid commodity
            with pytest.raises(RPCError) as exc_info:
                await client.dump_cargo(
                    items=[{"commodity": "invalid_commodity", "units": 5}],
                    character_id=char_id
                )

            # Should return 400 client error
            assert exc_info.value.status == 400
            assert "commodity" in str(exc_info.value).lower() or "invalid" in str(exc_info.value).lower()
