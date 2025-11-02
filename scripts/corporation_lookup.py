#!/usr/bin/env python3
"""Admin helper for looking up corporation information."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "game-server"))

from utils.api_client import AsyncGameClient, RPCError


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Lookup corporation information. Use --list to see all corporations."
    )
    parser.add_argument(
        "character_id",
        nargs="?",
        help="Character ID to query from (shows member view if in corp, public view otherwise)",
    )
    parser.add_argument(
        "--corp-id",
        help="Corporation ID to lookup",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List all corporations (sorted by member count)",
    )
    parser.add_argument(
        "--server",
        default="http://localhost:8000",
        help="Server base URL (default: %(default)s)",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Show full JSON payload",
    )
    args = parser.parse_args()

    if args.list:
        # List all corporations
        try:
            async with AsyncGameClient(
                base_url=args.server,
                character_id="admin-tool",
            ) as client:
                await client.identify(character_id="admin-tool")

                result = await client._request("corporation.list", {})
                corps = result.get("corporations", [])

                if not corps:
                    print("No corporations exist.")
                    return 0

                print(f"Found {len(corps)} corporation(s):\n")
                for corp in corps:
                    print(f"  {corp.get('name')} (ID: {corp.get('corp_id')})")
                    print(f"    Members: {corp.get('member_count', 0)}")
                    print()

                return 0

        except RPCError as exc:
            print(f"Corporation list failed: {exc}", file=sys.stderr)
            return 1
        except Exception as exc:
            print(f"Unexpected error: {exc}", file=sys.stderr)
            return 1

    # Corporation info lookup
    if not args.character_id:
        print("Error: character_id required for corporation info lookup", file=sys.stderr)
        print("Use --list to see all corporations", file=sys.stderr)
        return 1

    character_id = args.character_id
    corp_id = args.corp_id

    # If no corp_id provided, auto-detect from character's corporation
    if not corp_id:
        try:
            async with AsyncGameClient(
                base_url=args.server,
                character_id=character_id,
            ) as client:
                await client.identify(character_id=character_id)

                # Get character status to find their corp
                status_data = None
                def capture_status(payload):
                    nonlocal status_data
                    status_data = payload

                client.on("status.snapshot")(capture_status)
                await client.my_status(character_id=character_id)
                await asyncio.sleep(1.0)

                if status_data:
                    payload = status_data.get('payload', status_data)
                    corp_info = payload.get('corporation')
                    if corp_info and isinstance(corp_info, dict):
                        corp_id = corp_info.get('corp_id')

                if not corp_id:
                    print("Error: Character is not in a corporation and no --corp-id provided", file=sys.stderr)
                    print("Use --list to see all corporations", file=sys.stderr)
                    return 1

        except RPCError as exc:
            print(f"Failed to get character status: {exc}", file=sys.stderr)
            return 1
        except Exception as exc:
            print(f"Unexpected error: {exc}", file=sys.stderr)
            return 1

    try:
        async with AsyncGameClient(
            base_url=args.server,
            character_id=character_id,
        ) as client:
            await client.identify(character_id=character_id)

            result = await client._request(
                "corporation.info",
                {
                    "character_id": character_id,
                    "corp_id": corp_id,
                },
            )

            if args.verbose:
                print("=== Full Corporation Info Payload ===")
                print(json.dumps(result, indent=2))
                print()

            # Display formatted output
            print(f"Corporation: {result.get('name')}")
            print(f"Corp ID: {result.get('corp_id')}")
            print(f"Founded: {result.get('founded', 'unknown')}")
            print(f"Member Count: {result.get('member_count', 0)}")

            # Member-only fields
            if result.get("invite_code"):
                print(f"Invite Code: {result.get('invite_code')}")
            if result.get("members"):
                members = result.get('members', [])
                # Handle both string IDs and dict objects
                member_strs = []
                for m in members:
                    if isinstance(m, dict):
                        name = m.get('name', m.get('character_id', 'unknown'))
                        char_id = m.get('character_id', '')
                        if name and char_id:
                            member_strs.append(f"{name} ({char_id[:8]}...)")
                        else:
                            member_strs.append(str(m))
                    else:
                        member_strs.append(str(m))
                print(f"Members: {', '.join(member_strs)}")

            # Display ships with full details
            if result.get("ships"):
                ships = result.get('ships', [])
                print(f"\nShips: {len(ships)}")
                if ships:
                    for i, ship in enumerate(ships, 1):
                        if isinstance(ship, dict):
                            print(f"\n  Ship {i}: {ship.get('name', 'Unnamed')}")
                            print(f"    Type: {ship.get('ship_type', 'unknown')}")
                            print(f"    Location: Sector {ship.get('sector', '?')}")
                            print(f"    Ship ID: {ship.get('ship_id', 'unknown')}")

                            # Show detailed stats if available
                            if 'cargo' in ship:
                                cargo = ship.get('cargo', {})
                                qf = cargo.get('quantum_foam', 0)
                                ro = cargo.get('retro_organics', 0)
                                ns = cargo.get('neuro_symbolics', 0)
                                cargo_capacity = ship.get('cargo_capacity', 0)
                                cargo_used = qf + ro + ns
                                empty_holds = cargo_capacity - cargo_used
                                print(f"    Cargo: {qf} QF | {ro} RO | {ns} NS. Empty holds: {empty_holds}")

                            if 'warp_power' in ship:
                                warp = ship.get('warp_power', 0)
                                warp_max = ship.get('warp_power_capacity', 0)
                                print(f"    Warp: {warp}/{warp_max}")

                            if 'shields' in ship:
                                shields = ship.get('shields', 0)
                                shields_max = ship.get('max_shields', 0)
                                print(f"    Shields: {shields}/{shields_max}")

                            if 'fighters' in ship:
                                fighters = ship.get('fighters', 0)
                                fighters_max = ship.get('max_fighters', 0)
                                print(f"    Fighters: {fighters}/{fighters_max}")
                        else:
                            print(f"  - {ship}")

            return 0

    except RPCError as exc:
        print(f"Corporation lookup failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Unexpected error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
