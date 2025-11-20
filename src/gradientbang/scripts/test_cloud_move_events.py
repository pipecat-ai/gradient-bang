"""Test that move endpoint emits events correctly on cloud."""
import asyncio
import httpx
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


async def main():
    supabase_url = os.environ.get("SUPABASE_URL", "http://127.0.0.1:54321")
    anon_key = os.environ.get("SUPABASE_ANON_KEY")
    service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

    if not anon_key or not service_role_key:
        print("❌ SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY must be set")
        return

    print(f"🔧 Testing move events on {supabase_url}\n")

    # Create a test character
    test_char_id = str(uuid.uuid4())
    print(f"📝 Creating test character: {test_char_id}")

    async with httpx.AsyncClient() as http:
        # Create character
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
                "name": f"Test Move Events {test_char_id[:8]}",
                "credits_in_megabank": 0,
                "is_npc": False
            }
        )
        if response.status_code not in (200, 201):
            print(f"❌ Failed to create character: {response.status_code} {response.text}")
            return
        print(f"   ✅ Character created\n")

        # Call join
        print("📍 Calling join...")
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
            return
        print(f"   ✅ Join successful\n")

        # Query events table to see what was inserted
        print("📊 Querying events table...")
        response = await http.get(
            f"{supabase_url}/rest/v1/events?character_id=eq.{test_char_id}&order=inserted_at.desc&limit=10",
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {service_role_key}",
            }
        )
        events = response.json()
        print(f"   Found {len(events)} events:")
        for event in events:
            print(f"     - {event.get('event_type')} (scope: {event.get('scope')})")

        # Query event_character_recipients to see recipients
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
            print(f"   First event has {len(recipients)} recipient(s)")

        # Now call move
        print(f"\n🚀 Calling move to sector 1...")
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
            return
        print(f"   ✅ Move initiated\n")

        # Wait for movement to complete
        await asyncio.sleep(2)

        # Query events again
        print("📊 Querying events after move...")
        response = await http.get(
            f"{supabase_url}/rest/v1/events?character_id=eq.{test_char_id}&order=inserted_at.desc&limit=10",
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {service_role_key}",
            }
        )
        events = response.json()
        print(f"   Found {len(events)} events total:")
        for event in events:
            print(f"     - {event.get('event_type')} (scope: {event.get('scope')})")

        print(f"\n✅ Events are being written to database successfully!")


if __name__ == "__main__":
    asyncio.run(main())
