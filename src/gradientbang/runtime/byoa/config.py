"""Runtime tunables for any TaskAgent (in-process or BYOA).

Agent-side configuration only: RPC timeouts, concurrency ceilings, wake/
teardown windows. The bundled bot reads ``ByoaAgentConfig.from_env()``;
external BYOA operators construct their own dataclass instance directly.

Ship-task locks are per-bot, in-memory — there is no server-side stale
window or heartbeat. Crash detection is via the BYOA presence heartbeat
the agent broadcasts on the bus, combined with the Orchestrator's
``TASK_AGENT_TIMEOUT`` sanity bound.

See docs/setup-byoa.md for the operator-facing env table.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class ByoaAgentConfig:
    """Runtime tunables. Defaults are safe for the bundled in-process agent.

    Construct directly or via env (``ByoaAgentConfig.from_env()``).
    """

    # Reply timeout for an outbound BusGameToolCallRequest. Read by the
    # BYOA TaskAgent.
    tool_call_timeout_seconds: float = 30.0

    # How long the Orchestrator waits for a target agent to signal alive
    # after start_task (via BusAgentHelloRequest/Response). Read by the bot,
    # not by BYOA — operators setting BYOA_AGENT_WAKE_TIMEOUT_SECONDS on
    # their sandbox have no effect. Generous enough to cover sandbox cold starts.
    agent_wake_timeout_seconds: float = 30.0

    # How long an idle in-process corp-ship agent stays around before
    # tearing itself down. BYOA workers are one-task processes and self-end
    # immediately after completion/cancellation so the next task always goes
    # through wake_agent.
    agent_idle_teardown_seconds: float = 300.0

    @classmethod
    def from_env(
        cls,
        env: dict[str, str] | None = None,
        prefix: str = "BYOA_",
    ) -> "ByoaAgentConfig":
        """Build a config from environment variables.

        Each field is overridden if the corresponding ``BYOA_<UPPER>`` env
        var is set; otherwise the dataclass default applies.

        Args:
            env: Optional dict to read from (defaults to ``os.environ``).
            prefix: Env var prefix (default ``BYOA_``).
        """

        source = env if env is not None else os.environ

        def _float(name: str, default: float) -> float:
            raw = source.get(f"{prefix}{name}")
            if raw is None or raw == "":
                return default
            return float(raw)

        return cls(
            tool_call_timeout_seconds=_float("TOOL_CALL_TIMEOUT_SECONDS", 30.0),
            agent_wake_timeout_seconds=_float(
                "AGENT_WAKE_TIMEOUT_SECONDS", 30.0
            ),
            agent_idle_teardown_seconds=_float(
                "AGENT_IDLE_TEARDOWN_SECONDS", 300.0
            ),
        )


__all__ = ["ByoaAgentConfig"]
