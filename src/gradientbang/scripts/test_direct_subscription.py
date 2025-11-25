"""Test direct subscription to postgres_changes without AsyncGameClient wrapper."""
import asyncio
import os
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from realtime import AsyncRealtimeClient
from datetime import datetime, timezone


async def main():
    supabase_url = os.environ.get("SUPABASE_URL", "http://127.0.0.1:54321")
    anon_key = os.environ.get("SUPABASE_ANON_KEY", "anon-key")

    # Get JWT for a test character
    import httpx
    character_id = "9169fd3c-887e-519c-a4ab-db8c4ebedcaf"

    print(f"🔐 Getting character JWT for {character_id}")
    async with httpx.AsyncClient() as http:
        response = await http.post(
            f"{supabase_url}/functions/v1/get_character_jwt",
            headers={
                "Content-Type": "application/json",
                "apikey": anon_key,
                "Authorization": f"Bearer {anon_key}",
                "X-API-Token": os.environ.get("SUPABASE_SERVICE_ROLE_KEY"),
            },
            json={"character_id": character_id},
        )
        jwt_data = response.json()
        character_jwt = jwt_data.get("jwt")
        print(f"   JWT obtained: {character_jwt[:50]}...")

    print(f"\n📡 Creating Realtime client")
    client = AsyncRealtimeClient(
        url=f"{supabase_url}/realtime/v1",
        token=anon_key,
        auto_reconnect=True,
    )

    # Set auth with character JWT
    print(f"🔑 Setting auth with character JWT")
    await client.set_auth(character_jwt)

    events_received = []

    def handle_postgres_change(payload):
        print(f"\n✅ POSTGRES CHANGE RECEIVED!")
        print(f"   Type: {type(payload)}")
        print(f"   Keys: {list(payload.keys()) if isinstance(payload, dict) else 'N/A'}")
        print(f"   Payload: {json.dumps(payload, indent=2, default=str)}")
        events_received.append(payload)

    print(f"\n📺 Creating channel and subscribing to postgres_changes")
    channel = client.channel("test-events-channel")
    channel.on_postgres_changes(
        event="INSERT",
        schema="public",
        table="events",
        callback=handle_postgres_change,
    )

    subscribe_complete = asyncio.Event()

    def state_callback(state, error):
        print(f"   Channel state: {state}")
        if error:
            print(f"   Error: {error}")
        if str(state) == "RealtimeSubscribeStates.SUBSCRIBED":
            subscribe_complete.set()

    await channel.subscribe(callback=state_callback)

    print(f"⏳ Waiting for subscription to complete...")
    try:
        await asyncio.wait_for(subscribe_complete.wait(), timeout=10)
        print(f"   ✓ Subscription complete!")
    except asyncio.TimeoutError:
        print(f"   ✗ Subscription timed out!")
        await client.close()
        return

    print(f"\n⏳ Waiting 2 seconds for connection to stabilize...")
    await asyncio.sleep(2)

    print(f"\n🚀 Now manually insert an event in another terminal:")
    print(f"   docker exec supabase_db_gb-supa psql -U postgres -d postgres -c \"")
    print(f"     INSERT INTO events (event_type, payload, scope, inserted_at) ")
    print(f"     VALUES ('test.manual', '{{}}', 'direct', NOW()) RETURNING id;")
    print(f"   \"")
    print(f"\n   And insert recipient:")
    print(f"   docker exec supabase_db_gb-supa psql -U postgres -d postgres -c \"")
    print(f"     INSERT INTO event_character_recipients (event_id, character_id, reason) ")
    print(f"     VALUES ((SELECT MAX(id) FROM events), '{character_id}', 'test');")
    print(f"   \"")

    print(f"\n⏳ Listening for 30 seconds...")
    await asyncio.sleep(30)

    print(f"\n📊 Results:")
    print(f"   Events received: {len(events_received)}")

    await client.close()
    print(f"\n🔌 Client closed")


if __name__ == "__main__":
    asyncio.run(main())
