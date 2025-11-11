"""Debug postgres_changes delivery with detailed logging."""
import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from utils.supabase_realtime import SupabaseRealtimeListener
from realtime import RealtimeSubscribeStates


async def main():
    supabase_url = os.environ.get("SUPABASE_URL", "http://127.0.0.1:54321")
    anon_key = os.environ.get("SUPABASE_ANON_KEY")
    service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

    if not anon_key or not service_role_key:
        print("❌ SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY must be set")
        return

    print(f"🔧 Testing postgres_changes on {supabase_url}\n")

    # Step 1: Create a test character
    import httpx
    test_char_id = str(uuid.uuid4())
    print(f"📝 Creating test character: {test_char_id}")

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
                "name": f"Test Realtime Debug {test_char_id[:8]}",
                "credits_in_megabank": 0,
                "is_npc": False
            }
        )
        if response.status_code not in (200, 201):
            print(f"❌ Failed to create character: {response.status_code} {response.text}")
            return
        print(f"   ✅ Character created\n")

        # Step 2: Get character JWT
        print("🔐 Getting character JWT...")
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
        print(f"   ✅ JWT obtained\n")

    # Step 3: Create realtime subscription with status monitoring
    print("📡 Creating realtime subscription...")
    events_received = []
    subscription_states = []

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
        print(f"      Payload keys: {list(payload.keys())}")
        events_received.append((event_name, payload))

    def capture_status(state: RealtimeSubscribeStates, error):
        print(f"   📊 Subscription state: {state}")
        if error:
            print(f"      Error: {error}")
        subscription_states.append((state, error))

    listener.on_any(capture_event)
    listener.add_status_handler(capture_status)

    await listener.start()
    print("   ✅ Subscribed to postgres_changes\n")

    # Step 4: Verify the subscription can see the event
    print("🔍 Testing if character can see events via RLS...")
    async with httpx.AsyncClient() as http:
        # First, insert a test event
        event_response = await http.post(
            f"{supabase_url}/rest/v1/rpc/record_event_with_recipients",
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {service_role_key}",
                "Content-Type": "application/json"
            },
            json={
                "p_event_type": "test.rls_check",
                "p_direction": "event_out",
                "p_scope": "direct",
                "p_actor_character_id": test_char_id,
                "p_payload": {"message": "RLS test"},
                "p_recipients": [test_char_id],
                "p_reasons": ["test"],
                "p_is_broadcast": False
            }
        )
        if event_response.status_code not in (200, 201):
            print(f"   ❌ Failed to insert event: {event_response.status_code} {event_response.text}")
        else:
            event_id = event_response.json()
            print(f"   ✅ Event inserted: {event_id}")

            # Query events table with character JWT to verify RLS
            await asyncio.sleep(0.5)
            query_response = await http.get(
                f"{supabase_url}/rest/v1/events?id=eq.{event_id}",
                headers={
                    "apikey": anon_key,
                    "Authorization": f"Bearer {character_jwt}",
                }
            )
            if query_response.status_code == 200:
                events = query_response.json()
                print(f"   ✅ Character can query event via RLS: {len(events)} rows")
                if len(events) > 0:
                    print(f"      Event: {events[0].get('event_type')}")
            else:
                print(f"   ❌ Query failed: {query_response.status_code} {query_response.text}")

    print()

    # Step 5: Insert another event and wait for delivery
    print("✍️  Inserting event for postgres_changes test...")
    await asyncio.sleep(2)  # Let subscription stabilize

    async with httpx.AsyncClient() as http:
        event_response = await http.post(
            f"{supabase_url}/rest/v1/rpc/record_event_with_recipients",
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {service_role_key}",
                "Content-Type": "application/json"
            },
            json={
                "p_event_type": "test.postgres_changes",
                "p_direction": "event_out",
                "p_scope": "direct",
                "p_actor_character_id": test_char_id,
                "p_payload": {"message": "postgres_changes test"},
                "p_recipients": [test_char_id],
                "p_reasons": ["test"],
                "p_is_broadcast": False
            }
        )
        if event_response.status_code not in (200, 201):
            print(f"❌ Failed to insert event: {event_response.status_code} {event_response.text}")
        else:
            event_id = event_response.json()
            print(f"   ✅ Event inserted: {event_id}\n")

    # Step 6: Wait for delivery
    print("⏳ Waiting 10 seconds for postgres_changes delivery...")
    await asyncio.sleep(10)

    # Step 7: Check results
    print(f"\n📊 Results:")
    print(f"   Subscription states: {len(subscription_states)}")
    for state, error in subscription_states:
        print(f"     - {state}" + (f" (error: {error})" if error else ""))
    print(f"   Events received via postgres_changes: {len(events_received)}")

    if len(events_received) > 0:
        print(f"   ✅ SUCCESS! Cloud postgres_changes is working!")
        for event_name, payload in events_received:
            print(f"     - {event_name}: {payload.get('message', 'no message')}")
    else:
        print(f"   ❌ No events received via postgres_changes")

    await listener.stop()


if __name__ == "__main__":
    import logging
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    )
    asyncio.run(main())
