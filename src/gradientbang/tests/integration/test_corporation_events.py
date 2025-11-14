"""Integration tests for corporation event broadcasts and logging."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from gradientbang.tests.helpers.corporation_utils import (
    managed_client,
    reset_corporation_test_state,
)


pytestmark = [pytest.mark.asyncio, pytest.mark.integration, pytest.mark.requires_server]

TESTS_DIR = Path(__file__).resolve().parents[1]
TEST_WORLD_DATA_DIR = TESTS_DIR / "test-world-data"


@pytest.fixture(autouse=True)
async def reset_corp_state(server_url):
    await reset_corporation_test_state(server_url)


async def _query_events(client, *, start: datetime, end: datetime, character_id: str, corporation_id: str | None = None):
    payload = {
        "character_id": character_id,
        "start": start.isoformat(),
        "end": end.isoformat(),
    }
    if corporation_id is not None:
        payload["corporation_id"] = corporation_id
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
    event = await event_task
    return result, event


@pytest.mark.asyncio
async def test_corporation_created_event_includes_invite_code(server_url, check_server_available):
    founder_id = "corp_events_founder_create"
    corp_name = "Event Horizon"

    async with managed_client(server_url, founder_id, credits=80_000) as founder:
        result, event = await _create_corporation(
            founder, character_id=founder_id, name=corp_name
        )

        payload = event["payload"]
        assert payload["corp_id"] == result["corp_id"]
        assert payload["invite_code"] == result["invite_code"]
        assert payload["name"] == corp_name


@pytest.mark.asyncio
async def test_corporation_created_has_corporation_id_in_jsonl(server_url, check_server_available):
    founder_id = "corp_events_founder_log"
    corp_name = "Log Keepers"

    async with managed_client(server_url, founder_id, credits=90_000) as founder:
        start = datetime.now(timezone.utc) - timedelta(seconds=1)
        result, _ = await _create_corporation(
            founder, character_id=founder_id, name=corp_name
        )

        await asyncio.sleep(0.2)
        end = datetime.now(timezone.utc) + timedelta(seconds=1)
        events = await _query_events(
            founder,
            start=start,
            end=end,
            character_id=founder_id,
            corporation_id=result["corp_id"],
        )

        matching = [evt for evt in events if evt.get("event") == "corporation.created"]
        assert matching, "Expected corporation.created event in JSONL query"
        assert all(evt.get("corporation_id") == result["corp_id"] for evt in matching)


@pytest.mark.asyncio
async def test_member_joined_event_to_all_members(server_url, check_server_available):
    founder_id = "corp_events_founder_join"
    joiner_id = "corp_events_joiner"

    async with managed_client(server_url, founder_id, credits=80_000) as founder, managed_client(
        server_url, joiner_id, credits=25_000
    ) as joiner:
        result, _ = await _create_corporation(
            founder, character_id=founder_id, name="Join Ops"
        )

        founder_task = asyncio.create_task(
            founder.wait_for_event("corporation.member_joined", timeout=5.0)
        )
        joiner_task = asyncio.create_task(
            joiner.wait_for_event("corporation.member_joined", timeout=5.0)
        )

        await joiner._request(
            "corporation.join",
            {
                "character_id": joiner_id,
                "corp_id": result["corp_id"],
                "invite_code": result["invite_code"],
            },
        )

        founder_event = await founder_task
        joiner_event = await joiner_task

        for event in (founder_event, joiner_event):
            payload = event["payload"]
            assert payload["corp_id"] == result["corp_id"]
            assert payload["member_id"] == joiner_id


@pytest.mark.asyncio
async def test_member_left_event_to_remaining_members(server_url, check_server_available):
    founder_id = "corp_events_founder_leave"
    member_a_id = "corp_events_member_a"
    member_b_id = "corp_events_member_b"

    async with managed_client(server_url, founder_id, credits=80_000) as founder, managed_client(
        server_url, member_a_id, credits=25_000
    ) as member_a, managed_client(
        server_url, member_b_id, credits=25_000
    ) as member_b:
        create_result, _ = await _create_corporation(
            founder, character_id=founder_id, name="Leave Squad"
        )

        # Member A joins
        await member_a._request(
            "corporation.join",
            {
                "character_id": member_a_id,
                "corp_id": create_result["corp_id"],
                "invite_code": create_result["invite_code"],
            },
        )

        # Member B joins
        await member_b._request(
            "corporation.join",
            {
                "character_id": member_b_id,
                "corp_id": create_result["corp_id"],
                "invite_code": create_result["invite_code"],
            },
        )

        founder_task = asyncio.create_task(
            founder.wait_for_event("corporation.member_left", timeout=5.0)
        )
        member_a_task = asyncio.create_task(
            member_a.wait_for_event("corporation.member_left", timeout=5.0)
        )

        await member_b._request("corporation.leave", {"character_id": member_b_id})

        founder_event = await founder_task
        member_a_event = await member_a_task

        for event in (founder_event, member_a_event):
            payload = event["payload"]
            assert payload["corp_id"] == create_result["corp_id"]
            assert payload["departed_member_id"] == member_b_id


@pytest.mark.asyncio
async def test_member_kicked_event_to_all_and_kicked(server_url, check_server_available):
    founder_id = "corp_events_founder_kick"
    target_id = "corp_events_target"

    async with managed_client(server_url, founder_id, credits=80_000) as founder, managed_client(
        server_url, target_id, credits=25_000
    ) as target:
        create_result, _ = await _create_corporation(
            founder, character_id=founder_id, name="Kick Club"
        )

        await target._request(
            "corporation.join",
            {
                "character_id": target_id,
                "corp_id": create_result["corp_id"],
                "invite_code": create_result["invite_code"],
            },
        )

        founder_task = asyncio.create_task(
            founder.wait_for_event("corporation.member_kicked", timeout=5.0)
        )
        target_task = asyncio.create_task(
            target.wait_for_event("corporation.member_kicked", timeout=5.0)
        )

        await founder._request(
            "corporation.kick",
            {"character_id": founder_id, "target_id": target_id},
        )

        founder_event = await founder_task
        target_event = await target_task

        for event in (founder_event, target_event):
            payload = event["payload"]
            assert payload["corp_id"] == create_result["corp_id"]
            assert payload["kicked_member_id"] == target_id


@pytest.mark.asyncio
async def test_disbanded_event_to_last_member(server_url, check_server_available):
    founder_id = "corp_events_founder_disband"

    async with managed_client(server_url, founder_id, credits=80_000) as founder:
        create_result, _ = await _create_corporation(
            founder, character_id=founder_id, name="Solo Corp"
        )

        disband_task = asyncio.create_task(
            founder.wait_for_event("corporation.disbanded", timeout=5.0)
        )

        await founder._request(
            "corporation.leave", {"character_id": founder_id}
        )

        disband_event = await disband_task
        payload = disband_event["payload"]
        assert payload["corp_id"] == create_result["corp_id"]
        assert payload["reason"] == "last_member_left"


@pytest.mark.asyncio
async def test_corporation_ship_purchased_event(server_url, check_server_available):
    founder_id = "corp_events_founder_ship"

    async with managed_client(
        server_url, founder_id, credits=80_000, bank=500_000
    ) as founder:
        create_result, _ = await _create_corporation(
            founder, character_id=founder_id, name="Shipwrights"
        )

        purchase_task = asyncio.create_task(
            founder.wait_for_event("corporation.ship_purchased", timeout=5.0)
        )

        await founder._request(
            "ship.purchase",
            {
                "character_id": founder_id,
                "ship_type": "atlas_hauler",
                "purchase_type": "corporation",
            },
        )

        purchase_event = await purchase_task
        payload = purchase_event["payload"]
        assert payload["corp_id"] == create_result["corp_id"]
        assert payload["ship_id"]
        assert payload["ship_type"] == "atlas_hauler"


@pytest.mark.asyncio
async def test_ships_abandoned_event_includes_locations(server_url, check_server_available):
    founder_id = "corp_events_founder_abandon"

    async with managed_client(
        server_url, founder_id, credits=80_000, bank=500_000
    ) as founder:
        create_result, _ = await _create_corporation(
            founder, character_id=founder_id, name="Abandon Co"
        )

        # Purchase a corporation ship so abandonment emits ship data
        await founder._request(
            "ship.purchase",
            {
                "character_id": founder_id,
                "ship_type": "atlas_hauler",
                "purchase_type": "corporation",
            },
        )

        abandon_task = asyncio.create_task(
            founder.wait_for_event("corporation.ships_abandoned", timeout=5.0)
        )

        await founder._request(
            "corporation.leave", {"character_id": founder_id}
        )

        abandon_event = await abandon_task
        payload = abandon_event["payload"]
        assert payload["corp_id"] == create_result["corp_id"]
        ships = payload.get("ships", [])
        assert ships, "Expected abandoned ships payload"
        for ship in ships:
            assert ship["ship_id"]
            assert ship["ship_type"]
            assert ship["sector"] is not None


@pytest.mark.asyncio
async def test_events_logged_to_jsonl(server_url, check_server_available):
    founder_id = "corp_events_founder_logcheck"
    joiner_id = "corp_events_log_joiner"

    async with managed_client(server_url, founder_id, credits=80_000) as founder, managed_client(
        server_url, joiner_id, credits=25_000
    ) as joiner:
        start = datetime.now(timezone.utc) - timedelta(seconds=1)
        create_result, _ = await _create_corporation(
            founder, character_id=founder_id, name="Log Check"
        )

        await joiner._request(
            "corporation.join",
            {
                "character_id": joiner_id,
                "corp_id": create_result["corp_id"],
                "invite_code": create_result["invite_code"],
            },
        )

        await asyncio.sleep(0.3)
        end = datetime.now(timezone.utc) + timedelta(seconds=1)

        log_path = TEST_WORLD_DATA_DIR / "event-log.jsonl"
        assert log_path.exists(), "event-log.jsonl should exist"

        matching_events = []
        with log_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                entry = json.loads(line)
                timestamp = entry.get("timestamp")
                if not isinstance(timestamp, str):
                    continue
                try:
                    ts = datetime.fromisoformat(timestamp)
                except ValueError:
                    continue
                if ts < start or ts > end:
                    continue
                if entry.get("event", "").startswith("corporation."):
                    if entry.get("payload", {}).get("corp_id") == create_result["corp_id"]:
                        matching_events.append(entry)

        assert matching_events, "Expected corporation events in JSONL window"
        assert all(evt.get("corporation_id") == create_result["corp_id"] for evt in matching_events)
