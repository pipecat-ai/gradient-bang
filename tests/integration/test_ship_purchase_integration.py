"""Integration tests for personal ship purchase and trade-in flows."""

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


@pytest.mark.asyncio
async def test_personal_trade_in_reduces_price(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_member_1", credits=300_000) as pilot:
        result = await pilot._request(
            "ship.purchase",
            {
                "character_id": "test_corp_member_1",
                "ship_type": "atlas_hauler",
                "purchase_type": "personal",
            },
        )

        assert result["net_cost"] == 245_000  # 260,000 - 15,000 trade-in
        assert result["credits_after"] == 55_000


@pytest.mark.asyncio
async def test_personal_trade_in_sets_new_ship_and_marks_old_unowned(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_member_2", credits=300_000) as pilot:
        old_ship_id = "test_corp_member_2-ship"
        old_record = _load_ship(old_ship_id)
        assert old_record is not None
        assert old_record.get("owner_type") == "character"

        result = await pilot._request(
            "ship.purchase",
            {
                "character_id": "test_corp_member_2",
                "ship_type": "atlas_hauler",
                "purchase_type": "personal",
            },
        )
        new_ship_id = result["ship_id"]
        assert new_ship_id != old_ship_id

        new_record = _load_ship(new_ship_id)
        assert new_record is not None
        assert new_record.get("owner_type") == "character"
        assert new_record.get("owner_id") == "test_corp_member_2"

        updated_old_record = _load_ship(old_ship_id)
        assert updated_old_record is not None
        assert updated_old_record.get("owner_type") == "unowned"
        assert updated_old_record.get("former_owner_name") == "test_corp_member_2"


@pytest.mark.asyncio
async def test_personal_trade_in_insufficient_funds_fails(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_member_3", credits=20_000) as pilot:
        with pytest.raises(RPCError) as excinfo:
            await pilot._request(
                "ship.purchase",
                {
                    "character_id": "test_corp_member_3",
                    "ship_type": "atlas_hauler",
                    "purchase_type": "personal",
                },
            )

        assert excinfo.value.status == 400
        assert "Insufficient credits" in excinfo.value.detail


@pytest.mark.asyncio
async def test_personal_purchase_updates_events(server_url, check_server_available):
    async with managed_client(server_url, "test_corp_member_1", credits=300_000) as pilot:
        status_task = asyncio.create_task(
            pilot.wait_for_event(
                "status.update",
                timeout=5.0,
                predicate=lambda event: event["payload"]["player"].get("id")
                == "test_corp_member_1",
            )
        )
        trade_in_task = asyncio.create_task(
            pilot.wait_for_event("ship.traded_in", timeout=5.0)
        )

        result = await pilot._request(
            "ship.purchase",
            {
                "character_id": "test_corp_member_1",
                "ship_type": "atlas_hauler",
                "purchase_type": "personal",
            },
        )

        status_event = await status_task
        assert status_event["payload"]["player"].get("id") == "test_corp_member_1"

        trade_in_event = await trade_in_task
        payload = trade_in_event["payload"]
        assert payload["new_ship_id"] == result["ship_id"]
        assert payload["trade_in_value"] == 15_000
        assert payload["net_cost"] == 245_000
