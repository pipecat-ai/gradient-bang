#!/usr/bin/env python3
"""Join a character to the game (required before most operations)."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

# Conditional import: Use Supabase client if SUPABASE_URL is set, otherwise use legacy
if os.getenv("SUPABASE_URL"):
    from utils.supabase_client import AsyncGameClient
    from utils.api_client import RPCError
else:
    from utils.api_client import AsyncGameClient, RPCError


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Join a character to the game. Required before creating corporations, trading, etc."
    )
    parser.add_argument(
        "character_id",
        help="Character ID to join",
    )
    parser.add_argument(
        "--server",
        default="http://localhost:8000",
        help="Server base URL (default: %(default)s)",
    )
    args = parser.parse_args()

    character_id = args.character_id

    try:
        async with AsyncGameClient(
            base_url=args.server,
            character_id=character_id,
        ) as client:
            print(f"Joining character {character_id}...")
            await client.join(character_id)
            await asyncio.sleep(1.0)
            print("✓ Character joined successfully!")
            print(f"  Character is now active in the game at sector 0")
            return 0

    except RPCError as exc:
        if "already joined" in str(exc).lower():
            print(f"✓ Character is already in the game")
            return 0
        print(f"Join failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Unexpected error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
