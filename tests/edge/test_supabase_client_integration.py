import asyncio
import os
from pathlib import Path

import pytest

from utils.supabase_client import AsyncGameClient as SupabaseAsyncGameClient

CHARACTER_ID = "00000000-0000-0000-0000-000000000001"
BASE_URL = os.environ.get("SUPABASE_URL", "http://127.0.0.1:54321")
CLIENT_LOG_PATH = Path(os.environ.get("SUPABASE_CLIENT_LOG", "logs/supabase-client.log"))

pytestmark = [pytest.mark.edge, pytest.mark.asyncio]


async def _wait_for_event(client, event_name: str, timeout: float = 5.0):
    future = asyncio.get_running_loop().create_future()

    def _capture(event):
        if not future.done():
            future.set_result(event)

    token = client.add_event_handler(event_name, _capture)
    try:
        return await asyncio.wait_for(future, timeout=timeout)
    except asyncio.TimeoutError as exc:
        log_excerpt = _tail_client_log()
        raise AssertionError(
            f"Timed out waiting for {event_name}. Recent Supabase client log:\n{log_excerpt}"
        ) from exc
    finally:
        client.remove_event_handler(token)


async def _create_client():
    client = SupabaseAsyncGameClient(base_url=BASE_URL, character_id=CHARACTER_ID, transport="supabase")
    await client.pause_event_delivery()  # start paused until first call drains
    await client.resume_event_delivery()
    return client


async def _plot_course_and_wait(client: SupabaseAsyncGameClient, to_sector: int):
    course_future = asyncio.create_task(_wait_for_event(client, "course.plot"))
    await client.plot_course(to_sector=to_sector, character_id=CHARACTER_ID)
    return await course_future


def _tail_client_log(lines: int = 80) -> str:
    if not CLIENT_LOG_PATH.exists():
        return "<no supabase client log file>"
    try:
        with CLIENT_LOG_PATH.open() as handle:
            data = handle.readlines()
    except OSError:
        return "<unable to read supabase client log>"
    tail = "".join(data[-lines:])
    return tail or "<supabase client log empty>"


async def test_join_emits_status_snapshot():
    client = await _create_client()
    try:
        status_task = asyncio.create_task(_wait_for_event(client, "status.snapshot"))
        map_task = asyncio.create_task(_wait_for_event(client, "map.local"))

        await client.join(character_id=CHARACTER_ID, sector=0)

        status_event = await status_task
        map_event = await map_task

        assert status_event["event_name"] == "status.snapshot"
        assert status_event["payload"]["player"]["id"] == CHARACTER_ID
        assert map_event["event_name"] == "map.local"
    finally:
        await client.close()


async def test_my_status_emits_status_snapshot():
    client = await _create_client()
    try:
        await client.join(character_id=CHARACTER_ID, sector=0)
        status_task = asyncio.create_task(_wait_for_event(client, "status.snapshot"))
        await client.my_status(character_id=CHARACTER_ID)
        status_event = await status_task
        assert status_event["event_name"] == "status.snapshot"
    finally:
        await client.close()


async def test_move_emits_movement_events():
    client = await _create_client()
    try:
        await client.join(character_id=CHARACTER_ID, sector=0)

        movement_start = asyncio.create_task(_wait_for_event(client, "movement.start"))
        movement_complete = asyncio.create_task(_wait_for_event(client, "movement.complete"))
        map_local = asyncio.create_task(_wait_for_event(client, "map.local"))

        await client.move(character_id=CHARACTER_ID, to_sector=1)

        start_event = await movement_start
        complete_event = await movement_complete
        map_event = await map_local

        assert start_event["event_name"] == "movement.start"
        assert start_event["payload"]["sector"]["id"] == 1
        assert complete_event["event_name"] == "movement.complete"
        assert map_event["event_name"] == "map.local"
    finally:
        try:
            await client.move(character_id=CHARACTER_ID, to_sector=0)
        except Exception:
            pass
        await client.close()


async def test_plot_course_emits_course_event():
    client = await _create_client()
    try:
        await client.join(character_id=CHARACTER_ID, sector=0)
        course_event = await _plot_course_and_wait(client, 3)
        payload = course_event["payload"]
        assert course_event["event_name"] == "course.plot"
        assert payload["path"][0] == payload["from_sector"]
        assert payload["path"][-1] == 3
    finally:
        await client.close()


async def test_trade_buy_via_supabase_client():
    client = await _create_client()
    try:
        await client.join(character_id=CHARACTER_ID, sector=0)
        course_event = await _plot_course_and_wait(client, 2)
        for sector in course_event["payload"]["path"][1:]:
            await client.move(character_id=CHARACTER_ID, to_sector=sector)

        trade_task = asyncio.create_task(_wait_for_event(client, "trade.executed"))
        port_update_task = asyncio.create_task(_wait_for_event(client, "port.update"))

        await client.trade(
            commodity="quantum_foam",
            quantity=3,
            trade_type="buy",
            character_id=CHARACTER_ID,
        )

        trade_event = await trade_task
        port_event = await port_update_task
        assert trade_event["payload"]["trade"]["commodity"] == "quantum_foam"
        assert trade_event["payload"]["trade"]["units"] == 3
        assert port_event["payload"]["sector"]["id"] == 2
    finally:
        try:
            await client.move(character_id=CHARACTER_ID, to_sector=1)
            await client.move(character_id=CHARACTER_ID, to_sector=0)
        except Exception:
            pass
        await client.close()
