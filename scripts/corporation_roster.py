#!/usr/bin/env python3
"""Display detailed roster of corporation members and ships."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "game-server"))

# Conditional import: Use Supabase client if SUPABASE_URL is set, otherwise use legacy
if os.getenv("SUPABASE_URL"):
    from utils.supabase_client import AsyncGameClient
    from utils.api_client import RPCError
else:
    from utils.api_client import AsyncGameClient, RPCError


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Display detailed corporation roster (members and ships).",
        epilog="""
Note: Detailed information (invite codes, ship details) only available to corporation members.
Non-members will see limited public information.
        """
    )
    parser.add_argument(
        "character_id",
        help="Character ID to query from (must be corp member for full details)",
    )
    parser.add_argument(
        "corp_id",
        nargs="?",
        help="Corporation ID (defaults to character's current corporation)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output raw JSON instead of formatted view",
    )
    parser.add_argument(
        "--server",
        default="http://localhost:8000",
        help="Server base URL (default: %(default)s)",
    )
    args = parser.parse_args()

    character_id = args.character_id
    corp_id = args.corp_id

    try:
        async with AsyncGameClient(
            base_url=args.server,
            character_id=character_id,
        ) as client:
            await client.identify(character_id=character_id)

            # If no corp_id provided, query character's corporation
            if not corp_id:
                # Get character status to find their corp
                status_received = False
                status_data = None

                def capture_status(payload):
                    nonlocal status_received, status_data
                    status_data = payload
                    status_received = True

                client.on("status.snapshot")(capture_status)
                await client.my_status(character_id=character_id)
                await asyncio.sleep(1.0)

                # Extract from payload (event wrapper contains payload)
                if status_data:
                    payload = status_data.get("payload", status_data)
                    corp_info = payload.get("corporation")
                    if corp_info and isinstance(corp_info, dict):
                        corp_id = corp_info.get("corp_id")

                if not corp_id:
                    print("Error: Character is not in a corporation and no corp_id provided", file=sys.stderr)
                    return 1

            # Query corporation info
            result = await client._request(
                "corporation.info",
                {
                    "character_id": character_id,
                    "corp_id": corp_id,
                },
            )

            if args.json:
                print(json.dumps(result, indent=2))
                return 0

            # Format output
            print(f"╔{'═' * 78}╗")
            print(f"║ Corporation: {result.get('name', 'Unknown'):<62} ║")
            print(f"╠{'═' * 78}╣")
            print(f"║ Corp ID: {result.get('corp_id', 'unknown'):<66} ║")
            print(f"║ Founded: {result.get('founded', 'unknown'):<66} ║")
            print(f"║ Member Count: {result.get('member_count', 0):<63} ║")

            if result.get("invite_code"):
                print(f"║ Invite Code: {result.get('invite_code'):<64} ║")

            print(f"╚{'═' * 78}╝")

            # Display members
            members = result.get("members", [])
            if members:
                print(f"\n{'━' * 80}")
                print(f"MEMBERS ({len(members)})")
                print(f"{'━' * 80}")

                for i, member in enumerate(members, 1):
                    if isinstance(member, dict):
                        name = member.get('name', 'Unknown')
                        char_id = member.get('character_id', 'unknown')
                        print(f"{i:2}. {name:<30} (ID: {char_id})")
                    else:
                        print(f"{i:2}. {member}")
            else:
                print(f"\n{'━' * 80}")
                print("MEMBERS")
                print(f"{'━' * 80}")
                print("(Member list not available - not a corporation member)")

            # Display ships
            ships = result.get("ships", [])
            if ships:
                print(f"\n{'━' * 80}")
                print(f"SHIPS ({len(ships)})")
                print(f"{'━' * 80}")
                print(f"{'#':<4} {'Ship Type':<25} {'Name':<25} {'Sector':<10} {'Ship ID':<36}")
                print(f"{'-' * 4} {'-' * 25} {'-' * 25} {'-' * 10} {'-' * 36}")

                for i, ship in enumerate(ships, 1):
                    if isinstance(ship, dict):
                        ship_type = ship.get('ship_type', 'unknown')
                        ship_name = ship.get('name') or '(unnamed)'
                        sector = ship.get('sector')
                        sector_str = str(sector) if sector is not None else '?'
                        ship_id = ship.get('ship_id', 'unknown')

                        # Truncate long names
                        if len(ship_name) > 24:
                            ship_name = ship_name[:21] + "..."

                        print(f"{i:<4} {ship_type:<25} {ship_name:<25} {sector_str:<10} {ship_id:<36}")
                    else:
                        print(f"{i:<4} {ship}")
            else:
                print(f"\n{'━' * 80}")
                print("SHIPS")
                print(f"{'━' * 80}")
                if result.get("members"):
                    # Member but no ships
                    print("(No ships owned)")
                else:
                    # Not a member
                    print("(Ship list not available - not a corporation member)")

            print()
            return 0

    except RPCError as exc:
        print(f"Corporation roster query failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Unexpected error: {exc}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
