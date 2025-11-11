"""Realtime healthcheck script for Supabase-backed Gradient Bang."""

from __future__ import annotations

import argparse
import asyncio
import os
from typing import Any, Dict, List, Optional

from utils.supabase_client import AsyncGameClient
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

        print("AsyncGameClient status.snapshot received", status_event["payload"].get("player", {}).get("id"))
        print("AsyncGameClient map.local received center", map_event["payload"].get("center_sector"))
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
