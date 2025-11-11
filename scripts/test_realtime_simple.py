"""Ultra-simple postgres_changes test."""
import asyncio
import httpx
import os
import sys
import uuid
import logging

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

from utils.supabase_realtime import SupabaseRealtimeListener


async def main():
    supabase_url = os.environ.get("SUPABASE_URL", "http://127.0.0.1:54321")
    anon_key = os.environ.get("SUPABASE_ANON_KEY")
    service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

    logger.info(f"🔧 Testing on {supabase_url}\n")

    # Create character
    test_char_id = str(uuid.uuid4())
    async with httpx.AsyncClient() as http:
        response = await http.post(
            f"{supabase_url}/rest/v1/characters",
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {service_role_key}",
                "Content-Type": "application/json",
            },
            json={
                "character_id": test_char_id,
                "name": f"Simple Test {test_char_id[:8]}",
                "credits_in_megabank": 0,
                "is_npc": False
            }
        )
        if response.status_code not in (200, 201):
            logger.error(f"❌ Create character failed: {response.text}")
            return

        # Get JWT
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
            logger.error(f"❌ JWT failed: {jwt_data}")
            return
        character_jwt = jwt_data["jwt"]

    logger.info("✅ Setup complete\n")

    # Subscribe
    logger.info("📡 Subscribing...")
    event_count = [0]  # Use list to allow modification in callback

    def on_event(name, payload):
        event_count[0] += 1
        logger.info(f"   🎉 EVENT #{event_count[0]}: {name}")
        logger.info(f"      Message: {payload.get('message', 'no message')}")

    listener = SupabaseRealtimeListener(
        supabase_url=supabase_url,
        anon_key=anon_key,
        topic="public:events",
        schema="public",
        table="events",
        access_token=character_jwt,
    )
    listener.on_any(on_event)

    await listener.start()
    logger.info("✅ Subscribed\n")

    # Wait for subscription to stabilize
    await asyncio.sleep(2)

    # Insert event
    logger.info("✍️  Inserting event...")
    async with httpx.AsyncClient() as http:
        response = await http.post(
            f"{supabase_url}/rest/v1/rpc/record_event_with_recipients",
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {service_role_key}",
                "Content-Type": "application/json"
            },
            json={
                "p_event_type": "test.simple",
                "p_direction": "event_out",
                "p_scope": "direct",
                "p_actor_character_id": test_char_id,
                "p_payload": {"message": "Hello from simple test!"},
                "p_recipients": [test_char_id],
                "p_reasons": ["test"],
                "p_is_broadcast": False
            }
        )
        event_id = response.json()
        logger.info(f"✅ Event inserted: {event_id}\n")

    # Wait for delivery
    logger.info("⏳ Waiting 5 seconds...\n")
    await asyncio.sleep(5)

    # Results
    logger.info(f"📊 Events received: {event_count[0]}")
    if event_count[0] > 0:
        logger.info("   ✅ SUCCESS!")
    else:
        logger.info("   ❌ No events received")

    await listener.stop()


if __name__ == "__main__":
    asyncio.run(main())
