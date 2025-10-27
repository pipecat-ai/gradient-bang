#!/usr/bin/env python3
"""Reset all ports to their initial state.

This script connects to the game server and calls the reset_ports admin endpoint.
All ports will be reset to their start-of-day quantities as defined in the universe data.

Usage:
    uv run python -m scripts.reset_ports [--server http://localhost:8000]
"""
import asyncio
import argparse
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.api_client import AsyncGameClient


async def main():
    parser = argparse.ArgumentParser(description="Reset all ports to initial state")
    parser.add_argument(
        "--server",
        default="http://localhost:8000",
        help="Game server URL (default: http://localhost:8000)"
    )
    args = parser.parse_args()

    print(f"Connecting to {args.server}...")

    # AsyncGameClient requires a character_id, but admin operations don't need one
    # We'll use a dummy character ID for this admin operation
    async with AsyncGameClient(base_url=args.server, character_id="admin") as client:
        # Make the RPC call directly using _request
        # The reset_ports endpoint doesn't require any payload parameters
        result = await client._request("reset_ports", {})

        print(f"✓ Success: {result['message']}")
        print(f"  Ports reset: {result['ports_reset']}")


if __name__ == "__main__":
    asyncio.run(main())
