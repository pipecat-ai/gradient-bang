"""Integration tests verifying corporation ship ownership flows."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pytest

from conftest import EVENT_DELIVERY_WAIT
from utils.api_client import AsyncGameClient, RPCError
from helpers.corporation_utils import (
    managed_client,
    reset_corporation_test_state,
    REQUIRED_CORPORATION_FUNCTIONS,
)
from helpers.client_setup import register_characters_for_test

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.integration,
    pytest.mark.requires_server,
    pytest.mark.timeout(60),
    pytest.mark.requires_supabase_functions(*REQUIRED_CORPORATION_FUNCTIONS),
]

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
    initial_ship_credits: int | None = None,
) -> dict:
    payload = {
        "character_id": character_id,
        "ship_type": ship_type,
        "purchase_type": "corporation",
    }
    if ship_name is not None:
        payload["ship_name"] = ship_name
    if initial_ship_credits is not None:
        payload["initial_ship_credits"] = initial_ship_credits
    return await client._request("ship.purchase", payload)

@pytest.mark.asyncio
async def test_corporation_member_can_control_ship(server_url, check_server_available):
    actor_id = "test_corp_founder"
    async with managed_client(
        server_url, actor_id, bank=500_000
    ) as founder:
        corp = await _create_corp(founder, character_id=actor_id, name="Remote Control Corp")
        purchase = await _purchase_corp_ship(
            founder,
            character_id=actor_id,
            ship_type="atlas_hauler",
            ship_name="Remote Atlas",
        )
        ship_id = purchase["ship_id"]
        # Corporation ship character already created by ship_purchase endpoint

        async with AsyncGameClient(
            base_url=server_url,
            character_id=ship_id,
            actor_character_id=actor_id,
            entity_type="corporation_ship",
        ) as ship_client:
            status_task = asyncio.create_task(
                ship_client.wait_for_event(
                    "status.snapshot",
                    timeout=15.0,
                    predicate=lambda event: event["payload"]["player"].get("id") == ship_id,
                )
            )
            await ship_client.join(character_id=ship_id)
            status_event = await status_task
            status_payload = status_event["payload"]
            status_summary = status_event.get("summary", "")

            assert status_payload["ship"]["ship_id"] == ship_id
            assert status_payload["player"]["id"] == ship_id
            assert status_payload["player"]["player_type"] == "corporation_ship"
            assert status_payload.get("corporation", {}).get("name") == corp["name"]
            assert status_payload.get("corporation", {}).get("corp_id") == corp["corp_id"]

            founder_status_task = asyncio.create_task(
                founder.wait_for_event(
                    "status.snapshot",
                    timeout=5.0,
                    predicate=lambda event: any(
                        p.get("id") == ship_id and p.get("player_type") == "corporation_ship"
                        for p in event["payload"].get("sector", {}).get("players", [])
                    ),
                )
            )
            await founder.my_status(character_id=actor_id)
            founder_snapshot = await founder_status_task
            players = founder_snapshot["payload"]["sector"]["players"]
            matching = [p for p in players if p.get("id") == ship_id]
            assert matching and matching[0]["player_type"] == "corporation_ship"
            founder_summary = founder_snapshot.get("summary", "")
            assert "Corp ship" in founder_summary

            adjacent = status_payload["sector"].get("adjacent_sectors") or []
            assert adjacent, "Expected adjacent sectors for movement test"
            destination = adjacent[0]

            await ship_client.move(to_sector=destination, character_id=ship_id)
            await asyncio.sleep(EVENT_DELIVERY_WAIT)

            followup_task = asyncio.create_task(
                ship_client.wait_for_event(
                    "status.snapshot",
                    timeout=5.0,
                    predicate=lambda event: event["payload"]["ship"]["ship_id"] == ship_id
                    and event["payload"]["sector"]["id"] == destination,
                )
            )
            await ship_client.my_status(character_id=ship_id)
            followup_event = await followup_task
            followup_payload = followup_event["payload"]

            assert followup_payload["sector"]["id"] == destination

@pytest.mark.asyncio
async def test_corporation_ship_can_trade(server_url, check_server_available):
    actor_id = "test_corp_founder"
    purchase_qty = 1
    async with managed_client(
        server_url, actor_id, bank=500_000, sector=1
    ) as founder:
        corp = await _create_corp(founder, character_id=actor_id, name="Trade Fleet Corp")
        purchase = await _purchase_corp_ship(
            founder,
            character_id=actor_id,
            ship_type="atlas_hauler",
            ship_name="Trader Atlas",
            initial_ship_credits=20_000,
        )
        ship_id = purchase["ship_id"]
        # Corporation ship character already created by ship_purchase endpoint

        async with AsyncGameClient(
            base_url=server_url,
            character_id=ship_id,
            actor_character_id=actor_id,
            entity_type="corporation_ship",
        ) as ship_client:
            status_task = asyncio.create_task(
                ship_client.wait_for_event(
                    "status.snapshot",
                    timeout=5.0,
                    predicate=lambda event: event["payload"]["player"].get("id") == ship_id,
                )
            )
            await ship_client.join(character_id=ship_id)
            status_event = await status_task
            status_payload = status_event["payload"]

            assert status_payload["ship"]["credits"] >= 20_000
            starting_credits = status_payload["ship"]["credits"]
            starting_cargo = status_payload["ship"]["cargo"].get("neuro_symbolics", 0)

            trade_event_task = asyncio.create_task(
                ship_client.wait_for_event(
                    "trade.executed",
                    timeout=5.0,
                )
            )

            trade_result = await ship_client.trade(
                commodity="neuro_symbolics",
                quantity=purchase_qty,
                trade_type="buy",
                character_id=ship_id,
            )
            assert trade_result.get("success") is True

            trade_event = await trade_event_task
            trade_payload = trade_event.get("payload", {})
            inner_payload = trade_payload.get("payload", trade_payload)
            ship_block = inner_payload.get("ship", {})
            assert ship_block.get("ship_id") == ship_id

            refresh_task = asyncio.create_task(
                ship_client.wait_for_event(
                    "status.snapshot",
                    timeout=5.0,
                    predicate=lambda event: event["payload"]["ship"]["ship_id"] == ship_id,
                )
            )
            await ship_client.my_status(character_id=ship_id)
            refreshed = await refresh_task
            refreshed_ship = refreshed["payload"]["ship"]

            assert refreshed_ship["cargo"]["neuro_symbolics"] >= starting_cargo + purchase_qty
            assert refreshed_ship["credits"] < starting_credits

@pytest.mark.asyncio
async def test_corporation_ship_can_recharge_warp_power(server_url, check_server_available):
    actor_id = "test_corp_founder"
    recharge_units = 10
    async with managed_client(
        server_url, actor_id, bank=500_000, sector=0
    ) as founder:
        corp = await _create_corp(founder, character_id=actor_id, name="Warp Fleet Corp")
        purchase = await _purchase_corp_ship(
            founder,
            character_id=actor_id,
            ship_type="atlas_hauler",
            ship_name="Warp Atlas",
            initial_ship_credits=15_000,
        )
        ship_id = purchase["ship_id"]
        # Corporation ship character already created by ship_purchase endpoint

        async with AsyncGameClient(
            base_url=server_url,
            character_id=ship_id,
            actor_character_id=actor_id,
            entity_type="corporation_ship",
        ) as ship_client:

            async def capture_status() -> dict:
                future: asyncio.Future = asyncio.get_running_loop().create_future()

                def on_status(event: dict) -> None:
                    payload = event.get("payload", {})
                    ship_block = payload.get("ship", {})
                    if ship_block.get("ship_id") == ship_id and not future.done():
                        future.set_result(payload)

                token = ship_client.add_event_handler("status.snapshot", on_status)
                try:
                    await ship_client.my_status(character_id=ship_id)
                    return await asyncio.wait_for(future, timeout=5.0)
                finally:
                    ship_client.remove_event_handler(token)

            async def wait_for_sector(expected_sector: int) -> dict:
                for _ in range(8):
                    snapshot = await capture_status()
                    if snapshot["sector"]["id"] == expected_sector:
                        return snapshot
                    await asyncio.sleep(EVENT_DELIVERY_WAIT)
                raise AssertionError(f"Ship did not reach sector {expected_sector}")

            await ship_client.join(character_id=ship_id)
            status_payload = await capture_status()

            starting_credits = status_payload["ship"]["credits"]
            starting_warp = status_payload["ship"]["warp_power"]
            adjacent = status_payload["sector"].get("adjacent_sectors") or []
            assert adjacent, "Expected adjacent sectors for movement test"
            outbound_sector = adjacent[0]

            await ship_client.move(to_sector=outbound_sector, character_id=ship_id)
            await asyncio.sleep(EVENT_DELIVERY_WAIT)
            outbound_status = await wait_for_sector(outbound_sector)

            await ship_client.move(to_sector=0, character_id=ship_id)
            await asyncio.sleep(EVENT_DELIVERY_WAIT)
            return_status = await wait_for_sector(0)

            warp_after_round_trip = return_status["ship"]["warp_power"]
            credits_after_round_trip = return_status["ship"]["credits"]

            assert warp_after_round_trip < starting_warp, "Warp should decrease after movement"
            assert credits_after_round_trip == starting_credits, "Movement should not spend ship credits"

            pre_status = return_status
            warp_before = pre_status["ship"]["warp_power"]
            credits_before = pre_status["ship"]["credits"]

            recharge_result = await ship_client.recharge_warp_power(
                units=recharge_units,
                character_id=ship_id,
            )
            assert recharge_result.get("success") is True

            post_status = await capture_status()
            post_ship = post_status["ship"]

            warp_after = post_ship["warp_power"]
            credits_after = post_ship["credits"]

            assert warp_after > warp_before
            assert credits_after < credits_before

@pytest.mark.asyncio
async def test_corporation_ship_can_engage_in_combat(server_url, check_server_available):
    actor_id = "test_corp_founder"
    target_id = "test_combat_defender"
    async with managed_client(
        server_url, actor_id, bank=500_000, sector=2
    ) as founder, managed_client(
        server_url, target_id, sector=2
    ) as _opponent:
        corp = await _create_corp(founder, character_id=actor_id, name="Combat Fleet Corp")
        purchase = await _purchase_corp_ship(
            founder,
            character_id=actor_id,
            ship_type="atlas_hauler",
            ship_name="War Atlas",
        )
        ship_id = purchase["ship_id"]
        # Corporation ship character already created by ship_purchase endpoint

        async with AsyncGameClient(
            base_url=server_url,
            character_id=ship_id,
            actor_character_id=actor_id,
            entity_type="corporation_ship",
        ) as ship_client:
            status_task = asyncio.create_task(
                ship_client.wait_for_event(
                    "status.snapshot",
                    timeout=5.0,
                    predicate=lambda event: event["payload"]["player"].get("id") == ship_id,
                )
            )
            await ship_client.join(character_id=ship_id)
            await status_task  # ensure ship is connected before combat

            combat_result = await ship_client.combat_initiate(
                character_id=ship_id,
                target_id=target_id,
            )
            combat_id = combat_result.get("combat_id")
            assert combat_id, "Expected combat_id from combat initiation"

            action_result = await ship_client.combat_action(
                combat_id=combat_id,
                action="attack",
                commit=50,
                target_id=target_id,
                character_id=ship_id,
            )
            assert "success" in action_result or "round" in action_result

@pytest.mark.asyncio
async def test_corporation_ship_rejects_unauthorized_actor(server_url, check_server_available):
    actor_id = "test_corp_founder"
    outsider_id = "test_corp_outsider"
    async with managed_client(
        server_url, actor_id, bank=500_000
    ) as founder:
        corp = await _create_corp(founder, character_id=actor_id, name="Auth Guard Corp")
        purchase = await _purchase_corp_ship(
            founder,
            character_id=actor_id,
            ship_type="atlas_hauler",
            ship_name="Guarded Atlas",
        )
        ship_id = purchase["ship_id"]
        # Corporation ship character already created by ship_purchase endpoint

        async with AsyncGameClient(
            base_url=server_url,
            character_id=ship_id,
            actor_character_id=outsider_id,
            entity_type="corporation_ship",
        ) as ship_client:
            with pytest.raises(RPCError) as excinfo:
                await ship_client.join(character_id=ship_id)
            assert excinfo.value.status == 403
            assert "not authorized" in excinfo.value.detail.lower()

@pytest.mark.asyncio
async def test_corporation_ship_invalid_id_rejected(server_url, check_server_available):
    invalid_ship_id = "00000000-0000-0000-0000-000000000000"
    async with AsyncGameClient(
        base_url=server_url,
        character_id=invalid_ship_id,
        actor_character_id="test_corp_founder",
        entity_type="corporation_ship",
    ) as ship_client:
        with pytest.raises(RPCError) as excinfo:
            await ship_client.join(character_id=invalid_ship_id)
        assert excinfo.value.status == 404
        assert "not registered" in excinfo.value.detail.lower()

@pytest.mark.asyncio
async def test_corporation_ship_actions_require_authorized_actor(server_url, check_server_available):
    actor_id = "test_corp_founder"
    outsider_id = "test_corp_outsider"

    async with managed_client(
        server_url, actor_id, bank=600_000, sector=1
    ) as founder:
        await _create_corp(founder, character_id=actor_id, name="Auth Sweep Corp")
        purchase = await _purchase_corp_ship(
            founder,
            character_id=actor_id,
            ship_type="atlas_hauler",
            ship_name="Auth Sweep Vessel",
            initial_ship_credits=50_000,
        )
        ship_id = purchase["ship_id"]
        # Corporation ship character already created by ship_purchase endpoint

        async with AsyncGameClient(
            base_url=server_url,
            character_id=ship_id,
            actor_character_id=actor_id,
            entity_type="corporation_ship",
        ) as ship_client:
            await ship_client.join(character_id=ship_id)

            async def assert_forbidden(label: str, func):
                with pytest.raises(RPCError) as excinfo:
                    await func()
                assert excinfo.value.status == 403, f"{label} should require authorized actor"
                assert "not authorized" in excinfo.value.detail.lower()

            ship_client.set_actor_character_id(outsider_id)

            await assert_forbidden(
                "move",
                lambda: ship_client.move(to_sector=0, character_id=ship_id),
            )
            await assert_forbidden(
                "trade",
                lambda: ship_client.trade(
                    commodity="neuro_symbolics",
                    quantity=1,
                    trade_type="buy",
                    character_id=ship_id,
                ),
            )
            await assert_forbidden(
                "transfer_credits",
                lambda: ship_client.transfer_credits(
                    to_player_name=actor_id,
                    amount=100,
                    character_id=ship_id,
                ),
            )
            await assert_forbidden(
                "transfer_warp_power",
                lambda: ship_client.transfer_warp_power(
                    to_player_name=actor_id,
                    units=5,
                    character_id=ship_id,
                ),
            )
            await assert_forbidden(
                "bank_transfer",
                lambda: ship_client.deposit_to_bank(
                    amount=250,
                    ship_id=ship_id,
                    target_player_name=actor_id,
                ),
            )
            await assert_forbidden(
                "combat_initiate",
                lambda: ship_client.combat_initiate(character_id=ship_id),
            )
            await assert_forbidden(
                "combat_action",
                lambda: ship_client.combat_action(
                    combat_id="bogus-combat",
                    action="attack",
                    commit=0,
                    target_id="target",
                    character_id=ship_id,
                ),
            )
            await assert_forbidden(
                "combat_leave_fighters",
                lambda: ship_client.combat_leave_fighters(
                    sector=1,
                    quantity=5,
                    mode="offensive",
                    character_id=ship_id,
                ),
            )
            await assert_forbidden(
                "combat_collect_fighters",
                lambda: ship_client.combat_collect_fighters(
                    sector=1,
                    quantity=5,
                    character_id=ship_id,
                ),
            )
            await assert_forbidden(
                "combat_set_garrison_mode",
                lambda: ship_client.combat_set_garrison_mode(
                    sector=1,
                    mode="offensive",
                    character_id=ship_id,
                ),
            )

@pytest.mark.asyncio
async def test_corporation_ship_chat_requires_authorized_actor(server_url, check_server_available):
    actor_id = "test_corp_founder"
    outsider_id = "test_corp_outsider"
    async with managed_client(
        server_url, actor_id, bank=500_000
    ) as founder:
        await _create_corp(founder, character_id=actor_id, name="Chat Guard Corp")
        purchase = await _purchase_corp_ship(
            founder,
            character_id=actor_id,
            ship_type="atlas_hauler",
            ship_name="Chatty Atlas",
        )
        ship_id = purchase["ship_id"]
        # Corporation ship character already created by ship_purchase endpoint

        async with AsyncGameClient(
            base_url=server_url,
            character_id=ship_id,
            actor_character_id=actor_id,
            entity_type="corporation_ship",
        ) as ship_client:
            await ship_client.join(character_id=ship_id)

            success_ack = await ship_client.send_message(
                content="Authorized broadcast from corp ship.",
                msg_type="broadcast",
                character_id=ship_id,
            )
            assert success_ack.get("id"), "Expected message ID for authorized broadcast"

            ship_client.set_actor_character_id(outsider_id)
            with pytest.raises(RPCError) as excinfo:
                await ship_client.send_message(
                    content="Unauthorized broadcast attempt.",
                    msg_type="broadcast",
                    character_id=ship_id,
                )
            assert excinfo.value.status == 403
            assert "not authorized" in excinfo.value.detail.lower()

@pytest.mark.asyncio
async def test_corporation_event_log_records_fleet_activity(server_url, check_server_available):
    actor_id = "test_corp_founder"
    async with managed_client(
        server_url, actor_id, bank=600_000
    ) as founder:
        corp = await _create_corp(founder, character_id=actor_id, name="Event Log Corp")
        start_time = datetime.now(timezone.utc) - timedelta(seconds=1)
        purchase = await _purchase_corp_ship(
            founder,
            character_id=actor_id,
            ship_type="atlas_hauler",
            ship_name="Logging Atlas",
            initial_ship_credits=25_000,
        )
        ship_id = purchase["ship_id"]
        # Corporation ship character already created by ship_purchase endpoint

        async with AsyncGameClient(
            base_url=server_url,
            character_id=ship_id,
            actor_character_id=actor_id,
            entity_type="corporation_ship",
        ) as ship_client:
            status_task = asyncio.create_task(
                ship_client.wait_for_event(
                    "status.snapshot",
                    timeout=5.0,
                    predicate=lambda event: event["payload"]["player"].get("id") == ship_id,
                )
            )
            await ship_client.join(character_id=ship_id)
            status_event = await status_task
            status_payload = status_event["payload"]
            sector_id = status_payload["sector"]["id"]

            trade_event_task = asyncio.create_task(
                ship_client.wait_for_event("trade.executed", timeout=5.0)
            )
            await ship_client.trade(
                commodity="neuro_symbolics",
                quantity=1,
                trade_type="buy",
                character_id=ship_id,
            )
            await trade_event_task

            transfer_event_task = asyncio.create_task(
                ship_client.wait_for_event(
                    "credits.transfer",
                    timeout=5.0,
                    predicate=lambda event: event["payload"]
                    .get("transfer_direction")
                    == "sent",
                )
            )
            founder_transfer_task = asyncio.create_task(
                founder.wait_for_event(
                    "credits.transfer",
                    timeout=5.0,
                    predicate=lambda event: event["payload"]
                    .get("transfer_direction")
                    == "received",
                )
            )
            await ship_client.transfer_credits(
                to_player_name=actor_id,
                amount=100,
                character_id=ship_id,
            )
            await transfer_event_task
            await founder_transfer_task

            garrison_event_task = asyncio.create_task(
                ship_client.wait_for_event("garrison.deployed", timeout=5.0)
            )
            await ship_client.combat_leave_fighters(
                sector=sector_id,
                quantity=25,
                mode="defensive",
                toll_amount=0,
                character_id=ship_id,
            )
            await garrison_event_task

            await asyncio.sleep(EVENT_DELIVERY_WAIT)

        end_time = datetime.now(timezone.utc) + timedelta(seconds=1)

        query_payload = {
            "character_id": actor_id,
            "corporation_id": corp["corp_id"],
            "start": start_time.isoformat(),
            "end": end_time.isoformat(),
        }
        query_result = await founder._request("event.query", query_payload)
        assert query_result.get("success") is True

        events = query_result.get("events", [])
        assert events, "Expected at least one event entry in the log query"

        def _find_event(name: str, *, sender: str | None = None):
            for entry in events:
                if entry.get("event") != name:
                    continue
                if sender and entry.get("sender") != sender:
                    continue
                return entry
            return None

        trade_entry = _find_event("trade.executed", sender=ship_id)
        assert trade_entry is not None, "trade.executed event missing from corp log"
        assert trade_entry.get("corporation_id") == corp["corp_id"]

        transfer_entry = _find_event("credits.transfer", sender=ship_id)
        assert transfer_entry is not None, "credits.transfer event missing from corp log"
        assert transfer_entry.get("corporation_id") == corp["corp_id"]

        garrison_entry = _find_event("garrison.deployed", sender=ship_id)
        assert garrison_entry is not None, "garrison.deployed event missing from corp log"
        assert garrison_entry.get("corporation_id") == corp["corp_id"]

@pytest.mark.asyncio
async def test_multiple_corporation_ships_independent_control(server_url, check_server_available):
    actor_id = "test_corp_founder"
    async with managed_client(
        server_url, actor_id, bank=800_000, sector=3
    ) as founder:
        corp = await _create_corp(founder, character_id=actor_id, name="Fleet Ops Corp")
        first_purchase = await _purchase_corp_ship(
            founder,
            character_id=actor_id,
            ship_type="atlas_hauler",
            ship_name="Fleet Alpha",
            initial_ship_credits=10_000,
        )
        second_purchase = await _purchase_corp_ship(
            founder,
            character_id=actor_id,
            ship_type="kestrel_courier",
            ship_name="Fleet Beta",
            initial_ship_credits=5_000,
        )

        ship_one_id = first_purchase["ship_id"]
        ship_two_id = second_purchase["ship_id"]

        async with AsyncGameClient(
            base_url=server_url,
            character_id=ship_one_id,
            actor_character_id=actor_id,
            entity_type="corporation_ship",
        ) as ship_one:
            async with AsyncGameClient(
                base_url=server_url,
                character_id=ship_two_id,
                actor_character_id=actor_id,
                entity_type="corporation_ship",
            ) as ship_two:

                status_one_task = asyncio.create_task(
                    ship_one.wait_for_event(
                        "status.snapshot",
                        timeout=5.0,
                        predicate=lambda event: event["payload"]["ship"]["ship_id"] == ship_one_id,
                    )
                )
                status_two_task = asyncio.create_task(
                    ship_two.wait_for_event(
                        "status.snapshot",
                        timeout=5.0,
                        predicate=lambda event: event["payload"]["ship"]["ship_id"] == ship_two_id,
                    )
                )

                await ship_one.join(character_id=ship_one_id)
                await ship_two.join(character_id=ship_two_id)

                join_payload_one = (await status_one_task)["payload"]
                join_payload_two = (await status_two_task)["payload"]

                assert join_payload_one["ship"]["ship_id"] == ship_one_id
                assert join_payload_two["ship"]["ship_id"] == ship_two_id

                assert join_payload_one["sector"]["id"] == join_payload_two["sector"]["id"]
                base_sector = join_payload_one["sector"]["id"]

                adjacents = join_payload_one.get("sector", {}).get("adjacent_sectors", [])
                assert adjacents, "Expected adjacent sectors for fleet movement test"
                dest_one = adjacents[0]
                dest_two = adjacents[1] if len(adjacents) > 1 else adjacents[0]

                move_one_event = asyncio.create_task(
                    ship_one.wait_for_event(
                        "movement.complete",
                        timeout=10.0,
                        predicate=lambda event: event["payload"].get("player", {}).get("id") == ship_one_id,
                    )
                )
                await ship_one.move(to_sector=dest_one, character_id=ship_one_id)
                move_one_result = await move_one_event

                move_two_event = asyncio.create_task(
                    ship_two.wait_for_event(
                        "movement.complete",
                        timeout=10.0,
                        predicate=lambda event: event["payload"].get("player", {}).get("id") == ship_two_id,
                    )
                )
                await ship_two.move(to_sector=dest_two, character_id=ship_two_id)
                move_two_result = await move_two_event

                final_sector_one = move_one_result["payload"].get("to_sector", dest_one)
                final_sector_two = move_two_result["payload"].get("to_sector", dest_two)

                assert final_sector_one == dest_one
                assert final_sector_two == dest_two
                assert final_sector_one != final_sector_two or len(adjacents) == 1
                assert final_sector_one != base_sector
                assert final_sector_two != base_sector

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
        # Corporation ship character already created by ship_purchase endpoint

        await founder._request("corporation.leave", {"character_id": "test_corp_founder"})

        async def _wait_for_former_owner() -> dict:
            while True:
                record = _load_ship(ship_id)
                if record is not None and record.get("former_owner_name"):
                    return record
                await asyncio.sleep(EVENT_DELIVERY_WAIT)

        record = await asyncio.wait_for(_wait_for_former_owner(), timeout=15.0)
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
        # Corporation ship character already created by ship_purchase endpoint

        await founder._request("corporation.leave", {"character_id": "test_corp_founder"})

        await asyncio.sleep(EVENT_DELIVERY_WAIT)
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

@pytest.mark.skip(reason="Temporarily skipped pending investigation of intermittent timeout")
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
            founder.wait_for_event("corporation.ships_abandoned", timeout=15.0)
        )
        await founder._request("corporation.leave", {"character_id": "test_corp_founder"})
        event = await event_task
        ships = event["payload"]["ships"]
        assert ships
        assert all(entry.get("ship_id") for entry in ships)

@pytest.mark.skip(reason="Temporarily skipped pending investigation of intermittent timeout")
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
        await asyncio.sleep(EVENT_DELIVERY_WAIT)

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
        # Corporation ship character already created by ship_purchase endpoint

        # Trigger a sector update to ensure state flush and leave no modifications
        await founder._request("corporation.leave", {"character_id": "test_corp_founder"})
        await asyncio.sleep(EVENT_DELIVERY_WAIT)

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
        # Corporation ship character already created by ship_purchase endpoint

        await founder._request("corporation.leave", {"character_id": "test_corp_founder"})
        await asyncio.sleep(EVENT_DELIVERY_WAIT)

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
        # Corporation ship character already created by ship_purchase endpoint

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
