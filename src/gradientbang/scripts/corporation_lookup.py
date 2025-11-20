#!/usr/bin/env python3
"""Admin helper for looking up corporation information."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any, Dict, Iterable, List, Tuple

from gradientbang.utils.api_client import AsyncGameClient, RPCError


COMMODITY_KEYS: Tuple[Tuple[str, str], ...] = (
    ("quantum_foam", "QF"),
    ("retro_organics", "RO"),
    ("neuro_symbolics", "NS"),
)


def _coerce_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _format_cargo(summary: Dict[str, Any]) -> str:
    cargo: Dict[str, Any] = summary.get("cargo") or {}
    capacity = summary.get("cargo_capacity")
    capacity_int = _coerce_int(capacity)

    amounts: List[str] = []
    used = 0
    for key, label in COMMODITY_KEYS:
        amount = _coerce_int(cargo.get(key))
        used += max(amount, 0)
        amounts.append(f"{label}:{amount}")

    fragments: List[str] = []
    if capacity_int > 0:
        empty = max(capacity_int - used, 0)
        fragments.append(f"{used}/{capacity_int} holds used (empty {empty})")
    else:
        fragments.append(f"{used} holds used")

    fragments.append(" ".join(amounts))
    return " | ".join(fragments)


def _format_combat(summary: Dict[str, Any]) -> str:
    fighters = _coerce_int(summary.get("fighters"))
    max_fighters = _coerce_int(summary.get("max_fighters"))
    shields = _coerce_int(summary.get("shields"))
    max_shields = _coerce_int(summary.get("max_shields"))
    warp = _coerce_int(summary.get("warp_power"))
    warp_max = _coerce_int(summary.get("warp_power_capacity"))

    parts: List[str] = []
    if max_fighters:
        parts.append(f"fighters {fighters}/{max_fighters}")
    elif fighters:
        parts.append(f"fighters {fighters}")

    if max_shields:
        parts.append(f"shields {shields}/{max_shields}")
    elif shields:
        parts.append(f"shields {shields}")

    if warp_max:
        parts.append(f"warp {warp}/{warp_max}")
    elif warp:
        parts.append(f"warp {warp}")

    return " | ".join(parts) if parts else "no combat stats reported"


def _print_ship_inventory(
    ships: Iterable[Dict[str, Any]],
    *,
    indent: str = "  ",
    show_header: bool = True,
) -> None:
    ships_list = sorted(
        [
            ship
            for ship in ships
            if isinstance(ship, dict) and ship.get("ship_id")
        ],
        key=lambda item: (
            str(item.get("name") or "").lower(),
            str(item.get("ship_id")),
        ),
    )

    if show_header:
        ready_count = sum(1 for ship in ships_list if ship.get("control_ready"))
        print(f"Ships: {len(ships_list)} total ({ready_count} control-ready)")
        if not ships_list:
            return
        print()

    for ship in ships_list:
        name = ship.get("name") or "Unnamed Vessel"
        ship_type = ship.get("ship_type") or "unknown_type"
        ship_id = ship.get("ship_id")
        sector = ship.get("sector")
        sector_display = f"Sector {sector}" if sector is not None else "Sector ?"

        print(f"{indent}- {name} [{ship_type}] — {sector_display}")
        print(f"{indent}  Character ID: {ship_id}")
        print(f"{indent}  Cargo: {_format_cargo(ship)}")
        print(f"{indent}  Combat: {_format_combat(ship)}")

        control_ready = ship.get("control_ready")
        if control_ready is True:
            print(f"{indent}  Control: READY (character knowledge present)")
        elif control_ready is False:
            print(
                f"{indent}  Control: BLOCKED — create character knowledge for {ship_id}"
            )
        else:
            print(f"{indent}  Control: UNKNOWN")

        print()


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
        "--ships",
        action="store_true",
        help="Show a detailed ship inventory for the target corporation",
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

    if args.list and args.ships:
        parser.error("--ships cannot be combined with --list")

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

            ships = result.get("ships", [])

            if args.ships:
                print(f"{result.get('name')} (Corp ID: {result.get('corp_id')})")
                print()
                _print_ship_inventory(ships, indent="")
                return 0

            # Display formatted output
            print(f"Corporation: {result.get('name')}")
            print(f"Corp ID: {result.get('corp_id')}")
            print(f"Founded: {result.get('founded', 'unknown')}")
            print(f"Member Count: {result.get('member_count', 0)}")

            # Member-only fields
            if result.get("invite_code"):
                print(f"Invite Code: {result.get('invite_code')}")
            if result.get("members"):
                members = result.get("members", [])
                # Handle both string IDs and dict objects
                member_strs = []
                for m in members:
                    if isinstance(m, dict):
                        name = m.get("name", m.get("character_id", "unknown"))
                        char_id = m.get("character_id", "")
                        if name and char_id:
                            member_strs.append(f"{name} ({char_id[:8]}...)")
                        else:
                            member_strs.append(str(m))
                    else:
                        member_strs.append(str(m))
                print(f"Members: {', '.join(member_strs)}")

            if ships:
                print()
                _print_ship_inventory(ships)

            return 0

    except RPCError as exc:
        print(f"Corporation lookup failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Unexpected error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
