#!/usr/bin/env python3
"""Command-line entrypoint for running a task agent on a character or corp ship.

A minimal launcher agent creates a TaskAgent child, sends it a task via bus
protocol, and shuts down the runner when the task completes.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from loguru import logger

from gradientbang.utils.config import get_repo_root
from gradientbang.utils.supabase_client import AsyncGameClient, RPCError

DEFAULT_MODEL = os.getenv("TASK_LLM_MODEL", "gemini-2.5-flash-preview-09-2025")

logger.enable("pipecat")
_log_level = os.getenv("LOGURU_LEVEL", "INFO").upper()
logger.configure(handlers=[{"sink": sys.stderr, "level": _log_level}])

REPO_ROOT = get_repo_root()
SESSION_LOCK_DIR = REPO_ROOT / "logs" / "ship-sessions"


class SessionLockError(RuntimeError):
    """Raised when a ship already has an active TaskAgent session."""


def _pid_is_active(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _acquire_ship_session_lock(
    ship_id: str,
    *,
    actor_id: str,
    server: str,
) -> callable:
    SESSION_LOCK_DIR.mkdir(parents=True, exist_ok=True)
    lock_path = SESSION_LOCK_DIR / f"{ship_id}.lock"
    metadata = {
        "ship_id": ship_id,
        "actor_id": actor_id,
        "server": server,
        "pid": os.getpid(),
        "started_at": datetime.now(timezone.utc).isoformat(),
    }

    while True:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            existing: dict[str, str] = {}
            with suppress(Exception):
                with lock_path.open("r", encoding="utf-8") as handle:
                    existing = json.load(handle)
            pid = existing.get("pid")
            if isinstance(pid, int) and _pid_is_active(pid):
                actor = existing.get("actor_id", "unknown actor")
                started = existing.get("started_at", "unknown time")
                raise SessionLockError(
                    f"ship {ship_id} already has an active TaskAgent session "
                    f"(pid {pid}, actor {actor}, started {started})"
                )
            with suppress(FileNotFoundError):
                lock_path.unlink()
            continue
        else:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(metadata, handle)
            break

    def release() -> None:
        with suppress(FileNotFoundError):
            lock_path.unlink()

    return release


def _log_join_error(
    exc: RPCError,
    *,
    actor_id: str | None,
    target_id: str,
) -> None:
    detail = (getattr(exc, "detail", "") or str(exc)).strip()
    status = getattr(exc, "status", "unknown")
    logger.error(
        "JOIN failed status={} detail={} actor={} target={}",
        status,
        detail,
        actor_id or target_id,
        target_id,
    )

    lower_detail = detail.lower()
    if "actor_character_id is required" in lower_detail:
        logger.info(
            "Provide a corporation member with --ship-id. "
            'Example: uv run npc/run_npc.py corp-member --ship-id {} "<task>"',
            target_id,
        )
    elif "not authorized" in lower_detail:
        logger.info(
            "Actor {} is not in the owning corporation for ship {}.",
            actor_id,
            target_id,
        )
    elif "not registered" in lower_detail:
        logger.info(
            "Register ship {} in the character registry before launching the agent.",
            target_id,
        )
    elif "has an active session" in lower_detail:
        logger.info(
            "Wait for the existing TaskAgent run on ship {} to finish or clear the lock.",
            target_id,
        )
    elif "knowledge" in lower_detail:
        logger.info(
            "Create world-data/character-map-knowledge/{}.json before retrying.",
            target_id,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a task agent on a character or corporation ship",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s npc-02 "Where am I?"
  %(prog)s corp-member-01 --ship-id ship-123 "Move to sector 5 and scan"

Environment Variables:
  GOOGLE_API_KEY             Required. Google Generative AI key.
  SUPABASE_URL               Required. Base URL for Supabase (edge functions + REST).
""",
    )

    parser.add_argument(
        "actor_id",
        help="Character issuing the task (use this character directly unless controlling a corporation ship)",
    )
    parser.add_argument("task", help="Task description to execute")

    parser.add_argument(
        "--server",
        default=os.getenv("SUPABASE_URL"),
        help="Supabase base URL (default: SUPABASE_URL)",
    )

    parser.add_argument(
        "--model",
        default=os.getenv("AGENT_MODEL", DEFAULT_MODEL),
        help="Gemini model name (default: %(default)s)",
    )
    parser.add_argument(
        "--ship-id",
        dest="ship_id",
        help="Corporation ship ID (character_id) to control; cannot equal actor_id",
    )

    args = parser.parse_args()

    if args.ship_id and args.ship_id == args.actor_id:
        parser.error(
            "--ship-id must differ from actor_id. Omit --ship-id to control the actor directly."
        )

    return args


