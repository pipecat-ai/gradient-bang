"""ByoaCoordinator — collaborator that owns BYOA-specific behavior for VoiceAgent.

BYOA (Bring-Your-Own-Agent) is a cold path: per-corp-ship operator setup,
not per-conversation. Keeping it out of VoiceAgent makes the speech/task
flow easier to grok and lets BYOA evolve independently. VoiceAgent
constructs one of these and delegates BYOA concerns to it.

This file is built incrementally — see the plan in
``/Users/jontaylor/.claude/plans/take-a-look-the-magical-feigenbaum.md``.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any, Dict, Optional

from loguru import logger
from pipecat.processors.frameworks.rtvi import RTVIProcessor, RTVIServerMessageFrame
from pipecat_subagents.bus import BusEndAgentMessage

from gradientbang.pipecat_server.subagents.bus_messages import BusByoaPresenceMessage
from gradientbang.utils.supabase_client import AsyncGameClient

if TYPE_CHECKING:
    from gradientbang.pipecat_server.subagents.voice_agent import VoiceAgent


PRESENCE_STALE_SECONDS = 25.0
PRESENCE_SWEEP_SECONDS = 5.0


@dataclass
class ByoaPresence:
    ship_id: str
    online: bool
    status: str
    last_seen_at: Optional[str]
    last_seen_monotonic: float


class ByoaCoordinator:
    """Owns BYOA wake, presence, broker auth, and registry handling for VoiceAgent."""

    def __init__(
        self,
        *,
        host: "VoiceAgent",
        game_client: AsyncGameClient,
        rtvi: RTVIProcessor,
        character_id: str,
    ) -> None:
        self._host = host
        self._game_client = game_client
        self._rtvi = rtvi
        self._character_id = character_id

        # Process presence for external BYOA runners. This is UI/task-start
        # liveness only; registry + hello remains authoritative for dispatch.
        self._presence: Dict[str, ByoaPresence] = {}
        self._sweep_task: Optional[asyncio.Task] = None
        self._known_ships: set[str] = set()

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

    # ── Presence ──────────────────────────────────────────────────────────

    def note_known_ship(self, ship_id: str) -> None:
        """Record that we've seen a BYOA-claimed ship. Idempotent."""
        self._known_ships.add(ship_id)

    async def on_presence(self, message: BusByoaPresenceMessage) -> None:
        """Track external BYOA runner process liveness and push it to RTVI."""
        ship_id = (message.ship_id or "").strip()
        source = getattr(message, "source", "") or ""
        if not ship_id or source != self.agent_name_for(ship_id):
            logger.warning(f"byoa.presence_ignored source={source!r} ship={ship_id[:8]!r}")
            return

        if ship_id not in self._known_ships:
            owner = await self.lookup_owner(ship_id)
            if not owner:
                logger.warning(
                    f"byoa.presence_ignored_not_claimed source={source!r} ship={ship_id[:8]}"
                )
                return
            self._known_ships.add(ship_id)

        online = bool(message.online)
        status = "online" if online else "offline"
        last_seen_at = message.last_seen_at
        now = time.monotonic()
        previous = self._presence.get(ship_id)
        self._presence[ship_id] = ByoaPresence(
            ship_id=ship_id,
            online=online,
            status=status,
            last_seen_at=last_seen_at,
            last_seen_monotonic=now,
        )

        if online:
            self._ensure_sweeper()
        else:
            # Child harness reported on_finished — invalidate its registry
            # entry so the next watch_agent waits for a fresh ready event
            # instead of synchronously dispatching against a dead child.
            self._host._invalidate_byoa_registry_entry(self.agent_name_for(ship_id))

        changed = previous is None or previous.online != online or previous.status != status
        if changed:
            await self._push_presence(
                ship_id=ship_id,
                online=online,
                status=status,
                last_seen_at=last_seen_at,
            )

    async def _push_presence(
        self,
        *,
        ship_id: str,
        online: bool,
        status: str,
        last_seen_at: Optional[str],
    ) -> None:
        await self._rtvi.push_frame(
            RTVIServerMessageFrame(
                {
                    "frame_type": "event",
                    "event": "byoa.presence",
                    "payload": {
                        "ship_id": ship_id,
                        "online": online,
                        "status": status,
                        "last_seen_at": last_seen_at,
                    },
                }
            )
        )

    def _ensure_sweeper(self) -> None:
        if self._sweep_task is None or self._sweep_task.done():
            self._sweep_task = asyncio.create_task(
                self._sweep_loop(),
                name="byoa_presence_sweeper",
            )

    async def _sweep_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(PRESENCE_SWEEP_SECONDS)
                if not self._presence:
                    return
                await self._mark_stale_offline()
        except asyncio.CancelledError:
            return
        finally:
            if asyncio.current_task() is self._sweep_task:
                self._sweep_task = None

    async def _mark_stale_offline(self) -> None:
        now = time.monotonic()
        for ship_id, presence in list(self._presence.items()):
            if presence.online and now - presence.last_seen_monotonic > PRESENCE_STALE_SECONDS:
                self._presence[ship_id] = replace(
                    presence,
                    online=False,
                    status="offline",
                )
                self._host._invalidate_byoa_registry_entry(self.agent_name_for(ship_id))
                await self._push_presence(
                    ship_id=ship_id,
                    online=False,
                    status="offline",
                    last_seen_at=presence.last_seen_at,
                )
                # If this BYOA was running a task, the bot is the only
                # authority on its lock. Release it locally and emit a
                # task.cancel event so downstream consumers (event log, UI)
                # see the task ended. The zombie BYOA (if still alive) won't
                # affect this bot's state — any belated bus messages tagged
                # with the cancelled task_id are filtered out by TaskAgent.
                await self._release_lock_on_offline(ship_id)

    async def _release_lock_on_offline(self, ship_character_id: str) -> None:
        framework_task_id = self._host.release_ship_lock(ship_character_id)
        if not framework_task_id:
            return
        logger.warning(
            f"byoa.presence_stale ship={ship_character_id[:8]} "
            f"task={framework_task_id[:8]} releasing lock locally"
        )
        try:
            await self._game_client.task_cancel(
                task_id=framework_task_id,
                character_id=self._character_id,
            )
        except Exception as exc:
            logger.warning(
                f"byoa.presence_stale task_cancel emit failed for "
                f"ship={ship_character_id[:8]} task={framework_task_id[:8]}: {exc}"
            )
        try:
            await self._host.send_message(
                BusEndAgentMessage(
                    source=self._host.name,
                    target=self.agent_name_for(ship_character_id),
                    reason="byoa_offline",
                )
            )
        except Exception as exc:
            logger.warning(
                f"byoa.presence_stale end_agent failed for ship={ship_character_id[:8]}: {exc}"
            )

    def close_sweeper(self) -> None:
        """Cancel the presence sweeper task. Called from VoiceAgent.close_tasks."""
        if self._sweep_task and not self._sweep_task.done():
            self._sweep_task.cancel()
        self._sweep_task = None
