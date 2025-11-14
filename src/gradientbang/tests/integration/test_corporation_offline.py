"""Integration tests for offline corporation interactions (Phase 7 polish)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from helpers.corporation_utils import managed_client, reset_corporation_test_state


pytestmark = [pytest.mark.asyncio, pytest.mark.integration, pytest.mark.requires_server]


async def _create_corp(client, *, character_id: str, name: str) -> dict:
    return await client._request(
        "corporation.create",
        {"character_id": character_id, "name": name},
    )


@pytest.fixture(autouse=True)
async def reset_state(server_url):
    await reset_corporation_test_state(server_url)


@pytest.mark.asyncio
async def test_kick_offline_member_and_event_visible_on_reconnect(server_url, check_server_available):
    founder_id = "test_corp_founder"
    member_id = "test_corp_member_1"

    async with managed_client(server_url, founder_id) as founder, managed_client(
        server_url, member_id
    ) as member:
        corp = await _create_corp(founder, character_id=founder_id, name="Offline Ops")
        await member._request(
            "corporation.join",
            {
                "character_id": member_id,
                "corp_id": corp["corp_id"],
                "invite_code": corp["invite_code"],
            },
        )

    # Member context exited -> offline
    start = datetime.now(timezone.utc) - timedelta(seconds=1)
    await founder._request(
        "corporation.kick",
        {"character_id": founder_id, "target_id": member_id},
    )
    await asyncio.sleep(0.2)
    end = datetime.now(timezone.utc) + timedelta(seconds=1)

    async with managed_client(server_url, member_id) as rejoined:
        my_corp = await rejoined._request("my.corporation", {"character_id": member_id})
        assert my_corp["corporation"] is None

        events = await rejoined._request(
            "event.query",
            {
                "character_id": member_id,
                "start": start.isoformat(),
                "end": end.isoformat(),
            },
        )
        kicked = [
            evt
            for evt in events["events"]
            if evt.get("event") == "corporation.member_kicked"
        ]
        assert kicked, "Expected corporation.member_kicked event in log"
        assert kicked[0].get("corporation_id") == corp["corp_id"]
