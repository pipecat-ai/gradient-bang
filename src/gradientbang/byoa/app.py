"""``uv run byoa`` entry point — the BYOA harness.

Bare ``byoa`` runs one BYOA session: read env, build prompt, build LLM, run
the TaskAgent against the wake-supplied channel until task finish or signal.
This is what wake_agent invokes inside the Vercel Sandbox.

``byoa --serve`` starts a local-dev HTTP wake provider (see :mod:`serve`).

The harness reads its config purely from ``os.environ`` — no ``.env`` files,
no implicit fallback. Whoever creates the sandbox / spawns the process
(wake_agent in production, the local serve daemon in dev) is responsible for
populating the env vars.

Two intended customisation modes:

* **Mode A** — set env vars (``BYOA_PROMPT``, ``TASK_LLM_PROVIDER``, …) and
  run the bundled harness unchanged.
* **Mode B** — instantiate :class:`ByoaApp` in your own ``module:main``,
  attach lifecycle hooks via ``@app.prompt`` / ``@app.llm`` /
  ``@app.on_session_start`` / ``@app.on_session_end``, rebind the ``byoa``
  console script in your fork's ``pyproject.byoa.toml`` to point at it.
"""

from __future__ import annotations

import argparse
import asyncio
import inspect
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional, TypeVar, Union

from loguru import logger

from gradientbang.byoa.config import ByoaAgentConfig

PROMPT_MAX_BYTES = 8192

T = TypeVar("T")
HookResult = Union[T, Awaitable[T]]


class ByoaConfigError(RuntimeError):
    """Raised when required BYOA env vars are missing or malformed."""


# ── Context ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ByoaContext:
    """All inputs the harness needs for one session, pulled from env.

    Hooks receive this object. Fields are documented in ``docs/byoa.md``.
    """

    ship_id: str
    character_id: str
    channel: str
    bus_dsn: str
    prompt: Optional[str]
    config: ByoaAgentConfig
    task_id: Optional[str]
    wake_request_id: Optional[str]

    @classmethod
    def from_env(cls) -> "ByoaContext":
        return cls(
            ship_id=_require("BYOA_SHIP_ID"),
            character_id=_require("BYOA_CHARACTER_ID"),
            channel=_require("BYOA_CHANNEL"),
            bus_dsn=_require("BYOA_BUS_DATABASE_URL"),
            prompt=_load_prompt(),
            config=ByoaAgentConfig.from_env(),
            task_id=os.environ.get("BYOA_TASK_ID") or None,
            wake_request_id=os.environ.get("BYOA_WAKE_REQUEST_ID") or None,
        )


def _require(env_key: str) -> str:
    value = (os.environ.get(env_key) or "").strip()
    if not value:
        raise ByoaConfigError(f"{env_key} is required")
    return value


def _load_prompt() -> Optional[str]:
    """Resolve the operator's custom prompt from env.

    Precedence: ``BYOA_PROMPT`` (inline) wins over ``BYOA_PROMPT_FILE``.
    Returns ``None`` when neither is set — the harness then runs against
    the unmodified base TaskAgent prompt.
    """
    inline = (os.environ.get("BYOA_PROMPT") or "").strip()
    if inline:
        if len(inline.encode("utf-8")) > PROMPT_MAX_BYTES:
            raise ByoaConfigError(
                f"BYOA_PROMPT exceeds {PROMPT_MAX_BYTES}-byte cap"
            )
        return inline

    path_str = (os.environ.get("BYOA_PROMPT_FILE") or "").strip()
    if not path_str:
        return None
    path = Path(path_str)
    if not path.exists():
        raise ByoaConfigError(f"BYOA_PROMPT_FILE not found: {path}")
    raw = path.read_bytes()
    if not raw.strip():
        raise ByoaConfigError(f"BYOA_PROMPT_FILE is empty: {path}")
    if len(raw) > PROMPT_MAX_BYTES:
        raise ByoaConfigError(
            f"BYOA_PROMPT_FILE exceeds {PROMPT_MAX_BYTES}-byte cap: "
            f"{path} is {len(raw)} bytes"
        )
    return raw.decode("utf-8")


