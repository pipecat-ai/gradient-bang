"""Test postgres_changes callback directly."""
import asyncio
import httpx
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from realtime import AsyncRealtimeClient


async def main():
    supabase_url = os.environ.get("SUPABASE_URL", "http://127.0.0.1:54321")
    anon_key = os.environ.get("SUPABASE_ANON_KEY")
    service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

    print(f"🔧 Testing direct callback on {supabase_url}\n")

    # Create character and get JWT
    test_char_id = str(uuid.uuid4())
    async with httpx.AsyncClient() as http:
        await http.post(
            f"{supabase_url}/rest/v1/characters",
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {service_role_key}",
                "Content-Type": "application/json",
            },
            json={
                "character_id": test_char_id,
                "name": f"Callback Test {test_char_id[:8]}",
                "credits_in_megabank": 0,
                "is_npc": False
            }
        )

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
        character_jwt = response.json()["jwt"]

    print("✅ Setup complete\n")

    # Create realtime client and channel
    print("📡 Setting up realtime...")
    event_count = [0]

    def my_callback(payload):
        event_count[0] += 1
        print(f"\n🎉 CALLBACK INVOKED! Event #{event_count[0]}")
        print(f"   Payload type: {type(payload)}")
        print(f"   Payload keys: {list(payload.keys()) if isinstance(payload, dict) else 'not a dict'}")
        if isinstance(payload, dict):
            data = payload.get("data", {})
            if isinstance(data, dict):
                record = data.get("record", {})
                print(f"   Event type: {record.get('event_type', 'unknown')}")
                print(f"   Message: {record.get('payload', {}).get('message', 'no message')}")
        print()

    client = AsyncRealtimeClient(
        url=f"{supabase_url}/realtime/v1",
        token=anon_key,
        auto_reconnect=True,
    )

    await client.set_auth(character_jwt)

    channel = client.channel("public:events")
    channel.on_postgres_changes(
        event="INSERT",
        schema="public",
        table="events",
        callback=my_callback,
    )

    print("Subscribing...")
    await channel.subscribe()
    print("✅ Subscribed\n")

    # Wait for subscription
    await asyncio.sleep(2)

    # Insert event
    print("✍️  Inserting event...")
    async with httpx.AsyncClient() as http:
        response = await http.post(
            f"{supabase_url}/rest/v1/rpc/record_event_with_recipients",
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {service_role_key}",
                "Content-Type": "application/json"
            },
            json={
                "p_event_type": "test.callback_direct",
                "p_direction": "event_out",
                "p_scope": "direct",
                "p_actor_character_id": test_char_id,
                "p_payload": {"message": "Direct callback test!"},
                "p_recipients": [test_char_id],
                "p_reasons": ["test"],
                "p_is_broadcast": False
            }
        )
        event_id = response.json()
        print(f"✅ Event inserted: {event_id}\n")

    # Wait
    print("⏳ Waiting 5 seconds...\n")
    await asyncio.sleep(5)

    # Results
    print(f"📊 Callbacks invoked: {event_count[0]}")
    if event_count[0] > 0:
        print("   ✅ SUCCESS!")
    else:
        print("   ❌ Callback never invoked")

    await channel.unsubscribe()
    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
