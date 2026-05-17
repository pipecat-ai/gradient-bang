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
import os
import time
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any, Dict, Optional

from loguru import logger
from pipecat.processors.frameworks.rtvi import RTVIProcessor, RTVIServerMessageFrame
from pipecat_subagents.bus import BusEndAgentMessage

from gradientbang.byoa import ByoaAgentConfig
from gradientbang.pipecat_server.subagents.bus_messages import BusByoaPresenceMessage
from gradientbang.utils.api_client import RPCError
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
        config: ByoaAgentConfig,
    ) -> None:
        self._host = host
        self._game_client = game_client
        self._rtvi = rtvi
        self._character_id = character_id
        self._config = config

        # Process presence for external BYOA runners. This is UI/task-start
        # liveness only; registry + hello remains authoritative for dispatch.
        self._presence: Dict[str, ByoaPresence] = {}
        self._sweep_task: Optional[asyncio.Task] = None
        self._known_ships: set[str] = set()

        # Remote BYOA agents are not children in this process, so the broker
        # keeps its own active-task table for authorization and cleanup.
        # agent_name -> {task_id, character_id, actor_character_id, task_metadata}
        self._active_agents: Dict[str, Dict[str, Any]] = {}

        # Per-ship wake watchdogs (target_character_id -> asyncio.Task).
        # Cancelled when the BYOA agent advertises ready (on_agent_ready)
        # or the task otherwise completes/cancels.
        self._pending_wakes: Dict[str, asyncio.Task] = {}

        # The per-session subagent-bus channel. The factory generates a
        # fresh UUID-128 channel per session and stores it in
        # SUBAGENT_BUS_SESSION_CHANNEL. Wake passes this value to the
        # spawned BYOA process over HTTPS.
        self._bus_channel = os.getenv("SUBAGENT_BUS_SESSION_CHANNEL", "").strip()
        if self._bus_channel:
            logger.info(f"byoa.session_channel channel_prefix={self._bus_channel[:11]}")

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
            self.invalidate_registry_entry(self.agent_name_for(ship_id))

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
                self.invalidate_registry_entry(self.agent_name_for(ship_id))
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

    # ── Active-agent table + broker auth ──────────────────────────────────

    def register_active(
        self,
        agent_name: str,
        *,
        framework_task_id: str,
        character_id: str,
        actor_character_id: str,
        task_metadata: Dict[str, Any],
    ) -> None:
        """Record a BYOA agent as the active task-holder for `agent_name`."""
        self._active_agents[agent_name] = {
            "task_id": framework_task_id,
            "character_id": character_id,
            "actor_character_id": actor_character_id,
            "task_metadata": task_metadata,
        }

    def deactivate(self, agent_name: str) -> Optional[Dict[str, Any]]:
        """Drop the active-agent entry, returning the removed context or None."""
        return self._active_agents.pop(agent_name, None)

    def get_active(self, agent_name: str) -> Optional[Dict[str, Any]]:
        return self._active_agents.get(agent_name)

    def invalidate_registry_entry(self, agent_name: str) -> None:
        """Pop a BYOA agent from pipecat's AgentRegistry.

        BYOA agents are one-shot: each wake spawns a fresh child that
        advertises ready, runs one task, and exits. The framework
        registry is sticky (no public deregister API) so without this
        helper a subsequent ``watch_agent`` synchronously fires
        ``on_agent_ready`` against a dead child and blocks on its
        unanswerable hello handshake.

        Reaches into private state because pipecat-subagents 0.4's
        AgentRegistry exposes ``register``/``watch``/``get`` but no
        removal — swap for a public API once the library grows one.
        """
        registry = self._host.get_agent_registry()
        if registry is None:
            return
        local_agents = getattr(registry, "_local_agents", None)
        if isinstance(local_agents, dict):
            local_agents.pop(agent_name, None)
        remote_runners = getattr(registry, "_remote_runners", None)
        if isinstance(remote_runners, dict):
            for remote_agents in remote_runners.values():
                if isinstance(remote_agents, dict):
                    remote_agents.pop(agent_name, None)

    def resolve_identity(
        self,
        source: str,
        incoming_task_id: str,
    ) -> tuple[str, Optional[str], str]:
        """Resolve authoritative identity for a brokered BYOA message.

        Caller must have already confirmed ``is_agent_name(source)``; this
        method assumes the source is a BYOA agent. Raises ``PermissionError``
        if there is no matching active task or the task_id doesn't match.

        Remote BYOA messages are untrusted even after the SQL wrapper
        verifies their source name — the broker only accepts them while
        there is a matching active task and derives character/actor
        identity from the pending task payload, not from message fields.
        """
        ctx = self._active_agents.get(source)
        if not ctx:
            raise PermissionError("unauthorized_byoa_source")
        expected_task_id = str(ctx.get("task_id") or "")
        if not incoming_task_id or str(incoming_task_id) != expected_task_id:
            raise PermissionError("unauthorized_byoa_task")
        return (
            str(ctx.get("character_id") or ""),
            str(ctx.get("actor_character_id") or "") or None,
            expected_task_id,
        )

    # ── Wake flow ─────────────────────────────────────────────────────────

    def arm_wake_watchdog(
        self,
        *,
        target_character_id: str,
        framework_task_id: str,
        agent_name: str,
    ) -> None:
        """Register a wake watchdog for a freshly-acquired BYOA task.

        Must be called before ``watch_agent`` so a same-tick ``on_agent_ready``
        can cancel the watchdog cleanly. The watchdog releases local state if
        the agent never advertises ready within
        ``ByoaAgentConfig.agent_wake_timeout_seconds``.
        """
        self._pending_wakes[target_character_id] = asyncio.create_task(
            self._watch_wake_timeout(
                target_character_id=target_character_id,
                framework_task_id=framework_task_id,
                agent_name=agent_name,
            ),
            name=f"byoa_wake_watchdog_{framework_task_id[:8]}",
        )

    def dispatch_wake_async(
        self,
        *,
        target_character_id: str,
        framework_task_id: str,
        agent_name: str,
    ) -> None:
        """Fire ``wake_agent`` off the start_task hot path as a background task."""
        asyncio.create_task(
            self._dispatch_wake(
                target_character_id=target_character_id,
                framework_task_id=framework_task_id,
                agent_name=agent_name,
            ),
            name=f"byoa_wake_dispatch_{framework_task_id[:8]}",
        )

    def cancel_pending_wake(self, target_character_id: str) -> bool:
        """Cancel and pop the wake watchdog for a ship, if any. Returns True if a live watchdog was cancelled."""
        watchdog = self._pending_wakes.pop(target_character_id, None)
        if watchdog is None:
            return False
        if not watchdog.done():
            watchdog.cancel()
            return True
        return False

    def cancel_all_pending_wakes(self) -> None:
        """Cancel every wake watchdog. Used on session teardown."""
        for watchdog in list(self._pending_wakes.values()):
            if not watchdog.done():
                watchdog.cancel()
        self._pending_wakes.clear()

    def try_cancel_pending_wake(self, game_task_id: str, *, summary: str) -> bool:
        """Clear a BYOA task that was cancelled before the runner became ready.

        Returns True if a pending wake was found and torn down (caller should
        stop processing the cancellation). False means no BYOA wake matched —
        caller falls through to the regular in-process cancellation path.
        """
        target_character_id = self._host.ship_for_locked_task(game_task_id)
        if not target_character_id:
            return False

        agent_name = self.agent_name_for(target_character_id)
        had_pending_task = self._host.has_pending_task(agent_name)
        watchdog = self._pending_wakes.pop(target_character_id, None)
        had_watchdog = watchdog is not None
        if not had_pending_task and not had_watchdog:
            return False

        if watchdog is not None and not watchdog.done():
            watchdog.cancel()
        self._host.clear_pending_task(agent_name)
        self._host.release_ship_lock(target_character_id)
        self._host._update_polling_scope()

        event_xml = (
            f'<event name="task.cancelled" task_id="{game_task_id[:8]}" '
            'task_type="corp_ship">\n'
            f"{summary}\n"
            "</event>"
        )
        self._host._enqueue_deferred_update(event_xml, ship_id=target_character_id)
        logger.info(
            f"byoa.pending_wake_cancelled ship={target_character_id[:8]} task={game_task_id[:8]}"
        )
        return True

    async def _call_wake_agent(
        self,
        *,
        task_id: str,
        ship_id: str,
    ) -> Dict[str, Any]:
        """Call the server-side ``wake_agent`` endpoint and return spawn status."""
        if not self._bus_channel:
            logger.warning(f"byoa.wake_agent.skipped ship={ship_id[:8]} reason=no_bus_channel")
            return {"spawn_target": "none", "spawn_status": "missing_bus_channel"}
        try:
            result = await self._game_client.wake_agent(
                ship_id=ship_id,
                channel=self._bus_channel,
                task_id=task_id,
            )
            spawn_target = str(result.get("spawn_target") or "unknown")
            spawn_status = str(result.get("spawn_status") or "unknown")
            logger.info(
                f"byoa.wake_agent.called ship={ship_id[:8]} "
                f"task={task_id[:8]} channel_prefix={self._bus_channel[:11]} "
                f"spawn_target={spawn_target!r} spawn_status={spawn_status!r}"
            )
            return result
        except RPCError as exc:
            body = exc.body if isinstance(exc.body, dict) else {}
            spawn_target = str(body.get("spawn_target") or "error")
            spawn_status = str(body.get("spawn_status") or "call_failed")
            logger.warning(
                f"byoa.wake_agent.call_failed ship={ship_id[:8]} "
                f"spawn_target={spawn_target!r} spawn_status={spawn_status!r} "
                f"error={exc!r}"
            )
            return {
                "spawn_target": spawn_target,
                "spawn_status": spawn_status,
                "error": str(body.get("error") or exc.detail),
            }
        except Exception as exc:
            logger.warning(f"byoa.wake_agent.call_failed ship={ship_id[:8]} error={exc!r}")
            return {
                "spawn_target": "error",
                "spawn_status": "call_failed",
                "error": repr(exc),
            }

    async def _dispatch_wake(
        self,
        *,
        target_character_id: str,
        framework_task_id: str,
        agent_name: str,
    ) -> None:
        """Fire ``wake_agent`` off the start_task hot path.

        Returning the tool result immediately is the goal — the LLM keeps
        talking and the player UI shows ``waking`` while wake_agent does
        its HTTP round-trip. On failure we mirror ``_watch_wake_timeout``'s
        cleanup so the task doesn't get stuck waking.
        """
        wake_result = await self._call_wake_agent(
            task_id=framework_task_id,
            ship_id=target_character_id,
        )
        wake_error = self.wake_failure_message(
            wake_result,
            ship_id=target_character_id,
        )
        if not wake_error:
            return
        # A `task.started` event for this task has already been consumed by
        # on_agent_ready — bail out so we don't double-cancel a live task.
        if not self._host.has_pending_task(agent_name):
            logger.info(
                f"byoa.wake_agent.rejected.no_pending ship={target_character_id[:8]} "
                f"task={framework_task_id[:8]} (agent already ready)"
            )
            return
        logger.warning(
            f"byoa.wake_agent.rejected ship={target_character_id[:8]} "
            f"task={framework_task_id[:8]} error={wake_error!r}"
        )
        self.cancel_pending_wake(target_character_id)
        self._host.clear_pending_task(agent_name)
        self._host.release_ship_lock(target_character_id, expected_task_id=framework_task_id)
        self.invalidate_registry_entry(agent_name)
        try:
            await self._game_client.task_cancel(
                task_id=framework_task_id,
                character_id=self._character_id,
                force=True,
            )
        except Exception as release_exc:
            logger.warning(f"byoa.wake_agent.rejected.release error={release_exc!r}")
        self._host._enqueue_deferred_update(
            (
                f'<event name="task.cancelled" task_id="{framework_task_id[:8]}" '
                'task_type="corp_ship">\n'
                f"{wake_error}\n"
                "</event>"
            ),
            ship_id=target_character_id,
        )

    async def _watch_wake_timeout(
        self,
        *,
        target_character_id: str,
        framework_task_id: str,
        agent_name: str,
    ) -> None:
        """Watchdog that fires after ``agent_wake_timeout_seconds`` if the
        BYOA agent never advertises ready.

        Cancellation is the happy path — ``on_agent_ready`` cancels this
        watchdog when the operator's agent comes online. Expiry is the
        failure path: cancel the task via ``task_cancel(force=true)`` and
        drop local state. A buffered ``BusTaskRequest`` (if still sitting
        in PGMQ) ages out per the bus's retention; if the operator's
        agent eventually wakes, it MUST verify its ``task_id`` is still
        the active lock holder before processing.
        """
        try:
            await asyncio.sleep(self._config.agent_wake_timeout_seconds)
        except asyncio.CancelledError:
            return

        logger.warning(
            f"byoa.wake_timeout ship={target_character_id[:8]} "
            f"task={framework_task_id[:8]} — clearing ship lock + cancelling task"
        )
        # Clean local state first so a concurrent unsolicited hello after
        # this point can't trigger a half-dispatched task.
        self._host.clear_pending_task(agent_name)
        self._pending_wakes.pop(target_character_id, None)
        self._host.release_ship_lock(target_character_id)
        self.invalidate_registry_entry(agent_name)

        # Force-cancel the task so the BYOA-owner check is bypassed when the
        # bot cleans up a failed wake.
        try:
            await self._game_client.task_cancel(
                task_id=framework_task_id,
                character_id=self._character_id,
                force=True,
            )
        except Exception as exc:
            logger.warning(
                f"byoa.wake_timeout.release_failed task={framework_task_id[:8]} error={exc!r}"
            )
        self._host._enqueue_deferred_update(
            (
                f'<event name="task.cancelled" task_id="{framework_task_id[:8]}" '
                'task_type="corp_ship">\n'
                "Task was cancelled because the BYOA agent did not come online in time.\n"
                "</event>"
            ),
            ship_id=target_character_id,
        )
