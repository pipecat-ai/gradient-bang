#!/usr/bin/env python3
"""Admin helper for joining a character to a corporation."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

from gradientbang.utils.api_client import AsyncGameClient, RPCError


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Join a character to a corporation (requires valid invite code)."
    )
    parser.add_argument(
        "character_id",
        help="Character ID - must not already be in a corporation",
    )
    parser.add_argument(
        "corp_id",
        help="Corporation ID to join",
    )
    parser.add_argument(
        "invite_code",
        help="Corporation invite code",
    )
    parser.add_argument(
        "--server",
        default="http://localhost:8000",
        help="Server base URL (default: %(default)s)",
    )
    args = parser.parse_args()

    character_id = args.character_id
    corp_id = args.corp_id
    invite_code = args.invite_code

    try:
        async with AsyncGameClient(
            base_url=args.server,
            character_id=character_id,
        ) as client:
            await client.identify(character_id=character_id)

            # Call corporation.join endpoint
            result = await client._request(
                "corporation.join",
                {
                    "character_id": character_id,
                    "corp_id": corp_id,
                    "invite_code": invite_code,
                },
            )

            print("✓ Successfully joined corporation.")
            print(f"  Name: {result.get('name')}")
            print(f"  Corp ID: {result.get('corp_id')}")
            print(f"  Member Count: {result.get('member_count')}")
            return 0

    except RPCError as exc:
        print(f"Corporation join failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Unexpected error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
