"""UI agent for autonomous client UI control.

Runs in a parallel branch to the voice pipeline. It watches the latest user
message (or course.plot events) and decides whether to issue UI actions. It
maintains a rolling context summary for UI-relevant state.

Pipeline: UIAgentContext → LLMService → UIAgentResponseCollector
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Optional

from loguru import logger
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import (
    CancelFrame,
    Frame,
    FunctionCallResultFrame,
    FunctionCallResultProperties,
    FunctionCallsStartedFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMMessagesAppendFrame,
    LLMTextFrame,
    StartFrame,
    EndFrame,
    SystemFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.frameworks.rtvi import RTVIServerMessageFrame
from pipecat.services.llm_service import FunctionCallParams

from gradientbang.pipecat_server.inference_gate import PreLLMInferenceGate
from gradientbang.utils.prompt_loader import build_ui_agent_prompt
from gradientbang.utils.tools_schema import CorporationInfo, MyStatus

CONTROL_UI_SCHEMA = FunctionSchema(
    name="control_ui",
    description="Control the game client user interface. Set any combination of fields.",
    properties={
        "show_panel": {
            "type": "string",
            "enum": ["map", "default"],
            "description": "Show map screen (map) or close it (default)",
        },
        "map_center_sector": {
            "type": "integer",
            "description": "Center the map on this sector ID (discovered sector only)",
        },
        "map_zoom_level": {
            "type": "integer",
            "description": "Zoom level: 4 (closest) to 50 (widest)",
        },
        "map_highlight_path": {
            "type": "array",
            "items": {"type": "integer"},
            "description": "Highlight these sectors as a course path",
        },
        "map_fit_sectors": {
            "type": "array",
            "items": {"type": "integer"},
            "description": "Adjust map bounds so all these sectors are visible",
        },
        "clear_course_plot": {
            "type": "boolean",
            "description": "Clear any highlighted course/path",
        },
    },
    required=[],
)

QUEUE_UI_INTENT_SCHEMA = FunctionSchema(
    name="queue_ui_intent",
    description=(
        "Queue a pending UI intent that will be fulfilled when a matching server event arrives. "
        "Does not change the UI immediately."
    ),
    properties={
        "intent_type": {
            "type": "string",
            "enum": ["ports.list", "ships.list", "course.plot"],
            "description": "Event type to wait for.",
        },
        "mega": {
            "type": "boolean",
            "description": "For ports.list intents: filter by mega-port status.",
        },
        "port_type": {
            "type": "string",
            "description": "For ports.list intents: filter by port code (e.g., 'BBB', 'SSS').",
        },
        "commodity": {
            "type": "string",
            "enum": ["quantum_foam", "retro_organics", "neuro_symbolics"],
            "description": "For ports.list intents: commodity filter.",
        },
        "trade_type": {
            "type": "string",
            "enum": ["buy", "sell"],
            "description": "For ports.list intents: trade direction filter.",
        },
        "from_sector": {
            "type": "integer",
            "description": "For ports.list intents: origin sector to measure hops from.",
        },
        "max_hops": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100,
            "description": "For ports.list intents: maximum hop distance to search.",
        },
        "ship_scope": {
            "type": "string",
            "enum": ["corporation", "personal", "all"],
            "description": "For ships.list intents: which ships to include.",
        },
        "include_player_sector": {
            "type": "boolean",
            "description": "Include the player's current sector in map_fit_sectors.",
        },
        "show_panel": {
            "type": "boolean",
            "description": "For course.plot intents: open the map when fulfilling.",
        },
        "expires_in_secs": {
            "type": "integer",
            "minimum": 1,
            "description": "Override the default intent timeout.",
        },
        "clear_existing": {
            "type": "boolean",
            "description": "Replace any existing pending intent of the same type.",
        },
    },
    required=["intent_type"],
)

UI_AGENT_TOOLS = ToolsSchema(
    [
        CONTROL_UI_SCHEMA,
        QUEUE_UI_INTENT_SCHEMA,
        CorporationInfo.schema(),
        MyStatus.schema(),
    ]
)

_CONTEXT_SUMMARY_RE = re.compile(r"<context_summary>(.*?)</context_summary>", re.DOTALL)
_EVENT_NAME_RE = re.compile(r"<event\s+name=(?:\"([^\"]+)\"|([^\s>]+))")

DEFAULT_SHIPS_CACHE_TTL_SECS = 60
DEFAULT_STATUS_TIMEOUT_SECS = 10
DEFAULT_PORTS_LIST_TIMEOUT_SECS = 15
DEFAULT_SHIPS_LIST_TIMEOUT_SECS = 15
DEFAULT_COURSE_PLOT_TIMEOUT_SECS = 25
DEFAULT_PORTS_LIST_STALE_SECS = 60
DEFAULT_UI_INTENT_REQUEST_DELAY_SECS = 2.0
DEFAULT_PORTS_LIST_MAX_HOPS = 100


class UIAgentContext(FrameProcessor):
    """Catches LLMContextFrame from main pipeline, builds fresh context, pushes to LLM."""

    def __init__(self, config, rtvi, game_client) -> None:
        super().__init__()
        self._config = config
        self._rtvi = rtvi
        self._game_client = game_client
        self._context_summary: str = ""
        self._cached_ships: list[dict] = []
        self._cached_ships_at: float | None = None
        self._cached_ships_source_ts: str | None = None
        self._cached_ships_source_epoch: float | None = None
        self._last_run_message_count = 0
        self._pending_rerun = False
        self._inference_lock = asyncio.Lock()
        self._inference_inflight = False
        self._context: Optional[Any] = None  # main pipeline LLMContext reference
        self._ships_cache_ttl_secs = self._read_ships_cache_ttl()

        # control_ui dedup state
        self._last_show_panel: str | None = None
        self._last_map_center_sector: int | None = None
        self._last_map_zoom_level: int | None = None
        self._last_map_highlight_path: tuple[int, ...] | None = None
        self._last_map_fit_sectors: tuple[int, ...] | None = None

        # Tool instances
        self._corp_info_tool = CorporationInfo(game_client)
        self._my_status_tool = MyStatus(game_client)

        # Event-driven tool result tracking
        self._messages: list[dict] = []
        self._pending_results: int = 0
        self._end_frame_seen: bool = False
        self._had_tool_calls: bool = False
        self._response_text: str = ""
        self._pending_tools: dict[str, dict] = {}  # correlation key → {tool_call_id, function_name}
        self._status_timeout_task: Optional[asyncio.Task] = None
        self._ports_list_timeout_task: Optional[asyncio.Task] = None
        self._ships_list_timeout_task: Optional[asyncio.Task] = None
        self._course_plot_timeout_task: Optional[asyncio.Task] = None
        self._ports_list_request_task: Optional[asyncio.Task] = None
        self._ships_list_request_task: Optional[asyncio.Task] = None
        # Function call completion tracking (solves race between LLMFullResponseEndFrame
        # and background function call handlers in pipecat's LLM service)
        self._expected_fc_count: int = 0
        self._received_fc_results: int = 0
        self._status_timeout_secs = float(
            os.getenv("UI_AGENT_STATUS_TIMEOUT_SECS", str(DEFAULT_STATUS_TIMEOUT_SECS))
        )
        self._ports_list_timeout_secs = float(
            os.getenv("UI_AGENT_PORTS_LIST_TIMEOUT_SECS", str(DEFAULT_PORTS_LIST_TIMEOUT_SECS))
        )
        self._ships_list_timeout_secs = float(
            os.getenv("UI_AGENT_SHIPS_LIST_TIMEOUT_SECS", str(DEFAULT_SHIPS_LIST_TIMEOUT_SECS))
        )
        self._course_plot_timeout_secs = float(
            os.getenv("UI_AGENT_COURSE_PLOT_TIMEOUT_SECS", str(DEFAULT_COURSE_PLOT_TIMEOUT_SECS))
        )
        self._ports_list_stale_secs = float(
            os.getenv("UI_AGENT_PORTS_LIST_STALE_SECS", str(DEFAULT_PORTS_LIST_STALE_SECS))
        )
        self._intent_request_delay_secs = float(
            os.getenv(
                "UI_AGENT_INTENT_REQUEST_DELAY_SECS",
                str(DEFAULT_UI_INTENT_REQUEST_DELAY_SECS),
            )
        )
        self._pending_ports_list_intent: dict | None = None
        self._pending_ships_list_intent: dict | None = None
        self._pending_course_plot_intent: dict | None = None
        self._pending_intent_id = 0
        self._ports_list_cache: dict[tuple, dict] = {}
        self._ports_list_cache_seen_at: dict[tuple, float] = {}

        # Register event listener for status.snapshot
        self._game_client.on("ships.list")(self._on_ships_list)
        self._game_client.add_event_handler("status.snapshot", self._on_status_snapshot)
        self._game_client.add_event_handler("ports.list", self._on_ports_list)
        self._game_client.add_event_handler("course.plot", self._on_course_plot)

    # ── Ships cache ───────────────────────────────────────────────────

    @staticmethod
    def _read_ships_cache_ttl() -> int:
        raw = os.getenv("UI_AGENT_SHIPS_CACHE_TTL_SECS", str(DEFAULT_SHIPS_CACHE_TTL_SECS))
        try:
            ttl = int(raw)
        except ValueError:
            logger.warning(
                f"Invalid UI_AGENT_SHIPS_CACHE_TTL_SECS '{raw}', using default {DEFAULT_SHIPS_CACHE_TTL_SECS}"
            )
            return DEFAULT_SHIPS_CACHE_TTL_SECS
        return max(0, ttl)

    async def _on_ships_list(self, event_message: dict) -> None:
        payload = event_message.get("payload", event_message)
        if not isinstance(payload, dict):
            return
        ships = payload.get("ships")
        if isinstance(ships, list):
            self._cached_ships = ships
            self._cached_ships_at = time.time()
            self._cached_ships_source_ts = None
            self._cached_ships_source_epoch = None

            source = payload.get("source")
            if isinstance(source, dict):
                timestamp = source.get("timestamp")
                if isinstance(timestamp, str) and timestamp.strip():
                    parsed_epoch = self._parse_timestamp(timestamp)
                    if parsed_epoch is not None:
                        self._cached_ships_source_ts = timestamp
                        self._cached_ships_source_epoch = parsed_epoch

        await self._handle_ships_list_intent(payload)

    @staticmethod
    def _parse_timestamp(value: str) -> float | None:
        try:
            normalized = value.replace("Z", "+00:00")
            return datetime.fromisoformat(normalized).astimezone(timezone.utc).timestamp()
        except Exception:
            return None

    def _ships_cache_age(self) -> float | None:
        if self._cached_ships_at is None:
            return None
        now = time.time()
        reference = self._cached_ships_source_epoch or self._cached_ships_at
        return max(0.0, now - reference)

    def _ships_cache_is_fresh(self) -> bool:
        age = self._ships_cache_age()
        if age is None:
            return False
        return age <= self._ships_cache_ttl_secs

    # ── Frame processing ──────────────────────────────────────────────

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, SystemFrame):
            if isinstance(frame, (StartFrame, EndFrame, CancelFrame)):
                await self.push_frame(frame, direction)
            return

        if not isinstance(frame, LLMContextFrame):
            return

        self._context = frame.context
        messages = frame.context.messages
        if not isinstance(messages, list) or not messages:
            return

        message_count = len(messages)
        if message_count == self._last_run_message_count:
            return

        last_message = messages[-1]
        if not isinstance(last_message, dict):
            return

        if last_message.get("role") != "user":
            return

        content = last_message.get("content")
        if not isinstance(content, str):
            return

        if self._is_event_message(last_message):
            event_name = self._extract_event_name(content)
            if event_name != "course.plot":
                return
        elif self._is_structured_message(content):
            return

        # Cancel any in-progress inference (stale tool results, etc.)
        self._cancel_pending_inference()

        await self._schedule_inference()

    # ── Inference scheduling ──────────────────────────────────────────

    async def _schedule_inference(self) -> None:
        async with self._inference_lock:
            if self._inference_inflight:
                self._pending_rerun = True
                return
            self._inference_inflight = True
        self.create_task(self._run_inference())

    async def _run_inference(self) -> None:
        try:
            if not self._context or not isinstance(self._context.messages, list):
                await self._abort_inference()
                return

            messages = self._context.messages
            latest_user = self._find_latest_message(messages, "user")
            if not latest_user:
                await self._abort_inference()
                return

            latest_assistant = self._find_latest_message(messages, "assistant")
            user_payload = self._build_user_payload(latest_user, latest_assistant)

            prompt = build_ui_agent_prompt()

            # Build fresh messages list for this inference run
            self._messages = [
                {"role": "system", "content": prompt},
                {"role": "user", "content": user_payload},
            ]
            self._pending_results = 0
            self._end_frame_seen = False
            self._had_tool_calls = False
            self._response_text = ""
            self._pending_tools.clear()
            self._expected_fc_count = 0
            self._received_fc_results = 0

            # Create fresh LLMContext with a snapshot of messages
            context = LLMContext(
                messages=list(self._messages),
                tools=UI_AGENT_TOOLS,
            )

            await self.push_frame(
                LLMContextFrame(context=context),
                FrameDirection.DOWNSTREAM,
            )
            self._last_run_message_count = len(messages)
        except Exception as exc:  # noqa: BLE001
            logger.exception(f"UI agent inference failed: {exc}")
            await self._abort_inference()

    async def _push_rerun_inference(self) -> None:
        """Push a new LLMContextFrame for re-inference after tool results."""
        context = LLMContext(
            messages=list(self._messages),
            tools=UI_AGENT_TOOLS,
        )
        self._end_frame_seen = False
        self._had_tool_calls = False
        self._response_text = ""
        self._pending_results = 0
        self._pending_tools.clear()
        self._expected_fc_count = 0
        self._received_fc_results = 0
        await self.push_frame(
            LLMContextFrame(context=context),
            FrameDirection.DOWNSTREAM,
        )

    async def _abort_inference(self) -> None:
        async with self._inference_lock:
            self._inference_inflight = False
            self._pending_rerun = False

    def _cancel_pending_inference(self) -> None:
        """Cancel any pending tool results and timeout tasks."""
        self._pending_results = 0
        self._end_frame_seen = False
        self._had_tool_calls = False
        self._pending_tools.clear()
        self._expected_fc_count = 0
        self._received_fc_results = 0
        if self._status_timeout_task and not self._status_timeout_task.done():
            self._status_timeout_task.cancel()
            self._status_timeout_task = None

    def _next_intent_id(self) -> int:
        self._pending_intent_id += 1
        return self._pending_intent_id

    def _set_pending_ports_list_intent(
        self,
        *,
        filters: dict,
        include_player_sector: bool,
        show_panel: bool,
        expires_in_secs: float | None,
        replace_existing: bool,
    ) -> int:
        if replace_existing:
            self._clear_pending_ports_list_intent()
        intent_id = self._next_intent_id()
        timeout_secs = self._ports_list_timeout_secs if expires_in_secs is None else max(
            1.0, float(expires_in_secs)
        )
        expires_at = time.time() + timeout_secs
        self._pending_ports_list_intent = {
            "id": intent_id,
            "filters": filters,
            "include_player_sector": include_player_sector,
            "show_panel": show_panel,
            "expires_at": expires_at,
        }

        if self._ports_list_timeout_task and not self._ports_list_timeout_task.done():
            self._ports_list_timeout_task.cancel()
        self._ports_list_timeout_task = self.create_task(
            self._ports_list_intent_timeout(intent_id, expires_at)
        )
        return intent_id

    def _set_pending_ships_list_intent(
        self,
        *,
        ship_scope: str,
        include_player_sector: bool,
        show_panel: bool,
        expires_in_secs: float | None,
        replace_existing: bool,
    ) -> int:
        if replace_existing:
            self._clear_pending_ships_list_intent()
        intent_id = self._next_intent_id()
        timeout_secs = self._ships_list_timeout_secs if expires_in_secs is None else max(
            1.0, float(expires_in_secs)
        )
        expires_at = time.time() + timeout_secs
        self._pending_ships_list_intent = {
            "id": intent_id,
            "ship_scope": ship_scope,
            "include_player_sector": include_player_sector,
            "show_panel": show_panel,
            "expires_at": expires_at,
        }

        if self._ships_list_timeout_task and not self._ships_list_timeout_task.done():
            self._ships_list_timeout_task.cancel()
        self._ships_list_timeout_task = self.create_task(
            self._ships_list_intent_timeout(intent_id, expires_at)
        )
        return intent_id

    def _set_pending_course_plot_intent(
        self,
        *,
        include_player_sector: bool,
        show_panel: bool,
        expires_in_secs: float | None,
        replace_existing: bool,
    ) -> int:
        if replace_existing:
            self._clear_pending_course_plot_intent()
        intent_id = self._next_intent_id()
        timeout_secs = self._course_plot_timeout_secs if expires_in_secs is None else max(
            1.0, float(expires_in_secs)
        )
        expires_at = time.time() + timeout_secs
        self._pending_course_plot_intent = {
            "id": intent_id,
            "include_player_sector": include_player_sector,
            "show_panel": show_panel,
            "expires_at": expires_at,
        }

        if self._course_plot_timeout_task and not self._course_plot_timeout_task.done():
            self._course_plot_timeout_task.cancel()
        self._course_plot_timeout_task = self.create_task(
            self._course_plot_intent_timeout(intent_id, expires_at)
        )
        return intent_id

    def _clear_pending_ports_list_intent(self) -> None:
        self._pending_ports_list_intent = None
        if self._ports_list_timeout_task and not self._ports_list_timeout_task.done():
            self._ports_list_timeout_task.cancel()
            self._ports_list_timeout_task = None
        if self._ports_list_request_task and not self._ports_list_request_task.done():
            self._ports_list_request_task.cancel()
            self._ports_list_request_task = None

    def _clear_pending_ships_list_intent(self) -> None:
        self._pending_ships_list_intent = None
        if self._ships_list_timeout_task and not self._ships_list_timeout_task.done():
            self._ships_list_timeout_task.cancel()
            self._ships_list_timeout_task = None
        if self._ships_list_request_task and not self._ships_list_request_task.done():
            self._ships_list_request_task.cancel()
            self._ships_list_request_task = None

    def _clear_pending_course_plot_intent(self) -> None:
        self._pending_course_plot_intent = None
        if self._course_plot_timeout_task and not self._course_plot_timeout_task.done():
            self._course_plot_timeout_task.cancel()
            self._course_plot_timeout_task = None

    async def _ports_list_intent_timeout(self, intent_id: int, expires_at: float) -> None:
        try:
            delay = max(0.0, expires_at - time.time())
            if delay:
                await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return

        pending = self._pending_ports_list_intent
        if not pending or pending.get("id") != intent_id:
            return
        self._pending_ports_list_intent = None
        logger.debug("UI agent ports.list intent expired before event arrival")

    async def _ships_list_intent_timeout(self, intent_id: int, expires_at: float) -> None:
        try:
            delay = max(0.0, expires_at - time.time())
            if delay:
                await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return

        pending = self._pending_ships_list_intent
        if not pending or pending.get("id") != intent_id:
            return
        self._pending_ships_list_intent = None
        logger.debug("UI agent ships.list intent expired before event arrival")

    async def _course_plot_intent_timeout(self, intent_id: int, expires_at: float) -> None:
        try:
            delay = max(0.0, expires_at - time.time())
            if delay:
                await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return

        pending = self._pending_course_plot_intent
        if not pending or pending.get("id") != intent_id:
            return
        self._pending_course_plot_intent = None
        logger.debug("UI agent course.plot intent expired before event arrival")

    @staticmethod
    def _ports_list_filters_match(payload: dict, filters: dict) -> bool:
        for key in ("mega", "port_type", "commodity", "trade_type", "from_sector", "max_hops"):
            expected = filters.get(key)
            if expected is None:
                continue
            if payload.get(key) != expected:
                return False
        return True

    @staticmethod
    def _ports_list_signature(filters: dict) -> tuple:
        return (
            filters.get("mega"),
            filters.get("port_type"),
            filters.get("commodity"),
            filters.get("trade_type"),
            filters.get("from_sector"),
            filters.get("max_hops"),
        )

    def _cache_ports_list_payload(self, payload: dict) -> None:
        self._prune_ports_list_cache()
        signature = self._ports_list_signature(payload)
        self._ports_list_cache[signature] = payload
        self._ports_list_cache_seen_at[signature] = time.time()

    def _prune_ports_list_cache(self, now: float | None = None) -> None:
        if self._ports_list_stale_secs <= 0:
            self._ports_list_cache.clear()
            self._ports_list_cache_seen_at.clear()
            return
        now = time.time() if now is None else now
        cutoff = now - self._ports_list_stale_secs
        for signature, seen_at in list(self._ports_list_cache_seen_at.items()):
            if seen_at < cutoff:
                self._ports_list_cache_seen_at.pop(signature, None)
                self._ports_list_cache.pop(signature, None)

    def _get_cached_ports_list(self, filters: dict) -> dict | None:
        self._prune_ports_list_cache()
        signature = self._ports_list_signature(filters)
        seen_at = self._ports_list_cache_seen_at.get(signature)
        if seen_at is None:
            return None
        age = max(0.0, time.time() - seen_at)
        if age > self._ports_list_stale_secs:
            return None
        return self._ports_list_cache.get(signature)

    async def _delayed_ports_list_request(self, intent_id: int, filters: dict) -> None:
        try:
            await asyncio.sleep(self._intent_request_delay_secs)
            pending = self._pending_ports_list_intent
            if not pending or pending.get("id") != intent_id:
                return
            if self._get_cached_ports_list(filters) is not None:
                return
            await self._game_client.list_known_ports(
                character_id=self._game_client.character_id,
                from_sector=filters.get("from_sector"),
                max_hops=filters.get("max_hops") or DEFAULT_PORTS_LIST_MAX_HOPS,
                port_type=filters.get("port_type"),
                commodity=filters.get("commodity"),
                trade_type=filters.get("trade_type"),
                mega=filters.get("mega"),
            )
        except asyncio.CancelledError:
            return
        except Exception as exc:  # noqa: BLE001
            logger.error(f"UI agent list_known_ports failed: {exc}")
        finally:
            if self._ports_list_request_task and self._ports_list_request_task.done():
                self._ports_list_request_task = None

    async def _delayed_ships_list_request(self, intent_id: int) -> None:
        try:
            await asyncio.sleep(self._intent_request_delay_secs)
            pending = self._pending_ships_list_intent
            if not pending or pending.get("id") != intent_id:
                return
            if self._ships_cache_is_fresh():
                return
            await self._game_client.list_user_ships(
                character_id=self._game_client.character_id,
            )
        except asyncio.CancelledError:
            return
        except Exception as exc:  # noqa: BLE001
            logger.error(f"UI agent list_user_ships failed: {exc}")
        finally:
            if self._ships_list_request_task and self._ships_list_request_task.done():
                self._ships_list_request_task = None

    async def _on_ports_list(self, event_message: dict) -> None:
        payload = event_message.get("payload", event_message)
        if not isinstance(payload, dict):
            return

        pending = self._pending_ports_list_intent
        if not pending:
            return

        expires_at = pending.get("expires_at")
        if isinstance(expires_at, (int, float)) and time.time() > expires_at:
            self._clear_pending_ports_list_intent()
            return

        filters = pending.get("filters") or {}
        if not self._ports_list_filters_match(payload, filters):
            return

        expected_player_id = getattr(self._game_client, "character_id", None)
        payload_player = payload.get("player")
        payload_player_id = payload_player.get("id") if isinstance(payload_player, dict) else None
        if expected_player_id and payload_player_id and expected_player_id != payload_player_id:
            return

        ports = payload.get("ports")
        if not isinstance(ports, list):
            self._clear_pending_ports_list_intent()
            return

        self._cache_ports_list_payload(payload)
        if self._ports_list_request_task and not self._ports_list_request_task.done():
            self._ports_list_request_task.cancel()
            self._ports_list_request_task = None

        sector_ids: list[int] = []
        for port_info in ports:
            if not isinstance(port_info, dict):
                continue
            sector = port_info.get("sector")
            if not isinstance(sector, dict):
                continue
            sector_id = sector.get("id")
            if isinstance(sector_id, int):
                sector_ids.append(sector_id)

        include_player_sector = pending.get("include_player_sector", True)
        if include_player_sector:
            player_sector = getattr(self._game_client, "_current_sector", None)
            if isinstance(player_sector, int) and player_sector not in sector_ids:
                sector_ids.append(player_sector)

        if not sector_ids:
            self._clear_pending_ports_list_intent()
            return

        unique_sectors = list(dict.fromkeys(sector_ids))
        arguments = {"map_fit_sectors": unique_sectors}
        if pending.get("show_panel", True):
            arguments["show_panel"] = "map"
        should_send = self._apply_control_ui_dedupe(arguments)
        if should_send:
            await self._rtvi.push_frame(
                RTVIServerMessageFrame(
                    {
                        "frame_type": "event",
                        "event": "ui-action",
                        "payload": {"ui-action": "control_ui", **arguments},
                    }
                )
            )
        else:
            logger.debug("UI agent skipped no-op control_ui action (ports.list)")

        self._clear_pending_ports_list_intent()

    async def _handle_ships_list_intent(self, payload: dict) -> None:
        pending = self._pending_ships_list_intent
        if not pending:
            return

        expires_at = pending.get("expires_at")
        if isinstance(expires_at, (int, float)) and time.time() > expires_at:
            self._clear_pending_ships_list_intent()
            return

        expected_player_id = getattr(self._game_client, "character_id", None)
        payload_player = payload.get("player")
        payload_player_id = payload_player.get("id") if isinstance(payload_player, dict) else None
        if expected_player_id and payload_player_id and expected_player_id != payload_player_id:
            return

        ships = payload.get("ships")
        if not isinstance(ships, list):
            self._clear_pending_ships_list_intent()
            return

        if self._ships_list_request_task and not self._ships_list_request_task.done():
            self._ships_list_request_task.cancel()
            self._ships_list_request_task = None

        ship_scope = pending.get("ship_scope") or "all"
        sector_ids: list[int] = []
        for ship in ships:
            if not isinstance(ship, dict):
                continue
            owner_type = ship.get("owner_type")
            if ship_scope == "corporation" and owner_type != "corporation":
                continue
            if ship_scope == "personal" and owner_type != "personal":
                continue
            sector = ship.get("sector")
            if isinstance(sector, int):
                sector_ids.append(sector)

        include_player_sector = pending.get("include_player_sector", True)
        if include_player_sector:
            player_sector = getattr(self._game_client, "_current_sector", None)
            if isinstance(player_sector, int) and player_sector not in sector_ids:
                sector_ids.append(player_sector)

        if not sector_ids:
            self._clear_pending_ships_list_intent()
            return

        unique_sectors = list(dict.fromkeys(sector_ids))
        arguments = {"map_fit_sectors": unique_sectors}
        if pending.get("show_panel", True):
            arguments["show_panel"] = "map"
        should_send = self._apply_control_ui_dedupe(arguments)
        if should_send:
            await self._rtvi.push_frame(
                RTVIServerMessageFrame(
                    {
                        "frame_type": "event",
                        "event": "ui-action",
                        "payload": {"ui-action": "control_ui", **arguments},
                    }
                )
            )
        else:
            logger.debug("UI agent skipped no-op control_ui action (ships.list)")

        self._clear_pending_ships_list_intent()

    async def _on_course_plot(self, event_message: dict) -> None:
        payload = event_message.get("payload", event_message)
        if not isinstance(payload, dict):
            return

        pending = self._pending_course_plot_intent
        if not pending:
            return

        expires_at = pending.get("expires_at")
        if isinstance(expires_at, (int, float)) and time.time() > expires_at:
            self._clear_pending_course_plot_intent()
            return

        expected_player_id = getattr(self._game_client, "character_id", None)
        payload_player = payload.get("player")
        payload_player_id = payload_player.get("id") if isinstance(payload_player, dict) else None
        if expected_player_id and payload_player_id and expected_player_id != payload_player_id:
            return

        path = payload.get("path")
        if not isinstance(path, list):
            self._clear_pending_course_plot_intent()
            return

        path_ids = [sector for sector in path if isinstance(sector, int)]
        include_player_sector = pending.get("include_player_sector", True)
        fit_sectors = list(dict.fromkeys(path_ids))
        if include_player_sector:
            player_sector = getattr(self._game_client, "_current_sector", None)
            if isinstance(player_sector, int) and player_sector not in fit_sectors:
                fit_sectors.append(player_sector)

        if not fit_sectors:
            self._clear_pending_course_plot_intent()
            return

        arguments = {
            "map_highlight_path": path_ids,
            "map_fit_sectors": fit_sectors,
        }
        if pending.get("show_panel", True):
            arguments["show_panel"] = "map"
        should_send = self._apply_control_ui_dedupe(arguments)
        if should_send:
            await self._rtvi.push_frame(
                RTVIServerMessageFrame(
                    {
                        "frame_type": "event",
                        "event": "ui-action",
                        "payload": {"ui-action": "control_ui", **arguments},
                    }
                )
            )
        else:
            logger.debug("UI agent skipped no-op control_ui action (course.plot)")

        self._clear_pending_course_plot_intent()

    # ── Message helpers ───────────────────────────────────────────────

    @staticmethod
    def _is_structured_message(content: str) -> bool:
        stripped = content.lstrip()
        return stripped.startswith("<task_progress") or stripped.startswith("<start_of_session")

    @staticmethod
    def _is_event_message(last_message: dict) -> bool:
        frame = LLMMessagesAppendFrame(messages=[last_message])
        return PreLLMInferenceGate._is_event_message(frame)

    @staticmethod
    def _extract_event_name(content: str) -> str | None:
        match = _EVENT_NAME_RE.search(content)
        if not match:
            return None
        return match.group(1) or match.group(2)

    @staticmethod
    def _normalize_message_content(value: Any) -> str:
        if isinstance(value, str):
            return value
        try:
            return json.dumps(value, ensure_ascii=True)
        except Exception:
            return str(value)

    @staticmethod
    def _find_latest_message(messages: list[dict], role: str) -> str | None:
        for msg in reversed(messages):
            if isinstance(msg, dict) and msg.get("role") == role:
                return UIAgentContext._normalize_message_content(msg.get("content"))
        return None

    def _build_user_payload(self, latest_user: str, latest_assistant: str | None) -> str:
        summary = self._context_summary.strip() or "(no prior UI summary)"
        ships_block = self._format_ships_block()

        parts = [
            "Latest user message:",
            latest_user.strip(),
            "",
            "Latest assistant message:",
            (latest_assistant or "(none)").strip(),
            "",
            "Current UI context summary:",
            f"<context_summary>\n{summary}\n</context_summary>",
            "",
            ships_block,
        ]
        return "\n".join(parts).strip()

    def _format_ships_block(self) -> str:
        if not self._ships_cache_is_fresh():
            age = self._ships_cache_age()
            age_str = f"{age:.1f}s" if age is not None else "unknown"
            return (
                "Recent ships list: (stale or unavailable)\n"
                f"Cache age: {age_str}. If needed, call corporation_info."
            )

        metadata = []
        if self._cached_ships_source_ts:
            metadata.append(f"source timestamp: {self._cached_ships_source_ts}")
        age = self._ships_cache_age()
        if age is not None:
            metadata.append(f"age: {age:.1f}s")
        meta_line = f"({', '.join(metadata)})" if metadata else ""
        try:
            ships_json = json.dumps(self._cached_ships, ensure_ascii=True, indent=2)
        except Exception:
            ships_json = str(self._cached_ships)
        return f"Recent ships list {meta_line}:\n{ships_json}"

    # ── Tool call handlers ────────────────────────────────────────────

    async def handle_queue_ui_intent(self, params: FunctionCallParams) -> None:
        arguments = params.arguments if isinstance(params.arguments, dict) else {}
        tool_call_id = params.tool_call_id
        function_name = params.function_name
        logger.debug(f"UI agent queue_ui_intent args: {arguments}")

        # Append tool_call message immediately
        self._messages.append({
            "role": "assistant",
            "tool_calls": [{
                "id": tool_call_id,
                "function": {
                    "name": function_name,
                    "arguments": json.dumps(arguments, ensure_ascii=False),
                },
                "type": "function",
            }],
        })

        result: dict[str, Any]
        intent_type = arguments.get("intent_type")
        clear_existing = arguments.get("clear_existing")
        replace_existing = True if clear_existing is None else bool(clear_existing)
        include_player_sector = arguments.get("include_player_sector")
        include_player_sector = True if include_player_sector is None else bool(include_player_sector)
        show_panel = arguments.get("show_panel")
        show_panel = True if show_panel is None else bool(show_panel)
        expires_in_secs = arguments.get("expires_in_secs")

        try:
            if intent_type not in ("ports.list", "ships.list", "course.plot"):
                raise ValueError(f"Unknown intent_type '{intent_type}'")

            expires_override: float | None = None
            if expires_in_secs is not None:
                expires_override = float(expires_in_secs)

            if intent_type == "ports.list":
                max_hops = arguments.get("max_hops")
                if max_hops is None:
                    max_hops = DEFAULT_PORTS_LIST_MAX_HOPS
                else:
                    max_hops = int(max_hops)
                from_sector = arguments.get("from_sector")
                if from_sector is None:
                    from_sector = getattr(self._game_client, "_current_sector", None)
                elif not isinstance(from_sector, int):
                    from_sector = int(from_sector)
                filters = {
                    "mega": arguments.get("mega"),
                    "port_type": arguments.get("port_type"),
                    "commodity": arguments.get("commodity"),
                    "trade_type": arguments.get("trade_type"),
                    "from_sector": from_sector,
                    "max_hops": max_hops,
                }
                intent_id = self._set_pending_ports_list_intent(
                    filters=filters,
                    include_player_sector=include_player_sector,
                    show_panel=show_panel,
                    expires_in_secs=expires_override,
                    replace_existing=replace_existing,
                )
                cached_payload = self._get_cached_ports_list(filters)
                if cached_payload is not None:
                    await self._on_ports_list({"payload": cached_payload})
                pending = self._pending_ports_list_intent
                if pending and pending.get("id") == intent_id:
                    if self._ports_list_request_task and not self._ports_list_request_task.done():
                        self._ports_list_request_task.cancel()
                    self._ports_list_request_task = self.create_task(
                        self._delayed_ports_list_request(intent_id, filters)
                    )
            elif intent_type == "ships.list":
                ship_scope = arguments.get("ship_scope") or "all"
                if ship_scope not in ("corporation", "personal", "all"):
                    raise ValueError(f"Invalid ship_scope '{ship_scope}'")
                intent_id = self._set_pending_ships_list_intent(
                    ship_scope=ship_scope,
                    include_player_sector=include_player_sector,
                    show_panel=show_panel,
                    expires_in_secs=expires_override,
                    replace_existing=replace_existing,
                )
                if self._ships_cache_is_fresh():
                    payload = {"ships": list(self._cached_ships)}
                    expected_player_id = getattr(self._game_client, "character_id", None)
                    if expected_player_id:
                        payload["player"] = {"id": expected_player_id}
                    await self._handle_ships_list_intent(payload)
                pending = self._pending_ships_list_intent
                if pending and pending.get("id") == intent_id:
                    if self._ships_list_request_task and not self._ships_list_request_task.done():
                        self._ships_list_request_task.cancel()
                    self._ships_list_request_task = self.create_task(
                        self._delayed_ships_list_request(intent_id)
                    )
            else:
                intent_id = self._set_pending_course_plot_intent(
                    include_player_sector=include_player_sector,
                    show_panel=show_panel,
                    expires_in_secs=expires_override,
                    replace_existing=replace_existing,
                )

            result = {"success": True, "intent_type": intent_type, "intent_id": intent_id}
        except Exception as exc:  # noqa: BLE001
            result = {"success": False, "error": str(exc)}

        self._messages.append({
            "role": "tool",
            "content": json.dumps(result),
            "tool_call_id": tool_call_id,
        })

        await params.result_callback(
            result,
            properties=FunctionCallResultProperties(run_llm=False),
        )

    async def handle_control_ui(self, params: FunctionCallParams) -> None:
        arguments = params.arguments if isinstance(params.arguments, dict) else {}

        # Ensure the player's current sector is included in map_fit_sectors
        fit_sectors = arguments.get("map_fit_sectors")
        if isinstance(fit_sectors, list):
            player_sector = getattr(self._game_client, "_current_sector", None)
            if isinstance(player_sector, int) and player_sector not in fit_sectors:
                arguments["map_fit_sectors"] = [*fit_sectors, player_sector]

        logger.debug(f"UI agent control_ui args: {arguments}")

        should_send = self._apply_control_ui_dedupe(arguments)
        if should_send:
            await self._rtvi.push_frame(
                RTVIServerMessageFrame(
                    {
                        "frame_type": "event",
                        "event": "ui-action",
                        "payload": {"ui-action": "control_ui", **arguments},
                    }
                )
            )
        else:
            logger.debug("UI agent skipped no-op control_ui action")

        # Append tool_call + tool_result messages (no counter increment for control_ui)
        tool_call_id = params.tool_call_id
        function_name = params.function_name
        result = {"success": True, "skipped": not should_send}

        self._messages.append({
            "role": "assistant",
            "tool_calls": [{
                "id": tool_call_id,
                "function": {
                    "name": function_name,
                    "arguments": json.dumps(arguments, ensure_ascii=False),
                },
                "type": "function",
            }],
        })
        self._messages.append({
            "role": "tool",
            "content": json.dumps(result),
            "tool_call_id": tool_call_id,
        })

        await params.result_callback(
            result,
            properties=FunctionCallResultProperties(run_llm=False),
        )

    async def handle_corporation_info(self, params: FunctionCallParams) -> None:
        arguments = params.arguments if isinstance(params.arguments, dict) else {}
        tool_call_id = params.tool_call_id
        function_name = params.function_name
        logger.debug(f"UI agent corporation_info args: {arguments}")

        # Append tool_call message immediately
        self._messages.append({
            "role": "assistant",
            "tool_calls": [{
                "id": tool_call_id,
                "function": {
                    "name": function_name,
                    "arguments": json.dumps(arguments, ensure_ascii=False),
                },
                "type": "function",
            }],
        })
        self._pending_results += 1
        self._had_tool_calls = True
        self._pending_tools[f"corp_info_{tool_call_id}"] = {
            "tool_call_id": tool_call_id,
            "function_name": function_name,
        }

        # Fire-and-forget background task
        async def _fetch():
            try:
                result = await self._corp_info_tool(**arguments)
                self._record_tool_result(tool_call_id, result)
            except Exception as exc:  # noqa: BLE001
                logger.error(f"UI agent corporation_info failed: {exc}")
                self._record_tool_result(tool_call_id, {"error": str(exc)})

        self.create_task(_fetch())

        await params.result_callback(
            {"status": "pending"},
            properties=FunctionCallResultProperties(run_llm=False),
        )

    async def handle_my_status(self, params: FunctionCallParams) -> None:
        arguments = params.arguments if isinstance(params.arguments, dict) else {}
        tool_call_id = params.tool_call_id
        function_name = params.function_name
        logger.debug(f"UI agent my_status args: {arguments}")

        # Guard: if there's already a pending my_status, resolve the old one with an error
        # before starting a new one, so _pending_results stays consistent.
        old_pending = self._pending_tools.get("status.snapshot")
        if old_pending:
            old_tool_call_id = old_pending["tool_call_id"]
            logger.warning(f"UI agent my_status: superseding previous pending call {old_tool_call_id}")
            self._record_tool_result(old_tool_call_id, {"error": "superseded by new my_status call"})

        # Append tool_call message immediately
        self._messages.append({
            "role": "assistant",
            "tool_calls": [{
                "id": tool_call_id,
                "function": {
                    "name": function_name,
                    "arguments": json.dumps(arguments, ensure_ascii=False),
                },
                "type": "function",
            }],
        })
        self._pending_results += 1
        self._had_tool_calls = True

        # Fire the RPC (returns ack)
        try:
            await self._game_client.my_status(self._game_client.character_id)
        except Exception as exc:  # noqa: BLE001
            logger.error(f"UI agent my_status RPC failed: {exc}")
            self._record_tool_result(tool_call_id, {"error": str(exc)})
            await params.result_callback(
                {"error": str(exc)},
                properties=FunctionCallResultProperties(run_llm=False),
            )
            return

        # Capture request_id for correlation (supabase_client stores it; api_client does not)
        request_id = getattr(self._game_client, "last_request_id", None)
        expected_player_id = getattr(self._game_client, "character_id", None)

        self._pending_tools["status.snapshot"] = {
            "tool_call_id": tool_call_id,
            "function_name": function_name,
            "request_id": request_id,
            "character_id": expected_player_id,
        }

        # Start timeout task
        async def _timeout():
            try:
                await asyncio.sleep(self._status_timeout_secs)
                # Timeout expired — check if still pending
                pending = self._pending_tools.get("status.snapshot")
                if pending and pending["tool_call_id"] == tool_call_id:
                    logger.warning(f"UI agent my_status timeout after {self._status_timeout_secs}s")
                    self._record_tool_result(tool_call_id, {"error": "status.snapshot timeout"})
            except asyncio.CancelledError:
                pass

        self._status_timeout_task = self.create_task(_timeout())

        await params.result_callback(
            {"status": "pending"},
            properties=FunctionCallResultProperties(run_llm=False),
        )

    async def _on_status_snapshot(self, event_message: dict) -> None:
        """Handle status.snapshot event from game_client."""
        pending = self._pending_tools.get("status.snapshot")
        if not pending:
            return  # No pending my_status call — ignore (stale or from join/reconnect)

        payload = event_message.get("payload", event_message)
        player_id = None
        if isinstance(payload, dict):
            player = payload.get("player")
            if isinstance(player, dict):
                player_id = player.get("id") or player.get("character_id")
            if player_id is None:
                player_id = payload.get("player_id") or payload.get("character_id")

        expected_player_id = pending.get("character_id") or getattr(
            self._game_client, "character_id", None
        )
        if player_id and expected_player_id and player_id != expected_player_id:
            logger.debug(
                "UI agent ignoring status.snapshot for different player "
                f"(expected={expected_player_id}, got={player_id})"
            )
            return

        # Correlate by request_id when available (supabase transport provides it)
        stored_request_id = pending.get("request_id")
        event_request_id = event_message.get("request_id")
        if stored_request_id and event_request_id:
            # Both sides have request_id — must match
            if event_request_id != stored_request_id:
                logger.debug(
                    f"UI agent status.snapshot request_id mismatch "
                    f"(expected={stored_request_id}, got={event_request_id}); accepting by player id"
                )
                # Accept anyway if it's for our player (request_id mismatch is common
                # because the Supabase client doesn't forward its request_id).
        elif stored_request_id and not event_request_id:
            # We have a stored ID but event doesn't (WebSocket transport) — accept anyway
            # (single-pending-call assumption)
            pass

        tool_call_id = pending["tool_call_id"]

        # Cancel timeout task
        if self._status_timeout_task and not self._status_timeout_task.done():
            self._status_timeout_task.cancel()
            self._status_timeout_task = None

        # Use the event payload as tool result
        self._record_tool_result(tool_call_id, payload)

    def _record_tool_result(self, tool_call_id: str, result: Any) -> None:
        """Record a tool result and potentially trigger re-inference."""
        # Guard: check that tool_call_id is still pending
        found_key = None
        for key, info in self._pending_tools.items():
            if info["tool_call_id"] == tool_call_id:
                found_key = key
                break
        if found_key is None:
            logger.debug(f"UI agent ignoring stale tool result for {tool_call_id}")
            return
        del self._pending_tools[found_key]

        # Append tool_result message
        self._messages.append({
            "role": "tool",
            "content": json.dumps(result, default=str),
            "tool_call_id": tool_call_id,
        })
        self._pending_results -= 1

        logger.debug(
            f"UI agent tool result recorded: {tool_call_id}, "
            f"pending_results={self._pending_results}, end_frame_seen={self._end_frame_seen}"
        )

        self._check_response_complete()

    # ── Function call frame tracking (called by UIAgentResponseCollector) ──

    def on_function_calls_started(self, count: int) -> None:
        """Called when FunctionCallsStartedFrame arrives (before handlers run)."""
        self._expected_fc_count = count

    def on_function_call_result(self) -> None:
        """Called when FunctionCallResultFrame arrives (handler called result_callback)."""
        self._received_fc_results += 1
        self._check_response_complete()

    # ── Response handling (called by UIAgentResponseCollector) ────────

    async def on_response_end(self, buffer_text: str) -> None:
        """Called when the LLM response is complete."""
        self._end_frame_seen = True
        self._response_text = buffer_text
        self._check_response_complete()

    def _check_response_complete(self) -> None:
        """Check if all gates are satisfied and proceed with response handling.

        Gates:
        1. LLMFullResponseEndFrame received (_end_frame_seen)
        2. All function call handlers completed (_received_fc_results >= _expected_fc_count)
        3. All async tool results arrived (_pending_results <= 0)
        """
        if not self._end_frame_seen:
            return
        if self._received_fc_results < self._expected_fc_count:
            return  # handlers haven't all completed yet
        if self._pending_results > 0:
            return  # async tool results still pending

        if self._had_tool_calls:
            self.create_task(self._push_rerun_inference())
            return

        # Text-only response (or only control_ui which doesn't set _had_tool_calls)
        summary = self._extract_summary(self._response_text)
        self.create_task(self._async_on_inference_complete(summary))

    async def _async_on_inference_complete(self, summary: str | None) -> None:
        await self.on_inference_complete(summary)

    async def on_inference_complete(self, new_summary: str | None) -> None:
        if new_summary is not None:
            self._context_summary = new_summary
            # Send debug RTVI event for client debug panel
            await self._rtvi.push_frame(
                RTVIServerMessageFrame({
                    "frame_type": "event",
                    "event": "ui-agent-context-summary",
                    "payload": {"context_summary": self._context_summary},
                })
            )

        should_rerun = False
        async with self._inference_lock:
            self._inference_inflight = False
            if self._pending_rerun:
                should_rerun = True
                self._pending_rerun = False
            elif self._context and isinstance(self._context.messages, list):
                if len(self._context.messages) != self._last_run_message_count:
                    should_rerun = True

        if should_rerun:
            await self._schedule_inference()

    @staticmethod
    def _extract_summary(text: str) -> str | None:
        if not text:
            return None
        match = _CONTEXT_SUMMARY_RE.search(text)
        if not match:
            return None
        summary = match.group(1).strip()
        return summary or ""

    # ── control_ui dedup ──────────────────────────────────────────────

    def _apply_control_ui_dedupe(self, arguments: dict) -> bool:
        changed = False

        show_panel = arguments.get("show_panel")
        map_center = arguments.get("map_center_sector")
        map_zoom = arguments.get("map_zoom_level")
        highlight_path = self._normalize_int_list(arguments.get("map_highlight_path"))
        fit_sectors = self._normalize_int_list(arguments.get("map_fit_sectors"))
        clear_plot = arguments.get("clear_course_plot") is True

        wants_map = any(
            value is not None
            for value in (map_center, map_zoom, highlight_path, fit_sectors)
        )
        effective_show_panel = show_panel if isinstance(show_panel, str) else None
        if wants_map and effective_show_panel is None:
            effective_show_panel = "map"

        if effective_show_panel in {"map", "default"}:
            if effective_show_panel != self._last_show_panel:
                changed = True
                self._last_show_panel = effective_show_panel

        if isinstance(map_center, int) and map_center != self._last_map_center_sector:
            changed = True
            self._last_map_center_sector = map_center

        if isinstance(map_zoom, int) and map_zoom != self._last_map_zoom_level:
            changed = True
            self._last_map_zoom_level = map_zoom

        if highlight_path is not None:
            highlight_tuple = tuple(highlight_path)
            if highlight_tuple != self._last_map_highlight_path:
                changed = True
                self._last_map_highlight_path = highlight_tuple

        if fit_sectors is not None:
            fit_tuple = tuple(fit_sectors)
            if fit_tuple != self._last_map_fit_sectors:
                changed = True
                self._last_map_fit_sectors = fit_tuple

        if clear_plot:
            if self._last_map_highlight_path not in {None, tuple()}:
                changed = True
            self._last_map_highlight_path = tuple()

        return changed

    @staticmethod
    def _normalize_int_list(value: Any) -> list[int] | None:
        if not isinstance(value, list):
            return None
        cleaned: list[int] = []
        for item in value:
            if isinstance(item, int):
                cleaned.append(item)
        return cleaned or None


class UIAgentResponseCollector(FrameProcessor):
    """Buffers LLM text and delegates to UIAgentContext on response end."""

    def __init__(self, context: UIAgentContext) -> None:
        super().__init__()
        self._context = context
        self._buffer: str = ""

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, SystemFrame):
            # FunctionCallsStartedFrame is a SystemFrame — catch it before the
            # generic SystemFrame drop.  It arrives synchronously BEFORE
            # LLMFullResponseEndFrame, letting us know function call handlers
            # will run (solving the race where handlers execute after EndFrame).
            if isinstance(frame, FunctionCallsStartedFrame):
                self._context.on_function_calls_started(len(frame.function_calls))
                return
            if isinstance(frame, (StartFrame, EndFrame, CancelFrame)):
                await self.push_frame(frame, direction)
            return

        if isinstance(frame, FunctionCallResultFrame):
            self._context.on_function_call_result()
        elif isinstance(frame, LLMFullResponseStartFrame):
            self._buffer = ""
        elif isinstance(frame, LLMTextFrame):
            self._buffer += frame.text
        elif isinstance(frame, LLMFullResponseEndFrame):
            await self._context.on_response_end(self._buffer)
        # All other frames: drop
