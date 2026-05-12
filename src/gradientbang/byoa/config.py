"""Runtime tunables for any TaskAgent (in-process or BYOA).

Two surfaces are explicitly separated:

- **Server-side** (game operator only): edge function env vars like
  ``TASK_LOCK_HEARTBEAT_STALE_SECONDS`` and ``TASK_LOCK_HARD_TTL_MINUTES``.
  These are enforced inside edge functions and Postgres; BYOA operators
  cannot override them.
- **Agent-side** (this module): heartbeat cadence, RPC timeouts,
  concurrency ceilings. The bundled bot reads ``ByoaAgentConfig.from_env()``;
  external BYOA operators construct their own dataclass instance directly.

Mismatches between agent-side server-window expectations and the actual
server config are logged at startup; the agent doesn't error out — it just
observes. The server is always the source of truth for staleness windows.

See docs/byoa.md ("Configuration") for the full table of env vars and
their interaction.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class ByoaAgentConfig:
    """Runtime tunables. Defaults are safe for the bundled in-process agent.

    Construct directly (``ByoaAgentConfig(heartbeat_interval_seconds=90)``)
    or via env (``ByoaAgentConfig.from_env()``).
    """

    # Client-side: how often the agent posts task_heartbeat for its held
    # locks. Must be strictly less than the server's stale window / 2 to
    # survive one missed beat. Default 60s pairs safely with the server's
    # 180s default stale window.
    heartbeat_interval_seconds: int = 60

    # Per-agent ceiling on concurrent tasks. The server also enforces
    # one task per ship; this is a soft local limit so a misbehaving
    # operator can't fan out arbitrarily many concurrent task children.
    max_concurrent_tasks: int = 4

    # Phase 1 (bus RPC) — reply timeout for an outbound BusGameToolCallRequest.
    # Inert during Groundwork because TaskAgent still holds its game client.
    tool_call_timeout_seconds: float = 30.0

    # Phase 1 (bus RPC) — reply timeout for a BusTaskRequest. Inert during
    # Groundwork.
    task_request_timeout_seconds: float = 600.0

    # Phase 1 — how long VoiceAgent waits for a target agent to signal
    # alive after start_task (via BusAgentHelloRequest/Response). Generous
    # enough to cover cold starts on Vercel Sandbox / AWS Lambda. In-process
    # agents respond near-instantly; remote BYOA agents respond after
    # cold start. See "Agent lifecycle & wake-up" in docs/byoa.md.
    agent_wake_timeout_seconds: float = 30.0

    # Phase 1 — how long an idle warm agent stays around before tearing
    # itself down. Each inbound task / tool call resets the timer. In-process
    # player-ship agents effectively never hit this (reuse keeps them busy);
    # corp-ship and BYOA agents do — firing releases the ship slot.
    agent_idle_teardown_seconds: float = 300.0

    # Informational: the agent's understanding of the server-side stale
    # window. Used at startup to validate that ``heartbeat_interval_seconds``
    # is small enough to survive one missed beat. Mismatch with the actual
    # server config (``TASK_LOCK_HEARTBEAT_STALE_SECONDS``) only generates a
    # warning — the server is authoritative.
    server_lock_stale_seconds_expected: int = 180

    # Informational: the agent's understanding of the hard-TTL safety floor.
    # Mirrors ``TASK_LOCK_HARD_TTL_MINUTES``.
    server_lock_hard_ttl_minutes_expected: int = 30

    # Deprecated BYOA-CLI setting kept for env compatibility. The CLI now
    # receives the channel from wake / --channel and waits for tasks over PGMQ.
    poll_interval_seconds: float = 5.0

    # Deprecated BYOA-CLI setting kept for env compatibility.
    claim_endpoint_url: str = ""

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

        def _int(name: str, default: int) -> int:
            raw = source.get(f"{prefix}{name}")
            if raw is None or raw == "":
                return default
            return int(raw)

        def _float(name: str, default: float) -> float:
            raw = source.get(f"{prefix}{name}")
            if raw is None or raw == "":
                return default
            return float(raw)

        def _str(name: str, default: str) -> str:
            raw = source.get(f"{prefix}{name}")
            if raw is None:
                return default
            return raw.strip()

        return cls(
            heartbeat_interval_seconds=_int("HEARTBEAT_INTERVAL_SECONDS", 60),
            max_concurrent_tasks=_int("MAX_CONCURRENT_TASKS", 4),
            tool_call_timeout_seconds=_float("TOOL_CALL_TIMEOUT_SECONDS", 30.0),
            task_request_timeout_seconds=_float(
                "TASK_REQUEST_TIMEOUT_SECONDS", 600.0
            ),
            agent_wake_timeout_seconds=_float(
                "AGENT_WAKE_TIMEOUT_SECONDS", 30.0
            ),
            agent_idle_teardown_seconds=_float(
                "AGENT_IDLE_TEARDOWN_SECONDS", 300.0
            ),
            server_lock_stale_seconds_expected=_int(
                "SERVER_LOCK_STALE_SECONDS", 180
            ),
            server_lock_hard_ttl_minutes_expected=_int(
                "SERVER_LOCK_HARD_TTL_MINUTES", 30
            ),
            poll_interval_seconds=_float("POLL_INTERVAL_SECONDS", 5.0),
            claim_endpoint_url=_str("CLAIM_ENDPOINT_URL", ""),
        )

    def validate_heartbeat_against_server(self) -> str | None:
        """Return a warning message if heartbeat cadence is too slow.

        The heartbeat must arrive strictly faster than half the server's
        stale window so a single missed beat doesn't make the lock
        steal-eligible. Returns None when the configuration is safe.
        """

        half_window = self.server_lock_stale_seconds_expected / 2.0
        if self.heartbeat_interval_seconds >= half_window:
            return (
                f"heartbeat_interval_seconds={self.heartbeat_interval_seconds} "
                f"is >= server stale window / 2 "
                f"({self.server_lock_stale_seconds_expected}/2 = {half_window:.0f}s); "
                "one missed beat would make the lock steal-eligible"
            )
        return None


__all__ = ["ByoaAgentConfig"]
