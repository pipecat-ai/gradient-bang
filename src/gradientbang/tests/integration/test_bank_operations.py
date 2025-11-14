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
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from gradientbang.tests.helpers.combat_helpers import create_test_character_knowledge
from gradientbang.tests.helpers.corporation_utils import (
    managed_client,
    reset_corporation_test_state,
)
from gradientbang.utils.api_client import AsyncGameClient, RPCError

from gradientbang.tests.config import TEST_WORLD_DATA_DIR

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


def _set_ship_credits(ship_id: str, credits: int) -> None:
    ships_path = TEST_WORLD_DATA_DIR / "ships.json"
    if not ships_path.exists():
        raise AssertionError("ships.json not found; ensure test fixtures created ships")
    with ships_path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    ship = data.get(ship_id)
    if not ship:
        raise AssertionError(f"Ship {ship_id} not found in ships.json")
    ship.setdefault("state", {})["credits"] = credits
    with ships_path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)


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
            ship_before = status_before["ship"]
            player_before = status_before["player"]
            credits_before = ship_before["credits"]
            bank_before = status_before["player"]["credits_in_bank"]

            assert credits_before == 1000, "Initial credits should be 1000"
            assert bank_before == 500, "Initial bank balance should be 500"

            ship_id = ship_before.get("ship_id") or f"{char_id}-ship"
            target_name = player_before.get("name") or char_id

            # Deposit 300 credits
            result = await client.deposit_to_bank(
                amount=300,
                ship_id=ship_id,
                target_player_name=target_name,
                character_id=char_id,
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
            assert bank_event["ship_credits_before"] == 1000
            assert bank_event["ship_credits_after"] == 700
            assert bank_event["credits_in_bank_before"] == 500
            assert bank_event["credits_in_bank_after"] == 800
            assert bank_event["source_character_id"] == char_id

            # Verify status.update event
            assert len(status_events) >= 1, "Should receive status.update event"
            status_event = status_events[-1]  # Get latest

            # Unwrap payload if nested
            if "payload" in status_event:
                status_event = status_event["payload"]

            assert status_event["ship"]["credits"] == 700
            assert status_event["player"]["credits_in_bank"] == 800

            # Verify final state
            status_after = await get_status(client, char_id)
            assert status_after["ship"]["credits"] == 700
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
            ship_before = status_before["ship"]
            credits_before = ship_before["credits"]
            bank_before = status_before["player"]["credits_in_bank"]

            assert credits_before == 500, "Initial credits should be 500"
            assert bank_before == 1000, "Initial bank balance should be 1000"

            # Withdraw 300 credits
            result = await client.withdraw_from_bank(
                amount=300,
                character_id=char_id,
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
            assert bank_event["ship_credits_before"] == 500
            assert bank_event["ship_credits_after"] == 800
            assert bank_event["credits_in_bank_before"] == 1000
            assert bank_event["credits_in_bank_after"] == 700

            # Verify status.update event
            assert len(status_events) >= 1, "Should receive status.update event"
            status_event = status_events[-1]

            # Unwrap payload if nested
            if "payload" in status_event:
                status_event = status_event["payload"]

            assert status_event["ship"]["credits"] == 800
            assert status_event["player"]["credits_in_bank"] == 700

            # Verify final state
            status_after = await get_status(client, char_id)
            assert status_after["ship"]["credits"] == 800
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
                await client.deposit_to_bank(
                    amount=200,
                    target_player_name=char_id,
                    character_id=char_id,
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
                await client.withdraw_from_bank(
                    amount=200,
                    character_id=char_id,
                )

            # Should return 400 client error
            assert exc_info.value.status == 400
            assert "insufficient" in str(exc_info.value).lower() or "not enough" in str(exc_info.value).lower()

    async def test_deposit_outside_sector_0(self, server_url, check_server_available):
        """Deposits should succeed even when the ship is not in sector 0."""
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

            status_before = await get_status(client, char_id)
            ship_before = status_before["ship"]
            bank_before = status_before["player"]["credits_in_bank"]
            result = await client.deposit_to_bank(
                amount=100,
                ship_id=ship_before.get("ship_id"),
                target_player_name=char_id,
                character_id=char_id,
            )

            assert result.get("success") is True

            status_after = await get_status(client, char_id)
            assert status_after["ship"]["credits"] == ship_before["credits"] - 100
            assert status_after["player"]["credits_in_bank"] == bank_before + 100

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
                await client.withdraw_from_bank(
                    amount=100,
                    character_id=char_id,
                )

            # Should return 400 client error
            assert exc_info.value.status == 400
            assert "sector 0" in str(exc_info.value).lower() or "megaport" in str(exc_info.value).lower()

    async def test_bank_withdraw_while_in_combat_blocked(self, server_url, check_server_available):
        """Deposits are allowed in combat, but withdrawals remain blocked."""
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
            deposit_result = await char_client.deposit_to_bank(
                amount=100,
                target_player_name=char_id,
                character_id=char_id,
            )
            assert deposit_result.get("success") is True

            # Withdrawals should still be blocked
            with pytest.raises(RPCError) as exc_info:
                await char_client.withdraw_from_bank(
                    amount=50,
                    character_id=char_id,
                )

            assert exc_info.value.status == 409
            assert "combat" in str(exc_info.value).lower()

        finally:
            await char_client.close()
            await opponent_client.close()


class TestCorporationBanking:
    """Banking scenarios that rely on corporation membership and ships."""

    async def test_personal_deposit_to_corp_member(self, server_url, check_server_available):
        """Character ship deposits to a corp mate's bank account."""
        await reset_corporation_test_state(server_url)

        founder_id = "test_bank_corp_founder"
        member_id = "test_bank_corp_member"

        async with managed_client(
            server_url,
            founder_id,
            credits=20_000,
            bank=0,
            sector=0,
        ) as founder, managed_client(
            server_url,
            member_id,
            credits=5_000,
            bank=0,
            sector=0,
        ) as member:
            corp = await founder._request(
                "corporation.create",
                {"character_id": founder_id, "name": "Deposit Guild"},
            )
            await member._request(
                "corporation.join",
                {
                    "character_id": member_id,
                    "corp_id": corp["corp_id"],
                    "invite_code": corp["invite_code"],
                },
            )

            founder_status = await get_status(founder, founder_id)
            founder_ship_id = founder_status["ship"]["ship_id"]

            member_bank_events: list[dict] = []
            member_status_events: list[dict] = []
            bank_token = member.add_event_handler("bank.transaction", lambda payload: member_bank_events.append(payload))
            status_token = member.add_event_handler("status.update", lambda payload: member_status_events.append(payload))

            try:
                result = await founder.deposit_to_bank(
                    amount=4000,
                    target_player_name=member_id,
                    character_id=founder_id,
                )

                assert result.get("success") is True
                assert result["ship_id"] == founder_ship_id
                assert result["source_character_id"] == founder_id

                await asyncio.sleep(0.5)

                assert member_bank_events, "Expected bank.transaction event for corp member"
                bank_event = member_bank_events[-1]
                if "payload" in bank_event:
                    bank_event = bank_event["payload"]
                assert bank_event["direction"] == "deposit"
                assert bank_event["amount"] == 4000
                assert bank_event["ship_id"] == founder_ship_id
                assert bank_event["source_character_id"] == founder_id

                status_after = await get_status(member, member_id)
                assert status_after["player"]["credits_in_bank"] == 4000

                founder_after = await get_status(founder, founder_id)
                assert founder_after["ship"]["credits"] == founder_status["ship"]["credits"] - 4000
            finally:
                member.remove_event_handler(bank_token)
                member.remove_event_handler(status_token)

    async def test_corporation_ship_deposit_to_member(self, server_url, check_server_available):
        """Corporation-owned ship deposits credits to a corp member."""
        await reset_corporation_test_state(server_url)

        founder_id = "test_bank_corp_ship_founder"
        member_id = "test_bank_corp_ship_member"

        async with managed_client(
            server_url,
            founder_id,
            credits=10_000,
            bank=500_000,
            sector=0,
        ) as founder, managed_client(
            server_url,
            member_id,
            credits=2_000,
            bank=0,
            sector=0,
        ) as member:
            corp = await founder._request(
                "corporation.create",
                {"character_id": founder_id, "name": "Corp Ship Depositors"},
            )
            await member._request(
                "corporation.join",
                {
                    "character_id": member_id,
                    "corp_id": corp["corp_id"],
                    "invite_code": corp["invite_code"],
                },
            )

            purchase = await founder._request(
                "ship.purchase",
                {
                    "character_id": founder_id,
                    "ship_type": "kestrel_courier",
                    "purchase_type": "corporation",
                },
            )
            corp_ship_id = purchase["ship_id"]

            starting_credits = 50_000
            _set_ship_credits(corp_ship_id, starting_credits)
            await asyncio.sleep(0.1)

            member_bank_events: list[dict] = []
            bank_token = member.add_event_handler("bank.transaction", lambda payload: member_bank_events.append(payload))

            try:
                result = await founder.deposit_to_bank(
                    amount=15_000,
                    ship_id=corp_ship_id,
                    target_player_name=member_id,
                )

                assert result.get("success") is True
                assert result["ship_id"] == corp_ship_id
                assert result.get("source_character_id") is None
                assert result["ship_credits_after"] == starting_credits - 15_000

                await asyncio.sleep(0.5)

                assert member_bank_events, "Expected bank.transaction event for corp member"
                bank_event = member_bank_events[-1]
                if "payload" in bank_event:
                    bank_event = bank_event["payload"]
                assert bank_event["direction"] == "deposit"
                assert bank_event["ship_id"] == corp_ship_id
                assert bank_event["amount"] == 15_000
                assert bank_event.get("source_character_id") is None

                status_after = await get_status(member, member_id)
                assert status_after["player"]["credits_in_bank"] == 15_000

                ships_path = TEST_WORLD_DATA_DIR / "ships.json"
                with ships_path.open("r", encoding="utf-8") as handle:
                    data = json.load(handle)
                corp_ship = data[corp_ship_id]
                assert corp_ship["state"]["credits"] == starting_credits - 15_000
            finally:
                member.remove_event_handler(bank_token)
