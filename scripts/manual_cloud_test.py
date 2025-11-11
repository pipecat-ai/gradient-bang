"""Manual cloud test for join and move event emission."""
import asyncio
import httpx
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from utils.supabase_realtime import SupabaseRealtimeListener


async def main():
    supabase_url = os.environ.get("SUPABASE_URL")
    anon_key = os.environ.get("SUPABASE_ANON_KEY")
    service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

    if not all([supabase_url, anon_key, service_role_key]):
        print("❌ Required env vars: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY")
        return

    print(f"🔧 Manual Cloud Test - {supabase_url}\n")
    print("=" * 80)

    # Step 1: Get existing character from database
    print("\n📋 Step 1: Query existing characters...")
    async with httpx.AsyncClient(timeout=10.0) as http:
        response = await http.get(
            f"{supabase_url}/rest/v1/characters?limit=1",
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {service_role_key}",
            }
        )
        if response.status_code != 200:
            print(f"❌ Query failed: {response.status_code} {response.text}")
            return
        characters = response.json()
        if not characters:
            print(f"❌ No characters found in database")
            return

        test_char_id = characters[0]["character_id"]
        test_char_name = characters[0]["name"]
        print(f"   ✅ Found character: {test_char_name} (id: {test_char_id[:8]}...)")
        print(f"   Using character: {test_char_id}")

    # Step 2: Get JWT for character
    print(f"\n🔐 Step 2: Get character JWT...")
    async with httpx.AsyncClient(timeout=10.0) as http:
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
        if response.status_code != 200:
            print(f"❌ JWT generation failed: {response.status_code} {response.text}")
            return
        jwt_data = response.json()
        if not jwt_data.get("success"):
            print(f"❌ JWT error: {jwt_data}")
            return
        character_jwt = jwt_data["jwt"]
        print(f"   ✅ JWT obtained")

    # Step 3: Setup realtime listener
    print(f"\n📡 Step 3: Setup postgres_changes listener...")
    events_received = []

    listener = SupabaseRealtimeListener(
        supabase_url=supabase_url,
        anon_key=anon_key,
        topic="public:events",
        schema="public",
        table="events",
        access_token=character_jwt,
    )

    def on_event(event_name: str, payload: dict):
        events_received.append({"event_name": event_name, "payload": payload, "received_at": datetime.now(timezone.utc).isoformat()})
        print(f"   🎉 Realtime event: {event_name}")

    listener.on_any(on_event)
    await listener.start()
    print(f"   ✅ Listening to postgres_changes")
    await asyncio.sleep(1)  # Let subscription stabilize

    # Step 4: Call join
    print(f"\n📍 Step 4: Call join endpoint...")
    async with httpx.AsyncClient(timeout=10.0) as http:
        response = await http.post(
            f"{supabase_url}/functions/v1/join",
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {service_role_key}",
                "X-API-Token": service_role_key,
                "Content-Type": "application/json"
            },
            json={"character_id": test_char_id}
        )
        if response.status_code != 200:
            print(f"❌ Join failed: {response.status_code} {response.text}")
            await listener.stop()
            return
        join_result = response.json()
        print(f"   ✅ Join successful: {join_result.get('success')}")

    await asyncio.sleep(2)  # Wait for events

    # Step 5: Query events table
    print(f"\n📊 Step 5: Query events table...")
    async with httpx.AsyncClient(timeout=10.0) as http:
        response = await http.get(
            f"{supabase_url}/rest/v1/events?character_id=eq.{test_char_id}&order=inserted_at.desc&limit=20",
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {service_role_key}",
            }
        )
        events = response.json()
        print(f"   Found {len(events)} events:")
        for event in events[:5]:
            print(f"     - {event.get('event_type')} (scope: {event.get('scope')}, id: {event.get('id')})")

        # Check recipients for first event
        if events:
            event_id = events[0]["id"]
            response = await http.get(
                f"{supabase_url}/rest/v1/event_character_recipients?event_id=eq.{event_id}",
                headers={
                    "apikey": anon_key,
                    "Authorization": f"Bearer {service_role_key}",
                }
            )
            recipients = response.json()
            print(f"   Event {event_id} has {len(recipients)} recipient(s)")

    # Step 6: Call move
    print(f"\n🚀 Step 6: Call move endpoint...")
    async with httpx.AsyncClient(timeout=10.0) as http:
        response = await http.post(
            f"{supabase_url}/functions/v1/move",
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {service_role_key}",
                "X-API-Token": service_role_key,
                "Content-Type": "application/json"
            },
            json={"character_id": test_char_id, "to_sector": 1}
        )
        if response.status_code != 200:
            print(f"❌ Move failed: {response.status_code} {response.text}")
            await listener.stop()
            return
        move_result = response.json()
        print(f"   ✅ Move initiated: {move_result.get('success')}")

    await asyncio.sleep(3)  # Wait for movement completion + events

    # Step 7: Query events again
    print(f"\n📊 Step 7: Query events after move...")
    async with httpx.AsyncClient(timeout=10.0) as http:
        response = await http.get(
            f"{supabase_url}/rest/v1/events?character_id=eq.{test_char_id}&order=inserted_at.desc&limit=20",
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {service_role_key}",
            }
        )
        events = response.json()
        print(f"   Found {len(events)} events total:")
        event_types = {}
        for event in events:
            event_type = event.get('event_type')
            event_types[event_type] = event_types.get(event_type, 0) + 1
        for event_type, count in sorted(event_types.items()):
            print(f"     - {event_type}: {count}")

    # Step 8: Check realtime delivery
    print(f"\n📡 Step 8: Realtime delivery summary...")
    print(f"   Events received via postgres_changes: {len(events_received)}")
    if events_received:
        print(f"   Event types received:")
        for event in events_received:
            print(f"     - {event['event_name']} at {event['received_at']}")

    await listener.stop()

    # Final verdict
    print(f"\n{'='*80}")
    print(f"📋 Test Summary:")
    print(f"   Database events: {len(events)} ✅")
    print(f"   Realtime events: {len(events_received)} {'✅' if len(events_received) > 0 else '❌'}")
    print(f"   Expected: movement.start, movement.complete, map.local, status.snapshot")

    if len(events_received) >= 4:
        print(f"\n✅ SUCCESS! Events are being emitted AND delivered via postgres_changes")
    elif len(events) >= 4:
        print(f"\n⚠️  PARTIAL: Events written to DB but realtime delivery may need investigation")
    else:
        print(f"\n❌ FAIL: Not enough events generated")


if __name__ == "__main__":
    asyncio.run(main())
