#!/usr/bin/env python3
"""Test NPC functionality locally without requiring OpenAI API.

This script exercises the tool execution and game integration without
making any LLM calls. It can be run directly and is not intended to be
executed as part of the automated test suite.
"""

import asyncio
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.api_client import AsyncGameClient
from utils.game_tools import AsyncToolExecutor


async def main() -> int:
    """Test NPC tools locally."""
    print("🧪 Testing NPC Tools Locally (No LLM Required)\n")

    server_url = "http://localhost:8000"
    character_id = "test_npc_local"

    try:
        # Create game client
        print(f"1. Connecting to {server_url}...")
        async with AsyncGameClient(base_url=server_url) as game_client:
            # Join the game
            print(f"2. Joining as '{character_id}'...")
            status = await game_client.join(character_id)
            print(f"   ✅ Joined at sector {status.sector}")

            # Display initial sector contents
            contents = status.sector_contents
            if contents.port:
                print(
                    f"   📦 Port found: Class {contents.port.class_num} ({contents.port.code})"
                )
            print(f"   🚀 Adjacent sectors: {contents.adjacent_sectors}")

            # Create tool executor
            print("\n3. Creating tool executor...")
            executor = AsyncToolExecutor(game_client, character_id)

            # Test MyStatus tool
            print("\n4. Testing MyStatus tool...")
            result = await executor.my_status()
            if result["success"]:
                print(f"   ✅ Current sector: {result['current_sector']}")
            else:
                print(f"   ❌ Error: {result['error']}")

            # Test PlotCourse tool
            print("\n5. Testing PlotCourse tool...")
            target_sector = 5
            result = await executor.plot_course(0, target_sector)
            if result["success"]:
                print(f"   ✅ Path to sector {target_sector}: {result['path']}")
                print(f"   📏 Distance: {result['distance']} warps")
            else:
                print(f"   ❌ Error: {result['error']}")

            # Test Move tool (if we have adjacent sectors)
            if contents.adjacent_sectors:
                print("\n6. Testing Move tool...")
                target = contents.adjacent_sectors[0]
                result = await executor.move(target)
                if result["success"]:
                    print(f"   ✅ Moved to sector {result['new_sector']}")

                    # Check new sector
                    new_status = await game_client.my_status(character_id)
                    new_contents = new_status.sector_contents
                    if new_contents.port:
                        print(
                            f"   📦 New sector has port: Class {new_contents.port.class_num}"
                        )
                    print(
                        f"   🚀 Can now warp to: {new_contents.adjacent_sectors[:5]}..."
                    )
                else:
                    print(f"   ❌ Error: {result['error']}")

            # Test WaitForTime tool
            print("\n7. Testing WaitForTime tool...")
            result = await executor.wait_for_time(0.5)
            if result["success"]:
                print(f"   ✅ Waited {result['waited_seconds']} seconds")
            else:
                print(f"   ❌ Error: {result['error']}")

            # Test Finished tool
            print("\n8. Testing Finished tool...")
            result = await executor.finish_task("Test completed successfully")
            if result["success"]:
                print(f"   ✅ Task marked as finished: {result['message']}")
                print(f"   🏁 Executor finished flag: {executor.finished}")
            else:
                print(f"   ❌ Error: {result['error']}")

            print("\n✅ All tool tests completed successfully!")

    except Exception as e:  # pragma: no cover - diagnostic output
        print(f"\n❌ Test failed: {str(e)}")
        import traceback

        traceback.print_exc()
        return 1

    return 0


if __name__ == "__main__":  # pragma: no cover - manual execution
    sys.exit(asyncio.run(main()))

