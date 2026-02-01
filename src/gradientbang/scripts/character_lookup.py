#!/usr/bin/env python3
"""Lookup a character ID by name using Supabase or local registry."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from gradientbang.utils.supabase_client import AsyncGameClient


def lookup_in_supabase(name: str) -> str | None:
    """Query Supabase for character by name. Returns character_id or None."""
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not supabase_key:
        return None

    try:
        from supabase import create_client

        client = create_client(supabase_url, supabase_key)
        result = client.table("characters").select("character_id").eq("name", name).execute()
        if result.data:
            return result.data[0]["character_id"]
    except Exception:
        pass
    return None


async def main_async() -> int:
    parser = argparse.ArgumentParser(description="Lookup a character UUID by display name.")
    parser.add_argument("name", help="Display name to search for")
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Show full status payload and natural language summary",
    )
    parser.add_argument(
        "--server",
        default=os.getenv("SUPABASE_URL"),
        help="Supabase base URL (default: SUPABASE_URL)",
    )
    args = parser.parse_args()

    if not args.server:
        print("SUPABASE_URL is required (or pass --server).", file=sys.stderr)
        return 1
    if not os.getenv("SUPABASE_SERVICE_ROLE_KEY"):
        print(
            "SUPABASE_SERVICE_ROLE_KEY is required to look up characters.",
            file=sys.stderr,
        )
        return 1

    # Supabase-only lookup
    character_id = lookup_in_supabase(args.name)

    if not character_id:
        print(f"No character found with name '{args.name}'", file=sys.stderr)
        return 1

    print(character_id)

    if args.verbose:
        # Fetch current status from server
        print()
        try:
            async with AsyncGameClient(
                base_url=args.server,
                character_id=character_id,
            ) as client:
                # Wait for status.snapshot event
                status_payload = None
                def capture_status(payload):
                    nonlocal status_payload
                    status_payload = payload

                client.on("status.snapshot")(capture_status)

                # Request status
                try:
                    await client.my_status(character_id=character_id)
                except Exception as exc:
                    # Handle case where character isn't in the game yet
                    if "404" in str(exc) or "not found" in str(exc).lower():
                        print("Character is registered but has not joined the game yet.", file=sys.stderr)
                        print("The character needs to call the /api/join endpoint to enter the game.", file=sys.stderr)
                        return 0
                    raise

                # Wait for event to arrive
                await asyncio.sleep(1.0)

                if status_payload is None:
                    print("Warning: No status.snapshot event received", file=sys.stderr)
                    return 0

                # Display full payload
                print("=== Full status.snapshot Event Payload ===")
                print(json.dumps(status_payload, indent=2))

                # Display natural language summary (extract from payload)
                print("\n=== Natural Language Summary ===")
                summary = status_payload.get("summary")
                if summary:
                    print(summary)
                else:
                    print("(No summary available)")

        except KeyboardInterrupt:
            print("\nInterrupted", file=sys.stderr)
            return 1
        except Exception as exc:
            print(f"Error fetching status: {exc}", file=sys.stderr)
            return 1

    return 0


def main() -> None:
    raise SystemExit(asyncio.run(main_async()))


if __name__ == "__main__":
    main()
