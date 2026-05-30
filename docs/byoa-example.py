"""Minimal BYOA custom harness.

Copy this file into your BYOA fork when prompt-only configuration is not
enough. It still uses the bundled Gradient Bang TaskAgent and bus wiring; the
decorators only customize the parts an operator usually wants to own.

To make this your entry point, point the `byoa` console script in your fork's
`pyproject.byoa.toml` at this module's `main` function.
"""

from __future__ import annotations

from loguru import logger

from gradientbang.runtime.byoa import ByoaApp, ByoaCombatWake, ByoaContext


app = ByoaApp()


@app.prompt
def build_prompt(ctx: ByoaContext) -> str:
    """Return the operator prompt appended to the base TaskAgent prompt."""

    operator_prompt = ctx.prompt or ""
    task_engine_rules = """
You are running a corporation ship.

Primary behavior:
- Prefer profitable, low-risk work.
- Keep enough fuel to return to a safe sector.
- Avoid combat unless the task explicitly calls for it.
- Report meaningful progress when a task changes direction.
- Finish the task cleanly when the objective is complete or impossible.
""".strip()

    if operator_prompt:
        return f"{operator_prompt}\n\n{task_engine_rules}"
    return task_engine_rules


@app.on_session_start
def on_session_start(ctx: ByoaContext) -> None:
    """Run once after wake, before the TaskAgent starts processing."""

    logger.info(
        "custom_byoa.session_start ship_id={} task_id={}",
        ctx.ship_id,
        ctx.task_id,
    )


@app.on_session_end
def on_session_end(ctx: ByoaContext) -> None:
    """Run once when the TaskAgent exits."""

    logger.info(
        "custom_byoa.session_end ship_id={} task_id={}",
        ctx.ship_id,
        ctx.task_id,
    )


@app.on_combat_wake
def on_combat_wake(ctx: ByoaContext, wake: ByoaCombatWake) -> ByoaCombatWake | None:
    """Optionally replace the combat wake before the task context resets."""

    logger.info(
        "custom_byoa.combat_wake ship_id={} task_id={}",
        ctx.ship_id,
        ctx.task_id,
    )

    # Return None to use the default combat goal. Return a replacement wake
    # when your agent should bias combat differently from the bundled prompt.
    return ByoaCombatWake(
        goal=(
            f"{wake.goal}\n\n"
            "Operator combat preference: preserve the ship first; flee if the "
            "opponent looks stronger, otherwise brace or attack conservatively."
        ),
        context=wake.context,
    )


# Optional: override model construction.
#
# Leave this commented to use TASK_LLM_PROVIDER, TASK_LLM_MODEL,
# TASK_LLM_THINKING_BUDGET, and the matching provider API key from
# `.env.byoa` or your Vercel project env.
#
# @app.llm
# def build_llm(ctx: ByoaContext):
#     """Return any pipecat LLMService instance."""
#     import os
#
#     from pipecat.services.openai.llm import OpenAILLMService
#
#     return OpenAILLMService(
#         api_key=os.environ["OPENAI_API_KEY"],
#         settings=OpenAILLMService.Settings(model="gpt-4.1-mini"),
#     )


def main() -> None:
    app.run()


if __name__ == "__main__":
    main()
