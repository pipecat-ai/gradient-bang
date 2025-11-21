#!/usr/bin/env python3
"""Debug admin query to see what events are actually returned."""

import asyncio
from datetime import datetime, timezone
from utils.api_client import AsyncGameClient
from tests.helpers.test_helpers import get_status
from tests.helpers.character_setup import create_client_with_character

async def main():
    server_url = "http://127.0.0.1:54321"
    char1_id = "test_debug_admin1"
    char2_id = "test_debug_admin2"

    client1 = await create_client_with_character(server_url, char1_id)
    client2 = await create_client_with_character(server_url, char2_id)

    try:
        print(f"\n{'='*80}")
        print(f"DEBUG ADMIN QUERY TEST")
        print(f"Character 1: {char1_id}")
        print(f"Character 2: {char2_id}")
        print(f"{'='*80}\n")

        # Record start time
        start_time = datetime.now(timezone.utc)
        await asyncio.sleep(0.2)

        # Trigger events
        print("Calling get_status for both characters...")
        status1 = await get_status(client1, char1_id)
        status2 = await get_status(client2, char2_id)

        print(f"Status1 player.id: {status1.get('player', {}).get('id')}")
        print(f"Status2 player.id: {status2.get('player', {}).get('id')}")

        await asyncio.sleep(2.0)
        end_time = datetime.now(timezone.utc)

        # Admin query
        print(f"\nQuerying events from {start_time.isoformat()} to {end_time.isoformat()}...")
        admin_result = await client1._request("event.query", {
            "admin_password": "",
            "start": start_time.isoformat(),
            "end": end_time.isoformat(),
        })

        print(f"\nAdmin query result:")
        print(f"  Success: {admin_result.get('success')}")
        print(f"  Count: {admin_result.get('count')}")
        print(f"  Scope: {admin_result.get('scope')}")

        events = admin_result.get("events", [])
        print(f"\nEvents returned: {len(events)}")
        for i, event in enumerate(events):
            print(f"\n  Event {i}:")
            print(f"    event: {event.get('event')}")
            print(f"    sender: {event.get('sender')}")
            print(f"    receiver: {event.get('receiver')}")
            print(f"    timestamp: {event.get('timestamp')}")

        # Check which characters' events we see
        char1_events = [e for e in events if e.get("sender") == char1_id or e.get("receiver") == char1_id]
        char2_events = [e for e in events if e.get("sender") == char2_id or e.get("receiver") == char2_id]

        print(f"\n{'='*80}")
        print(f"Character event distribution:")
        print(f"  {char1_id}: {len(char1_events)} events")
        print(f"  {char2_id}: {len(char2_events)} events")
        print(f"{'='*80}\n")

    finally:
        await client1.close()
        await client2.close()

if __name__ == "__main__":
    asyncio.run(main())
