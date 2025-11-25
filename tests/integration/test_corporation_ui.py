"""Integration tests covering corporation-aware status and sector payloads."""

from __future__ import annotations

import asyncio
import contextlib

import pytest

from conftest import EVENT_DELIVERY_WAIT
from helpers.combat_helpers import create_test_character_knowledge
from helpers.corporation_utils import REQUIRED_CORPORATION_FUNCTIONS
from helpers.client_setup import create_client_with_character
from gradientbang.utils.api_client import AsyncGameClient


pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.integration,
    pytest.mark.requires_server,
    pytest.mark.requires_supabase_functions(*REQUIRED_CORPORATION_FUNCTIONS),
]


async def _create_client(
    server_url: str,
    character_id: str,
    *,
    sector: int,
    credits: int = 80_000,
    fighters: int = 300,
) -> AsyncGameClient:
    # create_client_with_character handles both registration and join()
    client = await create_client_with_character(
        server_url,
        character_id,
        sector=sector,
        credits=credits,
        fighters=fighters,
    )
    return client


async def _status_snapshot(client: AsyncGameClient, character_id: str) -> dict:
    waiter = asyncio.create_task(client.wait_for_event("status.snapshot", timeout=5.0))
    try:
        await client.my_status(character_id=character_id)
        event = await waiter
        return event["payload"]
    finally:
        if not waiter.done():
            waiter.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await waiter


@pytest.mark.asyncio
async def test_status_includes_corporation_details(server_url, check_server_available):
    founder_id = "test_corp_ui_founder"
    member_id = "test_corp_ui_member"
    sector = 4

    founder = await _create_client(server_url, founder_id, sector=sector)
    member = await _create_client(server_url, member_id, sector=sector)

    async with founder, member:
        create_result = await founder._request(
            "corporation.create",
            {"character_id": founder_id, "name": "UI Test Corps"},
        )

        await member._request(
            "corporation.join",
            {
                "character_id": member_id,
                "corp_id": create_result["corp_id"],
                "invite_code": create_result["invite_code"],
            },
        )

        # Wait for event delivery in polling mode
        await asyncio.sleep(EVENT_DELIVERY_WAIT)

        status_payload = await _status_snapshot(member, member_id)
        corp_info = status_payload.get("corporation")

        assert corp_info is not None
        assert corp_info["corp_id"] == create_result["corp_id"]
        assert corp_info["name"] == "UI Test Corps"
        assert corp_info["member_count"] == 2
        assert corp_info["joined_at"]


@pytest.mark.asyncio
async def test_sector_players_and_garrisons_reflect_corporations(server_url, check_server_available):
    founder_id = "test_corp_ui_founder_sector"
    member_id = "test_corp_ui_member_sector"
    outsider_id = "test_corp_ui_outsider"
    sector = 5

    founder = await _create_client(server_url, founder_id, sector=sector)
    member = await _create_client(server_url, member_id, sector=sector)
    outsider = await _create_client(server_url, outsider_id, sector=sector)

    async with founder, member, outsider:
        create_result = await founder._request(
            "corporation.create",
            {"character_id": founder_id, "name": "Sector Corps"},
        )

        await member._request(
            "corporation.join",
            {
                "character_id": member_id,
                "corp_id": create_result["corp_id"],
                "invite_code": create_result["invite_code"],
            },
        )

        # Wait for event delivery in polling mode
        await asyncio.sleep(EVENT_DELIVERY_WAIT)

        leave_ack = await founder.combat_leave_fighters(
            character_id=founder_id,
            sector=sector,
            quantity=25,
            mode="offensive",
        )
        assert leave_ack["success"] is True

        # Wait for garrison event delivery
        await asyncio.sleep(EVENT_DELIVERY_WAIT)

        member_status = await _status_snapshot(member, member_id)
        # Key by name, not id (Supabase uses UUIDs for id, names for name)
        players = {player["name"]: player for player in member_status["sector"]["players"]}
        assert founder_id in players
        founder_corp = players[founder_id].get("corporation")
        assert founder_corp and founder_corp.get("name") == "Sector Corps"
        assert isinstance(member_status["sector"].get("unowned_ships"), list)

        garrison = member_status["sector"].get("garrison")
        assert garrison
        assert garrison["is_friendly"] is True

        outsider_status = await _status_snapshot(outsider, outsider_id)
        outsider_garrison = outsider_status["sector"].get("garrison")
        assert outsider_garrison
        assert outsider_garrison["is_friendly"] is False
