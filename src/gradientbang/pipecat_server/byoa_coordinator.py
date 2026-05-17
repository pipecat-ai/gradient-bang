"""ByoaCoordinator — collaborator that owns BYOA-specific behavior for VoiceAgent.

BYOA (Bring-Your-Own-Agent) is a cold path: per-corp-ship operator setup,
not per-conversation. Keeping it out of VoiceAgent makes the speech/task
flow easier to grok and lets BYOA evolve independently. VoiceAgent
constructs one of these and delegates BYOA concerns to it.

This file is built incrementally — see the plan in
``/Users/jontaylor/.claude/plans/take-a-look-the-magical-feigenbaum.md``.
Step 1 ships the pure helpers (no shared state); subsequent steps move
presence, broker auth, registry invalidation, and the wake flow.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, Optional

from loguru import logger

from gradientbang.utils.supabase_client import AsyncGameClient

if TYPE_CHECKING:
    from gradientbang.pipecat_server.subagents.voice_agent import VoiceAgent


class ByoaCoordinator:
    """Owns BYOA wake, presence, broker auth, and registry handling for VoiceAgent."""

    def __init__(
        self,
        *,
        host: "VoiceAgent",
        game_client: AsyncGameClient,
        character_id: str,
    ) -> None:
        self._host = host
        self._game_client = game_client
        self._character_id = character_id

    # ── Pure helpers ──────────────────────────────────────────────────────

    @staticmethod
    def agent_name_for(target_character_id: str) -> str:
        """Bus identity convention for a remote BYOA agent.

        The operator's ``uv run byoa`` CLI advertises itself with this exact
        name so the bot can target it via ``watch_agent`` / ``request_task``.
        Format: ``byoa_<ship_id>`` with the full UUID (dashes kept).
        """
        return f"byoa_{target_character_id}"

    @staticmethod
    def is_agent_name(agent_name: str) -> bool:
        return agent_name.startswith("byoa_") and not agent_name.startswith("byoa_runner_")

    @staticmethod
    def is_runner_name(agent_name: str) -> bool:
        return agent_name.startswith("byoa_runner_")

    async def lookup_owner(self, ship_id: str) -> Optional[str]:
        """Return the BYOA owner character_id for ``ship_id``, or None.

        Hits ``my_corporation`` to read the ``byoa`` block surfaced by
        ``_shared/corporations.ts``. Truthy return means the ship is
        BYOA-claimed (route via wake_agent); None means in-process spawn.
        """
        try:
            corp_result = await self._game_client._request(
                "my_corporation",
                {"character_id": self._character_id},
            )
        except Exception as exc:
            logger.warning(f"byoa.lookup_owner failed: {exc}")
            return None
        corp = corp_result.get("corporation") if isinstance(corp_result, dict) else None
        if not isinstance(corp, dict):
            return None
        ships = corp.get("ships")
        if not isinstance(ships, list):
            return None
        for ship in ships:
            if not isinstance(ship, dict):
                continue
            if ship.get("ship_id") != ship_id:
                continue
            byoa = ship.get("byoa")
            if not isinstance(byoa, dict):
                return None
            # The corp payload exposes a truncated 12-char prefix, not the
            # full UUID. That's enough as a routing hint for the wake_agent
            # call (the server re-resolves the owner from the row).
            owner_prefix = byoa.get("owner_character_id_prefix")
            return owner_prefix if isinstance(owner_prefix, str) and owner_prefix else None
        return None

    @staticmethod
    def wake_failure_message(
        wake_result: Dict[str, Any],
        *,
        ship_id: str,
    ) -> Optional[str]:
        """Human-readable explanation for a non-accepted wake_agent result.

        Returns None when the wake was accepted (the operator's HTTP runner
        took the request). Otherwise returns a sentence suitable for the
        ``task.cancelled`` narration shown to the player.
        """
        target = str(wake_result.get("spawn_target") or "unknown")
        status = str(wake_result.get("spawn_status") or "unknown")
        if target == "http" and status == "accepted":
            return None
        if target == "noop":
            return (
                "BYOA wake is configured as noop and no runner is online for "
                f"ship {ship_id[:8]}. Set BYOA_WAKE_TARGET=http and run "
                "`uv run byoa --serve`, or start a manual BYOA runner before "
                "assigning the task."
            )
        return f"BYOA wake failed before the runner came online ({target}/{status})."
