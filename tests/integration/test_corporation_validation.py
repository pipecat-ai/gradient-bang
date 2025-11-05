"""Integration tests covering corporation validation rules (Phase 6)."""

from __future__ import annotations

import pytest

from utils.api_client import RPCError
from helpers.corporation_utils import managed_client, reset_corporation_test_state


pytestmark = [pytest.mark.asyncio, pytest.mark.integration, pytest.mark.requires_server]


@pytest.fixture(autouse=True)
async def reset_state(server_url):
    await reset_corporation_test_state(server_url)


async def _create_corporation(client, *, character_id: str, name: str) -> dict:
    return await client._request(
        "corporation.create",
        {"character_id": character_id, "name": name},
    )


@pytest.mark.asyncio
async def test_unique_corp_name_case_insensitive(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_founder") as founder, managed_client(
        server_url, "test_corp_rival_founder"
    ) as rival:
        await _create_corporation(founder, character_id="test_corp_founder", name="Star Traders")

        with pytest.raises(RPCError) as excinfo:
            await _create_corporation(
                rival,
                character_id="test_corp_rival_founder",
                name="star traders",
            )

        assert excinfo.value.status == 400
        assert "already taken" in excinfo.value.detail


@pytest.mark.asyncio
async def test_create_fails_with_duplicate_name(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_founder") as founder, managed_client(
        server_url, "test_corp_member_1"
    ) as contender:
        await _create_corporation(founder, character_id="test_corp_founder", name="Galactic Ventures")

        with pytest.raises(RPCError) as excinfo:
            await _create_corporation(
                contender,
                character_id="test_corp_member_1",
                name="Galactic Ventures",
            )

        assert excinfo.value.status == 400
        assert "already taken" in excinfo.value.detail


@pytest.mark.asyncio
async def test_join_requires_exact_corp_name(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_founder") as founder, managed_client(
        server_url, "test_corp_member_1"
    ) as joiner:
        corp = await _create_corporation(founder, character_id="test_corp_founder", name="Orbital Alliance")

        with pytest.raises(RPCError) as excinfo:
            await joiner._request(
                "corporation.join",
                {
                    "character_id": "test_corp_member_1",
                    "corp_id": "Orbital Alliance",  # Incorrect: must supply corp_id, not name
                    "invite_code": corp["invite_code"],
                },
            )

        assert excinfo.value.status == 404
        assert "Corporation not found" in excinfo.value.detail


@pytest.mark.asyncio
async def test_join_case_insensitive_invite_code(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_founder") as founder, managed_client(
        server_url, "test_corp_member_2"
    ) as joiner:
        corp = await _create_corporation(founder, character_id="test_corp_founder", name="Invite Testers")
        uppercase_code = corp["invite_code"].upper()

        result = await joiner._request(
            "corporation.join",
            {
                "character_id": "test_corp_member_2",
                "corp_id": corp["corp_id"],
                "invite_code": uppercase_code,
            },
        )

        assert result["success"] is True
        assert result["member_count"] == 2


@pytest.mark.asyncio
async def test_corp_name_length_validation(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_founder") as founder:
        with pytest.raises(RPCError) as excinfo_short:
            await _create_corporation(founder, character_id="test_corp_founder", name="AB")
        assert excinfo_short.value.status == 400
        assert "3-50" in excinfo_short.value.detail

        long_name = "C" * 51
        with pytest.raises(RPCError) as excinfo_long:
            await _create_corporation(founder, character_id="test_corp_founder", name=long_name)
        assert excinfo_long.value.status == 400
        assert "3-50" in excinfo_long.value.detail


@pytest.mark.asyncio
async def test_invite_code_format_validation(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_founder") as founder, managed_client(
        server_url, "test_corp_member_3"
    ) as joiner:
        corp = await _create_corporation(founder, character_id="test_corp_founder", name="Invite Format Co")

        with pytest.raises(RPCError) as excinfo:
            await joiner._request(
                "corporation.join",
                {
                    "character_id": "test_corp_member_3",
                    "corp_id": corp["corp_id"],
                    "invite_code": "badcode",
                },
            )

        assert excinfo.value.status == 400
        assert "Invalid invite code" in excinfo.value.detail
