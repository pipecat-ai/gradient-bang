#!/usr/bin/env python3
"""Reset all ports to their initial state.

This script connects to the game server and calls the reset_ports admin endpoint.
All ports will be reset to their start-of-day quantities as defined in the universe data.

Usage:
    uv run python -m scripts.reset_ports [--server http://localhost:8000]
"""
import asyncio
import argparse
<<<<<<< HEAD:scripts/reset_ports.py
import os
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

# Conditional import: Use Supabase client if SUPABASE_URL is set, otherwise use legacy
if os.getenv("SUPABASE_URL"):
    from gradientbang.utils.supabase_client import AsyncGameClient
else:
    from gradientbang.utils.api_client import AsyncGameClient
=======

from gradientbang.utils.api_client import AsyncGameClient
>>>>>>> main:src/gradientbang/scripts/reset_ports.py


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
