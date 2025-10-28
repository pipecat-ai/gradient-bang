"""
Integration tests for bank operations (deposit/withdrawal).

This module tests:
- Deposit credits to megaport bank (sector 0 only)
- Withdraw credits from megaport bank (sector 0 only)
- Location validation (must be in sector 0)
- Balance validation (sufficient credits)
- Combat restrictions (cannot bank while in combat)
- Event emissions (bank.transaction, status.update)

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
# Test Bank Operations - Happy Path
# =============================================================================


class TestBankOperations:
    """Tests for successful bank deposit and withdrawal operations."""

    async def test_deposit_credits_in_sector_0(self, server_url, check_server_available):
        """Test depositing credits to bank in sector 0."""
        char_id = "test_bank_deposit"

        # Create character with credits in sector 0
        create_test_character_knowledge(
            char_id,
            sector=0,
            credits=1000,
            credits_in_bank=500
        )

        async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
            await client.join(character_id=char_id)

            # Setup event listeners
            bank_events = []
            status_events = []

            client.on("bank.transaction")(lambda p: bank_events.append(p))
            client.on("status.update")(lambda p: status_events.append(p))

            # Get initial state
            status_before = await get_status(client, char_id)
            credits_before = status_before["player"]["credits_on_hand"]
            bank_before = status_before["player"]["credits_in_bank"]

            assert credits_before == 1000, "Initial credits should be 1000"
            assert bank_before == 500, "Initial bank balance should be 500"

            # Deposit 300 credits
            result = await client.bank_transfer(
                direction="deposit",
                amount=300,
                character_id=char_id
            )

            assert result.get("success") is True

            # Wait for events
            await asyncio.sleep(0.5)

            # Verify bank.transaction event
            assert len(bank_events) >= 1, "Should receive bank.transaction event"
            bank_event = bank_events[0]

            # Unwrap payload if nested
            if "payload" in bank_event:
                bank_event = bank_event["payload"]

            assert bank_event["direction"] == "deposit"
            assert bank_event["amount"] == 300
            assert bank_event["credits_on_hand_before"] == 1000
            assert bank_event["credits_on_hand_after"] == 700
            assert bank_event["credits_in_bank_before"] == 500
            assert bank_event["credits_in_bank_after"] == 800

            # Verify status.update event
            assert len(status_events) >= 1, "Should receive status.update event"
            status_event = status_events[-1]  # Get latest

            # Unwrap payload if nested
            if "payload" in status_event:
                status_event = status_event["payload"]

            assert status_event["player"]["credits_on_hand"] == 700
            assert status_event["player"]["credits_in_bank"] == 800

            # Verify final state
            status_after = await get_status(client, char_id)
            assert status_after["player"]["credits_on_hand"] == 700
            assert status_after["player"]["credits_in_bank"] == 800

    async def test_withdraw_credits_in_sector_0(self, server_url, check_server_available):
        """Test withdrawing credits from bank in sector 0."""
        char_id = "test_bank_withdraw"

        # Create character with bank balance in sector 0
        create_test_character_knowledge(
            char_id,
            sector=0,
            credits=500,
            credits_in_bank=1000
        )

        async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
            await client.join(character_id=char_id)

            # Setup event listeners
            bank_events = []
            status_events = []

            client.on("bank.transaction")(lambda p: bank_events.append(p))
            client.on("status.update")(lambda p: status_events.append(p))

            # Get initial state
            status_before = await get_status(client, char_id)
            credits_before = status_before["player"]["credits_on_hand"]
            bank_before = status_before["player"]["credits_in_bank"]

            assert credits_before == 500, "Initial credits should be 500"
            assert bank_before == 1000, "Initial bank balance should be 1000"

            # Withdraw 300 credits
            result = await client.bank_transfer(
                direction="withdraw",
                amount=300,
                character_id=char_id
            )

            assert result.get("success") is True

            # Wait for events
            await asyncio.sleep(0.5)

            # Verify bank.transaction event
            assert len(bank_events) >= 1, "Should receive bank.transaction event"
            bank_event = bank_events[0]

            # Unwrap payload if nested
            if "payload" in bank_event:
                bank_event = bank_event["payload"]

            assert bank_event["direction"] == "withdraw"
            assert bank_event["amount"] == 300
            assert bank_event["credits_on_hand_before"] == 500
            assert bank_event["credits_on_hand_after"] == 800
            assert bank_event["credits_in_bank_before"] == 1000
            assert bank_event["credits_in_bank_after"] == 700

            # Verify status.update event
            assert len(status_events) >= 1, "Should receive status.update event"
            status_event = status_events[-1]

            # Unwrap payload if nested
            if "payload" in status_event:
                status_event = status_event["payload"]

            assert status_event["player"]["credits_on_hand"] == 800
            assert status_event["player"]["credits_in_bank"] == 700

            # Verify final state
            status_after = await get_status(client, char_id)
            assert status_after["player"]["credits_on_hand"] == 800
            assert status_after["player"]["credits_in_bank"] == 700


# =============================================================================
# Test Bank Operations - Validation Errors
# =============================================================================


class TestBankValidation:
    """Tests for bank operation validation and error conditions."""

    async def test_deposit_exceeds_on_hand_balance(self, server_url, check_server_available):
        """Test depositing more credits than available fails."""
        char_id = "test_bank_deposit_exceed"

        # Create character with limited credits
        create_test_character_knowledge(
            char_id,
            sector=0,
            credits=100,
            credits_in_bank=0
        )

        async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
            await client.join(character_id=char_id)

            # Try to deposit more than available
            with pytest.raises(RPCError) as exc_info:
                await client.bank_transfer(
                    direction="deposit",
                    amount=200,
                    character_id=char_id
                )

            # Should return 400 client error
            assert exc_info.value.status == 400
            assert "insufficient" in str(exc_info.value).lower() or "not enough" in str(exc_info.value).lower()

    async def test_withdraw_exceeds_bank_balance(self, server_url, check_server_available):
        """Test withdrawing more than bank balance fails."""
        char_id = "test_bank_withdraw_exceed"

        # Create character with limited bank balance
        create_test_character_knowledge(
            char_id,
            sector=0,
            credits=0,
            credits_in_bank=100
        )

        async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
            await client.join(character_id=char_id)

            # Try to withdraw more than available
            with pytest.raises(RPCError) as exc_info:
                await client.bank_transfer(
                    direction="withdraw",
                    amount=200,
                    character_id=char_id
                )

            # Should return 400 client error
            assert exc_info.value.status == 400
            assert "insufficient" in str(exc_info.value).lower() or "not enough" in str(exc_info.value).lower()

    async def test_deposit_outside_sector_0(self, server_url, check_server_available):
        """Test depositing credits outside sector 0 fails."""
        char_id = "test_bank_deposit_wrong_sector"

        # Create character in sector 5 (not sector 0)
        create_test_character_knowledge(
            char_id,
            sector=5,
            credits=1000,
            credits_in_bank=0
        )

        async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
            await client.join(character_id=char_id)

            # Try to deposit from wrong sector
            with pytest.raises(RPCError) as exc_info:
                await client.bank_transfer(
                    direction="deposit",
                    amount=100,
                    character_id=char_id
                )

            # Should return 400 client error
            assert exc_info.value.status == 400
            assert "sector 0" in str(exc_info.value).lower() or "megaport" in str(exc_info.value).lower()

    async def test_withdraw_outside_sector_0(self, server_url, check_server_available):
        """Test withdrawing credits outside sector 0 fails."""
        char_id = "test_bank_withdraw_wrong_sector"

        # Create character in sector 5 (not sector 0)
        create_test_character_knowledge(
            char_id,
            sector=5,
            credits=0,
            credits_in_bank=1000
        )

        async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
            await client.join(character_id=char_id)

            # Try to withdraw from wrong sector
            with pytest.raises(RPCError) as exc_info:
                await client.bank_transfer(
                    direction="withdraw",
                    amount=100,
                    character_id=char_id
                )

            # Should return 400 client error
            assert exc_info.value.status == 400
            assert "sector 0" in str(exc_info.value).lower() or "megaport" in str(exc_info.value).lower()

    async def test_bank_operation_while_in_combat(self, server_url, check_server_available):
        """Test bank operations blocked while in combat."""
        char_id = "test_bank_in_combat"
        opponent_id = "test_bank_opponent"

        # Create two characters in sector 0 to trigger auto-combat
        create_test_character_knowledge(
            char_id,
            sector=0,
            credits=1000,
            credits_in_bank=500,
            fighters=100
        )
        create_test_character_knowledge(
            opponent_id,
            sector=0,
            credits=500,
            fighters=100
        )

        char_client = AsyncGameClient(base_url=server_url, character_id=char_id)
        opponent_client = AsyncGameClient(base_url=server_url, character_id=opponent_id)

        try:
            await char_client.join(character_id=char_id)
            await opponent_client.join(character_id=opponent_id)

            # Deploy garrison to trigger auto-combat
            await char_client.combat_leave_fighters(
                sector=0,
                quantity=50,
                mode="offensive",
                character_id=char_id
            )

            # Wait for auto-combat to engage
            await asyncio.sleep(1.0)

            # Try to deposit while in combat
            with pytest.raises(RPCError) as exc_info:
                await char_client.bank_transfer(
                    direction="deposit",
                    amount=100,
                    character_id=char_id
                )

            # Should return 409 conflict (combat in progress)
            assert exc_info.value.status == 409
            assert "combat" in str(exc_info.value).lower()

        finally:
            await char_client.close()
            await opponent_client.close()
