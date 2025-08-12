#!/usr/bin/env python3
"""
NPC Command-Line Interface for Gradient Bang.

Usage:
    python run_npc.py <character_id> "<task>"

Examples:
    python run_npc.py npc_trader "Move to sector 10"
    python run_npc.py npc_explorer "Find the nearest port and report what it trades"
    python run_npc.py npc_scout "Move to sector 5 and wait there for 10 seconds"
"""

import sys
import os
import argparse
import asyncio
from datetime import datetime
from pathlib import Path
import json

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.api_client import AsyncGameClient
from utils.llm_interface import AsyncLLMAgent, LLMConfig
from utils.game_tools import AsyncToolExecutor


VERBOSE = os.getenv("NPC_VERBOSE", "true").lower() == "true"


def log(message: str, data: dict = None):
    """Print a timestamped log message."""
    if not VERBOSE:
        return
    timestamp = datetime.now().strftime("%H:%M:%S")
    if data:
        # Compact JSON representation on same line
        print(f"{timestamp} {message}: {json.dumps(data, separators=(',', ':'))}")
    else:
        print(f"{timestamp} {message}")


async def main():
    """Main entry point for the NPC CLI."""
    parser = argparse.ArgumentParser(
        description="Run an AI-controlled NPC in Gradient Bang",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s npc_trader "Move to sector 10"
  %(prog)s npc_explorer "Find the nearest port and report what it trades"
  %(prog)s npc_scout "Move to sector 5 and wait there for 10 seconds"
  
Environment Variables:
  OPENAI_API_KEY       - Required: Your OpenAI API key
  GAME_SERVER_URL      - Optional: Game server URL (default: http://localhost:8000)
  NPC_MODEL            - Optional: OpenAI model to use (default: gpt-5)
  NPC_VERBOSE          - Optional: Set to 'false' to reduce log output (default: true)
  NPC_VERBOSE_PROMPTS  - Optional: Set to 'true' to show full prompts and responses
        """,
    )

    parser.add_argument("character_id", help="Unique identifier for the NPC character")

    parser.add_argument(
        "task", help="Natural language description of the task to complete"
    )

    parser.add_argument(
        "--server",
        default=os.getenv("GAME_SERVER_URL", "http://localhost:8000"),
        help="Game server URL (default: %(default)s)",
    )

    parser.add_argument(
        "--model",
        default=os.getenv("NPC_MODEL", "gpt-5"),
        help="OpenAI model to use (default: %(default)s)",
    )

    parser.add_argument(
        "--max-iterations",
        type=int,
        default=25,
        help="Maximum OODA loop iterations (default: %(default)s)",
    )

    parser.add_argument(
        "--verbose-prompts",
        action="store_true",
        help="Show full prompts and responses sent to/from the LLM (or set NPC_VERBOSE_PROMPTS=true)",
    )

    args = parser.parse_args()

    # Check for API key
    if not os.getenv("OPENAI_API_KEY"):
        log("ERROR", {"message": "OPENAI_API_KEY environment variable not set"})
        print("Please set it with: export OPENAI_API_KEY='your-key-here'")
        sys.exit(1)

    # Determine verbosity levels
    verbose_prompts = (
        args.verbose_prompts
        or os.getenv("NPC_VERBOSE_PROMPTS", "false").lower() == "true"
    )

    try:
        # Create async game client
        log("CONNECT", {"server": args.server})
        async with AsyncGameClient(base_url=args.server) as game_client:

            # Join the game
            log("JOIN", {"character": args.character_id})
            status = await game_client.join(args.character_id)

            log("JOINED", {"sector": status.sector})

            # Display sector contents
            if status.sector_contents:
                contents = status.sector_contents
                sector_info = {
                    "warps": contents.adjacent_sectors
                }
                if contents.port:
                    sector_info["port"] = {
                        "class": contents.port.class_num,
                        "code": contents.port.code,
                        "buys": contents.port.buys,
                        "sells": contents.port.sells
                    }
                if contents.other_players:
                    sector_info["players"] = list(contents.other_players)
                log("SECTOR", sector_info)

            # Create tool executor
            tool_executor = AsyncToolExecutor(game_client, args.character_id)

            # Configure LLM
            llm_config = LLMConfig(api_key=os.getenv("OPENAI_API_KEY"), model=args.model)

            # Create LLM agent
            log("INIT_AGENT", {"model": args.model})
            agent = AsyncLLMAgent(
                config=llm_config,
                tool_executor=tool_executor,
                verbose_prompts=verbose_prompts,
            )

            # Prepare initial state
            initial_state = {
                "status": status.model_dump(),
                "time": datetime.now().isoformat(),
            }

            log("TASK_START", {"task": args.task})
            success = await agent.run_task(
                task=args.task,
                initial_state=initial_state,
                max_iterations=args.max_iterations,
            )

            # Report results
            if success:
                log("TASK_COMPLETE", {"status": "success"})
            else:
                log("TASK_INCOMPLETE", {"max_iterations": args.max_iterations})

            # Get final status
            final_status = await game_client.my_status(args.character_id)
            log("FINAL_POSITION", {"sector": final_status.sector})

    except KeyboardInterrupt:
        log("INTERRUPTED", {"reason": "user_abort"})
        sys.exit(130)

    except Exception as e:
        log("ERROR", {"message": str(e), "type": type(e).__name__})
        if verbose_prompts:
            import traceback
            traceback.print_exc()
        sys.exit(1)

    log("SESSION_END")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
