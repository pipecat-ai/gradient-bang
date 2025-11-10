"""Integration tests covering corporation error handling scenarios."""

from __future__ import annotations

import pytest

from utils.api_client import RPCError
from helpers.corporation_utils import (
    managed_client,
    reset_corporation_test_state,
    REQUIRED_CORPORATION_FUNCTIONS,
)


pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.integration,
    pytest.mark.requires_server,
    pytest.mark.requires_supabase_functions(*REQUIRED_CORPORATION_FUNCTIONS),
]


@pytest.fixture(autouse=True)
async def reset_state(server_url):
    await reset_corporation_test_state(server_url)


async def _create_corp(client, *, character_id: str, name: str) -> dict:
    return await client._request(
        "corporation.create",
        {"character_id": character_id, "name": name},
    )


@pytest.mark.asyncio
async def test_kick_nonexistent_member(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_founder") as founder, managed_client(
        server_url, "test_corp_member_1"
    ) as target:
        await _create_corp(founder, character_id="test_corp_founder", name="Kick Errors Inc")

        with pytest.raises(RPCError) as excinfo:
            await founder._request(
                "corporation.kick",
                {
                    "character_id": "test_corp_founder",
                    "target_id": "test_corp_member_1",
                },
            )

        assert excinfo.value.status == 400
        assert "Target is not in your corporation" in excinfo.value.detail


@pytest.mark.asyncio
async def test_leave_when_not_in_corp(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_outsider") as outsider:
        with pytest.raises(RPCError) as excinfo:
            await outsider._request(
                "corporation.leave",
                {"character_id": "test_corp_outsider"},
            )

        assert excinfo.value.status == 400
        assert "Not in a corporation" in excinfo.value.detail


@pytest.mark.asyncio
async def test_create_while_already_in_corp(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_founder") as founder:
        await _create_corp(founder, character_id="test_corp_founder", name="Double Create LLC")

        with pytest.raises(RPCError) as excinfo:
            await _create_corp(founder, character_id="test_corp_founder", name="Second Corp")

        assert excinfo.value.status == 400
        assert "Already in a corporation" in excinfo.value.detail


@pytest.mark.asyncio
async def test_operations_fail_when_not_member(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_founder") as founder, managed_client(
        server_url, "test_corp_outsider"
    ) as outsider:
        corp = await _create_corp(founder, character_id="test_corp_founder", name="Access Control Corp")

        with pytest.raises(RPCError) as excinfo:
            await outsider._request(
                "corporation.regenerate_invite_code",
                {"character_id": "test_corp_outsider"},
            )

        assert excinfo.value.status == 400
        assert "Not in a corporation" in excinfo.value.detail


@pytest.mark.asyncio
async def test_insufficient_credits_for_creation(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_poor_player", credits=5_000) as poor_player:
        with pytest.raises(RPCError) as excinfo:
            await _create_corp(
                poor_player,
                character_id="test_corp_poor_player",
                name="Budget Corp",
            )

        assert excinfo.value.status == 400
        assert "Insufficient credits" in excinfo.value.detail


@pytest.mark.asyncio
async def test_cannot_kick_yourself(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_founder") as founder:
        await _create_corp(founder, character_id="test_corp_founder", name="Self Kickers Anonymous")

        with pytest.raises(RPCError) as excinfo:
            await founder._request(
                "corporation.kick",
                {
                    "character_id": "test_corp_founder",
                    "target_id": "test_corp_founder",
                },
            )

        assert excinfo.value.status == 400
        assert "Use leave" in excinfo.value.detail
