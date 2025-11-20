#!/usr/bin/env python3
"""Withdraw credits from bank (must be in sector 0)."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

<<<<<<< HEAD:scripts/bank_withdraw.py
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

# Conditional import: Use Supabase client if SUPABASE_URL is set, otherwise use legacy
if os.getenv("SUPABASE_URL"):
    from gradientbang.utils.supabase_client import AsyncGameClient
    from gradientbang.utils.api_client import RPCError
else:
    from gradientbang.utils.api_client import AsyncGameClient, RPCError
=======
from gradientbang.utils.api_client import AsyncGameClient, RPCError
>>>>>>> main:src/gradientbang/scripts/bank_withdraw.py


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Withdraw credits from bank. Character must be in sector 0."
    )
    parser.add_argument(
        "character_id",
        help="Character ID",
    )
    parser.add_argument(
        "amount",
        type=int,
        help="Amount to withdraw",
    )
    parser.add_argument(
        "--server",
        default="http://localhost:8000",
        help="Server base URL (default: %(default)s)",
    )
    args = parser.parse_args()

    character_id = args.character_id
    amount = args.amount

    try:
        async with AsyncGameClient(
            base_url=args.server,
            character_id=character_id,
        ) as client:
            await client.identify(character_id=character_id)

            await client.withdraw_from_bank(amount=amount, character_id=character_id)

            print(f"✓ Withdrew {amount:,} credits from bank")
            return 0

    except RPCError as exc:
        print(f"Bank withdrawal failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Unexpected error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
