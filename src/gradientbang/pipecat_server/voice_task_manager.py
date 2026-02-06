import asyncio
import json
import time
import uuid
from collections import deque
from typing import Optional, Callable, Dict, Any, Mapping

from loguru import logger

from pipecat.services.llm_service import FunctionCallParams
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.processors.frameworks.rtvi import RTVIServerMessageFrame, RTVIProcessor
from pipecat.frames.frames import FunctionCallResultProperties, LLMMessagesAppendFrame

import os

from gradientbang.utils.supabase_client import AsyncGameClient
from gradientbang.utils.prompt_loader import TaskOutputType, build_task_progress_prompt
from gradientbang.utils.task_agent import TaskAgent
from gradientbang.pipecat_server.frames import TaskActivityFrame
from gradientbang.utils.supabase_client import RPCError
from gradientbang.utils.weave_tracing import (
    init_weave,
    traced,
    trace_attributes,
    voice_session_attributes,
    task_attributes,
)
from gradientbang.utils.tools_schema import (
    MyStatus,
    LeaderboardResources,
    PlotCourse,
    ListKnownPorts,
    StartTask,
    StopTask,
    SendMessage,
    CombatInitiate,
    CombatAction,
    CorporationInfo,
    RenameShip,
    QueryTaskProgress,
    SteerTask,
    LoadGameInfo,
    UI_SHOW_PANEL_SCHEMA,
    _summarize_corporation_info,
    _shorten_embedded_ids,
    _short_id,
    _friendly_ship_type,
    _format_ship_holds,
)

MAX_CORP_SHIP_TASKS = 3  # Maximum concurrent corp ship tasks per player
REQUEST_ID_CACHE_TTL_SECONDS = 15 * 60
REQUEST_ID_CACHE_MAX_SIZE = 5000
FINISHED_TASK_ID_CACHE_TTL_SECONDS = 15 * 60
FINISHED_TASK_ID_CACHE_MAX_SIZE = 5000
TASK_LOG_TTL_SECONDS = 15 * 60
CORP_TASK_EVENT_VALIDATE_TIMEOUT_SECONDS = 10.0
TASK_SCOPED_DIRECT_EVENT_ALLOWLIST = {
    "bank.transaction",
    "movement.complete",
    "port.update",
    "task.start",
    "task.finish",
    "trade.executed",
    "warp.purchase",
    "status.update",
    "map.local",
}


def _extract_display_name(payload: Mapping[str, Any]) -> Optional[str]:
    """Extract the player's display name from a payload if available."""

    def _clean(value: Any) -> Optional[str]:
        if isinstance(value, str):
            value = value.strip()
            if value:
                return value
        return None

    if not isinstance(payload, Mapping):
        return None

    player = payload.get("player")
    if isinstance(player, Mapping):
        for key in ("name", "display_name", "player_name"):
            candidate = _clean(player.get(key))
            if candidate:
                return candidate

    for fallback in ("player_name", "name"):
        candidate = _clean(payload.get(fallback))
        if candidate:
            return candidate

    return None


