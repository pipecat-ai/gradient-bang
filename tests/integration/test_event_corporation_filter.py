"""Integration tests for corporation-aware event querying."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from helpers.corporation_utils import (
    managed_client,
    reset_corporation_test_state,
    REQUIRED_CORPORATION_FUNCTIONS,
)
from helpers.combat_helpers import deploy_garrison


pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.integration,
    pytest.mark.requires_server,
    pytest.mark.requires_supabase_functions(*REQUIRED_CORPORATION_FUNCTIONS),
]


@pytest.fixture(autouse=True)
async def reset_corp_state(server_url):
    await reset_corporation_test_state(server_url)


async def _query_events(
    client,
    *,
    start: datetime,
    end: datetime,
    character_id: str | None = None,
    corporation_id: str | None = None,
    sector: int | None = None,
    admin: bool = False,
):
    payload = {
        "start": start.isoformat(),
        "end": end.isoformat(),
    }
    if admin:
        payload["admin_password"] = ""
    if character_id is not None:
        payload["character_id"] = character_id
    if corporation_id is not None:
        payload["corporation_id"] = corporation_id
    if sector is not None:
        payload["sector"] = sector
    result = await client._request("event.query", payload)
    return result["events"]


async def _create_corporation(client, *, character_id: str, name: str):
    event_task = asyncio.create_task(
        client.wait_for_event("corporation.created", timeout=5.0)
    )
    result = await client._request(
        "corporation.create",
        {"character_id": character_id, "name": name},
    )
    await event_task
    return result


@pytest.mark.asyncio
async def test_garrison_deployed_tagged_with_corp(server_url, check_server_available):
    character_id = "corp_filter_garrison_member"

    async with managed_client(server_url, character_id, credits=75_000, sector=3) as client:
        corp = await _create_corporation(
            client, character_id=character_id, name="Garrison Guild"
        )

        start = datetime.now(timezone.utc) - timedelta(seconds=1)
        await deploy_garrison(client, character_id, sector=3, fighters=15)
        await asyncio.sleep(0.2)
        end = datetime.now(timezone.utc) + timedelta(seconds=1)

        events = await _query_events(
            client,
            start=start,
            end=end,
            character_id=character_id,
            corporation_id=corp["corp_id"],
        )

        garrison_events = [evt for evt in events if evt.get("event") == "garrison.deployed"]
        assert garrison_events, "Expected garrison.deployed event for corp member"
        assert all(evt.get("corporation_id") == corp["corp_id"] for evt in garrison_events)


@pytest.mark.asyncio
async def test_garrison_deployed_no_corp_no_tag(server_url, check_server_available):
    character_id = "corp_filter_garrison_solo"

    async with managed_client(server_url, character_id, credits=50_000, sector=4) as client:
        start = datetime.now(timezone.utc) - timedelta(seconds=1)
        await deploy_garrison(client, character_id, sector=4, fighters=10)
        await asyncio.sleep(0.2)
        end = datetime.now(timezone.utc) + timedelta(seconds=1)

        events = await _query_events(
            client,
            start=start,
            end=end,
            character_id=character_id,
        )

        garrison_events = [evt for evt in events if evt.get("event") == "garrison.deployed"]
        assert garrison_events, "Expected garrison.deployed event for solo player"
        assert all(evt.get("corporation_id") is None for evt in garrison_events)


@pytest.mark.asyncio
async def test_query_by_corporation_id(server_url, check_server_available):
    founder_id = "corp_filter_founder"
    joiner_id = "corp_filter_joiner"

    async with managed_client(server_url, founder_id, credits=80_000) as founder, managed_client(
        server_url, joiner_id, credits=25_000
    ) as joiner:
        start = datetime.now(timezone.utc) - timedelta(seconds=1)
        corp = await _create_corporation(
            founder, character_id=founder_id, name="Filter Test"
        )

        await joiner._request(
            "corporation.join",
            {
                "character_id": joiner_id,
                "corp_id": corp["corp_id"],
                "invite_code": corp["invite_code"],
            },
        )

        await asyncio.sleep(0.3)
        end = datetime.now(timezone.utc) + timedelta(seconds=1)

        events = await _query_events(
            founder,
            start=start,
            end=end,
            corporation_id=corp["corp_id"],
            admin=True,
        )

        assert events, "Expected events when filtering by corporation_id"
        assert all(evt.get("corporation_id") == corp["corp_id"] for evt in events)


@pytest.mark.asyncio
async def test_query_by_corporation_and_sector(server_url, check_server_available):
    founder_id = "corp_filter_sector_founder"

    target_sector = 5
    async with managed_client(server_url, founder_id, credits=80_000, sector=target_sector) as founder:
        start = datetime.now(timezone.utc) - timedelta(seconds=1)
        corp = await _create_corporation(
            founder, character_id=founder_id, name="Sector Filter"
        )

        await asyncio.sleep(0.1)
        end = datetime.now(timezone.utc) + timedelta(seconds=1)

        events = await _query_events(
            founder,
            start=start,
            end=end,
            corporation_id=corp["corp_id"],
            sector=target_sector,
            admin=True,
        )

        assert events, "Expected events when filtering by corp and sector"
        assert all(evt.get("sector") == target_sector for evt in events)
        assert all(evt.get("corporation_id") == corp["corp_id"] for evt in events)


@pytest.mark.asyncio
async def test_corporation_events_have_corp_id(server_url, check_server_available):
    founder_id = "corp_filter_field_founder"
    member_id = "corp_filter_field_member"

    async with managed_client(server_url, founder_id, credits=80_000) as founder, managed_client(
        server_url, member_id, credits=25_000
    ) as member:
        start = datetime.now(timezone.utc) - timedelta(seconds=1)
        corp = await _create_corporation(
            founder, character_id=founder_id, name="Field Checks"
        )

        await member._request(
            "corporation.join",
            {
                "character_id": member_id,
                "corp_id": corp["corp_id"],
                "invite_code": corp["invite_code"],
            },
        )

        await founder._request(
            "corporation.regenerate_invite_code",
            {"character_id": founder_id},
        )

        await asyncio.sleep(0.3)
        end = datetime.now(timezone.utc) + timedelta(seconds=1)

        events = await _query_events(
            founder,
            start=start,
            end=end,
            corporation_id=corp["corp_id"],
            admin=True,
        )

        assert events, "Expected multiple corporation events"
        assert all(evt.get("corporation_id") == corp["corp_id"] for evt in events)
        assert {evt.get("event") for evt in events} >= {
            "corporation.created",
            "corporation.member_joined",
            "corporation.invite_code_regenerated",
        }


@pytest.mark.asyncio
async def test_corporation_ship_purchase_logged(server_url, check_server_available):
    founder_id = "corp_filter_ship_founder"

    async with managed_client(
        server_url, founder_id, credits=80_000, bank=500_000
    ) as founder:
        start = datetime.now(timezone.utc) - timedelta(seconds=1)
        corp = await _create_corporation(
            founder, character_id=founder_id, name="Ship Logs"
        )

        await founder._request(
            "ship.purchase",
            {
                "character_id": founder_id,
                "ship_type": "atlas_hauler",
                "purchase_type": "corporation",
            },
        )

        await asyncio.sleep(0.3)
        end = datetime.now(timezone.utc) + timedelta(seconds=1)

        events = await _query_events(
            founder,
            start=start,
            end=end,
            corporation_id=corp["corp_id"],
            admin=True,
        )

        ship_events = [evt for evt in events if evt.get("event") == "corporation.ship_purchased"]
        assert ship_events, "Expected corporation.ship_purchased in logs"
        assert all(evt.get("corporation_id") == corp["corp_id"] for evt in ship_events)
