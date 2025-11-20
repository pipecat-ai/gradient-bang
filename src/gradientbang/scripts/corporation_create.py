#!/usr/bin/env python3
"""Admin helper for creating corporations."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

from gradientbang.utils.api_client import AsyncGameClient, RPCError


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create a corporation (requires 10,000 credits)."
    )
    parser.add_argument(
        "character_id",
        help="Character ID (founder) - must not be in another corporation",
    )
    parser.add_argument(
        "name",
        help="Corporation name (3-50 characters)",
    )
    parser.add_argument(
        "--server",
        default="http://localhost:8000",
        help="Server base URL (default: %(default)s)",
    )
    args = parser.parse_args()

    character_id = args.character_id
    corp_name = args.name

    if len(corp_name) < 3 or len(corp_name) > 50:
        print("Error: Corporation name must be 3-50 characters", file=sys.stderr)
        return 1

    try:
        async with AsyncGameClient(
            base_url=args.server,
            character_id=character_id,
        ) as client:
            await client.identify(character_id=character_id)

            # Call corporation.create endpoint
            result = await client._request(
                "corporation.create",
                {
                    "character_id": character_id,
                    "name": corp_name,
                },
            )

            print("✓ Corporation created successfully.")
            print(f"  Name: {result.get('name')}")
            print(f"  Corp ID: {result.get('corp_id')}")
            print(f"  Invite Code: {result.get('invite_code')}")
            print(f"  Founder ID: {result.get('founder_id')}")
            print(f"  Member Count: {result.get('member_count')}")
            return 0

    except RPCError as exc:
        print(f"Corporation creation failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Unexpected error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
