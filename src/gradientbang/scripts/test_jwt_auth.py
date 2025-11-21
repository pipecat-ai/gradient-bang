"""Test if custom JWT is recognized by Supabase Auth."""
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

    print(f"🔧 Testing custom JWT auth on {supabase_url}\n")

    # Step 1: Create a test character
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
                "name": f"Test JWT Auth {test_char_id[:8]}",
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
        print(f"   JWT (first 50 chars): {character_jwt[:50]}...\n")

        # Step 3: Test auth.uid() with custom JWT
        print("🔍 Testing auth.uid() with custom JWT...")
        response = await http.post(
            f"{supabase_url}/rest/v1/rpc/jwt_claim",
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {character_jwt}",
                "Content-Type": "application/json"
            },
            json={"claim_name": "sub"}
        )

        if response.status_code != 200:
            print(f"❌ RPC failed: {response.status_code} {response.text}")
            return

        sub_claim = response.json()
        print(f"   sub claim: {sub_claim}")

        if sub_claim == test_char_id:
            print(f"   ✅ JWT is valid! auth.uid() returns: {sub_claim}")
        else:
            print(f"   ❌ JWT validation issue. Expected {test_char_id}, got {sub_claim}")

        # Step 4: Test a simple query with the JWT
        print("\n🔍 Testing authenticated query...")
        response = await http.get(
            f"{supabase_url}/rest/v1/characters?character_id=eq.{test_char_id}",
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {character_jwt}",
            }
        )

        if response.status_code == 200:
            print(f"   ✅ Authenticated query succeeded")
        else:
            print(f"   ❌ Authenticated query failed: {response.status_code}")


if __name__ == "__main__":
    asyncio.run(main())
