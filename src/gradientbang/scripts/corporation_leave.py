#!/usr/bin/env python3
"""Admin helper for leaving a corporation."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

<<<<<<< HEAD:scripts/corporation_leave.py
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "game-server"))

# Conditional import: Use Supabase client if SUPABASE_URL is set, otherwise use legacy
if os.getenv("SUPABASE_URL"):
    from gradientbang.utils.supabase_client import AsyncGameClient
    from gradientbang.utils.api_client import RPCError
else:
    from gradientbang.utils.api_client import AsyncGameClient, RPCError
=======
from gradientbang.utils.api_client import AsyncGameClient, RPCError
>>>>>>> main:src/gradientbang/scripts/corporation_leave.py


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Remove a character from their corporation. If this is the last member, the corporation will be disbanded."
    )
    parser.add_argument(
        "character_id",
        help="Character ID - must be in a corporation",
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
            await client.identify(character_id=character_id)

            # Call corporation.leave endpoint
            result = await client._request(
                "corporation.leave",
                {
                    "character_id": character_id,
                },
            )

            print("✓ Successfully left corporation.")
            if result.get("success"):
                print("  Character is no longer a member of any corporation.")
            return 0

    except RPCError as exc:
        print(f"Corporation leave failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Unexpected error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
