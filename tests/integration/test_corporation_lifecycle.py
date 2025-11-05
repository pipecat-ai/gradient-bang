"""
Integration tests covering the end-to-end corporation lifecycle.

These tests exercise:
- Corporation creation and credit deductions
- Joining via invite codes (including validation and regeneration)
- Membership management (leave, kick, disband)
"""

import asyncio
from contextlib import suppress

import pytest

from utils.api_client import AsyncGameClient, RPCError
from helpers.combat_helpers import create_test_character_knowledge


pytestmark = [pytest.mark.asyncio, pytest.mark.integration, pytest.mark.requires_server]


async def _status_snapshot(client: AsyncGameClient, character_id: str) -> dict:
    waiter = asyncio.create_task(
        client.wait_for_event("status.snapshot", timeout=5.0)
    )
    try:
        await client.my_status(character_id=character_id)
        event = await waiter
        return event["payload"]
    finally:
        if not waiter.done():
            waiter.cancel()
            with suppress(asyncio.CancelledError):
                await waiter


async def _create_client(server_url: str, character_id: str, *, credits: int = 50_000, bank: int = 0, sector: int = 1):
    create_test_character_knowledge(
        character_id,
        sector=sector,
        credits=credits,
        credits_in_bank=bank,
    )
    client = AsyncGameClient(base_url=server_url, character_id=character_id)
    await client.join(character_id=character_id)
    return client


@pytest.mark.asyncio
async def test_create_corporation(server_url, check_server_available):
    founder_id = "test_corp_founder_1"

    client = await _create_client(server_url, founder_id, credits=60_000)
    async with client:
        result = await client._request(
            "corporation.create",
            {"character_id": founder_id, "name": "Star Traders"},
        )

        assert result["success"] is True
        assert result["name"] == "Star Traders"
        assert result["member_count"] == 1
        assert isinstance(result["invite_code"], str) and len(result["invite_code"]) == 8

        corp_info = await client._request("my.corporation", {"character_id": founder_id})
        assert corp_info["corporation"]["corp_id"] == result["corp_id"]


@pytest.mark.asyncio
async def test_create_corporation_costs_credits(server_url, check_server_available):
    founder_id = "test_corp_founder_credits"

    client = await _create_client(server_url, founder_id, credits=25_000)
    async with client:
        await client._request(
            "corporation.create",
            {"character_id": founder_id, "name": "Credit Checkers"},
        )

        status = await _status_snapshot(client, founder_id)
        assert status["ship"]["credits"] == 15_000


@pytest.mark.asyncio
async def test_create_corporation_fails_without_funds(server_url, check_server_available):
    founder_id = "test_corp_founder_broke"

    client = await _create_client(server_url, founder_id, credits=5_000)
    async with client:
        with pytest.raises(RPCError) as excinfo:
            await client._request(
                "corporation.create",
                {"character_id": founder_id, "name": "Budget Corp"},
            )
        assert excinfo.value.status == 400
        assert "Insufficient credits" in excinfo.value.detail


@pytest.mark.asyncio
async def test_join_with_valid_invite_code(server_url, check_server_available):
    founder_id = "test_join_founder"
    joiner_id = "test_join_member"

    founder = await _create_client(server_url, founder_id, credits=60_000)
    joiner = await _create_client(server_url, joiner_id, credits=10_000)

    async with founder, joiner:
        create_result = await founder._request(
            "corporation.create",
            {"character_id": founder_id, "name": "Joiners Guild"},
        )

        join_result = await joiner._request(
            "corporation.join",
            {
                "character_id": joiner_id,
                "corp_id": create_result["corp_id"],
                "invite_code": create_result["invite_code"],
            },
        )

        assert join_result["success"] is True
        assert join_result["member_count"] == 2

        my_corp = await joiner._request("my.corporation", {"character_id": joiner_id})
        assert my_corp["corporation"]["corp_id"] == create_result["corp_id"]


@pytest.mark.asyncio
async def test_join_fails_with_invalid_invite_code(server_url, check_server_available):
    founder_id = "test_join_invalid_founder"
    joiner_id = "test_join_invalid_member"

    founder = await _create_client(server_url, founder_id, credits=60_000)
    joiner = await _create_client(server_url, joiner_id, credits=10_000)

    async with founder, joiner:
        create_result = await founder._request(
            "corporation.create",
            {"character_id": founder_id, "name": "Code Guard"},
        )

        with pytest.raises(RPCError) as excinfo:
            await joiner._request(
                "corporation.join",
                {
                    "character_id": joiner_id,
                    "corp_id": create_result["corp_id"],
                    "invite_code": "deadbeef",
                },
            )
        assert excinfo.value.status == 400
        assert "Invalid invite code" in excinfo.value.detail


@pytest.mark.asyncio
async def test_join_is_case_insensitive(server_url, check_server_available):
    founder_id = "test_join_case_founder"
    joiner_id = "test_join_case_member"

    founder = await _create_client(server_url, founder_id, credits=60_000)
    joiner = await _create_client(server_url, joiner_id, credits=10_000)

    async with founder, joiner:
        create_result = await founder._request(
            "corporation.create",
            {"character_id": founder_id, "name": "Case Corps"},
        )

        uppercase_code = create_result["invite_code"].upper()
        join_result = await joiner._request(
            "corporation.join",
            {
                "character_id": joiner_id,
                "corp_id": create_result["corp_id"],
                "invite_code": uppercase_code,
            },
        )

        assert join_result["success"] is True
        assert join_result["member_count"] == 2


