#!/usr/bin/env python3
"""CI smoke script that exercises Supabase admin helpers end-to-end."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "game-server"))

os.environ.setdefault("SUPABASE_ALLOW_LEGACY_IDS", "1")

from utils.api_client import RPCError
from utils.supabase_client import AsyncGameClient
from utils.supabase_admin import SupabaseAdminClient, SupabaseAdminError


async def run_smoke(name_prefix: str, sector: int) -> None:
    character_name = f"{name_prefix}-{uuid.uuid4().hex[:8]}"
    async with SupabaseAdminClient() as admin:
        created = await admin.create_character(
            name=character_name,
            player={"player_type": "ci_smoke", "credits": 40000},
            ship={"ship_name": f"{character_name}-ship"},
            start_sector=sector,
        )
        character = created["character"]
        ship = created["ship"]
        character_id = character["character_id"]
        ship_id = ship["ship_id"]
        try:
            async with AsyncGameClient(character_id=character_id) as client:
                await client.join(character_id=character_id, sector=sector)
                await client.my_status(character_id=character_id)
            await admin.modify_character(
                character_id=character_id,
                name=f"{character_name}-renamed",
                player={"credits": 45000},
                ship={"ship_name": f"{character_name}-upgraded", "current_fighters": 310},
            )
        finally:
            await admin.delete_character(character_id)
        print(
            "Smoke test succeeded:",
            {
                "character_id": character_id,
                "ship_id": ship_id,
            },
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Supabase admin smoke test")
    parser.add_argument(
        "--name-prefix",
        default="ci-smoke",
        help="Prefix for the temporary character name (default: %(default)s)",
    )
    parser.add_argument(
        "--sector",
        type=int,
        default=0,
        help="Sector used for the smoke character (default: %(default)s)",
    )
    return parser.parse_args()


async def _async_main() -> int:
    args = parse_args()
    if args.sector < 0:
        print("Sector must be non-negative", file=sys.stderr)
        return 1
    try:
        await run_smoke(args.name_prefix, args.sector)
    except (SupabaseAdminError, RPCError) as exc:
        print(f"Smoke test failed: {exc}", file=sys.stderr)
        return 1
    return 0


def main() -> int:
    return asyncio.run(_async_main())


if __name__ == "__main__":
    raise SystemExit(main())