async def run_task(args: argparse.Namespace) -> int:
    if not args.server:
        logger.error("SUPABASE_URL is required (or pass --server).")
        return 1
    target_character_id = args.ship_id or args.actor_id
    actor_character_id = args.actor_id if args.ship_id else None

    from gradientbang.subagents.agents.base_agent import BaseAgent
    from gradientbang.subagents.runner import AgentRunner
    from gradientbang.subagents.types import TaskStatus

    from gradientbang.pipecat_server.subagents.task_agent import TaskAgent

    success = False
    async with AsyncGameClient(
        base_url=args.server,
        character_id=target_character_id,
        actor_character_id=actor_character_id,
        entity_type="corporation_ship" if args.ship_id else "character",
    ) as game_client:
        logger.info(
            "CONNECT server={server} target={target} actor={actor}",
            server=args.server,
            target=target_character_id,
            actor=actor_character_id or target_character_id,
        )

        try:
            await game_client.join(target_character_id)
        except RPCError as exc:
            _log_join_error(
                exc,
                actor_id=actor_character_id,
                target_id=target_character_id,
            )
            return 1

        logger.info("JOINED target={}", target_character_id)

        # Minimal launcher agent that starts a TaskAgent child and waits for completion.
        task_done = asyncio.Event()
        task_success = {"value": False}

        class Launcher(BaseAgent):
            def __init__(self, name, *, bus):
                super().__init__(name, bus=bus)

            async def build_pipeline(self):
                return None

            async def on_task_response(self, message):
                await super().on_task_response(message)
                task_success["value"] = message.status == TaskStatus.COMPLETED
                task_done.set()

            async def on_task_completed(self, result):
                await super().on_task_completed(result)
                task_done.set()

        runner = AgentRunner(handle_sigint=True)
        launcher = Launcher("launcher", bus=runner.bus)
        await runner.add_agent(launcher)

        @runner.event_handler("on_ready")
        async def on_ready(r):
            task_agent = TaskAgent(
                "npc_task",
                bus=runner.bus,
                game_client=game_client,
                character_id=target_character_id,
                is_corp_ship=bool(args.ship_id),
            )
            await launcher.start_task(
                task_agent,
                payload={"task_description": args.task},
            )

        # Run in background, wait for task completion
        runner_task = asyncio.create_task(runner.run())
        try:
            await task_done.wait()
            success = task_success["value"]
        except asyncio.CancelledError:
            pass
        finally:
            await runner.end()
            with suppress(asyncio.CancelledError):
                await runner_task

        if success:
            logger.info("TASK_COMPLETE status=success")
        else:
            logger.warning("TASK_INCOMPLETE")

        with suppress(Exception):
            final_status = await game_client.my_status(target_character_id)
            summary = final_status.get("summary")
            if summary:
                logger.info("FINAL_STATUS {}", summary)

    return 0 if success else 1


def main() -> int:
    args = parse_args()
    release_lock = None
    try:
        if args.ship_id:
            try:
                release_lock = _acquire_ship_session_lock(
                    args.ship_id,
                    actor_id=args.actor_id,
                    server=args.server,
                )
            except SessionLockError as exc:
                logger.error(str(exc))
                logger.info(
                    "If this is stale, remove the lock file in {}",
                    SESSION_LOCK_DIR,
                )
                return 1

        return asyncio.run(run_task(args))
    except KeyboardInterrupt:
        logger.info("INTERRUPTED by user")
        return 130
    except Exception as exc:  # pragma: no cover - diagnostic path
        logger.exception("ERROR: {}", exc)
        return 1
    finally:
        if release_lock:
            release_lock()


if __name__ == "__main__":
    sys.exit(main())
