#!/usr/bin/env python3
"""
Status Subscription Demo

Watches my_status push events over WebSocket and runs a TaskAgent with the
provided prompt whenever a status update changes (ignores the first update).

Usage:
  python status_subscription_demo.py <character_id> "<prompt>" \
      [--server http://localhost:8001] [--transport websocket]

Behavior:
  - Connects to the server (default WebSocket server on port 8001)
  - Joins the game as the character (if not already present)
  - Subscribes to my_status events
  - On the first status event: records baseline; does not run prompt
  - On a subsequent different status: runs TaskAgent with the prompt
  - Continues running; if interrupted:
      - If no task running: exits
      - If a task is running: cancels it and keeps waiting for next change
"""

import os
import sys
import json
import asyncio
import argparse
from pathlib import Path
from loguru import logger

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.api_client import AsyncGameClient
from utils.base_llm_agent import LLMConfig
from utils.task_agent import TaskAgent


def normalize_status(status: dict) -> dict:
    """Return a shallow-normalized copy excluding volatile fields like last_active."""
    if not isinstance(status, dict):
        return {}
    out = {k: v for k, v in status.items() if k != "last_active"}
    return out


async def run(
    prompt: str, character_id: str, server: str, transport: str, model: str
) -> int:
    # Logging setup
    logger.remove()
    logger.add(sys.stderr, format="{time:HH:mm:ss} {message}", level="INFO")

    if transport != "websocket":
        logger.warning("This demo now supports only websocket transport; overriding option.")
        transport = "websocket"
        return 1

    # OpenAI key required for TaskAgent
    if not os.getenv("OPENAI_API_KEY"):
        logger.error("OPENAI_API_KEY is not set; export it to run the agent.")
        return 1

    # State
    last_sig = None
    current_task: asyncio.Task | None = None
    current_agent: TaskAgent | None = None
    update_queue: asyncio.Queue = asyncio.Queue()
    running = True

    async with AsyncGameClient(base_url=server) as client:
        # Ensure character exists and fetch initial map
        logger.info(f"CONNECT server={server} transport=websocket")
        status = await client.join(character_id)
        logger.info(f"JOINED sector={status['sector']}")

        # Subscribe to my_status events
        @client.on("status.update")
        async def on_status(data: dict):  # noqa: F401
            try:
                await update_queue.put({"type": "status.update", "data": data})
            except Exception:
                # In case of shutdown
                pass

        @client.on("chat.message")
        async def on_chat(data: dict):  # noqa: F401
            try:
                await update_queue.put({"type": "chat.message", "data": data})
            except Exception:
                # In case of shutdown
                pass

        # Initialize baseline from the join response so the first differing
        # my_status event triggers a task (no need to consume an event just to
        # establish the baseline).
        try:
            last_sig = json.dumps(normalize_status(status), sort_keys=True)
            logger.info("STATUS base set from join; waiting for change...")
        except Exception:
            # If join status is malformed, fall back to first event handling
            last_sig = None

        # Event loop
        while running:
            try:
                # this is too simple: we should get all the available events (todo)
                # we will need to refactor all the logic below when we implement
                # fetching multiple events at once
                event = await update_queue.get()
                this_event_prompt = ""

                # Set up prompt for incoming message
                if event["type"] == "chat.message":
                    chat = event["data"]
                    logger.info(f"CHAT {chat}")
                    this_event_prompt = f"Received message:\n{chat}\n\nTask:\n{prompt}"

                if event["type"] == "status.update":
                    # Normalize status
                    sig = json.dumps(normalize_status(event["data"]), sort_keys=True)

                    # First event: set baseline and continue
                    if last_sig is None:
                        last_sig = sig
                        logger.info(
                            "STATUS base set (first update); waiting for change..."
                        )
                        continue

                    # No change: ignore
                    if sig == last_sig:
                        continue

                    # Change detected
                    previous_status = last_sig
                    current_status = sig
                    last_sig = sig
                    logger.info("STATUS changed; preparing to run task")
                    this_event_prompt = f"Previous status:\n{previous_status}\n\nNew status:\n{current_status}\n\nTask:\n{prompt}"

                # If a task is running, skip starting a new one
                if current_task and not current_task.done():
                    logger.info("A task is already running; ignoring event")
                    await update_queue.put(event)
                    await asyncio.sleep(2)
                    continue

                # Build agent and run task
                llm_config = LLMConfig(api_key=os.getenv("OPENAI_API_KEY"), model=model)
                current_agent = TaskAgent(
                    config=llm_config,
                    verbose_prompts=False,
                    game_client=client,
                    character_id=character_id,
                )

                async def run_task_once():
                    logger.info(f"TASK_START task='{this_event_prompt}'")
                    try:
                        await current_agent.run_task(
                            this_event_prompt, max_iterations=25
                        )
                    except Exception as e:
                        logger.warning(f"TASK_ERROR {type(e).__name__}: {str(e)}")
                    finally:
                        logger.info("TASK_END")

                current_task = asyncio.create_task(run_task_once())

            except KeyboardInterrupt:
                if current_task and not current_task.done():
                    logger.info("INTERRUPT: cancelling running task...")
                    try:
                        if current_agent:
                            current_agent.cancel()
                        await current_task
                        logger.info("Task cancelled; continuing to watch for changes")
                    except Exception:
                        logger.info("Task cancellation completed")
                    finally:
                        current_task = None
                        current_agent = None
                    continue
                else:
                    logger.info("INTERRUPT: exiting (no task running)")
                    running = False
                    break

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Status subscription demo (WebSocket)")
    parser.add_argument("character_id", help="Character ID to use")
    parser.add_argument("prompt", help="Prompt to run on each status change")
    parser.add_argument(
        "--server", default=os.getenv("GAME_SERVER_URL", "http://localhost:8001")
    )
    parser.add_argument(
        "--transport",
        choices=["http", "websocket"],
        default=os.getenv("NPC_TRANSPORT", "websocket"),
    )
    parser.add_argument(
        "--model",
        default=os.getenv("NPC_MODEL", "gpt-5"),
        help="OpenAI model to use (default from NPC_MODEL or gpt-5)",
    )
    args = parser.parse_args()

    try:
        return asyncio.run(
            run(args.prompt, args.character_id, args.server, args.transport, args.model)
        )
    except KeyboardInterrupt:
        # Fallback - should normally be handled inside run()
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
