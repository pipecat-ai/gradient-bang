"""Debug script to test Supabase Realtime postgres_changes delivery."""
import asyncio
import os
import sys
from datetime import datetime, timezone

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from utils.supabase_client import AsyncGameClient


async def main():
    os.environ["SUPABASE_REALTIME_DEBUG"] = "1"

    # Use a test character ID
    character_id = "9169fd3c-887e-519c-a4ab-db8c4ebedcaf"
    supabase_url = os.environ.get("SUPABASE_URL", "http://127.0.0.1:54321")

    print(f"🔧 Connecting to {supabase_url} as character {character_id}")

    client = AsyncGameClient(
        base_url=supabase_url,
        character_id=character_id,
        transport="supabase",
    )

    events_received = []

    def capture_event(event_name: str, payload: dict):
        print(f"✅ EVENT RECEIVED: {event_name}")
        print(f"   Payload keys: {list(payload.keys())}")
        events_received.append((event_name, payload))

    # Register handlers for the events we expect
    client.on("status.snapshot")(lambda p: capture_event("status.snapshot", p))
    client.on("map.local")(lambda p: capture_event("map.local", p))

    try:
        print("\n🔐 Getting character JWT...")
        jwt_response = await client.ensure_character_jwt(force=True)
        print(f"   JWT obtained (length: {len(jwt_response)})")

        print("\n📡 Establishing realtime connection...")
        # This should trigger _ensure_realtime_listener
        await client._ensure_realtime_listener()
        print("   Realtime listener started")

        print("\n⏳ Waiting 2 seconds for subscription to stabilize...")
        await asyncio.sleep(2)

        print("\n🚀 Calling join RPC (should insert events)...")
        start_time = datetime.now(timezone.utc)

        result = await client.join(character_id=character_id, sector=0)
        print(f"   Join succeeded: {result.get('success')}")

        print("\n⏳ Waiting 5 seconds for postgres_changes delivery...")
        await asyncio.sleep(5)

        end_time = datetime.now(timezone.utc)

        print(f"\n📊 Results:")
        print(f"   Events received via websocket: {len(events_received)}")
        for event_name, _ in events_received:
            print(f"     - {event_name}")

        # Also query the database to see if events were inserted
        print(f"\n🔍 Querying events table directly...")
        try:
            query_result = await client._request("event_query", {
                "character_id": character_id,
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            })
            print(f"   Events in database: {query_result.get('count', 0)}")
            if query_result.get('events'):
                for evt in query_result['events'][:5]:  # Show first 5
                    print(f"     - {evt.get('event_type')} (id: {evt.get('id')})")
        except Exception as e:
            print(f"   Query error: {e}")

        if len(events_received) == 0:
            print("\n❌ ISSUE CONFIRMED: Events inserted but not delivered via postgres_changes")
        else:
            print("\n✅ SUCCESS: Events delivered via postgres_changes")

    finally:
        print("\n🔌 Closing client...")
        await client.close()
        print("   Done")


if __name__ == "__main__":
    asyncio.run(main())
