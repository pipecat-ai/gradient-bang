"""
Integration tests for credit transfer between players.

This module tests:
- Transfer credits between players in same sector
- Player name resolution (not character IDs)
- Sector validation (must be in same sector)
- Balance validation (sufficient credits)
- Combat restrictions (cannot transfer while in combat)
- Event emissions (credits.transfer, status.update)

IMPORTANT: All tests use player names (not character IDs) for targeting.

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
from helpers.client_setup import create_client_with_character
from conftest import EVENT_DELIVERY_WAIT

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
# Test Credit Transfers - Happy Path
# =============================================================================

class TestCreditTransfers:
    """Tests for successful credit transfer operations."""

    async def test_transfer_credits_same_sector(self, server_url, check_server_available):
        """Test transferring credits between players in same sector."""
        sender_id = "test_credit_sender"
        receiver_id = "test_credit_receiver"

        # Create both characters in same sector with credits

        # Create both clients
        sender_client = await create_client_with_character(server_url, sender_id, sector=5, credits=1000)
        receiver_client = await create_client_with_character(server_url, receiver_id, sector=5, credits=500)

        try:
            # Join both characters
            # Already joined via create_client_with_character()
            # Already joined via create_client_with_character()

            # Setup event listeners on both clients
            sender_events = []
            receiver_events = []

            sender_client.on("credits.transfer")(lambda p: sender_events.append(p))
            receiver_client.on("credits.transfer")(lambda p: receiver_events.append(p))

            # Get initial state
            sender_status_before = await get_status(sender_client, sender_id)
            receiver_status_before = await get_status(receiver_client, receiver_id)

            sender_credits_before = sender_status_before["ship"]["credits"]
            receiver_credits_before = receiver_status_before["ship"]["credits"]

            assert sender_credits_before == 1000
            assert receiver_credits_before == 500

            # Transfer 300 credits using player name (not character ID)
            result = await sender_client.transfer_credits(
                to_player_name=receiver_id,  # Using player name, not ID
                amount=300,
                character_id=sender_id
            )

            assert result.get("success") is True

            # Wait for events
            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            # Verify both characters received credits.transfer event
            assert len(sender_events) >= 1, "Sender should receive credits.transfer event"
            assert len(receiver_events) >= 1, "Receiver should receive credits.transfer event"

            # Verify sender event
            sender_event = sender_events[0]
            if "payload" in sender_event:
                sender_event = sender_event["payload"]

            # Verify sender received "sent" event with new payload structure
            assert sender_event["transfer_direction"] == "sent"
            assert sender_event["transfer_details"]["credits"] == 300
            assert sender_event["from"]["id"] == sender_id
            assert sender_event["from"]["name"] is not None
            assert sender_event["to"]["id"] == receiver_id
            assert sender_event["to"]["name"] is not None

            # Verify NO private balance fields in new payload
            assert "from_balance_before" not in sender_event
            assert "from_balance_after" not in sender_event
            assert "amount" not in sender_event  # now in transfer_details.credits
            assert "from_character_id" not in sender_event  # now in from.id
            assert "to_character_id" not in sender_event  # now in to.id

            # Verify receiver event
            receiver_event = receiver_events[0]
            if "payload" in receiver_event:
                receiver_event = receiver_event["payload"]

            # Verify receiver received "received" event with new payload structure
            assert receiver_event["transfer_direction"] == "received"
            assert receiver_event["transfer_details"]["credits"] == 300
            assert receiver_event["from"]["id"] == sender_id
            assert receiver_event["to"]["id"] == receiver_id

            # Verify NO private balance fields in new payload
            assert "to_balance_before" not in receiver_event
            assert "to_balance_after" not in receiver_event
            assert "amount" not in receiver_event
            assert "from_character_id" not in receiver_event
            assert "to_character_id" not in receiver_event

            # Verify final state
            sender_status_after = await get_status(sender_client, sender_id)
            receiver_status_after = await get_status(receiver_client, receiver_id)

            assert sender_status_after["ship"]["credits"] == 700
            assert receiver_status_after["ship"]["credits"] == 800

        finally:
            await sender_client.close()
            await receiver_client.close()

    async def test_transfer_credits_uses_player_name(self, server_url, check_server_available):
        """Test that transfer uses player display name resolution."""
        sender_id = "test_credit_resolve_sender"
        receiver_id = "test_credit_resolve_receiver"

        # Create both clients with characters in same sector
        sender_client = await create_client_with_character(server_url, sender_id, sector=5, credits=1000)
        receiver_client = await create_client_with_character(server_url, receiver_id, sector=5, credits=500)

        try:
            # Setup event listeners
            sender_status_events = []
            sender_client.on("status.update")(lambda p: sender_status_events.append(p))

            # Transfer using player name (not character_id parameter)
            result = await sender_client.transfer_credits(
                to_player_name=receiver_id,  # Display name
                amount=100,
                character_id=sender_id
            )

            assert result.get("success") is True

            # Wait for status.update event
            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            # Verify transfer completed via event payload
            assert len(sender_status_events) >= 1, "Should receive status.update event"
            status_event = sender_status_events[0]
            if "payload" in status_event:
                status_event = status_event["payload"]

            assert status_event["ship"]["credits"] == 900, "Sender should have 900 credits after transfer"

        finally:
            await sender_client.close()
            await receiver_client.close()

# =============================================================================
# Test Credit Transfer Validation
# =============================================================================

class TestCreditTransferValidation:
    """Tests for credit transfer validation and error conditions."""

    async def test_transfer_exceeds_sender_balance(self, server_url, check_server_available):
        """Test transferring more than sender has fails."""
        sender_id = "test_credit_exceed_sender"
        receiver_id = "test_credit_exceed_receiver"

        # Create both clients with characters in same sector
        sender_client = await create_client_with_character(server_url, sender_id, sector=5, credits=100)
        receiver_client = await create_client_with_character(server_url, receiver_id, sector=5, credits=500)

        try:
            # Try to transfer more than available
            with pytest.raises(RPCError) as exc_info:
                await sender_client.transfer_credits(
                    to_player_name=receiver_id,
                    amount=200,
                    character_id=sender_id
                )

            # Should return 400 client error
            assert exc_info.value.status == 400
            assert "insufficient" in str(exc_info.value).lower() or "not enough" in str(exc_info.value).lower()

        finally:
            await sender_client.close()
            await receiver_client.close()

    async def test_transfer_between_different_sectors(self, server_url, check_server_available):
        """Test transferring between different sectors fails."""
        sender_id = "test_credit_diff_sector_sender"
        receiver_id = "test_credit_diff_sector_receiver"

        # Create characters in DIFFERENT sectors
        create_test_character_knowledge(sender_id, sector=5, credits=1000)
        create_test_character_knowledge(receiver_id, sector=8, credits=500)

        async with AsyncGameClient(base_url=server_url, character_id=sender_id) as client:
            await client.join(character_id=sender_id)

            # Join receiver in different sector
            receiver_client = await create_client_with_character(server_url, receiver_id)
            # Already joined via create_client_with_character()

            # Try to transfer across sectors
            with pytest.raises(RPCError) as exc_info:
                await client.transfer_credits(
                    to_player_name=receiver_id,
                    amount=100,
                    character_id=sender_id
                )

            # Should return 404 - player not found in source's sector
            assert exc_info.value.status == 404
            assert "no player named" in str(exc_info.value).lower() or "not found" in str(exc_info.value).lower()

            await receiver_client.close()

    async def test_transfer_to_nonexistent_player(self, server_url, check_server_available):
        """Test transferring to nonexistent player fails."""
        sender_id = "test_credit_nonexistent_sender"

        create_test_character_knowledge(sender_id, sector=5, credits=1000)

        async with AsyncGameClient(base_url=server_url, character_id=sender_id) as client:
            await client.join(character_id=sender_id)

            # Try to transfer to nonexistent player
            with pytest.raises(RPCError) as exc_info:
                await client.transfer_credits(
                    to_player_name="nonexistent_player_9999",
                    amount=100,
                    character_id=sender_id
                )

            # Should return 404 not found
            assert exc_info.value.status == 404
            assert "no player named" in str(exc_info.value).lower() or "not found" in str(exc_info.value).lower()

    async def test_transfer_to_self(self, server_url, check_server_available):
        """Test transferring to self fails."""
        sender_id = "test_credit_self_sender"

        create_test_character_knowledge(sender_id, sector=5, credits=1000)

        async with AsyncGameClient(base_url=server_url, character_id=sender_id) as client:
            await client.join(character_id=sender_id)

            # Try to transfer to self
            with pytest.raises(RPCError) as exc_info:
                await client.transfer_credits(
                    to_player_name=sender_id,  # Same as sender
                    amount=100,
                    character_id=sender_id
                )

            # Should return 404 - source character excluded from search
            assert exc_info.value.status == 404
            assert "no player named" in str(exc_info.value).lower() or "not found" in str(exc_info.value).lower()

    async def test_transfer_while_sender_in_combat(self, server_url, check_server_available):
        """Test transferring while sender is in combat fails."""
        sender_id = "test_credit_combat_sender"
        receiver_id = "test_credit_combat_receiver"

        # Create both clients with characters in same sector
        sender_client = await create_client_with_character(server_url, sender_id, sector=5, credits=1000, fighters=100)
        receiver_client = await create_client_with_character(server_url, receiver_id, sector=5, credits=500)

        try:
            # Deploy garrison to create combat
            await sender_client.combat_leave_fighters(
                sector=5,
                quantity=50,
                mode="offensive",
                character_id=sender_id
            )

            # Try to transfer while in combat
            with pytest.raises(RPCError) as exc_info:
                await sender_client.transfer_credits(
                    to_player_name=receiver_id,
                    amount=100,
                    character_id=sender_id
                )

            # Should return 409 conflict (combat in progress)
            assert exc_info.value.status == 409
            assert "combat" in str(exc_info.value).lower()

        finally:
            await sender_client.close()
            await receiver_client.close()

    async def test_transfer_while_receiver_in_combat(self, server_url, check_server_available):
        """Test transferring while receiver is in combat fails."""
        sender_id = "test_credit_sender"
        receiver_id = "test_credit_receiver"

        # Create both clients with characters in same sector
        sender_client = await create_client_with_character(server_url, sender_id, sector=6, credits=1000)
        receiver_client = await create_client_with_character(server_url, receiver_id, sector=6, credits=500, fighters=100)

        try:
            # Deploy garrison from receiver to create combat
            await receiver_client.combat_leave_fighters(
                sector=6,
                quantity=50,
                mode="offensive",
                character_id=receiver_id
            )

            # Try to transfer to receiver in combat
            with pytest.raises(RPCError) as exc_info:
                await sender_client.transfer_credits(
                    to_player_name=receiver_id,
                    amount=100,
                    character_id=sender_id
                )

            # Should return 409 conflict (combat in progress)
            assert exc_info.value.status == 409
            assert "combat" in str(exc_info.value).lower()

        finally:
            await sender_client.close()
            await receiver_client.close()
