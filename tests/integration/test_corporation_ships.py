"""Integration tests verifying corporation ship ownership flows."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from utils.api_client import RPCError
from helpers.corporation_utils import managed_client, reset_corporation_test_state


pytestmark = [pytest.mark.asyncio, pytest.mark.integration, pytest.mark.requires_server]

SHIPS_PATH = Path("tests/test-world-data/ships.json")


@pytest.fixture(autouse=True)
async def reset_state(server_url):
    await reset_corporation_test_state(server_url)


def _load_ship(ship_id: str) -> dict | None:
    if not SHIPS_PATH.exists():
        return None
    with SHIPS_PATH.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    return data.get(ship_id)


async def _create_corp(client, *, character_id: str, name: str) -> dict:
    return await client._request(
        "corporation.create",
        {"character_id": character_id, "name": name},
    )


async def _join_corp(client, *, character_id: str, corp: dict) -> dict:
    return await client._request(
        "corporation.join",
        {
            "character_id": character_id,
            "corp_id": corp["corp_id"],
            "invite_code": corp["invite_code"],
        },
    )


async def _purchase_corp_ship(
    client,
    *,
    character_id: str,
    ship_type: str,
    ship_name: str | None = None,
) -> dict:
    return await client._request(
        "ship.purchase",
        {
            "character_id": character_id,
            "ship_type": ship_type,
            "purchase_type": "corporation",
            "ship_name": ship_name,
        },
    )


@pytest.mark.asyncio
async def test_corp_ships_transferred_to_unowned_on_disband(server_url, check_server_available):
    async with managed_client(
        server_url, "test_corp_founder", bank=500_000
    ) as founder:
        corp = await _create_corp(founder, character_id="test_corp_founder", name="Derelict Co")
        purchase = await _purchase_corp_ship(
            founder,
            character_id="test_corp_founder",
            ship_type="atlas_hauler",
            ship_name="Corp Atlas",
        )
        ship_id = purchase["ship_id"]

        await founder._request("corporation.leave", {"character_id": "test_corp_founder"})
        await asyncio.sleep(0.2)

        record = _load_ship(ship_id)
        assert record is not None
        assert record.get("owner_type") == "unowned"
        assert record.get("owner_id") is None
        assert record.get("former_owner_name") == "Derelict Co"
        assert record.get("became_unowned") is not None


@pytest.mark.asyncio
async def test_unowned_ships_appear_in_sector_contents(server_url, check_server_available):
    async with managed_client(
        server_url, "test_corp_founder", bank=500_000
    ) as founder, managed_client(server_url, "test_corp_outsider") as outsider:
        corp = await _create_corp(founder, character_id="test_corp_founder", name="Sector Scan Corp")
        purchase = await _purchase_corp_ship(
            founder,
            character_id="test_corp_founder",
            ship_type="kestrel_courier",
        )
        ship_id = purchase["ship_id"]

        await founder._request("corporation.leave", {"character_id": "test_corp_founder"})

        await asyncio.sleep(0.2)
        status_task = asyncio.create_task(
            outsider.wait_for_event(
                "status.snapshot",
                timeout=5.0,
                predicate=lambda event: event["payload"]["player"].get("id")
                == "test_corp_outsider",
            )
        )
        await outsider.my_status(character_id="test_corp_outsider")
        status_event = await status_task
        unowned = status_event["payload"]["sector"]["unowned_ships"]
        assert any(ship["ship_id"] == ship_id for ship in unowned)


@pytest.mark.asyncio
async def test_ships_abandoned_event_emitted(server_url, check_server_available):
    async with managed_client(
        server_url, "test_corp_founder", bank=500_000
    ) as founder:
        corp = await _create_corp(founder, character_id="test_corp_founder", name="Abandon Testers")
        await _purchase_corp_ship(
            founder,
            character_id="test_corp_founder",
            ship_type="kestrel_courier",
        )

        event_task = asyncio.create_task(
            founder.wait_for_event("corporation.ships_abandoned", timeout=5.0)
        )
        await founder._request("corporation.leave", {"character_id": "test_corp_founder"})
        event = await event_task
        ships = event["payload"]["ships"]
        assert ships
        assert all(entry.get("ship_id") for entry in ships)


@pytest.mark.asyncio
async def test_multiple_ships_all_become_unowned(server_url, check_server_available):
    async with managed_client(
        server_url, "test_corp_founder", bank=800_000
    ) as founder:
        corp = await _create_corp(founder, character_id="test_corp_founder", name="Fleet Drop Corp")
        ship_ids = []
        for ship_type in ("kestrel_courier", "atlas_hauler"):
            purchase = await _purchase_corp_ship(
                founder,
                character_id="test_corp_founder",
                ship_type=ship_type,
            )
            ship_ids.append(purchase["ship_id"])

        await founder._request("corporation.leave", {"character_id": "test_corp_founder"})
        await asyncio.sleep(0.2)

        for ship_id in ship_ids:
            record = _load_ship(ship_id)
            assert record is not None
            assert record.get("owner_type") == "unowned"


@pytest.mark.asyncio
async def test_ship_retains_state_when_unowned(server_url, check_server_available):
    async with managed_client(
        server_url, "test_corp_founder", bank=500_000
    ) as founder:
        corp = await _create_corp(founder, character_id="test_corp_founder", name="Stateful Corp")
        purchase = await _purchase_corp_ship(
            founder,
            character_id="test_corp_founder",
            ship_type="kestrel_courier",
        )
        ship_id = purchase["ship_id"]

        # Trigger a sector update to ensure state flush and leave no modifications
        await founder._request("corporation.leave", {"character_id": "test_corp_founder"})
        await asyncio.sleep(0.2)

        record = _load_ship(ship_id)
        assert record is not None
        state = record.get("state", {})
        # Default kestrel stats: fighters=300, shields=150 per ships data
        assert state.get("fighters") == 300
        assert state.get("shields") == 150


@pytest.mark.asyncio
async def test_unowned_ship_includes_former_corp_info(server_url, check_server_available):
    async with managed_client(
        server_url, "test_corp_founder", bank=500_000
    ) as founder:
        corp = await _create_corp(founder, character_id="test_corp_founder", name="History Corp")
        purchase = await _purchase_corp_ship(
            founder,
            character_id="test_corp_founder",
            ship_type="atlas_hauler",
        )
        ship_id = purchase["ship_id"]

        await founder._request("corporation.leave", {"character_id": "test_corp_founder"})
        await asyncio.sleep(0.2)

        record = _load_ship(ship_id)
        assert record is not None
        assert record.get("former_owner_name") == "History Corp"
        assert record.get("became_unowned") is not None


@pytest.mark.asyncio
async def test_unowned_ships_only_visible_in_their_sector(server_url, check_server_available):
    async with managed_client(
        server_url, "test_corp_founder", bank=500_000, sector=1
    ) as founder, managed_client(server_url, "test_corp_member_1", sector=1) as nearby, managed_client(
        server_url, "test_corp_member_2", sector=2
    ) as distant:
        corp = await _create_corp(founder, character_id="test_corp_founder", name="Visibility Corp")
        purchase = await _purchase_corp_ship(
            founder,
            character_id="test_corp_founder",
            ship_type="kestrel_courier",
        )
        ship_id = purchase["ship_id"]

        await founder._request("corporation.leave", {"character_id": "test_corp_founder"})

        # Nearby character should see the unowned ship
        near_task = asyncio.create_task(
            nearby.wait_for_event(
                "status.snapshot",
                timeout=5.0,
                predicate=lambda event: event["payload"]["player"].get("id")
                == "test_corp_member_1",
            )
        )
        await nearby.my_status(character_id="test_corp_member_1")
        near_event = await near_task
        near_ships = near_event["payload"]["sector"]["unowned_ships"]
        assert any(ship["ship_id"] == ship_id for ship in near_ships)

        # Distant character (different sector) should not see it
        far_task = asyncio.create_task(
            distant.wait_for_event(
                "status.snapshot",
                timeout=5.0,
                predicate=lambda event: event["payload"]["player"].get("id")
                == "test_corp_member_2",
            )
        )
        await distant.my_status(character_id="test_corp_member_2")
        far_event = await far_task
        far_ships = far_event["payload"]["sector"]["unowned_ships"]
        assert all(ship["ship_id"] != ship_id for ship in far_ships)


@pytest.mark.asyncio
async def test_corporation_ship_purchase_adds_ship(server_url, check_server_available):
    async with managed_client(
        server_url, "test_corp_founder", bank=500_000
    ) as founder:
        corp = await _create_corp(founder, character_id="test_corp_founder", name="Ship Ledger Corp")
        result = await _purchase_corp_ship(
            founder,
            character_id="test_corp_founder",
            ship_type="atlas_hauler",
            ship_name="Ledger One",
        )
        ship_id = result["ship_id"]

        info = await founder._request(
            "corporation.info",
            {"character_id": "test_corp_founder", "corp_id": corp["corp_id"]},
        )
        ships = info.get("ships", [])
        assert any(ship["ship_id"] == ship_id for ship in ships)


@pytest.mark.asyncio
async def test_corporation_ship_purchase_requires_bank_credits(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_founder", bank=10_000) as founder:
        corp = await _create_corp(founder, character_id="test_corp_founder", name="Credit Check Corp")

        with pytest.raises(RPCError) as excinfo:
            await _purchase_corp_ship(
                founder,
                character_id="test_corp_founder",
                ship_type="kestrel_courier",
            )

        assert excinfo.value.status == 400
        assert "Insufficient bank balance" in excinfo.value.detail


@pytest.mark.asyncio
async def test_corp_ship_purchase_rejects_trade_in(server_url, check_server_available):
    async with managed_client(
        server_url, "test_corp_founder", bank=500_000
    ) as founder:
        corp = await _create_corp(founder, character_id="test_corp_founder", name="No Trade-Ins LLC")

        with pytest.raises(RPCError) as excinfo:
            await founder._request(
                "ship.purchase",
                {
                    "character_id": "test_corp_founder",
                    "ship_type": "kestrel_courier",
                    "purchase_type": "corporation",
                    "trade_in_ship_id": "fake-ship",
                },
            )

        assert excinfo.value.status == 400
        assert "trade in a corporation-owned ship" in excinfo.value.detail
