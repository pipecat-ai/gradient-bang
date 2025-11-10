"""Integration tests for corporation info and listing queries."""

from __future__ import annotations

import pytest

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
async def test_corporation_info_as_member_includes_invite_code(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_founder") as founder:
        corp = await _create_corp(founder, character_id="test_corp_founder", name="Info Access Corp")

        response = await founder._request(
            "corporation.info",
            {"character_id": "test_corp_founder", "corp_id": corp["corp_id"]},
        )

        assert response["success"] is True
        assert response["corp_id"] == corp["corp_id"]
        assert response["invite_code"] == corp["invite_code"]
        assert response["member_count"] == 1


@pytest.mark.asyncio
async def test_corporation_info_as_non_member_hides_invite_code(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_founder") as founder, managed_client(
        server_url, "test_corp_outsider"
    ) as outsider:
        corp = await _create_corp(founder, character_id="test_corp_founder", name="Public Summary Corp")

        response = await outsider._request(
            "corporation.info",
            {"character_id": "test_corp_outsider", "corp_id": corp["corp_id"]},
        )

        assert response["success"] is True
        assert response["corp_id"] == corp["corp_id"]
        assert "invite_code" not in response
        assert response["member_count"] == 1


@pytest.mark.asyncio
async def test_corporation_list_all(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_founder") as founder:
        corp = await _create_corp(founder, character_id="test_corp_founder", name="List Makers")

        response = await founder._request("corporation.list", {"character_id": "test_corp_founder"})
        corps = response["corporations"]

        found = next((entry for entry in corps if entry["corp_id"] == corp["corp_id"]), None)
        assert found is not None
        assert found["name"] == "List Makers"
        assert found["member_count"] == 1


@pytest.mark.asyncio
async def test_corporation_list_sorted_by_member_count(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_founder") as corp_a_founder, managed_client(
        server_url, "test_corp_rival_founder"
    ) as corp_b_founder, managed_client(server_url, "test_corp_member_1") as member1, managed_client(
        server_url, "test_corp_member_2"
    ) as member2:
        corp_a = await _create_corp(corp_a_founder, character_id="test_corp_founder", name="Alpha Alliance")
        corp_b = await _create_corp(
            corp_b_founder, character_id="test_corp_rival_founder", name="Beta Collective"
        )

        # Add two members to Alpha Alliance
        for client, character_id in [(member1, "test_corp_member_1"), (member2, "test_corp_member_2")]:
            await client._request(
                "corporation.join",
                {
                    "character_id": character_id,
                    "corp_id": corp_a["corp_id"],
                    "invite_code": corp_a["invite_code"],
                },
            )

        response = await corp_a_founder._request(
            "corporation.list", {"character_id": "test_corp_founder"}
        )
        corps = response["corporations"]

        assert len(corps) >= 2
        idx_a = next(i for i, entry in enumerate(corps) if entry["corp_id"] == corp_a["corp_id"])
        idx_b = next(i for i, entry in enumerate(corps) if entry["corp_id"] == corp_b["corp_id"])
        assert idx_a < idx_b  # Alpha should come before Beta due to higher member count

        entry_a = corps[idx_a]
        entry_b = corps[idx_b]
        assert entry_a["member_count"] == 3
        assert entry_b["member_count"] == 1
