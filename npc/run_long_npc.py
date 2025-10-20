#!/usr/bin/env python3
"""Command-line entrypoint for the experimental Pipecat-based task agent."""

import argparse
import asyncio
import os
import sys
import time
from pathlib import Path
from google import genai

from loguru import logger

# Ensure project modules are importable when running as a script
sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.api_client import AsyncGameClient
from utils.task_agent import TaskAgent
from utils.prompts import GAME_DESCRIPTION, RUN_LONG_NPC_INSTRUCTIONS
from typing import Any, Dict, List, Optional

DEFAULT_MODEL = "gemini-2.5-flash-preview-09-2025"

character_id: Optional[str] = None
game_client: Optional[AsyncGameClient] = None
task_agent: Optional[TaskAgent] = None
task_output: List[str] = []
event_loop: Optional[asyncio.AbstractEventLoop] = None


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


def get_event_loop() -> asyncio.AbstractEventLoop:
    global event_loop
    if event_loop is None:
        event_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(event_loop)
    return event_loop


async def initialize(args: argparse.Namespace) -> None:
    global game_client
    global character_id
    global task_agent

    game_client = AsyncGameClient(base_url=args.server, character_id=args.character_id)
    logger.info(f"CONNECT server={args.server}")
    await game_client.join(args.character_id)
    logger.info("JOINED")
    character_id = args.character_id

    task_agent = TaskAgent(
        game_client=game_client,
        character_id=character_id,
        output_callback=output_callback,
    )


def exit() -> None:
    logger.info("EXIT")
    sys.exit(0)


def output_callback(message: str, output_type: Optional[str]) -> None:
    if output_type:
        task_output.append(f"[{output_type}] {message}")
    else:
        task_output.append(message)


async def _run_task(task: str) -> Dict[str, Any]:
    if game_client is None or character_id is None:
        raise RuntimeError("Game client is not initialized")

    logger.info(f'TASK_START instructions="{task}"')
    success = await task_agent.run_task(
        task=task,
    )

    if success:
        logger.info("TASK_COMPLETE status=success")
    else:
        logger.warning("TASK_INCOMPLETE")

    return {"task_success": success}


def run_task(task: str) -> Dict[str, Any]:
    loop = get_event_loop()
    return loop.run_until_complete(_run_task(task))


def main() -> int:
    args = parse_args()
    api_key = ensure_api_key()
    loop = get_event_loop()

    try:
        loop.run_until_complete(initialize(args))

        client = genai.Client(api_key=api_key)
        chat = client.chats.create(
            model=args.model,
            config=genai.types.GenerateContentConfig(
                system_instruction=f"{GAME_DESCRIPTION}\n\n{RUN_LONG_NPC_INSTRUCTIONS}\n\nINSTRUCTIONS: {args.instructions}",
                tools=[run_task, exit],
            ),
        )

        while True:
            log_payload = "\n".join(task_output)
            task_output.clear()
            response = chat.send_message(
                f"<task.log>{log_payload}</task.log>\nExecute next task."
            )
            if response.text:
                print(response.text)
            time.sleep(1)
    except KeyboardInterrupt:
        logger.info("INTERRUPTED by user")
        return 130
    except Exception as exc:  # pragma: no cover - diagnostic path
        logger.exception(f"ERROR: {exc}")
        return 1
    finally:
        try:
            if game_client is not None:
                loop.run_until_complete(game_client.close())
        except Exception:
            logger.exception("Failed to close game client cleanly")
        finally:
            loop.close()
            globals()["event_loop"] = None


if __name__ == "__main__":
    sys.exit(main())
