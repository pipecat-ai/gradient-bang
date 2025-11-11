"""Minimal test for cloud postgres_changes - doesn't require test fixtures."""
import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from utils.supabase_realtime import SupabaseRealtimeListener


async def main():
    supabase_url = os.environ.get("SUPABASE_URL", "http://127.0.0.1:54321")
    anon_key = os.environ.get("SUPABASE_ANON_KEY")
    service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

    if not anon_key or not service_role_key:
        print("❌ SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY must be set")
        return

    print(f"🔧 Testing postgres_changes on {supabase_url}")

    # Step 1: Create a test character directly
    import httpx
    print("\n📝 Creating test character...")

    test_char_id = str(uuid.uuid4())
    async with httpx.AsyncClient() as http:
        # Insert character
        response = await http.post(
            f"{supabase_url}/rest/v1/characters",
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {service_role_key}",
                "Content-Type": "application/json",
                "Prefer": "return=representation"
            },
            json={
                "character_id": test_char_id,
                "name": f"Test Character {test_char_id[:8]}",
                "credits_in_megabank": 0,
                "is_npc": False
            }
        )
        if response.status_code not in (200, 201):
            print(f"❌ Failed to create character: {response.status_code} {response.text}")
            return
        print(f"   ✅ Character created: {test_char_id}")

        # Get character JWT
        print("\n🔐 Getting character JWT...")
        response = await http.post(
            f"{supabase_url}/functions/v1/get_character_jwt",
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {anon_key}",
                "X-API-Token": service_role_key,
                "Content-Type": "application/json"
            },
            json={"character_id": test_char_id}
        )
        jwt_data = response.json()
        if not jwt_data.get("success"):
            print(f"❌ Failed to get JWT: {jwt_data}")
            return
        character_jwt = jwt_data["jwt"]
        print(f"   ✅ JWT obtained")

    # Step 2: Subscribe to postgres_changes
    print("\n📡 Creating realtime subscription...")
    events_received = []

    listener = SupabaseRealtimeListener(
        supabase_url=supabase_url,
        anon_key=anon_key,
        topic="public:events",
        schema="public",
        table="events",
        access_token=character_jwt,
    )

    def capture_event(event_name: str, payload: dict):
        print(f"   ✅ EVENT RECEIVED: {event_name}")
        events_received.append((event_name, payload))

    listener.on_any(capture_event)
    await listener.start()

    print("   ✅ Subscribed to postgres_changes")

    # Step 3: Insert an event directly
    print("\n✍️  Inserting test event...")
    await asyncio.sleep(2)  # Let subscription stabilize

    async with httpx.AsyncClient() as http:
        # Insert event
        event_response = await http.post(
            f"{supabase_url}/rest/v1/rpc/record_event_with_recipients",
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {service_role_key}",
                "Content-Type": "application/json"
            },
            json={
                "p_event_type": "test.manual",
                "p_direction": "event_out",
                "p_scope": "direct",
                "p_actor_character_id": test_char_id,
                "p_payload": {"message": "test event"},
                "p_recipients": [test_char_id],
                "p_reasons": ["test"],
                "p_is_broadcast": False
            }
        )
        if event_response.status_code not in (200, 201):
            print(f"❌ Failed to insert event: {event_response.status_code} {event_response.text}")
        else:
            event_id = event_response.json()
            print(f"   ✅ Event inserted: {event_id}")

    # Step 4: Wait for delivery
    print("\n⏳ Waiting 5 seconds for postgres_changes delivery...")
    await asyncio.sleep(5)

    # Step 5: Check results
    print(f"\n📊 Results:")
    print(f"   Events received via postgres_changes: {len(events_received)}")

    if len(events_received) > 0:
        print(f"   ✅ SUCCESS! Cloud postgres_changes is working!")
        for event_name, _ in events_received:
            print(f"     - {event_name}")
    else:
        print(f"   ❌ No events received via postgres_changes")
        print(f"   (But event was inserted - check database directly)")

    await listener.stop()


if __name__ == "__main__":
    asyncio.run(main())
