#!/usr/bin/env python3
"""Admin helper for creating new characters via RPC."""

from __future__ import annotations

import argparse
import asyncio
import getpass
from pathlib import Path
import sys
from typing import Any, Dict, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "game-server"))

from core.character_registry import CharacterRegistry
from core.config import get_world_data_path
from ships import ShipType
from utils.api_client import AsyncGameClient, RPCError


def _prompt(message: str) -> str:
    """Read a line from stdin and strip whitespace."""
    try:
        return input(message).strip()
    except EOFError:
        return ""


def _prompt_int(message: str) -> int | None:
    """Prompt until the user enters a valid integer or blank."""
    while True:
        raw = _prompt(message)
        if raw == "":
            return None
        try:
            return int(raw)
        except ValueError:
            print("Please enter a valid integer or leave blank to skip.")


def _prompt_cargo() -> Dict[str, int]:
    """Prompt for a comma-separated cargo manifest."""
    while True:
        raw = _prompt(
            "Cargo manifest (comma separated name=qty, leave blank for none): "
        )
        if raw == "":
            return {}
        manifest: Dict[str, int] = {}
        parts = [part.strip() for part in raw.split(",") if part.strip()]
        valid = True
        for part in parts:
            if "=" not in part:
                print("Cargo entries must be formatted as commodity=amount.")
                valid = False
                break
            name, qty = (piece.strip() for piece in part.split("=", 1))
            if not name:
                print("Commodity name cannot be empty.")
                valid = False
                break
            try:
                manifest[name] = int(qty)
            except ValueError:
                print(f"Quantity for {name!r} must be an integer.")
                valid = False
                break
        if valid:
            return manifest


def _collect_player_payload() -> Dict[str, Any]:
    payload: Dict[str, Any] = {}
    credits = _prompt_int("Starting credits (leave blank for default): ")
    if credits is not None:
        payload["credits"] = credits

    player_type = _prompt("Player type (leave blank to skip): ")
    if player_type:
        payload["player_type"] = player_type
    return payload


def _collect_ship_payload() -> Dict[str, Any]:
    payload: Dict[str, Any] = {}
    ship_name = _prompt("Ship name (leave blank to skip): ")
    if ship_name:
        payload["ship_name"] = ship_name

    ship_type_choices = ", ".join(st.value for st in ShipType)
    ship_type = _prompt(
        f"Ship type ({ship_type_choices}) [blank for default kestrel]: "
    )
    if ship_type:
        payload["ship_type"] = ship_type.strip().lower()

    warp_power = _prompt_int("Current warp power (leave blank to skip): ")
    if warp_power is not None:
        payload["current_warp_power"] = warp_power

    shields = _prompt_int("Current shields (leave blank to skip): ")
    if shields is not None:
        payload["current_shields"] = shields

    fighters = _prompt_int("Current fighters (leave blank to skip): ")
    if fighters is not None:
        payload["current_fighters"] = fighters

    cargo = _prompt_cargo()
    if cargo:
        payload["cargo"] = cargo

    return payload


def _admin_password_required() -> bool:
    """Return True if the registry currently requires an admin password."""
    registry_path = get_world_data_path() / "characters.json"
    registry = CharacterRegistry(registry_path)
    try:
        registry.load()
    except Exception:
        # Fail closed if the registry is unreadable
        return True
    return bool(registry.admin_password_plain or registry.password_hash)


async def _execute_create_request(
    client: AsyncGameClient,
    *,
    name: str,
    player: Optional[Dict[str, Any]],
    ship: Optional[Dict[str, Any]],
    admin_password: Optional[str],
    password_required: bool,
) -> Dict[str, Any]:
    """Attempt character creation, prompting for password only if the server demands it."""

    password = admin_password
    require_flag = password_required

    while True:
        try:
            return await client.character_create(
                admin_password=password,
                name=name,
                player=player,
                ship=ship,
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


async def main() -> int:
    parser = argparse.ArgumentParser(description="Create a character via admin RPC.")
    parser.add_argument(
        "--server",
        default="http://localhost:8000",
        help="Server base URL (default: %(default)s)",
    )
    parser.add_argument(
        "--client-id",
        default="admin-tool",
        help="Identifier for this admin client (default: %(default)s)",
    )
    parser.add_argument(
        "--name",
        help="Display name for the new character (prompted if omitted)",
    )
    parser.add_argument(
        "--admin-password",
        help="Admin password (prompted if required and not provided)",
    )
    args = parser.parse_args()

    name = args.name or _prompt("Display name: ")
    if not name:
        print("Character name is required.")
        return 1

    password_required = _admin_password_required()
    admin_password = args.admin_password
    if password_required:
        admin_password = admin_password or getpass.getpass("Admin password: ")
        if not admin_password:
            print("Admin password is required.")
            return 1

    print("Collecting optional player fields (press Enter to skip each).")
    player_payload = _collect_player_payload()
    print("Collecting optional ship fields (press Enter to skip each).")
    ship_payload = _collect_ship_payload()

    try:
        async with AsyncGameClient(
            base_url=args.server,
            character_id=args.client_id,
        ) as client:
            await client.identify(character_id=args.client_id)
            result = await _execute_create_request(
                client,
                name=name,
                player=player_payload or None,
                ship=ship_payload or None,
                admin_password=admin_password,
                password_required=password_required,
            )
    except RPCError as exc:
        print(f"Character creation failed: {exc}")
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"Unexpected error: {exc}")
        return 1

    print("✓ Character created successfully.")
    print(f"  Name: {result.get('name')}")
    print(f"  Character ID: {result.get('character_id')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
