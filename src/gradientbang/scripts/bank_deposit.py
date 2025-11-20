#!/usr/bin/env python3
"""Deposit credits to bank (must be in sector 0)."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

from gradientbang.utils.api_client import AsyncGameClient, RPCError


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Deposit credits to bank. Character must be in sector 0."
    )
    parser.add_argument("character_id", help="Character ID used for authentication")
    parser.add_argument("amount", type=int, help="Amount to deposit")
    parser.add_argument(
        "--ship-id",
        help="Ship ID to withdraw credits from (defaults to character's active ship)",
    )
    parser.add_argument(
        "--target-name",
        help="Display name of the character receiving the deposit (defaults to the authenticated character)",
    )
    parser.add_argument(
        "--server",
        default="http://localhost:8000",
        help="Server base URL (default: %(default)s)",
    )
    args = parser.parse_args()

    character_id = args.character_id
    amount = args.amount
    ship_id = args.ship_id
    target_name = args.target_name

    try:
        async with AsyncGameClient(
            base_url=args.server,
            character_id=character_id,
        ) as client:
            await client.identify(character_id=character_id)

            status_payload = None

            def capture_status(event_payload):
                nonlocal status_payload
                status_payload = event_payload.get("payload", event_payload)

            client.on("status.snapshot")(capture_status)
            await client.my_status(character_id=character_id)
            await asyncio.sleep(0.5)

            if status_payload is None:
                raise RuntimeError("Unable to fetch status snapshot for ship/character info")

            if ship_id is None:
                ship_section = status_payload.get("ship") or {}
                ship_id = ship_section.get("ship_id")
            if ship_id is None:
                raise RuntimeError("No ship_id available; specify one with --ship-id")

            if target_name is None:
                player_section = status_payload.get("player") or {}
                target_name = player_section.get("name") or character_id

            result = await client.deposit_to_bank(
                amount=amount,
                ship_id=ship_id,
                target_player_name=target_name,
                character_id=character_id,
            )

            ship_after = result.get("ship_credits_after")
            bank_after = result.get("credits_in_bank_after")
            target_id = result.get("target_character_id", target_name)

            print(f"✓ Deposited {amount:,} credits from ship {ship_id} to {target_id}")
            if ship_after is not None or bank_after is not None:
                print(
                    "  Balances → ",
                    f"ship: {ship_after:,}" if isinstance(ship_after, int) else "ship: ?",
                    f"bank: {bank_after:,}" if isinstance(bank_after, int) else "bank: ?",
                )
            return 0

    except RPCError as exc:
        print(f"Bank deposit failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Unexpected error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
