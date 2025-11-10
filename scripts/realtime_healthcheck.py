"""Realtime healthcheck script for Supabase-backed Gradient Bang."""

from __future__ import annotations

import argparse
import asyncio
import os
from typing import Any, Dict, List, Optional, Tuple

from utils.supabase_client import AsyncGameClient
from utils.supabase_realtime import SupabaseRealtimeListener

try:  # Convenience helper for dev defaults
    from tests.edge.support.characters import char_id as lookup_character_id
except Exception:  # pragma: no cover - tests package not installed in prod envs
    lookup_character_id = None  # type: ignore


async def wait_for_event(
    client: AsyncGameClient,
    event_name: str,
    timeout: float = 5.0,
) -> Dict[str, Any]:
    loop = asyncio.get_running_loop()
    future: asyncio.Future[Dict[str, Any]] = loop.create_future()

    def _capture(event: Dict[str, Any]) -> None:
        if not future.done():
            future.set_result(event)

    token = client.add_event_handler(event_name, _capture)
    try:
        return await asyncio.wait_for(future, timeout)
    finally:
        client.remove_event_handler(token)


async def verify_direct_listener(
    supabase_url: str,
    anon_key: str,
    character_id: str,
) -> Tuple[List[Tuple[str, Dict[str, Any]]], SupabaseRealtimeListener]:
    topic = f"public:character:{character_id}"
    listener = SupabaseRealtimeListener(
        supabase_url=supabase_url,
        anon_key=anon_key,
        topic=topic,
    )
    events: List[Tuple[str, Dict[str, Any]]] = []

    def _record(event_name: str, payload: Dict[str, Any]) -> None:
        events.append((event_name, payload))

    listener.on_any(_record)
    await listener.start()
    return events, listener


async def main() -> None:
    parser = argparse.ArgumentParser(description="Supabase realtime smoke test")
    parser.add_argument(
        "--supabase-url",
        default=os.environ.get("SUPABASE_URL", "http://127.0.0.1:54321"),
        help="Base Supabase URL (default: %(default)s)",
    )
    parser.add_argument(
        "--character-id",
        help="Character UUID to target",
    )
    parser.add_argument(
        "--character-name",
        help="Lookup helper for dev fixtures (e.g., test_2p_player1)",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=5.0,
        help="Seconds to wait for each event",
    )
    parser.add_argument(
        "--skip-direct-listener",
        action="store_true",
        help="Skip the raw SupabaseRealtimeListener check",
    )
    args = parser.parse_args()

    anon_key = os.environ.get("SUPABASE_ANON_KEY") or "anon-key"
    character_id = args.character_id
    if not character_id and args.character_name and lookup_character_id:
        character_id = lookup_character_id(args.character_name)
    if not character_id:
        env_char = os.environ.get("TEST_CHARACTER_ID")
        if env_char:
            character_id = env_char
    if not character_id:
        raise SystemExit("character id is required (pass --character-id or set TEST_CHARACTER_ID)")

    listener_events: List[Tuple[str, Dict[str, Any]]] = []
    listener: Optional[SupabaseRealtimeListener] = None

    if not args.skip_direct_listener:
        listener_events, listener = await verify_direct_listener(
            supabase_url=args.supabase_url,
            anon_key=anon_key,
            character_id=character_id,
        )

    client = AsyncGameClient(
        base_url=args.supabase_url,
        character_id=character_id,
        transport="supabase",
    )

    try:
        await client.pause_event_delivery()
        await client.resume_event_delivery()

        status_task = asyncio.create_task(wait_for_event(client, "status.snapshot", args.timeout))
        map_task = asyncio.create_task(wait_for_event(client, "map.local", args.timeout))

        await client.join(character_id=character_id, sector=0)

        status_event = await status_task
        map_event = await map_task

        if listener is not None:
            await asyncio.sleep(0.5)

        print("AsyncGameClient status.snapshot received", status_event["payload"].get("player", {}).get("id"))
        print("AsyncGameClient map.local received center", map_event["payload"].get("center_sector"))

        if listener is not None:
            print(f"Direct listener captured {len(listener_events)} events")
            for name, payload in listener_events:
                print("  -", name, list(payload.keys()))
    finally:
        if listener is not None:
            await listener.stop()
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())