# ── App ───────────────────────────────────────────────────────────────────


PromptHook = Callable[[ByoaContext], HookResult[Optional[str]]]
LLMHook = Callable[[ByoaContext], HookResult[Any]]
LifecycleHook = Callable[[ByoaContext], HookResult[None]]


class ByoaApp:
    """Default BYOA harness.

    Run ``ByoaApp().run()`` for the zero-config path, or instantiate, attach
    hooks, then run::

        from gradientbang.byoa import ByoaApp
        app = ByoaApp()

        @app.prompt
        def my_prompt(ctx):
            return ctx.prompt + "\\n\\nExtra instructions: ..."

        @app.llm
        def my_llm(ctx):
            from pipecat.services.aws.llm import AWSBedrockLLMService
            return AWSBedrockLLMService(aws_region="us-west-2", model="...")

        if __name__ == "__main__":
            app.run()
    """

    def __init__(self) -> None:
        self._prompt_hook: Optional[PromptHook] = None
        self._llm_hook: Optional[LLMHook] = None
        self._on_session_start: Optional[LifecycleHook] = None
        self._on_session_end: Optional[LifecycleHook] = None

    # ── Decorators ────────────────────────────────────────────────────

    def prompt(self, fn: PromptHook) -> PromptHook:
        """Override how the TaskAgent's custom prompt is built.

        Receives the :class:`ByoaContext`, returns the operator prompt string
        (or ``None`` to skip operator augmentation entirely). Whatever you
        return is appended to the base TaskAgent system prompt via
        ``build_task_agent_prompt(custom_prompt=...)``.
        """
        self._prompt_hook = fn
        return fn

    def llm(self, fn: LLMHook) -> LLMHook:
        """Override how the pipecat LLMService is constructed.

        Receives the :class:`ByoaContext`, returns a
        ``pipecat.services.llm_service.LLMService`` instance. Use this to
        select any pipecat-supported provider or wrap a custom backend.
        """
        self._llm_hook = fn
        return fn

    def on_session_start(self, fn: LifecycleHook) -> LifecycleHook:
        """Run once before the TaskAgent starts. May be sync or async."""
        self._on_session_start = fn
        return fn

    def on_session_end(self, fn: LifecycleHook) -> LifecycleHook:
        """Run once after the TaskAgent stops (success or failure)."""
        self._on_session_end = fn
        return fn

    # ── Entry points ──────────────────────────────────────────────────

    def run(self) -> None:
        """Blocking entry: run one session and return when the agent stops."""
        asyncio.run(self.run_async())

    async def run_async(self) -> None:
        """Async entry. Use when you need to drive the event loop yourself."""
        ctx = ByoaContext.from_env()

        provider = os.getenv("TASK_LLM_PROVIDER", "google").strip().lower()
        model = os.getenv("TASK_LLM_MODEL", "(provider default)").strip()
        thinking = os.getenv("TASK_LLM_THINKING_BUDGET", "4096").strip()
        _log_startup_banner(
            mode="run (single session)",
            fields=[
                ("ship_id", _short(ctx.ship_id)),
                ("character_id", _short(ctx.character_id)),
                ("channel_prefix", ctx.channel[:11]),
                ("task_id", _short(ctx.task_id) if ctx.task_id else "(none)"),
                ("task_llm", f"{provider}/{model}  thinking={thinking}"),
                ("prompt", _prompt_summary(ctx.prompt)),
                ("hooks", _hooks_summary(self)),
            ],
        )

        # Lazy imports — keep startup light when this module is imported just
        # for type/annotation purposes (e.g. by a Mode-B operator's hooks file
        # at install time).
        from pipecat.pipeline.runner import PipelineRunner

        from gradientbang.adapters.bus.pgmq import build_pgmq_bus
        from gradientbang.runtime.subagents.task_agent import TaskAgent

        prompt = await _maybe_await(self._prompt_hook, ctx) if self._prompt_hook else ctx.prompt
        llm_override = await _maybe_await(self._llm_hook, ctx) if self._llm_hook else None

        bus = await build_pgmq_bus(
            database_url=ctx.bus_dsn,
            channel=ctx.channel,
        )

        agent_name = f"byoa_{ctx.ship_id}"
        runner = PipelineRunner(
            name=f"byoa_runner_{ctx.ship_id}",
            bus=bus,
            handle_sigint=True,
        )
        # TaskAgent's character_id is the SHIP's pseudo-character (the
        # subject of every game tool call). Authorization is the bus channel
        # (capability) + corp membership + ship_byoa_configure ownership.
        agent = TaskAgent(
            agent_name,
            character_id=ctx.ship_id,
            is_corp_ship=True,
            task_metadata={
                "actor_character_id": ctx.character_id,
                "task_scope": "byoa",
            },
            byoa_config=ctx.config,
            custom_prompt=prompt,
            llm_override=llm_override,
        )

        if self._on_session_start is not None:
            await _maybe_await(self._on_session_start, ctx)

        logger.info(
            f"byoa.app.session.starting agent={agent_name} "
            f"channel_prefix={ctx.channel[:11]} task={ctx.task_id!s}"
        )
        try:
            await runner.add_workers(agent)
            await runner.run()
        finally:
            if self._on_session_end is not None:
                try:
                    await _maybe_await(self._on_session_end, ctx)
                except Exception:
                    logger.exception("byoa.app.on_session_end.failed")
            try:
                await bus.stop()
            except Exception:
                logger.exception("byoa.app.bus.stop_failed")


