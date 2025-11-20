#!/usr/bin/env python3
"""Interactive admin tool to modify character properties."""

from __future__ import annotations

import argparse
import asyncio
import getpass
<<<<<<< HEAD:scripts/character_modify.py
import os
from pathlib import Path
=======
>>>>>>> main:src/gradientbang/scripts/character_modify.py
import sys
from typing import Any, Dict, Optional

from gradientbang.game_server.core.character_registry import CharacterRegistry
from gradientbang.game_server.ships import ShipType
from gradientbang.utils.api_client import AsyncGameClient, RPCError
from gradientbang.utils.config import get_world_data_path


def _prompt(text: str) -> str:
    try:
        return input(text).strip()
    except EOFError:
        return ""


def _collect_payload() -> Dict[str, Any]:
    payload: Dict[str, Any] = {}
    name = _prompt("New display name (leave blank to keep current): ")
    if name:
        payload["name"] = name

    player: Dict[str, Any] = {}
    credits = _prompt("Credits (leave blank to skip): ")
    if credits:
        player["credits"] = int(credits)
    if player:
        payload["player"] = player

    ship: Dict[str, Any] = {}
    ship_name = _prompt("Ship name (leave blank to skip): ")
    if ship_name:
        ship["ship_name"] = ship_name
    ship_type = _prompt(f"Ship type {list(st.value for st in ShipType)} (leave blank to skip): ")
    if ship_type:
        ship["ship_type"] = ship_type.lower()
    fighters = _prompt("Current fighters (leave blank to skip): ")
    if fighters:
        ship["current_fighters"] = int(fighters)
    shields = _prompt("Current shields (leave blank to skip): ")
    if shields:
        ship["current_shields"] = int(shields)
    warp = _prompt("Current warp power (leave blank to skip): ")
    if warp:
        ship["current_warp_power"] = int(warp)
    if ship:
        payload["ship"] = ship

    return payload


def _admin_password_required() -> bool:
    registry_path = get_world_data_path() / "characters.json"
    registry = CharacterRegistry(registry_path)
    try:
        registry.load()
    except Exception:
        return True
    return bool(registry.admin_password_plain or registry.password_hash)


async def _execute_modify_request(
    client: AsyncGameClient,
    *,
    character_id: str,
    payload: Dict[str, Any],
    admin_password: Optional[str],
    password_required: bool,
) -> Dict[str, Any]:
    password = admin_password
    require_flag = password_required

    while True:
        try:
            return await client.character_modify(
                admin_password=password,
                character_id=character_id,
                name=payload.get("name"),
                player=payload.get("player"),
                ship=payload.get("ship"),
            )
        except RPCError as exc:
            if (
                not require_flag
                and password is None
                and getattr(exc, "status", None) == 403
            ):
                print(
                    "Server rejected the request because an admin password is required."
                )
                password = getpass.getpass("Admin password: ")
                if not password:
                    raise
                require_flag = True
                continue
            raise


async def main_async() -> int:
    parser = argparse.ArgumentParser(description="Modify character properties via RPC.")
    parser.add_argument("--server", default="http://localhost:8000", help="Server base URL (default: %(default)s)")
    parser.add_argument("--character-id", help="Character UUID to modify")
    parser.add_argument("--client-id", default="admin-tool", help="Identifier to register this admin connection")
    parser.add_argument("--admin-password", help="Admin password (prompted if required and not provided)")
    parser.add_argument(
        "--supabase",
        action="store_true",
        help="Force Supabase admin mode (default when SUPABASE_URL is set)",
    )
    parser.add_argument(
        "--legacy",
        action="store_true",
        help="Force legacy FastAPI RPC mode",
    )
    args = parser.parse_args()

    character_id = args.character_id or _prompt("Character UUID: ")
    if not character_id:
        print("Character ID is required.")
        return 1

    payload = _collect_payload()
    if not payload:
        print("No changes specified; aborting.")
        return 0

    use_supabase = _should_use_supabase_mode(args)
    if use_supabase:
        os.environ.setdefault("SUPABASE_ALLOW_LEGACY_IDS", "1")
        return await _modify_via_supabase(character_id, payload)

    password_required = _admin_password_required()
    admin_password = args.admin_password
    if password_required:
        admin_password = admin_password or getpass.getpass("Admin password: ")
        if not admin_password:
            print("Admin password is required.")
            return 1

    try:
        async with AsyncGameClient(base_url=args.server, character_id=args.client_id) as client:
            await client.identify(character_id=args.client_id)
            result = await _execute_modify_request(
                client,
                character_id=character_id,
                payload=payload,
                admin_password=admin_password,
                password_required=password_required,
            )
    except RPCError as exc:
        print(f"Update failed: {exc}")
        return 1
    print("Update complete:", result)
    return 0


<<<<<<< HEAD:scripts/character_modify.py
def _should_use_supabase_mode(args: argparse.Namespace) -> bool:
    if args.legacy:
        return False
    if args.supabase:
        return True
    return bool(os.getenv("SUPABASE_URL"))


async def _modify_via_supabase(character_id: str, payload: Dict[str, Any]) -> int:
    try:
        from gradientbang.utils.supabase_admin import SupabaseAdminClient, SupabaseAdminError
    except ImportError as exc:  # pragma: no cover - dependency missing
        print(f"Supabase admin helpers unavailable: {exc}")
        return 1

    try:
        async with SupabaseAdminClient() as admin:
            result = await admin.modify_character(
                character_id=character_id,
                name=payload.get("name"),
                player=payload.get("player"),
                ship=payload.get("ship"),
            )
    except SupabaseAdminError as exc:
        print(f"Supabase character update failed: {exc}")
        return 1

    print("✓ Supabase character updated.")
    if result.get("character"):
        print(f"  Name: {result['character'].get('name')}")
    if result.get("ship"):
        ship = result["ship"]
        print(f"  Ship: {ship.get('ship_id')} ({ship.get('ship_type')})")
    return 0
=======
def main() -> None:
    raise SystemExit(asyncio.run(main_async()))
>>>>>>> main:src/gradientbang/scripts/character_modify.py


if __name__ == "__main__":
    main()
