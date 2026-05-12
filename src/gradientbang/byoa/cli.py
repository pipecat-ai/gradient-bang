"""``uv run byoa`` entry point.

Runs a single BYOA TaskAgent against a single corp ship, talking the
subagent bus the bot already speaks. Reuses every primitive shipped in
Phases 1-3:

- The TaskAgent code from ``pipecat_server.subagents.task_agent`` (Phase 1
  contract — the bundled agent IS the BYOA reference implementation).
- ``make_subagent_bus()`` (Phase 2 + Phase 3 ``byoa_pgmq`` branch) for
  the token-gated PGMQ transport.
- ``ByoaAgentConfig`` for heartbeat / timeout tunables.

Configuration is env-driven from ``./.env.byoa`` (loaded via python-dotenv
without overriding shell env, so individual values can be overridden on
the command line). See ``env.byoa.example`` for the canonical template
and ``docs/setup-byoa.md`` for the operator quickstart.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from loguru import logger

# Hard cap on operator-supplied prompt content. Larger files refuse to
# start. Caps per-task context bloat the operator can introduce and keeps
# the appended block from dominating the base prompt.
PROMPT_MAX_BYTES = 8192
DEFAULT_ENV_FILE = ".env.byoa"


class CliError(Exception):
    """Raised for operator-facing configuration errors. The main()
    wrapper translates these into a clean stderr message + exit 1
    instead of a Python traceback the operator has to read through."""


def _load_prompt(path: Path) -> str:
    """Read + validate the operator's custom-prompt file.

    Returns the decoded UTF-8 contents. Raises ``CliError`` with an
    actionable message on missing / empty / oversize files.
    """
    if not path.exists():
        raise CliError(f"prompt file not found: {path}")
    raw = path.read_bytes()
    if not raw.strip():
        raise CliError(f"prompt file is empty: {path}")
    if len(raw) > PROMPT_MAX_BYTES:
        raise CliError(
            f"prompt file exceeds {PROMPT_MAX_BYTES}-byte cap: "
            f"{path} is {len(raw)} bytes"
        )
    return raw.decode("utf-8")


def _resolve_env_file(arg: Optional[str]) -> Path:
    """Default to ``./.env.byoa``; honor ``--env-file`` override."""
    return Path(arg) if arg else Path(DEFAULT_ENV_FILE)


def _require(arg_value: Optional[str], env_key: str, flag: str) -> str:
    """Resolve a required value from CLI arg → env, in that order."""
    if arg_value:
        return arg_value
    env_value = os.environ.get(env_key, "").strip()
    if env_value:
        return env_value
    raise CliError(f"{flag} is required (or set {env_key})")


async def run(args: argparse.Namespace) -> int:
    """Async entry point. Wired so unit tests can call it directly."""
    env_file = _resolve_env_file(args.env_file)
    if env_file.exists():
        # Don't override shell env so operators can rotate individual
        # values without rewriting the file (standard dotenv pattern).
        load_dotenv(env_file, override=False)
        logger.info(f"byoa.cli.env_loaded path={str(env_file)!r}")
    else:
        logger.info(
            f"byoa.cli.env_file_absent path={str(env_file)!r} — relying on shell env"
        )

    # Resolve required inputs. CLI args win over env values; missing
    # values produce a clear error rather than a vague downstream
    # crash.
    prompt_file_raw = args.prompt_file or os.environ.get("BYOA_PROMPT_FILE", "").strip()
    if not prompt_file_raw:
        raise CliError("--prompt-file is required (or set BYOA_PROMPT_FILE)")
    custom_prompt = _load_prompt(Path(prompt_file_raw))

    ship_id = _require(args.ship_id, "BYOA_SHIP_ID", "--ship-id")
    character_id = _require(
        args.character_id, "BYOA_CHARACTER_ID", "--character-id"
    )

    # Late imports so unit tests of arg parsing / file validation don't
    # pull in the full pipecat/asyncpg/etc. dependency graph.
    from pipecat_subagents.runner import AgentRunner

    from gradientbang.adapters.bus import make_subagent_bus
    from gradientbang.byoa.config import ByoaAgentConfig
    from gradientbang.pipecat_server.subagents.task_agent import TaskAgent

    config = ByoaAgentConfig.from_env()
    warn = config.validate_heartbeat_against_server()
    if warn:
        logger.warning(warn)

    bus = await make_subagent_bus()
    runner = AgentRunner(bus=bus, handle_sigint=True)

    # Bus identity convention — must match VoiceAgent.byoa_agent_name().
    # The bot publishes BusTaskRequest to this exact name; the operator's
    # agent registers under it on the bus.
    agent_name = f"byoa_{ship_id}"

    task_agent = TaskAgent(
        agent_name,
        bus=bus,
        # TaskAgent's character_id is the SHIP's pseudo-character (the
        # subject of every game tool call). The BYOA token bound to the
        # operator's real character is authorized to act on the ship via
        # corp membership + ship_byoa_configure ownership.
        character_id=ship_id,
        is_corp_ship=True,
        task_metadata={
            "actor_character_id": character_id,
            "task_scope": "byoa",
        },
        byoa_config=config,
        custom_prompt=custom_prompt,
    )
    await runner.add_agent(task_agent)

    logger.info(
        f"byoa.cli.starting agent={agent_name} "
        f"ship={ship_id[:8]} character={character_id[:8]} "
        f"prompt_bytes={len(custom_prompt.encode('utf-8'))}"
    )
    await runner.run()
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="byoa",
        description=(
            "Run a Bring-Your-Own-Agent task agent against a Gradient Bang "
            "corp ship. Reads BYOA_TOKEN, SUBAGENT_BUS_* and identity vars "
            "from .env.byoa (or --env-file)."
        ),
    )
    parser.add_argument(
        "--prompt-file",
        default=None,
        help="Path to operator-supplied system prompt markdown "
        "(or set BYOA_PROMPT_FILE). Required.",
    )
    parser.add_argument(
        "--ship-id",
        default=None,
        help="Corp ship pseudo-character_id (or set BYOA_SHIP_ID). Required.",
    )
    parser.add_argument(
        "--character-id",
        default=None,
        help="Operator's character_id the BYOA token is bound to "
        "(or set BYOA_CHARACTER_ID). Required.",
    )
    parser.add_argument(
        "--env-file",
        default=None,
        help=f"Path to env file; defaults to ./{DEFAULT_ENV_FILE}. "
        "Shell env always wins over file values.",
    )
    return parser


def main() -> None:
    """Console-script entry point. Translates ``CliError`` to clean exit-1."""
    args = _build_parser().parse_args()
    try:
        sys.exit(asyncio.run(run(args)))
    except CliError as exc:
        print(f"byoa: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
