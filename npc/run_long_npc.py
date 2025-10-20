#!/usr/bin/env python3
"""Command-line entrypoint for the experimental Pipecat-based task agent."""

import argparse
import asyncio
import os
import sys
from pathlib import Path
from google import genai

from loguru import logger

# Ensure project modules are importable when running as a script
sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.api_client import AsyncGameClient
from utils.task_agent import TaskAgent
from utils.prompts import GAME_DESCRIPTION, RUN_LONG_NPC_INSTRUCTIONS
from utils.task_agent import TaskOutputType
from typing import List

DEFAULT_MODEL = "gemini-2.5-flash-preview-09-2025"

game_client: AsyncGameClient
character_id: str
task_output: List[str] = []


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the experimental Pipecat-based task agent",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s npc-02 "Where am I?"
  %(prog)s npc-scout "Scan the area and report nearby ports"

Environment Variables:
  GOOGLE_API_KEY             Required. Google Generative AI key.
  GAME_SERVER_URL            Optional. Defaults to http://localhost:8000.
""",
    )

    parser.add_argument("character_id", help="Character to control")
    parser.add_argument("instructions", help="Instructions for the NPC")

    parser.add_argument(
        "--server",
        default=os.getenv("GAME_SERVER_URL", "http://localhost:8000"),
        help="Game server URL (default: %(default)s)",
    )

    parser.add_argument(
        "--model",
        default=os.getenv("AGENT_MODEL", DEFAULT_MODEL),
        help="Gemini model name (default: %(default)s)",
    )

    return parser.parse_args()


def ensure_api_key() -> str:
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        logger.error("GOOGLE_API_KEY environment variable not set")
        logger.info("Export it with: export GOOGLE_API_KEY=your-key")
        sys.exit(1)
    return api_key


async def loop(args: argparse.Namespace):
    global game_client
    global character_id
    global task_output

    game_client = AsyncGameClient(base_url=args.server, character_id=args.character_id)
    logger.info(f"CONNECT server={args.server}")
    await game_client.pause_event_delivery()
    await game_client.join(args.character_id)
    logger.info("JOINED")
    character_id = args.character_id

    client = genai.Client(api_key=ensure_api_key())
    chat = client.chats.create(
        model=args.model,
        config=genai.types.GenerateContentConfig(
            system_instruction=f"{GAME_DESCRIPTION}\n\n{RUN_LONG_NPC_INSTRUCTIONS}",
            tools=[run_task, exit],
        ),
    )
    while True:
        task_output.clear()
        response = chat.send_message(
            f"<task.log>{task_output}</task.log>\nExecute next task."
        )
        print(response.text)
        await asyncio.sleep(1)


def exit():
    logger.info("EXIT")
    sys.exit(0)


async def output_callback(message: str, output_type: TaskOutputType):
    task_output.append(message)


async def run_task(task: str) -> int:
    global game_client
    global character_id

    agent = TaskAgent(
        game_client=game_client,
        character_id=character_id,
    )

    logger.info(f'TASK_START instructions="{task}"')
    success = await agent.run_task(
        task=task,
    )

    if success:
        logger.info("TASK_COMPLETE status=success")
    else:
        logger.warning("TASK_INCOMPLETE")

    final_status = await game_client.my_status(character_id)
    logger.info(f"FINAL_STATUS {final_status.get('summary')}")

    return {"task_success": success, "final_status": final_status}


def main() -> int:
    ensure_api_key()
    args = parse_args()
    try:
        return asyncio.run(loop(args))
    except KeyboardInterrupt:
        logger.info("INTERRUPTED by user")
        return 130
    except Exception as exc:  # pragma: no cover - diagnostic path
        logger.exception(f"ERROR: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