async def _maybe_await(fn: Callable[..., HookResult[T]], *args: Any) -> T:
    """Invoke a hook that may be sync or async; await the latter."""
    result = fn(*args)
    if inspect.isawaitable(result):
        return await result
    return result  # type: ignore[return-value]


# ── Startup banner ────────────────────────────────────────────────────────


def _short(value: Optional[str], n: int = 8) -> str:
    if not value:
        return "(none)"
    return f"{value[:n]}…" if len(value) > n else value


def _prompt_summary(prompt: Optional[str]) -> str:
    if not prompt:
        return "(base only)"
    return f"custom ({len(prompt.encode('utf-8'))} bytes)"


def _hooks_summary(app: "ByoaApp") -> str:
    names = []
    if app._prompt_hook is not None:
        names.append("prompt")
    if app._llm_hook is not None:
        names.append("llm")
    if app._on_session_start is not None:
        names.append("on_session_start")
    if app._on_session_end is not None:
        names.append("on_session_end")
    return " ".join(names) if names else "(none)"


def _log_startup_banner(*, mode: str, fields: list[tuple[str, str]]) -> None:
    """Mirror bot.py's startup banner for the BYOA harness.

    Logged as a single ``logger.info`` call so the banner stays atomic in
    line-buffered log destinations (Vercel Sandbox stdout, file sinks, …).
    """
    from gradientbang import __version__
    from gradientbang.pipecat_server import STARTUP_BANNER

    divider = "─" * 103
    lines = [
        divider,
        STARTUP_BANNER.strip("\n"),
        "",
        f"  mode               {mode}",
        f"  version            {__version__}",
    ]
    for label, value in fields:
        lines.append(f"  {label:<19}{value}")
    lines.append(divider)
    logger.info("\n" + "\n".join(lines))


# ── CLI ───────────────────────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="byoa",
        description=(
            "Bring-Your-Own-Agent harness for Gradient Bang. "
            "Bare invocation runs one session reading env vars; --serve "
            "starts a local-dev HTTP wake provider."
        ),
    )
    parser.add_argument(
        "--serve",
        action="store_true",
        help=(
            "Run the local-dev HTTP wake provider instead of a single "
            "session. Each POST /wake spawns `uv run byoa` as a child."
        ),
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Wake daemon host (only used with --serve). Default 127.0.0.1.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="Wake daemon port (only used with --serve). Default 8765.",
    )
    return parser


def main() -> None:
    args = _build_parser().parse_args()
    try:
        if args.serve:
            from gradientbang.byoa.serve import run_wake_daemon

            run_wake_daemon(host=args.host, port=args.port)
            return
        from gradientbang.utils.logging_config import configure_logging

        configure_logging()
        ByoaApp().run()
    except ByoaConfigError as exc:
        print(f"byoa: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