class VoiceTaskManager:
    def __init__(
        self,
        character_id: str,
        rtvi_processor: RTVIProcessor,
        task_complete_callback: Optional[Callable[[bool, bool], None]] = None,
        base_url: Optional[str] = None,
    ):
        """Initialize the task manager.

        Args:
            character_id: Character ID being controlled
            rtvi_processor: RTVI processor, which we use for pushing frames
            task_complete_callback: Callback when task completes (receives was_cancelled flag)
            base_url: Optional game server URL (defaults to http://localhost:8000)
        """
        self.character_id = character_id
        self.display_name: str = character_id
        self._current_sector_id: Optional[int] = None
        resolved_base_url = base_url or os.getenv("SUPABASE_URL")
        if not resolved_base_url:
            raise RuntimeError("SUPABASE_URL is required to initialize VoiceTaskManager.")
        self.game_client = AsyncGameClient(
            character_id=character_id,
            base_url=resolved_base_url,
            transport="supabase",
        )
        self._last_corporation_id: Optional[str] = self.game_client.corporation_id
        self._event_names = [
            "status.snapshot",
            "status.update",
            "sector.update",
            "course.plot",
            "path.region",
            "movement.start",
            "movement.complete",
            "map.knowledge",
            "map.region",
            "map.local",
            "map.update",
            "ports.list",
            "character.moved",
            "trade.executed",
            "port.update",
            "fighter.purchase",
            "warp.purchase",
            "warp.transfer",
            "credits.transfer",
            "garrison.deployed",
            "garrison.collected",
            "garrison.mode_changed",
            "salvage.collected",
            "salvage.created",
            "bank.transaction",
            "combat.round_waiting",
            "combat.round_resolved",
            "combat.ended",
            "combat.action_accepted",
            "ship.destroyed",
            "ship.renamed",
            "corporation.created",
            "corporation.ship_purchased",
            "corporation.member_joined",
            "corporation.member_left",
            "corporation.member_kicked",
            "corporation.disbanded",
            "chat.message",
            "error",
            # Client history query events (relayed via event system)
            "event.query",
            "ships.list",
            "task.start",
            "task.finish",
        ]
        for event_name in self._event_names:
            self.game_client.on(event_name)(self._relay_event)

        self.game_client.on("task.cancel")(self._handle_task_cancel_event)

        self.task_complete_callback = task_complete_callback

        # Create task agent driven by the Pipecat pipeline
        self.task_agent = TaskAgent(
            config=None,
            game_client=self.game_client,
            character_id=self.character_id,
            output_callback=self._handle_agent_output,
        )

        # Task management - now supports multiple concurrent tasks
        # Task IDs are now UUIDs (stored as full_task_id) with short IDs (first 6 hex chars)
        # used as keys for human-readable tracking and event correlation
        self.rtvi_processor = rtvi_processor
        self._active_tasks: Dict[str, Dict[str, Any]] = {}  # short_task_id -> task info
        self.task_running = False  # Deprecated, kept for backwards compatibility
        self.cancelled_via_tool = False
        # Track request IDs from voice agent tool calls for inference triggering
        self._voice_agent_request_ids: Dict[str, float] = {}
        self._voice_agent_request_queue: deque[tuple[str, float]] = deque()
        self._tool_call_inflight = 0
        self._deferred_llm_events: deque[tuple[str, bool]] = deque()
        # Track task IDs that have finished but whose task.finish event hasn't arrived yet
        self._finished_task_ids: Dict[str, float] = {}
        self._finished_task_queue: deque[tuple[str, float]] = deque()
        self._task_log_cursors: Dict[str, int] = {}

        # Build generic tool dispatch map for common game tools
        # Start/stop/ui_show_panel are handled inline in execute_tool_call
        # Note: Most game_client methods require character_id, but the LLM tools
        # don't expose it. We wrap methods to inject self.character_id automatically.
        self._tool_dispatch = {
            "my_status": lambda: self.game_client.my_status(
                character_id=self.character_id
            ),
            "leaderboard_resources": lambda **kwargs: self.game_client.leaderboard_resources(
                character_id=self.character_id, **kwargs
            ),
            "plot_course": lambda to_sector: self.game_client.plot_course(
                to_sector=to_sector, character_id=self.character_id
            ),
            "list_known_ports": lambda **kwargs: self.game_client.list_known_ports(
                character_id=self.character_id, **kwargs
            ),
            "send_message": lambda **kwargs: self.game_client.send_message(
                character_id=self.character_id, **kwargs
            ),
            "combat_initiate": lambda **kwargs: self.game_client.combat_initiate(
                character_id=self.character_id, **kwargs
            ),
            "combat_action": lambda **kwargs: self.game_client.combat_action(
                character_id=self.character_id, **kwargs
            ),
            "corporation_info": lambda **kwargs: self.game_client._request(
                "corporation.list" if kwargs.get("list_all") else "my_corporation",
                {} if kwargs.get("list_all") else {"character_id": self.character_id}
            ),
            "rename_ship": lambda **kwargs: self.game_client.rename_ship(
                character_id=self.character_id, **kwargs
            ),
        }

        # Initialize Weave tracing if available
        init_weave()

    async def close(self) -> None:
        """Clean up all resources: cancel active tasks and close game clients."""
        # Cancel all active task agents
        for task_id, task_info in list(self._active_tasks.items()):
            task_agent = task_info.get("task_agent")
            asyncio_task = task_info.get("asyncio_task")

            if task_agent and not task_agent.cancelled:
                logger.info(f"Cancelling task {task_id} on disconnect")
                task_agent.cancel()

            # Wait for the asyncio task to finish (with timeout)
            if asyncio_task and not asyncio_task.done():
                try:
                    await asyncio.wait_for(asyncio_task, timeout=5.0)
                except asyncio.TimeoutError:
                    logger.warning(f"Task {task_id} did not finish within timeout, forcing cancel")
                    asyncio_task.cancel()
                    try:
                        await asyncio_task
                    except asyncio.CancelledError:
                        pass
                except asyncio.CancelledError:
                    pass

            # Close corp ship game client if different from main client
            task_game_client = task_info.get("task_game_client")
            if task_game_client and task_game_client != self.game_client:
                try:
                    await task_game_client.close()
                except Exception as e:
                    logger.error(f"Failed to close task {task_id} game client: {e}")

        # Close any task agents to release handlers/context
        for task_id, task_info in list(self._active_tasks.items()):
            task_agent = task_info.get("task_agent")
            if task_agent and task_agent is not self.task_agent:
                try:
                    await task_agent.close()
                except Exception as e:
                    logger.error(f"Failed to close task agent {task_id}: {e}")

        self._active_tasks.clear()

        try:
            await self.task_agent.close()
        except Exception as e:
            logger.error(f"Failed to close shared TaskAgent: {e}")

        # Close main game client
        try:
            await self.game_client.close()
        except Exception as e:
            logger.error(f"Failed to close main game client: {e}")

    def _generate_task_id(self) -> tuple[str, str]:
        """Generate a new task ID using UUID.

        Returns:
            Tuple of (short_task_id, full_task_id) where:
            - short_task_id: First 6 hex chars of UUID for display/tracking
            - full_task_id: Full UUID string for database storage
        """
        full_task_id = str(uuid.uuid4())
        short_task_id = full_task_id[:6]
        return short_task_id, full_task_id

    def _get_task_type(self, ship_id: Optional[str]) -> str:
        """Determine task type based on whether it's controlling a corp ship."""
        if ship_id and ship_id != self.character_id:
            return "corp_ship"
        return "player_ship"

    def _count_active_corp_ship_tasks(self) -> int:
        """Count currently running corp ship tasks."""
        return sum(
            1
            for task_info in self._active_tasks.values()
            if task_info.get("is_corp_ship") and not task_info["asyncio_task"].done()
        )

    def _update_display_name(self, payload: Mapping[str, Any]) -> None:
        candidate = _extract_display_name(payload)
        if isinstance(candidate, str) and candidate and candidate != self.display_name:
            self.display_name = candidate

    async def join(self):
        logger.info(f"Joining game as character: {self.character_id}")
        result = await self.game_client.join(self.character_id)
        # Track the join request_id so the resulting status.snapshot triggers
        # LLM inference for the bot's first speaking turn.
        if isinstance(result, Mapping):
            self._track_request_id(result.get("request_id"))
        await self.game_client.subscribe_my_messages()
        # Send ships list so client has it on connection
        await self.game_client.list_user_ships(character_id=self.character_id)
        if isinstance(result, Mapping):
            self._update_display_name(result)
        logger.info(f"Join successful as {self.display_name}: {result}")
        return result

    def _get_voice_summary(self, event_name: str, event: Dict[str, Any]) -> Optional[str]:
        """Get a condensed summary suitable for voice LLM context.

        For verbose events like event.query, produces a much shorter summary
        than the TaskAgent receives. Falls back to the standard summary.
        """
        payload = event.get("payload", {})

        if event_name == "event.query":
            # Very condensed: count + key filter context
            count = payload.get("count", 0)
            has_more = payload.get("has_more", False)
            filters = payload.get("filters", {})

            # Build filter context from most relevant filters
            filter_parts = []
            if filters.get("filter_event_type"):
                filter_parts.append(f"type={filters['filter_event_type']}")
            if filters.get("filter_task_id"):
                filter_parts.append("task-scoped")
            if filters.get("filter_sector"):
                filter_parts.append(f"sector {filters['filter_sector']}")

            if filter_parts:
                filter_str = f" ({', '.join(filter_parts)})"
            else:
                filter_str = ""

            summary = f"Query returned {count} events{filter_str}."
            if has_more:
                summary += " More available."

            return summary

        if event_name == "ships.list":
            # Summarize fleet information for voice context (one line per ship)
            ships = payload.get("ships", [])
            if not ships:
                return "No ships available."

            personal_ships = [s for s in ships if s.get("owner_type") == "personal"]
            corp_ships = [s for s in ships if s.get("owner_type") == "corporation"]

            lines = [f"Fleet: {len(ships)} ship{'s' if len(ships) != 1 else ''}"]

            # Personal ship first
            if personal_ships:
                lines.append("Your ship:")
                for ship in personal_ships:
                    lines.append(self._format_ship_line(ship, include_id=False))

            # Corp ships
            if corp_ships:
                lines.append(f"Corporation ships ({len(corp_ships)}):")
                for ship in corp_ships:
                    lines.append(self._format_ship_line(ship, include_id=True))

            return "\n".join(lines)

        # Fall back to standard summary
        return event.get("summary")

    def _format_ship_line(self, ship: Dict[str, Any], include_id: bool = True) -> str:
        """Format a single ship as a summary line."""
        ship_name = ship.get("ship_name") or "Unnamed"
        ship_name = _shorten_embedded_ids(str(ship_name))
        ship_type = _friendly_ship_type(ship.get("ship_type"))
        sector = ship.get("sector")
        sector_display = sector if isinstance(sector, int) else "unknown"

        # Build line parts
        if include_id:
            ship_id_prefix = _short_id(ship.get("ship_id"))
            id_suffix = f" [{ship_id_prefix}]" if ship_id_prefix else ""
        else:
            id_suffix = ""

        details = [f"{ship_name}{id_suffix} ({ship_type}) in sector {sector_display}"]

        # Add cargo info
        details.append(_format_ship_holds(ship))

        # Add warp info
        warp = ship.get("warp_power")
        warp_max = ship.get("warp_power_capacity")
        if isinstance(warp, (int, float)) and isinstance(warp_max, (int, float)):
            details.append(f"warp {int(warp)}/{int(warp_max)}")

        # Add task status
        current_task_id = ship.get("current_task_id")
        if isinstance(current_task_id, str) and current_task_id:
            task_display = _short_id(current_task_id) or current_task_id
            details.append(f"task {task_display}")
        else:
            details.append("task none")

        return "- " + "; ".join(details)

    @staticmethod
    def _extract_sector_id(payload: Mapping[str, Any]) -> Optional[int]:
        sector = payload.get("sector")
        if isinstance(sector, Mapping):
            candidate = sector.get("id") or sector.get("sector_id")
        else:
            candidate = payload.get("sector_id")
            if candidate is None:
                candidate = sector
        if isinstance(candidate, int):
            return candidate
        if isinstance(candidate, str) and candidate.strip().isdigit():
            try:
                return int(candidate.strip())
            except ValueError:
                return None
        return None

    @staticmethod
    def _strip_internal_event_metadata(payload: Any) -> Any:
        if not isinstance(payload, Mapping):
            return payload
        cleaned = dict(payload)
        cleaned.pop("__event_context", None)
        cleaned.pop("event_context", None)
        cleaned.pop("recipient_ids", None)
        cleaned.pop("recipient_reasons", None)
        return cleaned

    @staticmethod
    def _extract_event_context(payload: Any) -> Optional[Mapping[str, Any]]:
        if not isinstance(payload, Mapping):
            return None
        ctx = payload.get("__event_context") or payload.get("event_context")
        if isinstance(ctx, Mapping):
            return ctx
        return None

    @staticmethod
    def _resolve_recipient_reason(
        ctx: Optional[Mapping[str, Any]],
        character_id: Optional[str],
    ) -> Optional[str]:
        if not ctx or not character_id:
            return None
        recipient_ids = ctx.get("recipient_ids")
        recipient_reasons = ctx.get("recipient_reasons")
        if (
            isinstance(recipient_ids, list)
            and isinstance(recipient_reasons, list)
            and len(recipient_ids) == len(recipient_reasons)
        ):
            for recipient_id, reason in zip(recipient_ids, recipient_reasons):
                if (
                    isinstance(recipient_id, str)
                    and recipient_id == character_id
                    and isinstance(reason, str)
                ):
                    return reason
        ctx_character_id = ctx.get("character_id")
        ctx_reason = ctx.get("reason")
        if (
            isinstance(ctx_character_id, str)
            and ctx_character_id == character_id
            and isinstance(ctx_reason, str)
        ):
            return ctx_reason
        return None

    def _prune_request_ids(self, now: Optional[float] = None) -> None:
        if now is None:
            now = time.monotonic()
        cutoff = now - REQUEST_ID_CACHE_TTL_SECONDS
        while self._voice_agent_request_queue:
            req_id, ts = self._voice_agent_request_queue[0]
            current = self._voice_agent_request_ids.get(req_id)
            if current is not None and current != ts:
                self._voice_agent_request_queue.popleft()
                continue
            if len(self._voice_agent_request_ids) > REQUEST_ID_CACHE_MAX_SIZE or ts < cutoff:
                self._voice_agent_request_queue.popleft()
                if current == ts:
                    self._voice_agent_request_ids.pop(req_id, None)
                continue
            break

    def _track_request_id(self, request_id: Optional[str]) -> None:
        if not isinstance(request_id, str):
            return
        cleaned = request_id.strip()
        if not cleaned:
            return
        now = time.monotonic()
        self._voice_agent_request_ids[cleaned] = now
        self._voice_agent_request_queue.append((cleaned, now))
        self._prune_request_ids(now)

    def _is_recent_request_id(self, request_id: Optional[str]) -> bool:
        if not isinstance(request_id, str) or not request_id.strip():
            return False
        self._prune_request_ids()
        return request_id in self._voice_agent_request_ids

    def _prune_finished_task_ids(self, now: Optional[float] = None) -> None:
        if now is None:
            now = time.monotonic()
        cutoff = now - FINISHED_TASK_ID_CACHE_TTL_SECONDS
        while self._finished_task_queue:
            task_id, ts = self._finished_task_queue[0]
            current = self._finished_task_ids.get(task_id)
            if current is not None and current != ts:
                self._finished_task_queue.popleft()
                continue
            if len(self._finished_task_ids) > FINISHED_TASK_ID_CACHE_MAX_SIZE or ts < cutoff:
                self._finished_task_queue.popleft()
                if current == ts:
                    self._finished_task_ids.pop(task_id, None)
                continue
            break

    def _track_finished_task_id(self, task_id: Optional[str]) -> None:
        if not isinstance(task_id, str):
            return
        cleaned = task_id.strip()
        if not cleaned:
            return
        now = time.monotonic()
        self._finished_task_ids[cleaned] = now
        self._finished_task_queue.append((cleaned, now))
        self._prune_finished_task_ids(now)

    def _is_recent_finished_task_id(self, task_id: Optional[str]) -> bool:
        if not isinstance(task_id, str) or not task_id.strip():
            return False
        self._prune_finished_task_ids()
        return task_id in self._finished_task_ids

    def _forget_finished_task_id(self, task_id: Optional[str]) -> None:
        if not isinstance(task_id, str) or not task_id.strip():
            return
        self._finished_task_ids.pop(task_id, None)

    def _prune_expired_tasks(self, now: Optional[float] = None) -> None:
        if now is None:
            now = time.monotonic()
        expired_ids = [
            task_id
            for task_id, task_info in self._active_tasks.items()
            if task_info.get("expires_at") and task_info["expires_at"] <= now
        ]
        for task_id in expired_ids:
            self._active_tasks.pop(task_id, None)
            self._task_log_cursors.pop(task_id, None)
        if expired_ids:
            self._update_polling_scope()

    def _update_polling_scope(self) -> None:
        ship_ids = [
            task_info.get("target_character_id")
            for task_info in self._active_tasks.values()
            if task_info.get("is_corp_ship") and task_info.get("target_character_id")
        ]
        unique_ship_ids = sorted({sid for sid in ship_ids if isinstance(sid, str)})
        corp_id = self.game_client.corporation_id
        self.game_client.set_event_polling_scope(
            character_ids=[self.character_id],
            corp_id=corp_id,
            ship_ids=unique_ship_ids,
        )

    def _sync_corp_polling_scope(self) -> None:
        corp_id = self.game_client.corporation_id
        if corp_id == self._last_corporation_id:
            return
        self._last_corporation_id = corp_id
        self._update_polling_scope()


    async def _relay_event(self, event: Dict[str, Any]) -> None:
        self._prune_expired_tasks()
        event_name = event.get("event_name")
        payload = event.get("payload")
        event_request_id = event.get("request_id")
        clean_payload = self._strip_internal_event_metadata(payload)

        # Find the task_id for this event (if it belongs to a task)
        task_id: Optional[str] = None
        payload_task_id: Optional[str] = None
        if isinstance(payload, Mapping):
            candidate = payload.get("__task_id") or payload.get("task_id")
            if isinstance(candidate, str) and candidate.strip():
                payload_task_id = candidate.strip()

        is_our_task = False
        if payload_task_id:
            task_id = self._get_task_id_for_full(payload_task_id)
            is_our_task = task_id is not None
            # Also check finished tasks (task cleaned up before event arrived)
            if not is_our_task and self._is_recent_finished_task_id(payload_task_id):
                is_our_task = True
                # Clean up once we've seen the event
                if event_name == "task.finish":
                    self._forget_finished_task_id(payload_task_id)

            # Fan out task-scoped events to corp task agents (polling disabled)
            if task_id:
                task_info = self._active_tasks.get(task_id)
                task_agent = task_info.get("task_agent") if task_info else None
                task_game_client = task_info.get("task_game_client") if task_info else None
                delivery_event = task_info.get("event_delivery_check") if task_info else None
                if isinstance(delivery_event, asyncio.Event) and not delivery_event.is_set():
                    delivery_event.set()
                if task_agent and task_game_client and task_game_client != self.game_client:
                    await task_agent._handle_event(event)

        player_id: Optional[str] = None
        if isinstance(payload, Mapping):
            player = payload.get("player")
            if isinstance(player, Mapping):
                candidate = player.get("id")
                if isinstance(candidate, str) and candidate.strip():
                    player_id = candidate

        is_other_player_event = bool(
            player_id and player_id != self.character_id
        )

        # map.update is emitted server-side in Supabase move handler.

        # Filter out corp-visible movement events we don't want to forward
        drop_event = False
        drop_reason: Optional[str] = None
        if event_name == "movement.start" and is_other_player_event:
            drop_event = True
            drop_reason = "other_player_movement_start"
        elif event_name == "movement.complete" and is_other_player_event:
            drop_event = True
            drop_reason = "other_player_movement_complete"
        elif event_name == "character.moved" and is_other_player_event:
            movement = payload.get("movement") if isinstance(payload, Mapping) else None
            if movement == "depart":
                sector_id = self._extract_sector_id(payload)
                if self._current_sector_id is not None and sector_id is not None:
                    if sector_id != self._current_sector_id:
                        drop_event = True
                        drop_reason = "other_player_depart_outside_sector"

        if drop_event:
            logger.debug(
                "dropping event due to identity filter",
                event=event_name,
                player_id=player_id,
                reason=drop_reason,
            )
            return

        # Keep display name in sync from our own status events
        if (
            not is_other_player_event
            and isinstance(clean_payload, Mapping)
            and event_name in {"status.snapshot", "status.update"}
        ):
            self._update_display_name(clean_payload)
            self._sync_corp_polling_scope()

        await self.rtvi_processor.push_frame(
            RTVIServerMessageFrame(
                {
                    "frame_type": "event",
                    "event": event_name,
                    "payload": clean_payload,
                }
            )
        )

        # Track current sector for local visibility decisions
        if (
            not is_other_player_event
            and isinstance(clean_payload, Mapping)
            and event_name in {"status.snapshot", "status.update", "movement.complete"}
        ):
            sector_id = self._extract_sector_id(clean_payload)
            if sector_id is not None:
                self._current_sector_id = sector_id

        # Use voice-specific condensed summary for verbose events
        if event_name:
            event_for_summary = dict(event)
            event_for_summary["payload"] = clean_payload
            summary = self._get_voice_summary(str(event_name), event_for_summary) or clean_payload
        else:
            summary = clean_payload

        if not task_id:
            task_id = self._get_task_id_for_character(self.character_id)

        if event_name == "status.snapshot":
            logger.debug(
                f"status.snapshot received request_id={event_request_id} payload_task_id={payload_task_id} "
                f"resolved_task_id={task_id} is_our_task={is_our_task}"
            )

        event_context = self._extract_event_context(payload)
        is_task_lifecycle_event = event_name in {"task.start", "task.finish"}
        is_task_scoped_event = payload_task_id is not None

        event_sector_id: Optional[int] = None
        if event_name in {"character.moved", "garrison.character_moved"}:
            if isinstance(clean_payload, Mapping):
                event_sector_id = self._extract_sector_id(clean_payload)
        is_local_sector_movement = (
            event_sector_id is not None
            and self._current_sector_id is not None
            and event_sector_id == self._current_sector_id
        )

        should_append = False
        if event_name == "map.update":
            should_append = False
        elif is_task_lifecycle_event and is_our_task:
            should_append = True
        elif event_context is None:
            logger.info(
                "voice.event_context.missing event_name={} request_id={} payload_task_id={}",
                event_name,
                event_request_id,
                payload_task_id,
            )
            return
        else:
            scope = event_context.get("scope")
            recipient_reason = self._resolve_recipient_reason(
                event_context,
                self.character_id,
            )
            is_direct_to_player = (
                isinstance(scope, str)
                and scope in {"direct", "self"}
                and recipient_reason in {"direct", "task_owner"}
            )
            if is_direct_to_player:
                if is_task_scoped_event:
                    should_append = event_name in TASK_SCOPED_DIRECT_EVENT_ALLOWLIST
                else:
                    should_append = True
            elif is_local_sector_movement:
                should_append = True

        if not should_append:
            return

        # Build event XML with optional task_id
        if task_id:
            event_xml = f"<event name=\"{event_name}\" task_id=\"{task_id}\">\n{summary}\n</event>"
        else:
            event_xml = f"<event name=\"{event_name}\">\n{summary}\n</event>"

        # Determine if this event should trigger LLM inference
        # Most events only trigger inference when they came from voice agent's own tool calls
        # (task events don't match our tracked request IDs and handle their own inference)
        inference_triggering_events = {
            "status.snapshot",       # my_status results
            "ports.list",            # list_known_ports results
            "course.plot",           # plot_course results
            "chat.message",          # Direct messages to bot
            "combat.round_waiting",  # Need to submit combat action
            "combat.round_resolved", # Combat updates
            "combat.ended",          # Combat finished
            "error",                 # Error messages
        }

        # Events that should always trigger inference (don't require request_id match)
        # These are external events the voice agent must respond to
        always_trigger_events = {
            "chat.message",          # Incoming messages from other players
            "combat.round_waiting",  # Combat system waiting for action
            "combat.round_resolved", # Combat round completed
            "combat.ended",          # Combat finished
            "ship.renamed",          # Corp ship renamed (want to know about all corp activity)
        }

        # Check if event came from voice agent's tool call
        is_voice_agent_event = self._is_recent_request_id(event_request_id)

        # Debug logging for request ID tracking
        logger.debug(f"Event arrived: {event_name}")
        logger.debug(f"  event_request_id: {event_request_id}")
        logger.debug(f"  is_voice_agent_event: {is_voice_agent_event}")

        # Trigger inference if:
        # 1. Event is in always_trigger_events (external events needing response), OR
        # 2. Event is in inference_triggering_events AND from voice agent's tool call, OR
        # 3. Event is task.finish AND task was started by us (in _active_tasks)
        should_run_llm = (
            (event_name in always_trigger_events)
            or ((event_name in inference_triggering_events) and is_voice_agent_event)
            or (event_name == "task.finish" and is_our_task)
        )
        logger.debug(f"  should_run_llm: {should_run_llm}")

        # Defer task-scoped events while a tool call is inflight so the tool call
        # appears in context before its resulting events.
        if payload_task_id and self._tool_call_inflight > 0:
            if event_name == "task.finish":
                # Coalesce with the in-flight tool result to avoid duplicate replies.
                should_run_llm = False
                logger.debug(
                    "Deferring task.finish without run_llm because tool calls are inflight"
                )
            self._deferred_llm_events.append((event_xml, should_run_llm))
            return

        await self._deliver_llm_event(event_xml, should_run_llm)

    async def _deliver_llm_event(self, event_xml: str, should_run_llm: bool) -> None:
        await self.rtvi_processor.push_frame(
            LLMMessagesAppendFrame(
                messages=[
                    {
                        "role": "user",
                        "content": event_xml,
                    }
                ],
                run_llm=should_run_llm,
            )
        )

    async def _flush_deferred_llm_events(self) -> None:
        while self._deferred_llm_events:
            event_xml, should_run_llm = self._deferred_llm_events.popleft()
            await self._deliver_llm_event(event_xml, should_run_llm)

    #
    # Task management
    #

    def _get_task_id_for_character(self, character_id: str) -> Optional[str]:
        """Find the task_id for an active task that matches the given character_id.

        Args:
            character_id: The character ID to look up

        Returns:
            The task_id if found, None otherwise
        """
        for task_id, task_info in self._active_tasks.items():
            asyncio_task = task_info.get("asyncio_task")
            if (
                task_info.get("target_character_id") == character_id
                and asyncio_task
                and not asyncio_task.done()
            ):
                return task_id
        return None

    def _get_task_id_for_full(self, task_id: str) -> Optional[str]:
        """Resolve a full UUID task_id to the short task_id used for display."""
        if not task_id:
            return None
        if task_id in self._active_tasks:
            return task_id
        for short_id, task_info in self._active_tasks.items():
            if task_info.get("full_task_id") == task_id:
                return short_id
        return None

    def get_task_progress(self) -> str:
        """Get buffered task progress for chat context.

        Returns:
            Formatted task progress string
        """
        task_id = self._get_task_id_for_character(self.character_id)
        if not task_id:
            return ""
        task_info = self._active_tasks.get(task_id)
        if not task_info:
            return ""
        task_agent = task_info.get("task_agent")
        if not task_agent:
            return ""
        lines = task_agent.get_task_log()
        if not lines:
            return ""
        cursor = self._task_log_cursors.get(task_id, 0)
        if cursor < 0 or cursor > len(lines):
            cursor = 0
        new_lines = lines[cursor:]
        self._task_log_cursors[task_id] = len(lines)
        return "\n".join(new_lines)

    @staticmethod
    def _summarize_tool_result(raw_text: str) -> Optional[str]:
        """Extract the summary line from a serialized tool message."""

        try:
            message = json.loads(raw_text)
        except json.JSONDecodeError:
            return None

        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str):
            return None

        try:
            payload = json.loads(content)
            if isinstance(payload, dict):
                summary_value = payload.get("summary")
                if isinstance(summary_value, str) and summary_value.strip():
                    return summary_value.strip()
        except json.JSONDecodeError:
            pass

        summary_line = content.split("\n", 1)[0].strip()
        if (
            not summary_line
            or summary_line.startswith("Delta:")
            or summary_line.startswith("Result:")
        ):
            return None

        return summary_line

    @staticmethod
    def _summarize_leaderboard_resources(result: Any) -> Optional[str]:
        if not isinstance(result, dict):
            return None
        players = result.get("players")
        corporations = result.get("corporations")
        if not isinstance(players, list):
            players = []
        if not isinstance(corporations, list):
            corporations = []

        summary = f"Leaderboard: {len(players)} players, {len(corporations)} corporations."

        def _extract_name(entry: Any, keys: tuple[str, ...]) -> Optional[str]:
            if not isinstance(entry, dict):
                return None
            for key in keys:
                candidate = entry.get(key)
                if isinstance(candidate, str) and candidate.strip():
                    return candidate.strip()
            return None

        top_player_name = _extract_name(players[0] if players else None, ("name", "player_name", "character_name"))
        if top_player_name:
            summary += f" Top player: {_shorten_embedded_ids(top_player_name)}."

        top_corp_name = _extract_name(corporations[0] if corporations else None, ("name", "corp_name", "corporation_name"))
        if top_corp_name:
            summary += f" Top corp: {_shorten_embedded_ids(top_corp_name)}."

        return summary

    def _summarize_direct_response(self, tool_name: str, result: Any) -> Optional[str]:
        if isinstance(result, dict):
            summary = result.get("summary")
            if isinstance(summary, str) and summary.strip():
                return _shorten_embedded_ids(summary.strip())

        if tool_name == "corporation_info":
            summary = _summarize_corporation_info(result)
            if isinstance(summary, str) and summary.strip():
                return summary

        if tool_name == "leaderboard_resources":
            summary = self._summarize_leaderboard_resources(result)
            if isinstance(summary, str) and summary.strip():
                return summary

        return None

    async def _emit_tool_result(
        self, tool_name: str, payload: Dict[str, Any]
    ) -> None:
        await self.rtvi_processor.push_frame(
            RTVIServerMessageFrame(
                {
                    "frame_type": "event",
                    "event": tool_name,
                    "payload": payload,
                }
            )
        )

    def _create_agent_output_callback(self, task_id: str, task_type: str) -> Callable:
        """Create a task-specific output callback that includes task_id and task_type."""
        def _handle_agent_output(text: str, message_type: Optional[str] = None) -> None:
            """Schedule processing of agent output asynchronously."""
            asyncio.create_task(self._task_output_handler(text, message_type, task_id, task_type))
        return _handle_agent_output

    def _handle_agent_output(
        self, text: str, message_type: Optional[str] = None
    ) -> None:
        """Legacy callback for backwards compatibility - uses player_ship task type."""
        asyncio.create_task(self._task_output_handler(text, message_type, None, "player_ship"))

    async def _task_output_handler(
        self, text: str, message_type: Optional[str] = None, task_id: Optional[str] = None, task_type: str = "player_ship"
    ) -> None:
        """Handle output from the task agent.

        Args:
            text: Output text from task agent
            message_type: Type of message (e.g., step, finished, error)
            task_id: Optional task ID for multi-task tracking
            task_type: Type of task ("player_ship" or "corp_ship")
        """
        logger.info(f"!!! task output: [{message_type}] task_id={task_id} task_type={task_type} {text}")

        # send everything from the task agent to the client to be displayed
        await self.rtvi_processor.push_frame(
            RTVIServerMessageFrame(
                data={
                    "frame_type": "event",
                    "event": "task_output",
                    "task_id": task_id,
                    "task_type": task_type,
                    "payload": {
                        "text": text,
                        "task_message_type": message_type,
                    },
                }
            )
        )

        # Push task activity frame to reset idle timeout on main pipeline
        await self.rtvi_processor.push_frame(
            TaskActivityFrame(task_id=task_id or "", activity_type="output")
        )

        # TaskAgent now owns the task log; no buffering here.

    @traced
    async def _run_task_with_tracking(
        self,
        task_id: str,
        task_agent: TaskAgent,
        task_game_client: AsyncGameClient,
        task_description: str,
        target_character_id: str,
        is_corp_ship: bool,
        full_task_id: Optional[str] = None,
    ):
        """Run a task to completion with multi-task tracking.

        Args:
            task_id: Short task identifier (first 6 hex chars of UUID) for display
            task_agent: TaskAgent instance for this task
            task_game_client: AsyncGameClient for this task
            task_description: Natural language task description
            target_character_id: Character ID being controlled
            is_corp_ship: Whether this is a corporation ship
            full_task_id: Full UUID task identifier for database storage. If not provided,
                         a new UUID is generated by TaskAgent.
        """
        task_type = "corp_ship" if is_corp_ship else "player_ship"

        # Set trace attributes for this task session
        # actor_id is always the human player controlling VoiceTaskManager
        # ship_id is the entity being controlled (character_id for player, ship UUID for corp)
        with trace_attributes(task_attributes(
            task_id=task_id,
            task_type=task_type,
            ship_id=target_character_id,
            actor_id=self.character_id,
            task_description=task_description,
        )):
            return await self._run_task_impl(
                task_id, task_agent, task_game_client, task_description,
                target_character_id, is_corp_ship, task_type, full_task_id
            )

    async def _run_task_impl(
        self,
        task_id: str,
        task_agent: TaskAgent,
        task_game_client: AsyncGameClient,
        task_description: str,
        target_character_id: str,
        is_corp_ship: bool,
        task_type: str,
        full_task_id: Optional[str] = None,
    ):
        """Implementation of _run_task_with_tracking, separated for trace attributes."""
        was_cancelled = False

        try:
            logger.info(f"!!! running task {task_id} ({task_type}): {task_description}")
            # Pass full_task_id to TaskAgent so events are tagged with the UUID
            success = await task_agent.run_task(
                task=task_description, max_iterations=100, task_id=full_task_id
            )
            logger.info(f"!!! task {task_id} result: {success}")

            if success:
                await self._task_output_handler(
                    "Task completed successfully", "complete", task_id, task_type
                )
            else:
                # Check if it was cancelled vs failed
                if task_agent.cancelled:
                    was_cancelled = True
                    await self._task_output_handler(
                        "Task was cancelled by user", "cancelled", task_id, task_type
                    )
                else:
                    await self._task_output_handler("Task failed", "failed", task_id, task_type)

        except asyncio.CancelledError:
            was_cancelled = True
            await self._task_output_handler("Task was cancelled", "cancelled", task_id, task_type)
        except Exception as e:
            await self._task_output_handler(f"Task error: {str(e)}", "error", task_id, task_type)

        finally:
            # Track full_task_id so we recognize task.finish event after cleanup
            if full_task_id:
                self._track_finished_task_id(full_task_id)

            task_info = self._active_tasks.get(task_id)
            if task_info:
                finished_at = time.monotonic()
                task_info["finished_at"] = finished_at
                task_info["expires_at"] = finished_at + TASK_LOG_TTL_SECONDS
            self._task_log_cursors.pop(task_id, None)
            self._update_polling_scope()

            if is_corp_ship:
                await task_agent.close()
            else:
                task_agent.reset_task_state()
                task_agent.output_callback = self._handle_agent_output
                task_agent.set_task_metadata({})

            # Clean up corp ship client
            if is_corp_ship and task_game_client != self.game_client:
                try:
                    await task_game_client.close()
                except Exception as e:
                    logger.error(f"Failed to close corp ship client: {e}")

            # Update legacy flags for backwards compatibility
            if target_character_id == self.character_id:
                self.task_running = False
                # Reset the flag for next time
                self.cancelled_via_tool = False

    async def _run_task(self, task_description: str):
        """Legacy method for backwards compatibility. Redirects to tracked version."""
        short_task_id, full_task_id = self._generate_task_id()
        await self._run_task_with_tracking(
            task_id=short_task_id,
            task_agent=self.task_agent,
            task_game_client=self.game_client,
            task_description=task_description,
            target_character_id=self.character_id,
            is_corp_ship=False,
            full_task_id=full_task_id,
        )

    def cancel_task(self, via_tool: bool = True):
        """Cancel the currently running task.

        Args:
            via_tool: Whether this was called via the stop_task tool
        """
        if self.current_task and not self.current_task.done():
            # Store whether this was via tool for the completion callback
            self.cancelled_via_tool = via_tool
            # Set the cancellation flag first
            self.task_agent.cancel()
            self.task_running = False
            # Add immediate feedback
            self._handle_agent_output(
                "Cancellation requested - stopping task...", "cancelled"
            )

    @traced
    async def execute_tool_call(self, params: FunctionCallParams):
        """Generic executor for all declared tools, for tool calls from the
        conversation LLM.

        Dispatches to AsyncGameClient methods or manager handlers, then sends
        a single RTVI server message with gg-action=<tool_name> and either
        {result: ...} on success or {error: ...} on failure. Always calls
        params.result_callback with the same payload.
        """
        with trace_attributes(voice_session_attributes(
            character_id=self.character_id,
            display_name=self.display_name,
        )):
            return await self._execute_tool_call_impl(params)

    async def _execute_tool_call_impl(self, params: FunctionCallParams):
        """Implementation of execute_tool_call, separated for trace attributes."""
        # Try to discover the tool name from params (Pipecat provides name)
        tool_name = getattr(params, "name", None) or getattr(
            params, "function_name", None
        )
        if not tool_name:
            # Fallback: try to peek at arguments for an injected name (not expected)
            tool_name = "unknown"

        # Tools that generate events return minimal ack - actual data comes via events.
        # This prevents duplicate data in context (function_response + event).
        # run_llm=False because the event arrival will trigger inference.
        event_generating_tools = {
            "my_status",        # generates status.snapshot
            "plot_course",      # generates course.plot
            "list_known_ports", # generates ports.list
            "rename_ship",      # generates ship.renamed
        }

        # Tools that need explicit run_llm=True because they don't emit
        # inference-triggering events
        direct_response_tools = {
            "corporation_info",
            "leaderboard_resources",
        }

        self._tool_call_inflight += 1
        try:
            # Gather arguments for the call
            arguments = params.arguments

            # Special tools managed by the voice task manager
            if tool_name == "start_task":
                result = await self._handle_start_task(params)
                payload = {"result": result}
            elif tool_name == "stop_task":
                result = await self._handle_stop_task(params)
                payload = {"result": result}
            elif tool_name == "ui_show_panel":
                result = await self._handle_ui_show_panel(params)
                payload = {"result": result}
            elif tool_name == "query_task_progress":
                result = await self._handle_query_task_progress(params)
                payload = {"result": result}
            elif tool_name == "steer_task":
                result = await self._handle_steer_task(params)
                payload = {"result": result}
            elif tool_name == "load_game_info":
                result = await self._handle_load_game_info(params)
                payload = {"result": result}
            else:
                # Call the tool function via our dispatch table
                if tool_name not in self._tool_dispatch:
                    raise ValueError(f"Unknown tool: {tool_name}")

                func = self._tool_dispatch[tool_name]
                result = await func(**arguments)
                payload = {"result": result}

                # Track request ID for voice agent inference triggering
                # Extract from result (preferred) or fall back to last_request_id
                req_id = None
                if isinstance(result, dict):
                    req_id = result.get('request_id')
                if not req_id and hasattr(self.game_client, 'last_request_id'):
                    req_id = self.game_client.last_request_id
                if req_id:
                    self._track_request_id(req_id)
                    logger.debug(f"Tool {tool_name} tracking request_id={req_id}")

            if tool_name in event_generating_tools:
                ack_payload = {"status": "Executed."}
                properties = FunctionCallResultProperties(run_llm=False)
                await params.result_callback(ack_payload, properties=properties)
            elif tool_name in {"query_task_progress", "steer_task"}:
                if isinstance(result, dict) and result.get("success") is False:
                    error_payload = {"error": result.get("error", "Request failed.")}
                    properties = FunctionCallResultProperties(run_llm=True)
                    await params.result_callback(error_payload, properties=properties)
                else:
                    summary = result.get("summary") if isinstance(result, dict) else None
                    if not summary:
                        summary = f"{tool_name} completed."
                    response_payload = {"summary": summary}
                    if isinstance(result, dict) and result.get("task_id"):
                        response_payload["task_id"] = result.get("task_id")
                    properties = FunctionCallResultProperties(run_llm=True)
                    await params.result_callback(response_payload, properties=properties)
            elif tool_name == "load_game_info":
                # Return the full fragment content to the LLM
                if isinstance(result, dict) and result.get("success") is False:
                    error_payload = {"error": result.get("error", "Failed to load info")}
                    properties = FunctionCallResultProperties(run_llm=True)
                    await params.result_callback(error_payload, properties=properties)
                else:
                    # Return the full content - this is the whole point of the tool
                    content = result.get("content", "") if isinstance(result, dict) else ""
                    topic = result.get("topic", "unknown") if isinstance(result, dict) else "unknown"
                    response_payload = {"topic": topic, "content": content}
                    properties = FunctionCallResultProperties(run_llm=True)
                    await params.result_callback(response_payload, properties=properties)
            elif tool_name in direct_response_tools:
                # These tools return data directly without events - trigger inference.
                # Prefer summaries when available to avoid leaking large payloads.
                await self._emit_tool_result(tool_name, payload)
                summary = self._summarize_direct_response(tool_name, result)
                if not summary:
                    summary = f"{tool_name} completed."
                payload = {"summary": summary}
                properties = FunctionCallResultProperties(run_llm=True)
                await params.result_callback(payload, properties=properties)
            else:
                # Other tools (send_message, combat_*) emit events that trigger inference
                await params.result_callback(payload)
        except Exception as e:
            logger.error(f"tool '{tool_name}' failed: {e}")
            error_payload = {"error": str(e)}
            # Emit a standardized error as tool_result
            await params.result_callback(error_payload)
            if tool_name in direct_response_tools:
                try:
                    await self._emit_tool_result(tool_name, error_payload)
                except Exception as emit_err:  # noqa: BLE001
                    logger.error(f"tool '{tool_name}' failed to emit result: {emit_err}")
        finally:
            self._tool_call_inflight = max(0, self._tool_call_inflight - 1)
            if self._tool_call_inflight == 0:
                await self._flush_deferred_llm_events()

    def _is_valid_uuid(self, value: str) -> bool:
        """Check if a string is a valid UUID format."""
        import re
        uuid_pattern = re.compile(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
            re.IGNORECASE
        )
        return bool(uuid_pattern.match(value))

    async def _resolve_ship_id_prefix(self, prefix: str) -> Optional[str]:
        if not isinstance(prefix, str):
            return None
        cleaned = prefix.strip().strip("[]").lower()
        if not cleaned:
            return None
        if self._is_valid_uuid(cleaned):
            return cleaned

        # Use corporation info to resolve prefix without exposing full IDs to the LLM.
        try:
            corp_result = await self.game_client._request(
                "my_corporation",
                {"character_id": self.character_id},
            )
        except Exception as exc:
            logger.error(f"Failed to resolve ship_id prefix: {exc}")
            return None

        corp = corp_result.get("corporation")
        if not isinstance(corp, dict):
            return None

        ships = corp.get("ships")
        if not isinstance(ships, list):
            return None

        matches = []
        for ship in ships:
            if not isinstance(ship, dict):
                continue
            ship_id = ship.get("ship_id")
            if isinstance(ship_id, str) and ship_id.lower().startswith(cleaned):
                matches.append(ship_id)

        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise ValueError(
                f"Ambiguous ship_id prefix '{cleaned}' matches {len(matches)} ships. "
                "Use a longer prefix."
            )

        return None

    def _resolve_task_id_prefix(self, value: str) -> Optional[str]:
        if not isinstance(value, str):
            return None
        cleaned = value.strip()
        if not cleaned:
            return None

        if cleaned in self._active_tasks:
            return cleaned

        matches = []
        for short_id, task_info in self._active_tasks.items():
            full_id = task_info.get("full_task_id")
            if full_id == cleaned:
                return short_id
            if short_id.startswith(cleaned) or (
                isinstance(full_id, str) and full_id.startswith(cleaned)
            ):
                matches.append(short_id)

        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise ValueError(
                f"Ambiguous task_id prefix '{cleaned}' matches {len(matches)} tasks. "
                "Use a longer prefix."
            )

        return None

    async def _await_status_snapshot(
        self,
        client: AsyncGameClient,
        character_id: str,
        *,
        retry_interval_seconds: float = 4.0,
        max_wait_seconds: float = 20.0,
    ) -> None:
        """Wait for my_status to succeed, retrying when the ship is in hyperspace."""
        deadline = time.monotonic() + max_wait_seconds
        while True:
            try:
                await client.my_status(character_id=character_id)
                return
            except RPCError as exc:
                if exc.status == 409 and "hyperspace" in str(exc).lower():
                    if time.monotonic() >= deadline:
                        raise RuntimeError(
                            "Timed out waiting for status snapshot; ship still in hyperspace."
                        ) from exc
                    logger.debug(
                        f"my_status unavailable (hyperspace). Retrying in {retry_interval_seconds:.1f}s."
                    )
                    await asyncio.sleep(retry_interval_seconds)
                    continue
                raise

    async def _validate_corp_task_event_delivery(self, task_id: str) -> None:
        task_info = self._active_tasks.get(task_id)
        if not task_info or not task_info.get("is_corp_ship"):
            return
        delivery_event = task_info.get("event_delivery_check")
        if not isinstance(delivery_event, asyncio.Event):
            return
        try:
            await asyncio.wait_for(
                delivery_event.wait(),
                timeout=CORP_TASK_EVENT_VALIDATE_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "Corp task {} did not receive events within {:.1f}s. "
                "Verify events_since scope includes ship_id/corp_id.",
                task_id,
                CORP_TASK_EVENT_VALIDATE_TIMEOUT_SECONDS,
            )

    @traced
    async def _handle_start_task(self, params: FunctionCallParams):
        task_game_client = None
        task_agent: Optional[TaskAgent] = None
        try:
            logger.info(f"!!! start_task: {params.arguments}")
            task_desc = params.arguments.get("task_description", "")
            ship_id = params.arguments.get("ship_id")
            self._prune_expired_tasks()

            if isinstance(ship_id, str):
                ship_id = ship_id.strip().strip("[]")

            # Resolve short ship_id prefixes to full UUIDs if needed
            if ship_id and not self._is_valid_uuid(ship_id):
                try:
                    resolved = await self._resolve_ship_id_prefix(ship_id)
                except ValueError as exc:
                    return {"success": False, "error": str(exc)}
                if not resolved:
                    return {
                        "success": False,
                        "error": (
                            f"Unknown ship_id '{ship_id}'. Use the short id shown in brackets "
                            "for corp ships (e.g., Red Probe [5a8369]) or provide the full UUID."
                        ),
                    }
                ship_id = resolved

            # Determine target character (ship or player)
            target_character_id = ship_id if ship_id else self.character_id
            actor_character_id = self.character_id if ship_id else None

            # Check if this specific ship already has a running task
            for task_id, task_info in self._active_tasks.items():
                if task_info["target_character_id"] == target_character_id and not task_info["asyncio_task"].done():
                    return {
                        "success": False,
                        "error": f"Ship {target_character_id[:8]}... already has task {task_id} running. Stop it first.",
                    }

            # Check corp ship task limit
            if ship_id:
                active_corp_tasks = self._count_active_corp_ship_tasks()
                if active_corp_tasks >= MAX_CORP_SHIP_TASKS:
                    return {
                        "success": False,
                        "error": (
                            f"Cannot start more than {MAX_CORP_SHIP_TASKS} corp ship tasks. "
                            f"Currently running {active_corp_tasks}. Stop a task first."
                        ),
                    }

            # Generate new task ID - returns (short_task_id, full_task_id)
            # short_task_id (6 hex chars) is used for UI display and tracking
            # full_task_id (full UUID) is stored in database for event correlation
            short_task_id, full_task_id = self._generate_task_id()
            task_type = self._get_task_type(ship_id)
            task_metadata = {
                "actor_character_id": self.character_id,
                "actor_character_name": self.display_name,
                "task_scope": task_type,
                "ship_id": ship_id if ship_id else None,
            }

            # Create a new game client for this task (if corp ship)
            if ship_id:
                task_game_client = AsyncGameClient(
                    base_url=self.game_client.base_url,
                    character_id=target_character_id,
                    actor_character_id=actor_character_id,
                    entity_type="corporation_ship",
                    transport="supabase",
                    enable_event_polling=False,
                )
                await task_game_client.pause_event_delivery()
                logger.debug(
                    f"Paused event delivery for corp task {short_task_id} (ship_id={target_character_id})"
                )
                # Corp ships don't need to "join" - they already exist in the game.
                # Skip the join call and proceed directly to my_status below.
            else:
                task_game_client = self.game_client
                await task_game_client.pause_event_delivery()

            # Create task-specific agent with custom output callback
            if ship_id:
                task_agent = TaskAgent(
                    config=None,
                    game_client=task_game_client,
                    character_id=target_character_id,
                    output_callback=self._create_agent_output_callback(short_task_id, task_type),
                    task_metadata=task_metadata,
                )
            else:
                task_agent = self.task_agent
                task_agent.output_callback = self._create_agent_output_callback(short_task_id, task_type)
                task_agent.set_task_metadata(task_metadata)
                task_agent.reset_task_state()

            # call my_status so the first thing the task gets is a status.snapshot event
            # Note: my_status will automatically recover ships stuck in hyperspace
            try:
                if ship_id:
                    logger.debug(
                        f"Corp task {short_task_id} requesting initial status.snapshot (ship_id={target_character_id})"
                    )
                await self._await_status_snapshot(
                    task_game_client,
                    target_character_id,
                    retry_interval_seconds=4.0,
                )
                if ship_id:
                    logger.debug(
                        f"Corp task {short_task_id} initial status.snapshot request completed (ship_id={target_character_id})"
                    )
            except Exception:
                if task_game_client != self.game_client:
                    await task_game_client.close()
                else:
                    await self.game_client.resume_event_delivery()
                raise

            # Start the task - pass full_task_id so events are tagged with the UUID
            asyncio_task = asyncio.create_task(
                self._run_task_with_tracking(
                    task_id=short_task_id,
                    task_agent=task_agent,
                    task_game_client=task_game_client,
                    task_description=task_desc,
                    target_character_id=target_character_id,
                    is_corp_ship=(ship_id is not None),
                    full_task_id=full_task_id,
                )
            )

            # Track the task using short_task_id as the key
            self._active_tasks[short_task_id] = {
                "task_id": short_task_id,
                "full_task_id": full_task_id,  # Store full UUID for event queries
                "task_type": task_type,
                "target_character_id": target_character_id,
                "actor_character_id": actor_character_id,
                "task_agent": task_agent,
                "task_game_client": task_game_client,
                "asyncio_task": asyncio_task,
                "description": task_desc,
                "is_corp_ship": (ship_id is not None),
                "finished_at": None,
                "expires_at": None,
                "event_delivery_check": asyncio.Event() if ship_id else None,
            }
            self._update_polling_scope()
            if ship_id:
                asyncio.create_task(self._validate_corp_task_event_delivery(short_task_id))

            # Update legacy flags for backwards compatibility
            if not ship_id:
                self.task_running = True
                self.current_task = asyncio_task

            return {
                "success": True,
                "message": f"Task {short_task_id} started",
                "task_id": short_task_id,
                "task_type": task_type,
            }
        except Exception as e:
            logger.error(f"start_task failed: {e}")
            if task_agent and ship_id:
                await task_agent.close()
            elif task_agent and not ship_id:
                task_agent.output_callback = self._handle_agent_output
                task_agent.set_task_metadata({})
            if task_game_client and task_game_client != self.game_client:
                await task_game_client.close()
            elif task_game_client == self.game_client:
                await self.game_client.resume_event_delivery()
            return {"success": False, "error": str(e)}

    async def _handle_task_cancel_event(self, event: Dict[str, Any]) -> None:
        """Handle incoming task.cancel events - cancel matching task if running."""
        payload = event.get("payload", {})
        task_id_to_cancel = payload.get("task_id")

        if not task_id_to_cancel:
            return

        # Find task by full_task_id or short_task_id
        matching_task_id = None
        for short_id, task_info in self._active_tasks.items():
            if task_info.get("full_task_id") == task_id_to_cancel or short_id == task_id_to_cancel:
                matching_task_id = short_id
                break

        if not matching_task_id:
            return

        task_info = self._active_tasks[matching_task_id]
        asyncio_task = task_info["asyncio_task"]
        if asyncio_task.done():
            return

        task_agent = task_info["task_agent"]
        task_agent.cancel()
        logger.info(f"Cancelled task {matching_task_id} via task.cancel event")

    @traced
    async def _handle_stop_task(self, params: FunctionCallParams):
        try:
            task_id = params.arguments.get("task_id")

            if task_id:
                if isinstance(task_id, str):
                    task_id = task_id.strip()
                try:
                    resolved_task_id = self._resolve_task_id_prefix(str(task_id))
                except ValueError as exc:
                    return {"success": False, "error": str(exc)}

                if not resolved_task_id:
                    return {
                        "success": False,
                        "error": f"Task {task_id} not found",
                    }
                task_id = resolved_task_id

                # Cancel specific task by ID
                task_info = self._active_tasks.get(task_id)
                if not task_info:
                    return {
                        "success": False,
                        "error": f"Task {task_id} not found",
                    }

                asyncio_task = task_info["asyncio_task"]
                if asyncio_task.done():
                    return {
                        "success": False,
                        "error": f"Task {task_id} is not running",
                    }

                task_agent = task_info["task_agent"]
                task_agent.cancel()

                return {
                    "success": True,
                    "message": f"Task {task_id} cancelled",
                    "task_id": task_id,
                }
            else:
                # Cancel player ship task (backwards compatibility)
                player_ship_task_id = None
                for tid, task_info in self._active_tasks.items():
                    if task_info["target_character_id"] == self.character_id and not task_info["asyncio_task"].done():
                        player_ship_task_id = tid
                        break

                if not player_ship_task_id:
                    # Fall back to legacy current_task
                    if self.current_task and not self.current_task.done():
                        self.task_agent.cancel()
                        return {"success": True, "message": "Task cancelled"}
                    else:
                        return {"success": False, "error": "No player ship task is currently running"}

                task_info = self._active_tasks[player_ship_task_id]
                task_agent = task_info["task_agent"]

                task_agent.cancel()

                return {
                    "success": True,
                    "message": f"Task {player_ship_task_id} cancelled",
                    "task_id": player_ship_task_id,
                }

        except Exception as e:
            logger.error(f"stop_task failed: {e}")
            return {"success": False, "error": str(e)}

    def _build_task_progress_prompt(self, log_lines: list[str]) -> str:
        return build_task_progress_prompt(log_lines)

    async def _run_query_task_progress_async(
        self,
        *,
        task_id: str,
        task_agent: TaskAgent,
        prompt: str,
        system_prompt: str,
        log_line_count: int,
        log_char_count: int,
    ) -> None:
        start = time.monotonic()
        try:
            response = await task_agent.query_task_progress(
                prompt.strip(),
                system_prompt=system_prompt,
            )
            elapsed = time.monotonic() - start
            summary = (response or "").strip() or "No task log available."
            logger.info(
                "query_task_progress async completed task_id={} log_lines={} log_chars={} elapsed={:.2f}s",
                task_id,
                log_line_count,
                log_char_count,
                elapsed,
            )
            event_xml = (
                f"<event name=\"task.progress\" task_id=\"{task_id}\">\n"
                f"{summary}\n"
                f"</event>"
            )
            if self._tool_call_inflight > 0:
                logger.debug(
                    "Deferring task.progress event while tool calls inflight count={}",
                    self._tool_call_inflight,
                )
                self._deferred_llm_events.append((event_xml, True))
            else:
                await self._deliver_llm_event(event_xml, should_run_llm=True)
        except Exception as exc:  # noqa: BLE001
            elapsed = time.monotonic() - start
            logger.exception(
                "query_task_progress async failed task_id={} log_lines={} log_chars={} elapsed={:.2f}s error={}",
                task_id,
                log_line_count,
                log_char_count,
                elapsed,
                exc,
            )
            event_xml = (
                f"<event name=\"error\" task_id=\"{task_id}\">\n"
                f"Task progress query failed: {exc}\n"
                f"</event>"
            )
            if self._tool_call_inflight > 0:
                logger.debug(
                    "Deferring task.progress error event while tool calls inflight count={}",
                    self._tool_call_inflight,
                )
                self._deferred_llm_events.append((event_xml, True))
            else:
                await self._deliver_llm_event(event_xml, should_run_llm=True)

    @traced
    async def _handle_query_task_progress(self, params: FunctionCallParams):
        self._prune_expired_tasks()
        prompt = params.arguments.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            return {"success": False, "error": "prompt is required"}

        task_id = params.arguments.get("task_id")
        if task_id:
            if isinstance(task_id, str):
                task_id = task_id.strip()
            try:
                resolved_task_id = self._resolve_task_id_prefix(str(task_id))
            except ValueError as exc:
                return {"success": False, "error": str(exc)}
            if not resolved_task_id:
                return {"success": False, "error": f"Task {task_id} not found"}
            task_id = resolved_task_id
        else:
            task_id = self._get_task_id_for_character(self.character_id)

        if not task_id:
            return {
                "success": False,
                "error": "No active task found. Provide a task_id to query.",
            }

        task_info = self._active_tasks.get(task_id)
        if not task_info:
            return {"success": False, "error": f"Task {task_id} not found"}

        task_agent = task_info.get("task_agent")
        if not task_agent:
            return {"success": False, "error": f"Task {task_id} not available"}

        full_task_id = task_info.get("full_task_id")
        log_lines = task_agent.get_task_log(full_task_id)
        if not log_lines:
            return {"success": False, "error": f"No task log available for {task_id}"}

        system_prompt = self._build_task_progress_prompt(log_lines)
        log_line_count = len(log_lines)
        log_char_count = sum(len(line) for line in log_lines)
        logger.info(
            "query_task_progress scheduled task_id={} log_lines={} log_chars={}",
            task_id,
            log_line_count,
            log_char_count,
        )
        asyncio.create_task(
            self._run_query_task_progress_async(
                task_id=task_id,
                task_agent=task_agent,
                prompt=prompt,
                system_prompt=system_prompt,
                log_line_count=log_line_count,
                log_char_count=log_char_count,
            )
        )
        return {
            "success": True,
            "summary": "Checking task progress now; I'll report back shortly.",
            "task_id": task_id,
            "async": True,
        }

    @traced
    async def _handle_steer_task(self, params: FunctionCallParams):
        task_id = params.arguments.get("task_id")
        message = params.arguments.get("message")

        if not isinstance(task_id, str) or not task_id.strip():
            return {"success": False, "error": "task_id is required"}
        if not isinstance(message, str) or not message.strip():
            return {"success": False, "error": "message is required"}

        try:
            resolved_task_id = self._resolve_task_id_prefix(task_id.strip())
        except ValueError as exc:
            return {"success": False, "error": str(exc)}
        if not resolved_task_id:
            return {"success": False, "error": f"Task {task_id} not found"}

        task_info = self._active_tasks.get(resolved_task_id)
        if not task_info:
            return {"success": False, "error": f"Task {resolved_task_id} not found"}

        asyncio_task = task_info.get("asyncio_task")
        if not asyncio_task or asyncio_task.done():
            return {"success": False, "error": f"Task {resolved_task_id} is not running"}

        task_agent = task_info.get("task_agent")
        if not task_agent:
            return {"success": False, "error": f"Task {resolved_task_id} not available"}

        steering_text = message.strip()
        if not steering_text.lower().startswith("steering instruction:"):
            steering_text = f"Steering instruction: {steering_text}"

        await task_agent.inject_user_message(steering_text)

        return {
            "success": True,
            "summary": f"Steering instruction sent to task {resolved_task_id}.",
            "task_id": resolved_task_id,
        }

    async def _handle_ui_show_panel(self, params: FunctionCallParams):
        try:
            logger.info(f"show_panel: {params.arguments}")
            await params.llm.push_frame(
                RTVIServerMessageFrame({"ui-action": "show_panel", **params.arguments})
            )
            return {"success": True, "message": "Panel shown"}
        except Exception as e:
            logger.error(f"ui_show_panel failed: {e}")
            return {"success": False, "error": str(e)}

    async def _handle_load_game_info(self, params: FunctionCallParams):
        """Load detailed game information for a specific topic."""
        topic = params.arguments.get("topic")
        if not isinstance(topic, str) or not topic.strip():
            return {"success": False, "error": "topic is required"}

        tool = LoadGameInfo()
        result = tool(topic=topic.strip())
        if "error" in result:
            return {"success": False, "error": result["error"]}
        return {"success": True, "topic": topic.strip(), "content": result.get("content", "")}

    def get_tools_schema(self) -> ToolsSchema:
        # Use the central tool schemas for consistency with TUI/NPC
        # Note: Most tools (Move, Trade, Banking, etc.) are only available through tasks.
        # See prompts.py for the full list of task-only vs direct tools.
        return ToolsSchema(
            standard_tools=[
                MyStatus.schema(),
                LeaderboardResources.schema(),
                PlotCourse.schema(),
                ListKnownPorts.schema(),
                SendMessage.schema(),
                CombatInitiate.schema(),
                CombatAction.schema(),
                CorporationInfo.schema(),
                RenameShip.schema(),
                QueryTaskProgress.schema(),
                SteerTask.schema(),
                StartTask.schema(),
                StopTask.schema(),
                LoadGameInfo.schema(),
                UI_SHOW_PANEL_SCHEMA,
            ]
        )