@pytest.mark.asyncio
async def test_join_fails_if_already_member(server_url, check_server_available):
    founder_id = "test_join_again_founder"
    joiner_id = "test_join_again_member"

    founder = await _create_client(server_url, founder_id, credits=60_000)
    joiner = await _create_client(server_url, joiner_id, credits=10_000)

    async with founder, joiner:
        create_result = await founder._request(
            "corporation.create",
            {"character_id": founder_id, "name": "Single Entry"},
        )

        await joiner._request(
            "corporation.join",
            {
                "character_id": joiner_id,
                "corp_id": create_result["corp_id"],
                "invite_code": create_result["invite_code"],
            },
        )

        with pytest.raises(RPCError) as excinfo:
            await joiner._request(
                "corporation.join",
                {
                    "character_id": joiner_id,
                    "corp_id": create_result["corp_id"],
                    "invite_code": create_result["invite_code"],
                },
            )
        assert excinfo.value.status == 400
        assert "Already in a corporation" in excinfo.value.detail


@pytest.mark.asyncio
async def test_regenerate_invite_code(server_url, check_server_available):
    founder_id = "test_regen_founder"

    founder = await _create_client(server_url, founder_id, credits=60_000)
    async with founder:
        create_result = await founder._request(
            "corporation.create",
            {"character_id": founder_id, "name": "Code Changers"},
        )

        regen_result = await founder._request(
            "corporation.regenerate_invite_code",
            {"character_id": founder_id},
        )

        assert regen_result["success"] is True
        assert regen_result["new_invite_code"] != create_result["invite_code"]


@pytest.mark.asyncio
async def test_old_invite_code_invalid_after_regeneration(server_url, check_server_available):
    founder_id = "test_regen_invalid_founder"
    joiner_id = "test_regen_invalid_joiner"

    founder = await _create_client(server_url, founder_id, credits=60_000)
    joiner = await _create_client(server_url, joiner_id, credits=10_000)

    async with founder, joiner:
        create_result = await founder._request(
            "corporation.create",
            {"character_id": founder_id, "name": "Rotating Codes"},
        )

        old_code = create_result["invite_code"]

        regen_result = await founder._request(
            "corporation.regenerate_invite_code",
            {"character_id": founder_id},
        )
        assert regen_result["success"] is True

        with pytest.raises(RPCError) as excinfo:
            await joiner._request(
                "corporation.join",
                {
                    "character_id": joiner_id,
                    "corp_id": create_result["corp_id"],
                    "invite_code": old_code,
                },
            )
        assert excinfo.value.status == 400
        assert "Invalid invite code" in excinfo.value.detail


@pytest.mark.asyncio
async def test_leave_corporation(server_url, check_server_available):
    founder_id = "test_leave_founder"
    member_id = "test_leave_member"

    founder = await _create_client(server_url, founder_id, credits=60_000)
    member = await _create_client(server_url, member_id, credits=10_000)

    async with founder, member:
        create_result = await founder._request(
            "corporation.create",
            {"character_id": founder_id, "name": "Leavers Club"},
        )

        await member._request(
            "corporation.join",
            {
                "character_id": member_id,
                "corp_id": create_result["corp_id"],
                "invite_code": create_result["invite_code"],
            },
        )

        leave_result = await member._request(
            "corporation.leave", {"character_id": member_id}
        )
        assert leave_result["success"] is True

        my_corp = await member._request("my.corporation", {"character_id": member_id})
        assert my_corp["corporation"] is None


@pytest.mark.asyncio
async def test_last_member_leaving_disbands_corporation(server_url, check_server_available):
    founder_id = "test_disband_founder"

    founder = await _create_client(server_url, founder_id, credits=60_000)
    async with founder:
        create_result = await founder._request(
            "corporation.create",
            {"character_id": founder_id, "name": "Solo Guild"},
        )

        await founder._request(
            "corporation.leave",
            {"character_id": founder_id},
        )

        with pytest.raises(RPCError) as excinfo:
            await founder._request(
                "corporation.info",
                {"character_id": founder_id, "corp_id": create_result["corp_id"]},
            )
        assert excinfo.value.status == 404


@pytest.mark.asyncio
async def test_kick_member(server_url, check_server_available):
    founder_id = "test_kick_founder"
    member_id = "test_kick_member"

    founder = await _create_client(server_url, founder_id, credits=60_000)
    member = await _create_client(server_url, member_id, credits=10_000)

    async with founder, member:
        create_result = await founder._request(
            "corporation.create",
            {"character_id": founder_id, "name": "Kick Club"},
        )

        await member._request(
            "corporation.join",
            {
                "character_id": member_id,
                "corp_id": create_result["corp_id"],
                "invite_code": create_result["invite_code"],
            },
        )

        kick_result = await founder._request(
            "corporation.kick",
            {"character_id": founder_id, "target_id": member_id},
        )
        assert kick_result["success"] is True

        my_corp = await member._request("my.corporation", {"character_id": member_id})
        assert my_corp["corporation"] is None


@pytest.mark.asyncio
async def test_cannot_kick_yourself(server_url, check_server_available):
    founder_id = "test_kick_self"

    founder = await _create_client(server_url, founder_id, credits=60_000)
    async with founder:
        await founder._request(
            "corporation.create",
            {"character_id": founder_id, "name": "Self Kicker"},
        )

        with pytest.raises(RPCError) as excinfo:
            await founder._request(
                "corporation.kick",
                {"character_id": founder_id, "target_id": founder_id},
            )
        assert excinfo.value.status == 400
        assert "Use leave" in excinfo.value.detail
