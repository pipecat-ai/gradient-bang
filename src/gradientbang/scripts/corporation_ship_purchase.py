#!/usr/bin/env python3
"""Admin helper for purchasing ships for a corporation."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

from gradientbang.game_server.ships import ShipType, get_ship_stats
from gradientbang.utils.api_client import AsyncGameClient, RPCError


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Purchase a ship for a corporation (deducts from buyer's bank balance)."
    )
    parser.add_argument(
        "character_id",
        help="Character ID (must be a member of the corporation)",
    )
    parser.add_argument(
        "ship_type",
        choices=[st.value for st in ShipType],
        help="Ship type to purchase",
    )
    parser.add_argument(
        "--ship-name",
        help="Custom name for the ship (optional)",
    )
    parser.add_argument(
        "--corp-id",
        help="Corporation ID (defaults to character's current corporation)",
    )
    parser.add_argument(
        "--initial-credits",
        type=int,
        default=0,
        help="Seed the new ship with this many onboard credits (deducted from bank)",
    )
    parser.add_argument(
        "--server",
        default="http://localhost:8000",
        help="Server base URL (default: %(default)s)",
    )
    args = parser.parse_args()

    character_id = args.character_id
    ship_type = args.ship_type
    ship_name = args.ship_name
    corp_id = args.corp_id
    initial_ship_credits = max(0, int(args.initial_credits))

    stats = get_ship_stats(ShipType(ship_type))
    ship_price = stats.price
    total_cost = ship_price + initial_ship_credits

    try:
        async with AsyncGameClient(
            base_url=args.server,
            character_id=character_id,
        ) as client:
            await client.identify(character_id=character_id)

            # Get current status to show bank balance
            status_data = None
            def capture_status(payload):
                nonlocal status_data
                status_data = payload

            client.on("status.snapshot")(capture_status)
            await client.my_status(character_id=character_id)
            await asyncio.sleep(1.0)

            # Extract bank balance
            bank_balance = 0
            ship_credits = 0
            if status_data:
                payload = status_data.get('payload', status_data)
                player = payload.get('player', {})
                ship_payload = payload.get('ship', {})
                bank_balance = player.get('credits_in_bank', 0)
                ship_credits = ship_payload.get('credits', 0)

            print(f"Current balance:")
            print(f"  Ship credits: {ship_credits:,}")
            print(f"  Bank balance: {bank_balance:,}")
            print(f"  Ship cost: {ship_price:,} (from bank)")
            if initial_ship_credits:
                print(f"  Initial ship credits: {initial_ship_credits:,} (additional bank cost)")
            print(f"  Total cost: {total_cost:,}")
            print()

            if bank_balance < total_cost:
                print(f"⚠ Warning: Insufficient bank balance!")
                print(f"  Need: {total_cost:,} credits in bank")
                print(f"  Have: {bank_balance:,} in bank, {ship_credits:,} on ship")
                print()
                print(f"To deposit to bank:")
                print(f"  uv run scripts/bank_deposit.py {character_id} {total_cost}")
                print()

            # Build request payload
            request_payload = {
                "character_id": character_id,
                "ship_type": ship_type,
                "purchase_type": "corporation",
            }

            if ship_name:
                request_payload["ship_name"] = ship_name
            if corp_id:
                request_payload["corp_id"] = corp_id
            if initial_ship_credits:
                request_payload["initial_ship_credits"] = initial_ship_credits

            # Call ship.purchase endpoint
            result = await client._request("ship.purchase", request_payload)

            print("✓ Corporation ship purchased successfully.")
            print(f"  Ship ID: {result.get('ship_id')}")
            print(f"  Ship Type: {result.get('ship_type')}")
            print(f"  Corporation ID: {result.get('corp_id')}")
            print(f"  Bank Balance After: {result.get('bank_after'):,}")
            if initial_ship_credits:
                print(f"  Ship Credits Seeded: {initial_ship_credits:,}")
        return 0

    except RPCError as exc:
        print(f"Ship purchase failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Unexpected error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
