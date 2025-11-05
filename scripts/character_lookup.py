#!/usr/bin/env python3
"""Lookup a character ID by name using the local registry."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "game-server"))

from core.character_registry import CharacterRegistry
from core.config import get_world_data_path
from utils.api_client import AsyncGameClient


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
        default="http://localhost:8000",
        help="Server base URL (default: %(default)s)",
    )
    args = parser.parse_args()

    registry_path = get_world_data_path() / "characters.json"
    registry = CharacterRegistry(registry_path)
    registry.load()
    profile = registry.find_by_name(args.name)
    if not profile:
        print(f"No character found with name '{args.name}'", file=sys.stderr)
        return 1

    character_id = profile.character_id
    print(character_id)

    if args.verbose:
        # Fetch current status from server
        print()
        try:
            async with AsyncGameClient(
                base_url=args.server,
                character_id=character_id,
            ) as client:
                # Use identify to set up the connection
                await client.identify(character_id=character_id)

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


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main_async()))
