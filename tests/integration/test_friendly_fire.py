"""Integration tests for corporation-friendly combat rules."""

from __future__ import annotations

import pytest

from helpers.combat_helpers import create_test_character_knowledge
from utils.api_client import AsyncGameClient, RPCError


pytestmark = [pytest.mark.asyncio, pytest.mark.integration, pytest.mark.requires_server]


async def _create_client(
    server_url: str,
    character_id: str,
    *,
    sector: int = 5,
    credits: int = 60_000,
    fighters: int = 300,
    ship_type: str = "kestrel_courier",
) -> AsyncGameClient:
    create_test_character_knowledge(
        character_id,
        sector=sector,
        credits=credits,
        fighters=fighters,
        ship_type=ship_type,
    )
    client = AsyncGameClient(base_url=server_url, character_id=character_id)
    await client.join(character_id=character_id)
    return client


async def _create_corporation(
    founder: AsyncGameClient,
    founder_id: str,
    name: str,
) -> dict:
    return await founder._request(
        "corporation.create",
        {"character_id": founder_id, "name": name},
    )


async def _join_corporation(
    client: AsyncGameClient,
    character_id: str,
    corp_id: str,
    invite_code: str,
) -> dict:
    return await client._request(
        "corporation.join",
        {
            "character_id": character_id,
            "corp_id": corp_id,
            "invite_code": invite_code,
        },
    )


@pytest.mark.asyncio
async def test_cannot_initiate_combat_against_corp_member(
    server_url, check_server_available
):
    attacker_id = "test_ff_attacker"
    defender_id = "test_ff_defender"

    sector = 9
    attacker = await _create_client(server_url, attacker_id, sector=sector)
    defender = await _create_client(
        server_url,
        defender_id,
        sector=sector,
        fighters=0,
        ship_type="escape_pod",
    )

    async with attacker, defender:
        corp = await _create_corporation(attacker, attacker_id, "Friendly Shields")
        await _join_corporation(defender, defender_id, corp["corp_id"], corp["invite_code"])

        with pytest.raises(RPCError) as excinfo:
            await attacker.combat_initiate(character_id=attacker_id)

        assert excinfo.value.status == 409
        assert "No targetable opponents" in excinfo.value.detail


@pytest.mark.asyncio
async def test_can_initiate_combat_after_leaving_corp(server_url, check_server_available):
    attacker_id = "test_ff_attacker_leave"
    defender_id = "test_ff_defender_leave"

    sector = 6
    attacker = await _create_client(server_url, attacker_id, sector=sector)
    defender = await _create_client(server_url, defender_id, sector=sector)

    async with attacker, defender:
        corp = await _create_corporation(attacker, attacker_id, "Friendly Shields 2")
        await _join_corporation(defender, defender_id, corp["corp_id"], corp["invite_code"])

        await defender._request(
            "corporation.leave", {"character_id": defender_id}
        )

        result = await attacker.combat_initiate(character_id=attacker_id)
        assert result["success"] is True
        assert "combat_id" in result


@pytest.mark.asyncio
async def test_corp_member_can_collect_shared_garrison(server_url, check_server_available):
    owner_id = "test_ff_garrison_owner"
    member_id = "test_ff_garrison_member"
    sector = 7

    owner = await _create_client(server_url, owner_id, sector=sector)
    member = await _create_client(server_url, member_id, sector=sector)

    async with owner, member:
        corp = await _create_corporation(owner, owner_id, "Garrison Friends")
        await _join_corporation(member, member_id, corp["corp_id"], corp["invite_code"])

        leave_ack = await owner.combat_leave_fighters(
            character_id=owner_id,
            sector=sector,
            quantity=20,
            mode="offensive",
        )
        assert leave_ack["success"] is True

        collect_result = await member.combat_collect_fighters(
            character_id=member_id,
            sector=sector,
            quantity=10,
        )
        assert collect_result["success"] is True

        owner_collect = await owner.combat_collect_fighters(
            character_id=owner_id,
            sector=sector,
            quantity=10,
        )
        assert owner_collect["success"] is True


@pytest.mark.asyncio
async def test_non_member_cannot_collect_corp_garrison(server_url, check_server_available):
    owner_id = "test_ff_garrison_owner_block"
    member_id = "test_ff_garrison_member_block"
    outsider_id = "test_ff_garrison_outsider"
    sector = 8

    owner = await _create_client(server_url, owner_id, sector=sector)
    member = await _create_client(server_url, member_id, sector=sector)
    outsider = await _create_client(server_url, outsider_id, sector=sector)

    async with owner, member, outsider:
        corp = await _create_corporation(owner, owner_id, "Garrison Guard")
        await _join_corporation(member, member_id, corp["corp_id"], corp["invite_code"])

        leave_ack = await owner.combat_leave_fighters(
            character_id=owner_id,
            sector=sector,
            quantity=15,
            mode="offensive",
        )
        assert leave_ack["success"] is True

        with pytest.raises(RPCError) as excinfo:
            await outsider.combat_collect_fighters(
                character_id=outsider_id,
                sector=sector,
                quantity=5,
            )

        assert excinfo.value.status == 404
        assert "No friendly garrison found" in excinfo.value.detail
