"""``uv run byoa`` entry point.

Runs a single BYOA TaskAgent against a single corp ship. The flow is:

1. Poll ``byoa_session_claim`` with the operator's HS256 BYOA token until
   the server reports a channel allocated for the bound ship.
2. Build the per-session PGMQ bus (``build_byoa_pgmq_bus``) and join it.
3. Run the TaskAgent until the bot signals task completion.
4. If the server's ``lifecycle_hint`` is ``single_task`` (prod), exit.
   Otherwise (``idle_loop``, dev), tear down the bus and resume polling.

Configuration is env-driven from ``./.env.byoa`` (loaded via python-dotenv
without overriding shell env). See ``env.byoa.example`` for the canonical
template and ``docs/setup-byoa.md`` for the operator quickstart.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import signal
import sys
from pathlib import Path
from typing import Any, Optional

import httpx
from dotenv import load_dotenv
from loguru import logger

PROMPT_MAX_BYTES = 8192
DEFAULT_ENV_FILE = ".env.byoa"
# HTTP timeout for byoa_session_claim. The endpoint returns immediately
# (short-poll), so a few seconds is plenty. Network blips fall through
# to the next poll iteration.
CLAIM_HTTP_TIMEOUT_SECONDS = 10.0


class CliError(Exception):
    """Raised for operator-facing configuration errors. The main()
    wrapper translates these into a clean stderr message + exit 1."""


def _load_prompt(path: Path) -> str:
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
    return Path(arg) if arg else Path(DEFAULT_ENV_FILE)


def _require(arg_value: Optional[str], env_key: str, flag: str) -> str:
    if arg_value:
        return arg_value
    env_value = os.environ.get(env_key, "").strip()
    if env_value:
        return env_value
    raise CliError(f"{flag} is required (or set {env_key})")


async def _call_claim(
    client: httpx.AsyncClient,
    url: str,
    token: str,
    ship_id: str,
) -> dict[str, Any]:
    """Single ``byoa_session_claim`` HTTP call.

    Returns the decoded JSON body on 200; raises :class:`CliError` for
    auth failures the operator must fix; returns ``{}`` for transient
    errors so the poll loop can retry.
    """
    try:
        resp = await client.post(
            url,
            json={"ship_id": ship_id},
            headers={"Authorization": f"Bearer {token}"},
            timeout=CLAIM_HTTP_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        logger.warning(f"byoa.cli.claim.network_error error={exc!r}")
        return {}

    if resp.status_code == 401:
        raise CliError(
            "byoa_session_claim rejected the BYOA token (401). "
            "Mint a fresh token via byoa_token_mint or update BYOA_TOKEN."
        )
    if resp.status_code == 403:
        raise CliError(
            "byoa_session_claim says the token's character is not authorized "
            "on BYOA_SHIP_ID (403). Verify ship ownership and corp membership."
        )
    if resp.status_code == 404:
        raise CliError(
            "byoa_session_claim says BYOA_SHIP_ID does not exist (404)."
        )
    if resp.status_code >= 500:
        logger.warning(f"byoa.cli.claim.server_error status={resp.status_code}")
        return {}
    if resp.status_code != 200:
        logger.warning(
            f"byoa.cli.claim.unexpected_status status={resp.status_code} body={resp.text!r}"
        )
        return {}

    try:
        return resp.json()
    except ValueError as exc:
        logger.warning(f"byoa.cli.claim.bad_json error={exc!r}")
        return {}


async def _wait_for_session(
    client: httpx.AsyncClient,
    url: str,
    token: str,
    ship_id: str,
    poll_interval: float,
    shutdown: asyncio.Event,
) -> Optional[dict[str, Any]]:
    """Poll ``byoa_session_claim`` until a channel is allocated.

    Returns the claim response (with ``channel`` set) once allocated, or
    None if ``shutdown`` fires before that.
    """
    logger.info(
        f"byoa.cli.claim.polling ship={ship_id[:8]} url={url!r} interval={poll_interval}s"
    )
    while not shutdown.is_set():
        body = await _call_claim(client, url, token, ship_id)
        channel = body.get("channel") if isinstance(body, dict) else None
        if isinstance(channel, str) and channel.strip():
            logger.info(
                f"byoa.cli.claim.allocated ship={ship_id[:8]} channel={channel!r} "
                f"task={body.get('current_task_id', '<none>')!s} "
                f"lifecycle={body.get('lifecycle_hint', '<unknown>')!s}"
            )
            return body
        try:
            await asyncio.wait_for(shutdown.wait(), timeout=poll_interval)
        except asyncio.TimeoutError:
            continue
    return None


async def _run_one_session(
    *,
    session: dict[str, Any],
    runner_name: str,
    agent_name: str,
    ship_id: str,
    character_id: str,
    custom_prompt: str,
    config,  # ByoaAgentConfig
) -> None:
    """Build the bus, run the TaskAgent until task finish, then tear down.

    Imports the heavy dependencies lazily so the CLI's arg-parse + config
    paths stay free of pipecat / asyncpg for fast unit tests.
    """
    from pipecat_subagents.runner import AgentRunner

    from gradientbang.adapters.bus.byoa_pgmq import build_byoa_pgmq_bus
    from gradientbang.pipecat_server.subagents.task_agent import TaskAgent

    channel = session["channel"]
    bus = await build_byoa_pgmq_bus(channel=channel)
    runner = AgentRunner(name=runner_name, bus=bus, handle_sigint=True)
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
        f"byoa.cli.session.starting agent={agent_name} channel={channel!r} "
        f"task={session.get('current_task_id', '<none>')!s}"
    )
    try:
        await runner.run()
    finally:
        try:
            await bus.stop()
        except Exception:
            logger.exception("byoa.cli.bus.stop_failed")


async def run(args: argparse.Namespace) -> int:
    """Async entry point."""
    env_file = _resolve_env_file(args.env_file)
    if env_file.exists():
        load_dotenv(env_file, override=False)
        logger.info(f"byoa.cli.env_loaded path={str(env_file)!r}")
    else:
        logger.info(
            f"byoa.cli.env_file_absent path={str(env_file)!r} — relying on shell env"
        )

    # Single-host dev convenience: when BYOA runs in the bot's checkout,
    # fall back to .env.bot for TASK_LLM_* and LLM API keys.
    bot_env = Path(".env.bot")
    if bot_env.exists():
        load_dotenv(bot_env, override=False)
        logger.info(f"byoa.cli.bot_env_loaded path={str(bot_env)!r}")

    prompt_file_raw = args.prompt_file or os.environ.get("BYOA_PROMPT_FILE", "").strip()
    if not prompt_file_raw:
        raise CliError("--prompt-file is required (or set BYOA_PROMPT_FILE)")
    custom_prompt = _load_prompt(Path(prompt_file_raw))

    ship_id = _require(args.ship_id, "BYOA_SHIP_ID", "--ship-id")
    character_id = _require(
        args.character_id, "BYOA_CHARACTER_ID", "--character-id"
    )

    token = os.environ.get("BYOA_TOKEN", "").strip()
    if not token:
        raise CliError("BYOA_TOKEN is required")

    # Lazy imports so argparse / config-validation paths stay light.
    from gradientbang.byoa.config import ByoaAgentConfig

    config = ByoaAgentConfig.from_env()
    warn = config.validate_heartbeat_against_server()
    if warn:
        logger.warning(warn)

    claim_url = config.claim_endpoint_url.strip()
    if not claim_url:
        raise CliError(
            "BYOA_CLAIM_ENDPOINT_URL is required "
            "(e.g. https://<project>.supabase.co/functions/v1/byoa_session_claim)"
        )

    agent_name = f"byoa_{ship_id}"
    runner_name = f"byoa_runner_{ship_id}"

    shutdown = asyncio.Event()

    def _request_shutdown(*_: Any) -> None:
        if not shutdown.is_set():
            logger.info("byoa.cli.shutdown.signal")
            shutdown.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _request_shutdown)
        except NotImplementedError:
            # Windows / restricted runtimes — fall through to default handler.
            signal.signal(sig, _request_shutdown)

    async with httpx.AsyncClient() as http:
        while not shutdown.is_set():
            session = await _wait_for_session(
                http,
                claim_url,
                token,
                ship_id,
                config.poll_interval_seconds,
                shutdown,
            )
            if session is None:
                break
            await _run_one_session(
                session=session,
                runner_name=runner_name,
                agent_name=agent_name,
                ship_id=ship_id,
                character_id=character_id,
                custom_prompt=custom_prompt,
                config=config,
            )
            hint = (
                session.get("lifecycle_hint")
                if isinstance(session, dict)
                else None
            )
            if hint == "single_task":
                logger.info("byoa.cli.lifecycle.single_task_exit")
                break
            logger.info("byoa.cli.lifecycle.idle_resume")

    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="byoa",
        description=(
            "Run a Bring-Your-Own-Agent task agent against a Gradient Bang "
            "corp ship. Discovers its bus channel via byoa_session_claim "
            "(env BYOA_CLAIM_ENDPOINT_URL) and joins it when the bot "
            "delegates a task."
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
    args = _build_parser().parse_args()
    try:
        sys.exit(asyncio.run(run(args)))
    except CliError as exc:
        print(f"byoa: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
