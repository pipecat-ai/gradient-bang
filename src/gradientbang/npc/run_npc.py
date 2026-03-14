#!/usr/bin/env python3
"""Command-line entrypoint for the experimental Pipecat-based task agent."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from contextlib import suppress
from datetime import datetime, timezone
from typing import Callable, Optional

from loguru import logger
from pipecat.services.llm_service import LLMService

from gradientbang.utils.base_llm_agent import LLMConfig
from gradientbang.utils.config import get_repo_root
from gradientbang.utils.llm_factory import (
    LLMProvider,
    LLMServiceConfig,
    UnifiedThinkingConfig,
    create_llm_service,
)
from gradientbang.utils.supabase_client import AsyncGameClient, RPCError
from gradientbang.utils.task_agent import TaskAgent

DEFAULT_MODEL = os.getenv("TASK_LLM_MODEL", "gemini-2.5-flash-preview-09-2025")
DEFAULT_PROVIDER = os.getenv("TASK_LLM_PROVIDER", "google").lower()
DEFAULT_THINKING_BUDGET = int(os.getenv("TASK_LLM_THINKING_BUDGET", "2048"))
DEFAULT_FUNCTION_CALL_TIMEOUT_SECS = float(os.getenv("TASK_LLM_FUNCTION_CALL_TIMEOUT_SECS", "20"))

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
        description="Run the experimental Pipecat-based task agent (supports corporation ships via --ship-id)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s npc-02 "Where am I?"
  %(prog)s corp-member-01 --ship-id ship-123 "Move to sector 5 and scan"
  %(prog)s f923c15c-2a6c-455a-b3c5-7c27ae7c8d50 \\
    --provider openai \\
    --model nemotron-3-super-120b \\
    --openai-base-url https://kwindla--nemotron-super-b200-budget-serve.modal.run \\
    --thinking-budget 1024 \\
    "Where am I?"

Environment Variables:
  TASK_LLM_PROVIDER          LLM provider (google, anthropic, openai)
  TASK_LLM_MODEL             Model name
  TASK_LLM_THINKING_BUDGET   Thinking budget
  TASK_LLM_FUNCTION_CALL_TIMEOUT_SECS  Tool call timeout
  GOOGLE_API_KEY             Google provider key
  ANTHROPIC_API_KEY          Anthropic provider key
  OPENAI_API_KEY             OpenAI/OpenAI-compatible provider key
  OPENAI_BASE_URL            OpenAI-compatible base URL (optional)
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
        default=DEFAULT_MODEL,
        help="Model name (default: TASK_LLM_MODEL or %(default)s)",
    )
    parser.add_argument(
        "--provider",
        choices=[provider.value for provider in LLMProvider],
        default=DEFAULT_PROVIDER,
        help="LLM provider (default: TASK_LLM_PROVIDER or %(default)s)",
    )
    parser.add_argument(
        "--thinking-budget",
        type=int,
        default=DEFAULT_THINKING_BUDGET,
        help="Thinking budget tokens (default: TASK_LLM_THINKING_BUDGET or %(default)s)",
    )
    parser.add_argument(
        "--function-call-timeout-secs",
        type=float,
        default=DEFAULT_FUNCTION_CALL_TIMEOUT_SECS,
        help=(
            "Tool/function call timeout in seconds "
            "(default: TASK_LLM_FUNCTION_CALL_TIMEOUT_SECS or %(default)s)"
        ),
    )
    parser.add_argument(
        "--openai-base-url",
        default=os.getenv("OPENAI_BASE_URL"),
        help=(
            "OpenAI-compatible base URL (optional). "
            "If provided without /v1, /v1 is appended."
        ),
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


def _build_llm_service_factory(args: argparse.Namespace) -> tuple[Callable[[], LLMService], Optional[str]]:
    provider = LLMProvider(args.provider)
    api_key_override: Optional[str] = None
    if provider == LLMProvider.OPENAI and args.openai_base_url and not os.getenv("OPENAI_API_KEY"):
        # Many local OpenAI-compatible endpoints don't validate auth.
        api_key_override = "dummy"
        logger.warning(
            "OPENAI_API_KEY not set; using placeholder key for OpenAI-compatible endpoint."
        )

    config = LLMServiceConfig(
        provider=provider,
        model=args.model,
        api_key=api_key_override,
        thinking=UnifiedThinkingConfig(
            enabled=True,
            budget_tokens=args.thinking_budget,
            include_thoughts=True,
        ),
        function_call_timeout_secs=args.function_call_timeout_secs,
        run_in_parallel=False,
        openai_base_url=args.openai_base_url,
    )

    def _factory() -> LLMService:
        return create_llm_service(config)

    return _factory, args.openai_base_url


async def run_task(args: argparse.Namespace) -> int:
    if not args.server:
        logger.error("SUPABASE_URL is required (or pass --server).")
        return 1
    try:
        llm_service_factory, resolved_openai_base_url = _build_llm_service_factory(args)
    except ValueError as exc:
        logger.error(str(exc))
        return 1

    logger.info(
        "LLM provider={} model={} thinking_budget={} function_call_timeout_secs={} openai_base_url={}",
        args.provider,
        args.model,
        args.thinking_budget,
        args.function_call_timeout_secs,
        resolved_openai_base_url or "(default)",
    )
    target_character_id = args.ship_id or args.actor_id
    actor_character_id = args.actor_id if args.ship_id else None

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
        await game_client.pause_event_delivery()

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

        agent = TaskAgent(
            config=LLMConfig(model=args.model),
            game_client=game_client,
            character_id=target_character_id,
            llm_service_factory=llm_service_factory,
            thinking_budget=args.thinking_budget,
        )

        logger.info('TASK_START task="{}"', args.task)
        success = await agent.run_task(task=args.task)

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
