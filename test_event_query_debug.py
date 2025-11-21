#!/usr/bin/env python3
"""Debug script to test event_query functionality."""

import asyncio
from datetime import datetime, timezone
from utils.api_client import AsyncGameClient
from tests.helpers.combat_helpers import create_test_character_knowledge


async def main():
    server_url = "http://127.0.0.1:54321"

    # Create test characters
    char1_id = "test_debug_char1"
    char2_id = "test_debug_char2"

    print(f"\nCreating character data for {char1_id} and {char2_id}...")
    create_test_character_knowledge(char1_id, sector=1, credits=10000, fighters=500)
    create_test_character_knowledge(char2_id, sector=2, credits=10000, fighters=500)

    # Create clients
    print(f"Creating HTTP clients...")
    client1 = AsyncGameClient(base_url=server_url, character_id=char1_id)
    client2 = AsyncGameClient(base_url=server_url, character_id=char2_id)

    try:
        # Join
        print(f"Joining...")
        await client1.join(character_id=char1_id)
        await client2.join(character_id=char2_id)

        # Record start time
        start_time = datetime.now(timezone.utc)
        await asyncio.sleep(0.2)

        # Trigger events
        print(f"\nTriggering events...")
        await client1.my_status(character_id=char1_id)
        await client2.my_status(character_id=char2_id)

        await asyncio.sleep(2.0)
        end_time = datetime.now(timezone.utc)

        # Query events in admin mode
        print(f"\n{'='*80}")
        print(f"ADMIN MODE QUERY (no character_id filter)")
        print(f"{'='*80}")
        admin_result = await client1._request("event.query", {
            "admin_password": "",
            "start": start_time.isoformat(),
            "end": end_time.isoformat(),
        })

        print(f"\nAdmin query result:")
        print(f"  Success: {admin_result.get('success')}")
        print(f"  Count: {admin_result.get('count')}")
        print(f"  Truncated: {admin_result.get('truncated')}")
        print(f"  Scope: {admin_result.get('scope')}")

        events = admin_result.get("events", [])
        print(f"\nEvents returned ({len(events)}):")
        for i, event in enumerate(events[:10]):  # First 10 only
            print(f"  [{i}] {event.get('event')}: sender={event.get('sender')}, receiver={event.get('receiver')}, sector={event.get('sector')}")

        # Check which characters' events we see
        char1_events = [e for e in events if e.get("sender") == char1_id or e.get("receiver") == char1_id]
        char2_events = [e for e in events if e.get("sender") == char2_id or e.get("receiver") == char2_id]

        print(f"\nCharacter event distribution:")
        print(f"  {char1_id}: {len(char1_events)} events")
        print(f"  {char2_id}: {len(char2_events)} events")

        # Try character-scoped query
        print(f"\n{'='*80}")
        print(f"CHARACTER MODE QUERY (character_id={char1_id})")
        print(f"{'='*80}")
        char_result = await client1._request("event.query", {
            "character_id": char1_id,
            "start": start_time.isoformat(),
            "end": end_time.isoformat(),
        })

        print(f"\nCharacter query result:")
        print(f"  Success: {char_result.get('success')}")
        print(f"  Count: {char_result.get('count')}")
        print(f"  Scope: {char_result.get('scope')}")

        char_events = char_result.get("events", [])
        print(f"\nEvents returned ({len(char_events)}):")
        for i, event in enumerate(char_events[:10]):  # First 10 only
            print(f"  [{i}] {event.get('event')}: sender={event.get('sender')}, receiver={event.get('receiver')}")

    finally:
        await client1.close()
        await client2.close()


if __name__ == "__main__":
    asyncio.run(main())
