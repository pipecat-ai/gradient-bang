#!/usr/bin/env python3
"""Withdraw credits from bank (must be in sector 0)."""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from utils.api_client import AsyncGameClient, RPCError


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

            # Withdraw from bank
            result = await client._request("bank_transfer", {
                "character_id": character_id,
                "direction": "withdraw",
                "amount": amount,
            })

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
