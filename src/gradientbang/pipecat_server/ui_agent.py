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
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine, Optional

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
        "map_zoom_direction": {
            "type": "string",
            "enum": ["in", "out"],
            "description": "Relative zoom: 'in' or 'out' (use when the user requests a general zoom).",
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
    description="Queue a UI intent fulfilled when a server event arrives. Does not change the UI immediately.",
    properties={
        "intent_type": {
            "type": "string",
            "enum": ["ports.list", "ships.list", "course.plot"],
            "description": "Event type to wait for.",
        },
        "mega": {
            "type": "boolean",
            "description": "ports.list: filter mega-ports.",
        },
        "port_type": {
            "type": "string",
            "description": "ports.list: port code filter (e.g., 'BBB', 'SSS').",
        },
        "commodity": {
            "type": "string",
            "enum": ["quantum_foam", "retro_organics", "neuro_symbolics"],
            "description": "ports.list: commodity filter.",
        },
        "trade_type": {
            "type": "string",
            "enum": ["buy", "sell"],
            "description": "ports.list: trade direction.",
        },
        "from_sector": {
            "type": "integer",
            "description": "Origin sector (ports.list: hops from; course.plot: route start).",
        },
        "to_sector": {
            "type": "integer",
            "description": "course.plot: route destination.",
        },
        "max_hops": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100,
            "description": "ports.list: max hop distance.",
        },
        "ship_scope": {
            "type": "string",
            "enum": ["corporation", "personal", "all"],
            "description": "ships.list: which ships to include.",
        },
        "include_player_sector": {
            "type": "boolean",
            "description": "Include player's sector in map_fit_sectors.",
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

DEFAULT_SHIPS_CACHE_TTL_SECS = 60
DEFAULT_STATUS_TIMEOUT_SECS = 10
DEFAULT_PORTS_LIST_TIMEOUT_SECS = 15
DEFAULT_SHIPS_LIST_TIMEOUT_SECS = 15
DEFAULT_COURSE_PLOT_TIMEOUT_SECS = 25
DEFAULT_PORTS_LIST_STALE_SECS = 60
DEFAULT_COURSE_PLOT_CACHE_TTL_SECS = 300
DEFAULT_UI_INTENT_REQUEST_DELAY_SECS = 2.0
DEFAULT_PORTS_LIST_MAX_HOPS = 100
DEFAULT_MAP_VIEW_LOCK_SECS = 25
DEFAULT_CONTEXT_SUMMARY_WORD_LIMIT = 120


@dataclass
class PendingIntent:
    id: int
    intent_type: str
    include_player_sector: bool
    show_panel: bool
    expires_at: float
    match_fn: Callable[[dict], bool]
    type_fields: dict[str, Any] = field(default_factory=dict)
    event_xml: str | None = None
    event_received_at: float | None = None
    timeout_task: asyncio.Task | None = None
    request_task: asyncio.Task | None = None


class UIAgentContext(FrameProcessor):
    """Catches LLMContextFrame from main pipeline, builds fresh context, pushes to LLM."""

    def __init__(
        self,
        config,
        rtvi,
        game_client,
        is_recent_voice_request_id: Optional[Callable[[Optional[str]], bool]] = None,
    ) -> None:
        super().__init__()
        self._config = config
        self._rtvi = rtvi
        self._game_client = game_client
        self._context_summary: str = ""
        self._cached_ships: list[dict] = []
        self._cached_ships_at: float | None = None
        self._cached_ships_source_ts: str | None = None
        self._cached_ships_source_epoch: float | None = None
        self._cached_ships_event_message: dict | None = None
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
        self._map_view_lock_until: float = 0.0
        self._map_view_lock_reason: str | None = None

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
        map_view_lock_secs_raw = os.getenv(
            "UI_AGENT_MAP_VIEW_LOCK_SECS",
            str(DEFAULT_MAP_VIEW_LOCK_SECS),
        )
        try:
            self._map_view_lock_secs = float(map_view_lock_secs_raw)
        except ValueError:
            logger.warning(
                "Invalid UI_AGENT_MAP_VIEW_LOCK_SECS "
                f"'{map_view_lock_secs_raw}', using default {DEFAULT_MAP_VIEW_LOCK_SECS}"
            )
            self._map_view_lock_secs = float(DEFAULT_MAP_VIEW_LOCK_SECS)

        summary_word_limit_raw = os.getenv(
            "UI_AGENT_CONTEXT_SUMMARY_WORD_LIMIT",
            str(DEFAULT_CONTEXT_SUMMARY_WORD_LIMIT),
        )
        try:
            self._summary_word_limit = int(summary_word_limit_raw)
        except ValueError:
            logger.warning(
                "Invalid UI_AGENT_CONTEXT_SUMMARY_WORD_LIMIT "
                f"'{summary_word_limit_raw}', using default {DEFAULT_CONTEXT_SUMMARY_WORD_LIMIT}"
            )
            self._summary_word_limit = DEFAULT_CONTEXT_SUMMARY_WORD_LIMIT
        self._latest_ui_user_message: str | None = None
        self._latest_ui_assistant_message: str | None = None
        self._is_recent_voice_request_id = is_recent_voice_request_id
        self._pending_intents: dict[str, PendingIntent] = {}
        self._pending_intent_id = 0
        self._ports_list_cache: dict[tuple, dict] = {}
        self._ports_list_cache_seen_at: dict[tuple, float] = {}
        self._course_plot_cache: dict[tuple[int, int], dict] = {}
        self._course_plot_cache_seen_at: dict[tuple[int, int], float] = {}
        self._course_plot_cache_ttl_secs = DEFAULT_COURSE_PLOT_CACHE_TTL_SECS
        self._missing_user_warning_at: float | None = None
        self._pending_intent_inference_requested = False

        # Register event listener for status.snapshot
        self._game_client.on("ships.list")(self._on_ships_list)
        self._game_client.add_event_handler("status.snapshot", self._on_status_snapshot)
        self._game_client.add_event_handler("ports.list", self._on_ports_list)
        self._game_client.add_event_handler("course.plot", self._on_course_plot)

    def _safe_create_task(
        self,
        coroutine: "asyncio.coroutines.CoroWrapper | asyncio.Future | asyncio.Task | Any",
        *,
        name: str | None = None,
    ) -> Optional[asyncio.Task]:
        task: Optional[asyncio.Task] = None
        try:
            task = self.create_task(coroutine, name=name)
        except RuntimeError as exc:
            logger.warning(f"UI agent could not schedule task {name or ''}: {exc}")
        except Exception as exc:  # noqa: BLE001
            logger.error(f"UI agent could not schedule task {name or ''}: {exc}")
        if task is None:
            try:
                coroutine.close()
            except Exception:  # noqa: BLE001
                pass
        return task

    @staticmethod
    def _log_metric(metric_name: str, **fields: Any) -> None:
        payload = {"metric": metric_name, **fields}
        try:
            serialized = json.dumps(payload, ensure_ascii=True, sort_keys=True)
        except Exception:
            serialized = str(payload)
        logger.info(f"UI_AGENT_METRIC {serialized}")

    async def _yield_for_pending_intent_tasks(self, intent_type: str, intent_id: int) -> None:
        """Let newly-created intent tasks enter the event loop before possible cancellation.

        Without this yield, immediate cache-hit paths can cancel timeout/request
        tasks before they start, which triggers "coroutine was never awaited"
        warnings in Python.
        """
        intent = self._pending_intents.get(intent_type)
        if not intent or intent.id != intent_id:
            return
        has_scheduled_task = bool(
            (intent.timeout_task and not intent.timeout_task.done())
            or (intent.request_task and not intent.request_task.done())
        )
        if has_scheduled_task:
            await asyncio.sleep(0)

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
            self._cached_ships_event_message = event_message

            source = payload.get("source")
            if isinstance(source, dict):
                timestamp = source.get("timestamp")
                if isinstance(timestamp, str) and timestamp.strip():
                    parsed_epoch = self._parse_timestamp(timestamp)
                    if parsed_epoch is not None:
                        self._cached_ships_source_ts = timestamp
                        self._cached_ships_source_epoch = parsed_epoch

        await self._handle_ships_list_intent(event_message)

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
            return
        elif self._is_structured_message(content):
            return

        if self._has_pending_intents():
            self._clear_all_pending_intents()

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
        self._safe_create_task(self._run_inference(), name="ui_agent_run_inference")

    async def _run_inference(self) -> None:
        try:
            if not self._context or not isinstance(self._context.messages, list):
                await self._abort_inference()
                return

            messages = list(self._context.messages)
            if self._pending_intent_inference_requested:
                if self._pending_intents_ready():
                    intent_events = self._take_pending_intent_events()
                    if intent_events:
                        messages.extend(intent_events)
                else:
                    self._pending_intent_inference_requested = False
            recent_messages, latest_assistant = self._select_recent_messages(messages)
            latest_user = self._find_latest_user_input(recent_messages)
            if not latest_user:
                self._warn_missing_user_input()
                latest_user = self._find_latest_message(messages, "user") or ""
            self._latest_ui_user_message = latest_user
            self._latest_ui_assistant_message = latest_assistant

            user_payload = self._build_user_payload(
                latest_user=latest_user,
                latest_assistant=latest_assistant,
                recent_messages=recent_messages,
            )

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
            self._last_run_message_count = len(self._context.messages)
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

    def _has_pending_intents(self) -> bool:
        return bool(self._pending_intents)

    def _clear_all_pending_intents(self) -> None:
        if not self._pending_intents:
            return
        logger.debug("UI agent clearing pending intents due to new user input")
        for intent_type in list(self._pending_intents):
            self._clear_pending_intent(intent_type)
        self._pending_intent_inference_requested = False

    def _pending_intents_ready(self) -> bool:
        if not self._pending_intents:
            return False
        return all(intent.event_xml for intent in self._pending_intents.values())

    def _format_event_xml(self, event_name: str, event_message: dict) -> str:
        summary = event_message.get("summary")
        if not isinstance(summary, str) or not summary.strip():
            payload = event_message.get("payload", event_message)
            try:
                summary = json.dumps(payload, ensure_ascii=True, indent=2)
            except Exception:
                summary = str(payload)
        return f'<event name="{event_name}">\n{summary}\n</event>'

    def _set_intent_event(self, pending: PendingIntent, event_name: str, event_message: dict) -> None:
        pending.event_xml = self._format_event_xml(event_name, event_message)
        pending.event_received_at = time.time()

    def _take_pending_intent_events(self) -> list[dict]:
        events: list[tuple[float, str]] = []
        for intent in self._pending_intents.values():
            event_xml = intent.event_xml
            if isinstance(event_xml, str) and event_xml:
                timestamp = intent.event_received_at if isinstance(intent.event_received_at, (int, float)) else 0.0
                events.append((timestamp, event_xml))

        events.sort(key=lambda item: item[0])

        for intent_type in list(self._pending_intents):
            self._clear_pending_intent(intent_type)
        self._pending_intent_inference_requested = False

        return [
            {"role": "user", "content": event_xml, "_ui_intent_event": True}
            for _, event_xml in events
        ]

    async def _maybe_trigger_pending_intent_inference(self) -> None:
        if not self._pending_intents_ready():
            return
        if self._pending_intent_inference_requested:
            return
        self._pending_intent_inference_requested = True
        await self._schedule_inference()

    def _next_intent_id(self) -> int:
        self._pending_intent_id += 1
        return self._pending_intent_id

    # ── Generic intent lifecycle ─────────────────────────────────────

    def _set_pending_intent(
        self,
        intent_type: str,
        *,
        match_fn: Callable[[dict], bool],
        type_fields: dict[str, Any],
        include_player_sector: bool,
        show_panel: bool,
        default_timeout_secs: float,
        expires_in_secs: float | None,
        replace_existing: bool,
        request_factory: Callable[[int], Coroutine[Any, Any, None]] | None = None,
    ) -> int:
        existing = self._pending_intents.get(intent_type)
        if existing is not None:
            if replace_existing:
                self._clear_pending_intent(intent_type)
            else:
                if existing.timeout_task and not existing.timeout_task.done():
                    existing.timeout_task.cancel()
                if existing.request_task and not existing.request_task.done():
                    existing.request_task.cancel()
        intent_id = self._next_intent_id()
        timeout_secs = default_timeout_secs if expires_in_secs is None else max(
            1.0, float(expires_in_secs)
        )
        expires_at = time.time() + timeout_secs
        intent = PendingIntent(
            id=intent_id,
            intent_type=intent_type,
            include_player_sector=include_player_sector,
            show_panel=show_panel,
            expires_at=expires_at,
            match_fn=match_fn,
            type_fields=type_fields,
        )
        self._pending_intents[intent_type] = intent

        intent.timeout_task = self._safe_create_task(
            self._intent_timeout(intent_type, intent_id, expires_at),
            name=f"{intent_type}_intent_timeout",
        )

        if request_factory is not None:
            intent.request_task = self._safe_create_task(
                request_factory(intent_id),
                name=f"{intent_type}_request",
            )

        return intent_id

    def _clear_pending_intent(self, intent_type: str) -> None:
        intent = self._pending_intents.pop(intent_type, None)
        if intent is None:
            return
        try:
            current_task = asyncio.current_task()
        except RuntimeError:
            current_task = None
        if (
            intent.timeout_task
            and not intent.timeout_task.done()
            and intent.timeout_task is not current_task
        ):
            intent.timeout_task.cancel()
        if (
            intent.request_task
            and not intent.request_task.done()
            and intent.request_task is not current_task
        ):
            intent.request_task.cancel()
        self._pending_intent_inference_requested = False

    async def _intent_timeout(self, intent_type: str, intent_id: int, expires_at: float) -> None:
        try:
            delay = max(0.0, expires_at - time.time())
            if delay:
                await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return

        intent = self._pending_intents.get(intent_type)
        if not intent or intent.id != intent_id:
            return
        self._clear_pending_intent(intent_type)
        logger.debug(f"UI agent {intent_type} intent expired before event arrival")
        await self._maybe_trigger_pending_intent_inference()

    def _payload_matches_player(self, payload: dict) -> bool:
        expected_player_id = getattr(self._game_client, "character_id", None)
        payload_player = payload.get("player")
        payload_player_id = payload_player.get("id") if isinstance(payload_player, dict) else None
        if expected_player_id and payload_player_id and expected_player_id != payload_player_id:
            return False
        return True

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

    def _cache_ports_list_event(self, event_message: dict) -> None:
        payload = event_message.get("payload", event_message)
        if not isinstance(payload, dict):
            return
        self._prune_ports_list_cache()
        signature = self._ports_list_signature(payload)
        self._ports_list_cache[signature] = event_message
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

    def _get_cached_ports_list_event(self, filters: dict) -> dict | None:
        self._prune_ports_list_cache()
        signature = self._ports_list_signature(filters)
        seen_at = self._ports_list_cache_seen_at.get(signature)
        if seen_at is None:
            return None
        age = max(0.0, time.time() - seen_at)
        if age > self._ports_list_stale_secs:
            return None
        return self._ports_list_cache.get(signature)

    def _prune_course_plot_cache(self, now: float | None = None) -> None:
        if self._course_plot_cache_ttl_secs <= 0:
            self._course_plot_cache.clear()
            self._course_plot_cache_seen_at.clear()
            return
        now = time.time() if now is None else now
        cutoff = now - self._course_plot_cache_ttl_secs
        for signature, seen_at in list(self._course_plot_cache_seen_at.items()):
            if seen_at < cutoff:
                self._course_plot_cache_seen_at.pop(signature, None)
                self._course_plot_cache.pop(signature, None)

    def _cache_course_plot_event(self, event_message: dict) -> None:
        payload = event_message.get("payload", event_message)
        if not isinstance(payload, dict):
            return
        from_sector = payload.get("from_sector")
        to_sector = payload.get("to_sector")
        if not isinstance(from_sector, int) or not isinstance(to_sector, int):
            return
        signature = (from_sector, to_sector)
        self._prune_course_plot_cache()
        self._course_plot_cache[signature] = event_message
        self._course_plot_cache_seen_at[signature] = time.time()

    def _get_cached_course_plot_event(
        self,
        from_sector: int | None,
        to_sector: int | None,
    ) -> dict | None:
        self._prune_course_plot_cache()
        if not (isinstance(from_sector, int) and isinstance(to_sector, int)):
            return None
        return self._course_plot_cache.get((from_sector, to_sector))

    async def _delayed_ports_list_request(self, intent_id: int, filters: dict) -> None:
        try:
            await asyncio.sleep(self._intent_request_delay_secs)
            intent = self._pending_intents.get("ports.list")
            if not intent or intent.id != intent_id:
                return
            if self._get_cached_ports_list_event(filters) is not None:
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
            intent = self._pending_intents.get("ports.list")
            if intent and intent.id == intent_id and intent.request_task and intent.request_task.done():
                intent.request_task = None

    async def _delayed_ships_list_request(self, intent_id: int) -> None:
        try:
            await asyncio.sleep(self._intent_request_delay_secs)
            intent = self._pending_intents.get("ships.list")
            if not intent or intent.id != intent_id:
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
            intent = self._pending_intents.get("ships.list")
            if intent and intent.id == intent_id and intent.request_task and intent.request_task.done():
                intent.request_task = None

    async def _on_ports_list(self, event_message: dict) -> None:
        payload = event_message.get("payload", event_message)
        if not isinstance(payload, dict):
            return

        self._cache_ports_list_event(event_message)

        intent = self._pending_intents.get("ports.list")
        if not intent:
            return

        if time.time() > intent.expires_at:
            self._clear_pending_intent("ports.list")
            return

        if not intent.match_fn(payload):
            return

        if not self._payload_matches_player(payload):
            return

        if intent.request_task and not intent.request_task.done():
            intent.request_task.cancel()
            intent.request_task = None

        if intent.timeout_task and not intent.timeout_task.done():
            intent.timeout_task.cancel()
            intent.timeout_task = None

        self._set_intent_event(intent, "ports.list", event_message)
        await self._maybe_trigger_pending_intent_inference()

    async def _handle_ships_list_intent(self, event_message: dict) -> None:
        payload = event_message.get("payload", event_message)
        if not isinstance(payload, dict):
            return

        intent = self._pending_intents.get("ships.list")
        if not intent:
            return

        if time.time() > intent.expires_at:
            self._clear_pending_intent("ships.list")
            return

        if not self._payload_matches_player(payload):
            return

        if intent.request_task and not intent.request_task.done():
            intent.request_task.cancel()
            intent.request_task = None

        if intent.timeout_task and not intent.timeout_task.done():
            intent.timeout_task.cancel()
            intent.timeout_task = None

        self._set_intent_event(intent, "ships.list", event_message)
        await self._maybe_trigger_pending_intent_inference()

    async def _on_course_plot(self, event_message: dict) -> None:
        payload = event_message.get("payload", event_message)
        if not isinstance(payload, dict):
            return
        if self._is_task_scoped_event_without_voice_request(event_message, payload):
            logger.debug("UI agent ignoring task-scoped course.plot event not tied to voice request")
            return
        self._cache_course_plot_event(event_message)

        intent = self._pending_intents.get("course.plot")
        if not intent:
            if not self._payload_matches_player(payload):
                logger.debug("UI agent course.plot received with no pending intent for different player")
                return
            logger.debug("UI agent course.plot received with no pending intent")
            await self._auto_fit_course_plot(payload)
            return

        if time.time() > intent.expires_at:
            self._clear_pending_intent("course.plot")
            logger.debug("UI agent course.plot arrived after intent expiration; cached only")
            return

        if not self._payload_matches_player(payload):
            return

        if not intent.match_fn(payload):
            return

        if intent.timeout_task and not intent.timeout_task.done():
            intent.timeout_task.cancel()
            intent.timeout_task = None

        self._set_intent_event(intent, "course.plot", event_message)
        await self._maybe_trigger_pending_intent_inference()

    def _is_task_scoped_event_without_voice_request(
        self,
        event_message: dict,
        payload: dict,
    ) -> bool:
        payload_task_id = payload.get("__task_id") or payload.get("task_id")
        if not isinstance(payload_task_id, str) or not payload_task_id.strip():
            return False

        event_request_id = event_message.get("request_id")
        is_voice_request = False
        if callable(self._is_recent_voice_request_id):
            try:
                is_voice_request = bool(self._is_recent_voice_request_id(event_request_id))
            except Exception:  # noqa: BLE001
                is_voice_request = False

        if is_voice_request:
            return False

        self._log_metric(
            "course_plot_event_ignored_task_scoped",
            task_id=payload_task_id.strip(),
            request_id=event_request_id,
        )
        return True

    def _map_view_lock_remaining_secs(self) -> float:
        return max(0.0, self._map_view_lock_until - time.time())

    def _map_view_lock_active(self) -> bool:
        if self._map_view_lock_until <= 0:
            return False
        remaining = self._map_view_lock_remaining_secs()
        if remaining <= 0:
            self._map_view_lock_until = 0.0
            self._map_view_lock_reason = None
            return False
        return True

    def _set_map_view_lock(self, reason: str) -> None:
        if self._map_view_lock_secs <= 0:
            return
        self._map_view_lock_until = time.time() + self._map_view_lock_secs
        self._map_view_lock_reason = reason

    def _user_prefers_no_auto_show_map(self) -> bool:
        summary = self._context_summary.lower()
        markers = (
            "don't auto-show map",
            "do not auto-show map",
            "don't auto show map",
            "do not auto show map",
            "prefer not to auto-show map",
            "prefer not to auto show map",
        )
        return any(marker in summary for marker in markers)

    @staticmethod
    def _is_affirmative_reply(text: str) -> bool:
        normalized = re.sub(r"[^a-z0-9\s]", "", text.lower()).strip()
        normalized = re.sub(r"\s+", " ", normalized)
        return normalized in {
            "yes",
            "y",
            "yeah",
            "yep",
            "yup",
            "sure",
            "ok",
            "okay",
            "please",
            "please do",
            "do it",
            "go ahead",
            "affirmative",
        }

    @staticmethod
    def _normalize_intent_text(text: str | None) -> str:
        if not isinstance(text, str):
            return ""
        return re.sub(r"\s+", " ", text.lower()).strip()

    @classmethod
    def _is_explicit_ui_request(cls, text: str | None) -> bool:
        normalized = cls._normalize_intent_text(text)
        if not normalized:
            return False
        if "ui agent" in normalized:
            return True

        ui_verbs = (
            "show",
            "display",
            "open",
            "close",
            "hide",
            "zoom",
            "center",
            "focus",
            "highlight",
            "fit",
            "frame",
            "clear",
            "plot",
            "adjust",
        )
        ui_targets = (
            "map",
            "panel",
            "course",
            "plot",
            "route",
            "sector",
            "ship",
            "ships",
            "port",
            "ports",
            "destination",
        )

        has_ui_verb = any(re.search(rf"\b{re.escape(verb)}\b", normalized) for verb in ui_verbs)
        has_ui_target = any(re.search(rf"\b{re.escape(target)}\b", normalized) for target in ui_targets)
        if has_ui_verb and has_ui_target:
            return True

        if any(
            phrase in normalized
            for phrase in ("course plot", "plot course", "show map", "clear course plot")
        ):
            return True
        return False

    @classmethod
    def _assistant_prompted_ui_confirmation(cls, text: str | None) -> bool:
        normalized = cls._normalize_intent_text(text)
        if not normalized:
            return False
        asks_confirmation = any(
            marker in normalized
            for marker in ("do you want", "would you like", "want me to", "should i")
        )
        if not asks_confirmation and "?" not in normalized:
            return False
        return any(
            token in normalized
            for token in ("map", "plot", "course", "zoom", "highlight", "center", "fit", "panel")
        )

    def _latest_user_allows_deferred_ui_action(self) -> bool:
        latest_user = self._latest_ui_user_message or ""
        if self._is_explicit_ui_request(latest_user):
            return True
        if self._is_affirmative_reply(latest_user) and self._assistant_prompted_ui_confirmation(
            self._latest_ui_assistant_message
        ):
            return True
        return False

    async def _auto_fit_course_plot(self, payload: dict) -> None:
        """Auto-fit map to a course.plot path when no intent was queued.

        The client draws the path from the raw RTVI event, so we need to
        zoom/fit the map to make the full route visible.
        """
        path = payload.get("path")
        if not isinstance(path, list) or len(path) < 2:
            return
        int_path = [s for s in path if isinstance(s, int)]
        if len(int_path) < 2:
            return
        if self._user_prefers_no_auto_show_map():
            self._log_metric(
                "course_plot_auto_fit_skipped",
                reason="user_prefers_no_auto_show_map",
                path_len=len(int_path),
            )
            logger.debug("UI agent auto-fit skipped due to user no-auto-show preference")
            return
        if self._map_view_lock_active():
            remaining = round(self._map_view_lock_remaining_secs(), 2)
            reason = self._map_view_lock_reason or "recent_explicit_map_view"
            self._log_metric(
                "course_plot_auto_fit_skipped",
                reason="recent_explicit_map_view",
                lock_reason=reason,
                lock_remaining_secs=remaining,
                path_len=len(int_path),
            )
            logger.debug(
                f"UI agent auto-fit skipped due to map view lock ({reason}, {remaining}s remaining)"
            )
            return

        arguments = {
            "show_panel": "map",
            "map_highlight_path": int_path,
            "map_fit_sectors": int_path,
        }
        should_send, skip_reason = self._apply_control_ui_dedupe(arguments, source="auto_fit")
        if should_send:
            logger.debug(f"UI agent auto-fit course.plot path ({len(int_path)} sectors)")
            self._log_metric("course_plot_auto_fit_applied", path_len=len(int_path))
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
            self._log_metric(
                "course_plot_auto_fit_skipped",
                reason=skip_reason,
                path_len=len(int_path),
            )

    # ── Message helpers ───────────────────────────────────────────────

    @staticmethod
    def _is_structured_message(content: str) -> bool:
        stripped = content.lstrip()
        return stripped.startswith("<task_progress") or stripped.startswith("<start_of_session")

    @staticmethod
    def _is_non_conversational_text(content: str) -> bool:
        stripped = content.lstrip()
        return (
            stripped.startswith("<event")
            or stripped.startswith("<task_progress")
            or stripped.startswith("<start_of_session")
        )

    @staticmethod
    def _is_event_message(last_message: dict) -> bool:
        frame = LLMMessagesAppendFrame(messages=[last_message])
        return PreLLMInferenceGate._is_event_message(frame)

    @staticmethod
    def _normalize_message_content(value: Any) -> str:
        if isinstance(value, str):
            return value
        try:
            return json.dumps(value, ensure_ascii=True)
        except Exception:
            return str(value)

    @classmethod
    def _content_text_parts(cls, content: Any) -> list[str]:
        parts: list[str] = []
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, dict):
            text = content.get("text")
            if isinstance(text, str):
                parts.append(text)
        elif isinstance(content, list):
            for item in content:
                parts.extend(cls._content_text_parts(item))
        return parts

    @classmethod
    def _message_text_parts(cls, msg: dict) -> list[str]:
        if not isinstance(msg, dict):
            return []
        parts: list[str] = []
        if "content" in msg:
            parts.extend(cls._content_text_parts(msg.get("content")))
        if "parts" in msg:
            parts.extend(cls._content_text_parts(msg.get("parts")))
        return parts

    @classmethod
    def _message_text(cls, msg: dict) -> str | None:
        parts = [part.strip() for part in cls._message_text_parts(msg) if isinstance(part, str)]
        parts = [part for part in parts if part]
        if not parts:
            return None
        return "\n".join(parts)

    @staticmethod
    def _is_assistant_role(role: str | None) -> bool:
        return role in ("assistant", "model")

    def _is_textual_assistant_message(self, msg: dict) -> bool:
        if not isinstance(msg, dict):
            return False
        if not self._is_assistant_role(msg.get("role")):
            return False
        parts = self._message_text_parts(msg)
        return any(part.strip() for part in parts if isinstance(part, str))

    def _is_real_user_message(self, msg: dict) -> bool:
        if not isinstance(msg, dict) or msg.get("role") != "user":
            return False
        if self._is_event_message(msg):
            return False
        parts = self._message_text_parts(msg)
        if not parts:
            return False
        for part in parts:
            if isinstance(part, str) and not self._is_non_conversational_text(part):
                return True
        return False

    def _is_event_or_structured_message(self, msg: dict) -> bool:
        parts = self._message_text_parts(msg)
        if not parts:
            return True
        return all(
            isinstance(part, str) and self._is_non_conversational_text(part) for part in parts
        )

    def _warn_missing_user_input(self) -> None:
        now = time.time()
        last = self._missing_user_warning_at
        if last is None or (now - last) > 60:
            logger.warning("UI agent missing real user input in recent messages.")
            self._missing_user_warning_at = now

    def _reset_missing_user_warning(self) -> None:
        self._missing_user_warning_at = None

    @staticmethod
    def _find_latest_message(messages: list[dict], role: str) -> str | None:
        for msg in reversed(messages):
            if isinstance(msg, dict) and msg.get("role") == role:
                return UIAgentContext._normalize_message_content(msg.get("content"))
        return None

    def _build_user_payload(
        self,
        *,
        latest_user: str,
        latest_assistant: str | None,
        recent_messages: list[dict],
    ) -> str:
        summary = self._context_summary.strip() or "(no prior UI summary)"
        ships_block = self._format_ships_block()
        recent_block = self._format_recent_messages(recent_messages)
        pending_intents_block = self._format_pending_intents_block()
        pending_events_block = self._format_pending_intent_events_block()

        parts = [
            "Latest user message:",
            latest_user.strip(),
            "",
            "Latest assistant message:",
            (latest_assistant or "(none)").strip(),
            "",
            recent_block,
            "",
            pending_intents_block,
            "",
            pending_events_block,
            "",
            "Current UI context summary:",
            f"<context_summary>\n{summary}\n</context_summary>",
            "",
            ships_block,
        ]
        return "\n".join(parts).strip()

    def _select_recent_messages(self, messages: list[dict]) -> tuple[list[dict], str | None]:
        max_messages = 20
        last_assistant_index: int | None = None
        latest_assistant: str | None = None
        for idx in range(len(messages) - 1, -1, -1):
            msg = messages[idx]
            if self._is_textual_assistant_message(msg):
                last_assistant_index = idx
                latest_assistant = self._message_text(msg)
                if not latest_assistant:
                    content = msg.get("content") if isinstance(msg, dict) else None
                    if content is not None:
                        latest_assistant = self._normalize_message_content(content)
                break

        if last_assistant_index is None:
            start_index = max(0, len(messages) - max_messages)
        else:
            start_index = last_assistant_index

        recent_messages = messages[start_index:]

        if not any(self._is_real_user_message(msg) for msg in recent_messages):
            user_index = None
            for idx in range(start_index - 1, -1, -1):
                if self._is_real_user_message(messages[idx]):
                    user_index = idx
                    break
            if user_index is not None:
                start_index = user_index
                recent_messages = messages[start_index:]
                self._reset_missing_user_warning()
            else:
                self._warn_missing_user_input()

        if not any(self._is_textual_assistant_message(msg) for msg in recent_messages):
            assistant_index = None
            for idx in range(start_index - 1, -1, -1):
                if self._is_textual_assistant_message(messages[idx]):
                    assistant_index = idx
                    break
            if assistant_index is not None:
                start_index = assistant_index
                recent_messages = messages[start_index:]

        required_indices: set[int] = set()
        for idx in range(len(recent_messages) - 1, -1, -1):
            if self._is_real_user_message(recent_messages[idx]):
                required_indices.add(idx)
                break
        for idx in range(len(recent_messages) - 1, -1, -1):
            if self._is_textual_assistant_message(recent_messages[idx]):
                required_indices.add(idx)
                break
        for idx, msg in enumerate(recent_messages):
            if isinstance(msg, dict) and msg.get("_ui_intent_event"):
                required_indices.add(idx)

        if len(recent_messages) > max_messages:
            drop_order: list[int] = []
            for idx, msg in enumerate(recent_messages):
                if idx in required_indices:
                    continue
                if self._is_event_or_structured_message(msg):
                    drop_order.append(idx)
            for idx in range(len(recent_messages)):
                if idx in required_indices or idx in drop_order:
                    continue
                drop_order.append(idx)
            to_drop = len(recent_messages) - max_messages
            keep = [True] * len(recent_messages)
            for idx in drop_order:
                if to_drop <= 0:
                    break
                keep[idx] = False
                to_drop -= 1
            recent_messages = [
                msg for idx, msg in enumerate(recent_messages) if keep[idx]
            ]

        return recent_messages, latest_assistant

    def _find_latest_user_input(self, messages: list[dict]) -> str | None:
        for msg in reversed(messages):
            if not self._is_real_user_message(msg):
                continue
            message_text = self._message_text(msg)
            if message_text:
                self._reset_missing_user_warning()
                return message_text
            content = msg.get("content") if isinstance(msg, dict) else None
            if content is not None:
                self._reset_missing_user_warning()
                return self._normalize_message_content(content)
        return None

    def _format_recent_messages(self, messages: list[dict]) -> str:
        if not messages:
            return "Recent conversation messages: (none)"
        lines = ["Recent conversation messages (from last assistant):"]
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            role = msg.get("role") or "unknown"
            content = self._message_text(msg)
            if not content:
                continue
            lines.append(f"[{role}] {content}")
        return "\n".join(lines)

    # Fields relevant for UI agent decisions (name, location, ownership)
    _SHIPS_SUMMARY_KEYS = ("ship_name", "sector", "owner_type")

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
        summary = [
            {k: ship[k] for k in self._SHIPS_SUMMARY_KEYS if k in ship}
            for ship in self._cached_ships
        ]
        try:
            ships_json = json.dumps(summary, ensure_ascii=True, indent=2)
        except Exception:
            ships_json = str(summary)
        return f"Recent ships list {meta_line}:\n{ships_json}"

    def _format_pending_intents_block(self) -> str:
        if not self._pending_intents:
            return "Pending UI intents: (none)"
        lines = ["Pending UI intents:"]
        for intent_type in self._pending_intents:
            lines.append(f"- {intent_type}")
        return "\n".join(lines)

    def _format_pending_intent_events_block(self) -> str:
        events: list[str] = []
        for intent in self._pending_intents.values():
            event_xml = intent.event_xml
            if isinstance(event_xml, str) and event_xml.strip():
                events.append(event_xml.strip())
        if not events:
            return "Pending intent events: (none)"
        lines = ["Pending intent events:"]
        lines.extend(events)
        return "\n".join(lines)

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
        include_player_sector = False if include_player_sector is None else bool(include_player_sector)
        show_panel = arguments.get("show_panel")
        show_panel = True if show_panel is None else bool(show_panel)
        expires_in_secs = arguments.get("expires_in_secs")
        result: dict[str, Any] | None = None
        intent_id: int | None = None

        try:
            if intent_type not in ("ports.list", "ships.list", "course.plot"):
                raise ValueError(f"Unknown intent_type '{intent_type}'")

            expires_override: float | None = None
            if expires_in_secs is not None:
                expires_override = float(expires_in_secs)

            if intent_type == "ports.list":
                if not self._latest_user_allows_deferred_ui_action():
                    self._log_metric(
                        "ui_intent_rejected_non_ui_request",
                        intent_type="ports.list",
                        latest_user=(self._latest_ui_user_message or "")[:160],
                    )
                    result = {
                        "success": True,
                        "intent_type": "ports.list",
                        "intent_id": None,
                        "skipped": True,
                        "skip_reason": "latest_user_not_ui_request",
                    }
                else:
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

                    def _ports_match_fn(payload: dict) -> bool:
                        return self._ports_list_filters_match(payload, filters)

                    async def _ports_request_factory(iid: int) -> None:
                        await self._delayed_ports_list_request(iid, filters)

                    intent_id = self._set_pending_intent(
                        "ports.list",
                        match_fn=_ports_match_fn,
                        type_fields={"filters": filters},
                        include_player_sector=include_player_sector,
                        show_panel=show_panel,
                        default_timeout_secs=self._ports_list_timeout_secs,
                        expires_in_secs=expires_override,
                        replace_existing=replace_existing,
                        request_factory=_ports_request_factory,
                    )
                    await self._yield_for_pending_intent_tasks("ports.list", intent_id)
                    cached_event = self._get_cached_ports_list_event(filters)
                    if cached_event is not None:
                        await self._on_ports_list(cached_event)

            elif intent_type == "ships.list":
                ship_scope = arguments.get("ship_scope") or "all"
                if ship_scope not in ("corporation", "personal", "all"):
                    raise ValueError(f"Invalid ship_scope '{ship_scope}'")

                def _ships_match_fn(payload: dict) -> bool:
                    return True

                async def _ships_request_factory(iid: int) -> None:
                    await self._delayed_ships_list_request(iid)

                intent_id = self._set_pending_intent(
                    "ships.list",
                    match_fn=_ships_match_fn,
                    type_fields={"ship_scope": ship_scope},
                    include_player_sector=include_player_sector,
                    show_panel=show_panel,
                    default_timeout_secs=self._ships_list_timeout_secs,
                    expires_in_secs=expires_override,
                    replace_existing=replace_existing,
                    request_factory=_ships_request_factory,
                )
                await self._yield_for_pending_intent_tasks("ships.list", intent_id)
                if self._ships_cache_is_fresh():
                    cached_event = self._cached_ships_event_message
                    if cached_event is None:
                        payload = {"ships": list(self._cached_ships)}
                        expected_player_id = getattr(self._game_client, "character_id", None)
                        if expected_player_id:
                            payload["player"] = {"id": expected_player_id}
                        cached_event = {"event_name": "ships.list", "payload": payload}
                    await self._handle_ships_list_intent(cached_event)

            else:
                if not self._latest_user_allows_deferred_ui_action():
                    self._log_metric(
                        "ui_intent_rejected_non_ui_request",
                        intent_type="course.plot",
                        latest_user=(self._latest_ui_user_message or "")[:160],
                    )
                    result = {
                        "success": True,
                        "intent_type": "course.plot",
                        "intent_id": None,
                        "skipped": True,
                        "skip_reason": "latest_user_not_ui_request",
                    }
                else:
                    from_sector = arguments.get("from_sector")
                    if from_sector is not None and not isinstance(from_sector, int):
                        from_sector = int(from_sector)
                    to_sector = arguments.get("to_sector")
                    if to_sector is not None and not isinstance(to_sector, int):
                        to_sector = int(to_sector)

                    def _course_match_fn(payload: dict) -> bool:
                        if isinstance(from_sector, int) and isinstance(to_sector, int):
                            if payload.get("from_sector") != from_sector or payload.get("to_sector") != to_sector:
                                logger.debug(
                                    "UI agent course.plot mismatch with pending intent; cached only"
                                )
                                return False
                        return True

                    intent_id = self._set_pending_intent(
                        "course.plot",
                        match_fn=_course_match_fn,
                        type_fields={"from_sector": from_sector, "to_sector": to_sector},
                        include_player_sector=include_player_sector,
                        show_panel=show_panel,
                        default_timeout_secs=self._course_plot_timeout_secs,
                        expires_in_secs=expires_override,
                        replace_existing=replace_existing,
                    )
                    await self._yield_for_pending_intent_tasks("course.plot", intent_id)
                    if isinstance(from_sector, int) and isinstance(to_sector, int):
                        cached_event = self._get_cached_course_plot_event(from_sector, to_sector)
                        if cached_event is not None:
                            await self._on_course_plot(cached_event)
                    else:
                        logger.debug(
                            "UI agent course.plot cache skipped; missing from/to sector"
                        )

            if result is None:
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

        logger.debug(f"UI agent control_ui args: {arguments}")

        highlight_path = self._normalize_int_list(arguments.get("map_highlight_path"))
        if highlight_path and not self._latest_user_allows_deferred_ui_action():
            should_send = False
            skip_reason = "latest_user_not_ui_request_for_route_highlight"
            self._log_metric(
                "control_ui_skipped_unsolicited_route_highlight",
                path_len=len(highlight_path),
                latest_user=(self._latest_ui_user_message or "")[:160],
            )
        else:
            should_send, skip_reason = self._apply_control_ui_dedupe(arguments, source="llm")
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
            logger.debug(f"UI agent skipped no-op control_ui action (reason={skip_reason})")

        # Append tool_call + tool_result messages (no counter increment for control_ui)
        tool_call_id = params.tool_call_id
        function_name = params.function_name
        result = {"success": True, "skipped": not should_send, "skip_reason": skip_reason}

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

        self._safe_create_task(_fetch(), name="corp_info_fetch")

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

        self._status_timeout_task = self._safe_create_task(
            _timeout(),
            name="status_snapshot_timeout",
        )

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
            self._safe_create_task(self._push_rerun_inference(), name="ui_agent_rerun")
            return

        # Text-only response (or only control_ui which doesn't set _had_tool_calls)
        summary = self._extract_summary(self._response_text)
        self._safe_create_task(
            self._async_on_inference_complete(summary),
            name="ui_agent_inference_complete",
        )

    async def _async_on_inference_complete(self, summary: str | None) -> None:
        await self.on_inference_complete(summary)

    async def on_inference_complete(self, new_summary: str | None) -> None:
        if new_summary is not None:
            self._context_summary = new_summary
            self._log_context_summary_quality(new_summary, self._latest_ui_user_message)
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
                if self._has_new_real_user_message(
                    self._context.messages, self._last_run_message_count
                ):
                    should_rerun = True

        if should_rerun:
            await self._schedule_inference()

    def _has_new_real_user_message(self, messages: list[dict], since_index: int) -> bool:
        if since_index < 0:
            since_index = 0
        if since_index >= len(messages):
            return False
        for msg in messages[since_index:]:
            if self._is_real_user_message(msg):
                return True
        return False

    @staticmethod
    def _extract_summary(text: str) -> str | None:
        if not text:
            return None
        match = _CONTEXT_SUMMARY_RE.search(text)
        if not match:
            return None
        summary = match.group(1).strip()
        return summary or ""

    @staticmethod
    def _word_count(text: str) -> int:
        return len(re.findall(r"\b\w+\b", text))

    @staticmethod
    def _looks_like_ui_intent(text: str) -> bool:
        normalized = text.lower()
        keywords = (
            "map",
            "zoom",
            "panel",
            "plot",
            "course",
            "clear",
            "ship",
            "sector",
            "port",
            "highlight",
            "center",
            "fit",
            "frame",
            "show",
            "hide",
        )
        return any(keyword in normalized for keyword in keywords)

    @classmethod
    def _summary_mentions_latest_intent(cls, summary: str, latest_user: str) -> bool:
        summary_lower = summary.lower()
        latest_lower = latest_user.lower()
        summary_signals = (
            "user asked",
            "user wants",
            "user requested",
            "latest user",
        )
        if any(signal in summary_lower for signal in summary_signals):
            return True
        keywords = (
            "map",
            "zoom",
            "panel",
            "plot",
            "course",
            "clear",
            "ship",
            "sector",
            "port",
            "highlight",
            "center",
            "fit",
            "frame",
            "show",
            "hide",
        )
        matched = [keyword for keyword in keywords if keyword in latest_lower]
        if not matched:
            return True
        return any(keyword in summary_lower for keyword in matched)

    def _summary_ship_sector_mentions(self, summary: str) -> dict[str, set[int]]:
        mentions: dict[str, set[int]] = {}
        if not summary:
            return mentions
        for ship in self._cached_ships:
            ship_name = ship.get("ship_name")
            if not isinstance(ship_name, str) or not ship_name.strip():
                continue
            name_parts = [re.escape(part) for part in ship_name.split() if part]
            if not name_parts:
                continue
            name_pattern = r"\s*".join(name_parts)
            pattern = re.compile(
                rf"{name_pattern}.{{0,120}}?sector\s+(\d+)",
                re.IGNORECASE | re.DOTALL,
            )
            sectors = {int(match) for match in pattern.findall(summary)}
            if sectors:
                mentions[ship_name] = sectors
        return mentions

    def _log_context_summary_quality(self, summary: str, latest_user: str | None) -> None:
        word_count = self._word_count(summary)
        self._log_metric("context_summary_observed", word_count=word_count)

        if self._summary_word_limit > 0 and word_count > self._summary_word_limit:
            self._log_metric(
                "context_summary_too_long",
                word_count=word_count,
                word_limit=self._summary_word_limit,
            )

        if (
            isinstance(latest_user, str)
            and latest_user.strip()
            and self._looks_like_ui_intent(latest_user)
            and not self._summary_mentions_latest_intent(summary, latest_user)
        ):
            self._log_metric(
                "context_summary_missing_latest_intent_signal",
                latest_user=latest_user,
            )

        latest_known_sectors: dict[str, int] = {}
        for ship in self._cached_ships:
            ship_name = ship.get("ship_name")
            ship_sector = ship.get("sector")
            if isinstance(ship_name, str) and isinstance(ship_sector, int):
                latest_known_sectors[ship_name] = ship_sector

        mentions = self._summary_ship_sector_mentions(summary)
        for ship_name, sectors in mentions.items():
            if len(sectors) > 1:
                self._log_metric(
                    "context_summary_ship_sector_conflict",
                    ship_name=ship_name,
                    sectors=sorted(sectors),
                )
            latest_sector = latest_known_sectors.get(ship_name)
            if isinstance(latest_sector, int) and latest_sector not in sectors:
                self._log_metric(
                    "context_summary_stale_ship_sector",
                    ship_name=ship_name,
                    summary_sectors=sorted(sectors),
                    latest_sector=latest_sector,
                )

    # ── control_ui dedup ──────────────────────────────────────────────

    def _apply_control_ui_dedupe(self, arguments: dict, *, source: str) -> tuple[bool, str]:
        changed = False
        reason = "no_change"
        show_panel_changed = False
        map_center_changed = False
        map_zoom_level_changed = False
        map_zoom_direction_changed = False
        fit_sectors_changed = False

        show_panel = arguments.get("show_panel")
        map_center = arguments.get("map_center_sector")
        map_zoom = arguments.get("map_zoom_level")
        map_zoom_direction = arguments.get("map_zoom_direction")
        highlight_path = self._normalize_int_list(arguments.get("map_highlight_path"))
        fit_sectors = self._normalize_int_list(arguments.get("map_fit_sectors"))
        clear_plot = arguments.get("clear_course_plot") is True

        wants_map = any(
            value is not None
            for value in (map_center, map_zoom, map_zoom_direction, highlight_path, fit_sectors)
        )
        effective_show_panel = show_panel if isinstance(show_panel, str) else None
        if wants_map and effective_show_panel is None:
            effective_show_panel = "map"

        if effective_show_panel in {"map", "default"}:
            if effective_show_panel != self._last_show_panel:
                changed = True
                show_panel_changed = True
                reason = "show_panel_changed"
                self._last_show_panel = effective_show_panel

        if isinstance(map_center, int) and map_center != self._last_map_center_sector:
            changed = True
            map_center_changed = True
            reason = "map_center_changed"
            self._last_map_center_sector = map_center

        if isinstance(map_zoom, int) and map_zoom != self._last_map_zoom_level:
            changed = True
            map_zoom_level_changed = True
            reason = "map_zoom_level_changed"
            self._last_map_zoom_level = map_zoom
        elif map_zoom_direction in {"in", "out"}:
            # Relative zoom should always be sent (no dedupe), since each call advances a step.
            changed = True
            map_zoom_direction_changed = True
            reason = "map_zoom_direction"

        if highlight_path is not None:
            highlight_tuple = tuple(highlight_path)
            if highlight_tuple != self._last_map_highlight_path:
                changed = True
                reason = "map_highlight_path_changed"
                self._last_map_highlight_path = highlight_tuple

        if fit_sectors is not None:
            fit_tuple = tuple(fit_sectors)
            if fit_tuple != self._last_map_fit_sectors:
                changed = True
                fit_sectors_changed = True
                reason = "map_fit_sectors_changed"
                self._last_map_fit_sectors = fit_tuple
                # fit_sectors changes the client zoom to an unknown level,
                # so invalidate the tracked zoom to prevent false dedup.
                self._last_map_zoom_level = None

        if clear_plot:
            # Explicit clear requests should always pass through even if our local
            # highlight state is already empty or unknown.
            changed = True
            reason = "explicit_clear_course_plot"
            self._last_map_highlight_path = tuple()

        if source == "llm" and changed:
            lock_reason: str | None = None
            if show_panel == "default" and show_panel_changed:
                lock_reason = "show_panel_default"
            elif isinstance(map_center, int) and map_center_changed:
                lock_reason = "map_center_sector"
            elif isinstance(map_zoom, int) and map_zoom_level_changed:
                lock_reason = "map_zoom_level"
            elif map_zoom_direction_changed:
                lock_reason = "map_zoom_direction"
            elif fit_sectors is not None and highlight_path is None and fit_sectors_changed:
                lock_reason = "map_fit_sectors"

            if lock_reason:
                self._set_map_view_lock(lock_reason)

        return changed, reason

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
