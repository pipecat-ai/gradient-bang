#!/usr/bin/env python3
"""
Status Subscription Demo

Watches status.snapshot events over WebSocket and runs a TaskAgent with the
provided prompt whenever a status snapshot changes (ignores the first update).

Usage:
  python status_subscription_demo.py <character_id> "<prompt>" \
      [--server http://localhost:8001] [--transport websocket]

Behavior:
  - Connects to the server (default WebSocket server on port 8001)
  - Joins the game as the character (if not already present)
  - Subscribes to status.snapshot events
  - On the first snapshot event: records baseline; does not run prompt
  - On a subsequent different snapshot: runs TaskAgent with the prompt
  - Continues running; if interrupted:
      - If no task running: exits
      - If a task is running: cancels it and keeps waiting for next change
"""

import os
import sys
import json
import asyncio
import argparse
from loguru import logger

from gradientbang.utils.api_client import AsyncGameClient
from gradientbang.utils.base_llm_agent import LLMConfig
from gradientbang.utils.task_agent import TaskAgent


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

    async with AsyncGameClient(base_url=server, character_id=character_id) as client:
        status_queue = client.get_event_queue("status.snapshot")

        # Subscribe to status and chat events before joining
        @client.on("status.snapshot")
        async def on_status(event: dict):  # noqa: F401
            try:
                await update_queue.put(event)
            except Exception:
                # In case of shutdown
                pass

        @client.on("chat.message")
        async def on_chat(event: dict):  # noqa: F401
            try:
                await update_queue.put(event)
            except Exception:
                # In case of shutdown
                pass

        # Ensure character exists and fetch initial state
        logger.info(f"CONNECT server={server} transport=websocket")
        join_ack = await client.join(character_id)
        logger.info(f"JOIN ACK: {join_ack}")

        # Initialize baseline from the first status snapshot emitted after join.
        try:
            baseline_event = await asyncio.wait_for(status_queue.get(), timeout=5.0)
            baseline_payload = baseline_event.get("payload", {})
            last_sig = json.dumps(normalize_status(baseline_payload), sort_keys=True)
            sector_id = None
            if isinstance(baseline_payload, dict):
                sector = baseline_payload.get("sector") or {}
                if isinstance(sector, dict):
                    sector_id = sector.get("id")
            sector_text = f"; sector={sector_id}" if sector_id is not None else ""
            logger.info(f"STATUS base set from first snapshot{sector_text}; waiting for change...")
        except asyncio.TimeoutError:
            logger.warning("No status snapshot received after join; waiting for first event...")
            last_sig = None

        # Event loop
        while running:
            try:
                # this is too simple: we should get all the available events (todo)
                # we will need to refactor all the logic below when we implement
                # fetching multiple events at once
                event = await update_queue.get()
                event_name = event.get("event_name")
                payload = event.get("payload", {})
                summary = event.get("summary")
                this_event_prompt = ""

                # Set up prompt for incoming message
                if event_name == "chat.message":
                    display = summary or payload
                    if not isinstance(display, str):
                        display = json.dumps(display, indent=2)
                    logger.info(f"CHAT {display}")
                    this_event_prompt = f"Received message:\n{display}\n\nTask:\n{prompt}"

                if event_name == "status.snapshot":
                    # Normalize status for comparison
                    normalized_status = normalize_status(payload)
                    sig = json.dumps(normalized_status, sort_keys=True)

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
                    last_sig = sig
                    logger.info("STATUS changed; preparing to run task")
                    status_display = summary or json.dumps(payload, indent=2)
                    if not isinstance(status_display, str):
                        status_display = json.dumps(status_display, indent=2)
                    this_event_prompt = (
                        f"Previous status signature:\n{previous_status}\n\n"
                        f"New status:\n{status_display}\n\nTask:\n{prompt}"
                    )

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
