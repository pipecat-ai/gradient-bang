"""Textual UI that can run tasks or handle sector combat automatically."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from contextlib import suppress
from dataclasses import dataclass
from enum import Enum, auto
from datetime import datetime, timezone
from pathlib import Path

import pyperclip
from loguru import logger
from rich.text import Text
from typing import (
    Any,
    Awaitable,
    Callable,
    Dict,
    Iterable,
    List,
    Mapping,
    Optional,
    Sequence,
    Set,
    Tuple,
    TextIO,
)

from textual import events
from textual.app import App, ComposeResult
from textual.containers import Horizontal
from textual.widgets import Header, Input, ListItem, ListView, Static

from gradientbang.npc.combat_session import CombatSession
from gradientbang.npc.combat_utils import ensure_position
from gradientbang.npc.status_bars import StatusBarUpdater
from gradientbang.utils.api_client import AsyncGameClient, RPCError
from gradientbang.utils.task_agent import TaskAgent, TaskOutputType
from gradientbang.utils.config import get_repo_root, get_world_data_path

REPO_ROOT = get_repo_root()
WORLD_DATA_DIR = get_world_data_path(ensure_exists=False)
SESSION_LOCK_DIR = REPO_ROOT / "logs" / "ship-sessions"
KNOWLEDGE_DIR = WORLD_DATA_DIR / "character-map-knowledge"


class SessionLockError(RuntimeError):
    """Raised when a corp ship already has an active session."""


def _pid_is_active(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _acquire_ship_session_lock(
    ship_id: str,
    *,
    actor_id: str,
    server: str,
) -> Callable[[], None]:
    SESSION_LOCK_DIR.mkdir(parents=True, exist_ok=True)
    lock_path = SESSION_LOCK_DIR / f"{ship_id}.lock"
    metadata = {
        "ship_id": ship_id,
        "actor_id": actor_id,
        "server": server,
        "pid": os.getpid(),
        "started_at": datetime.now(timezone.utc).isoformat(),
    }

    while True:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            existing: Dict[str, Any] = {}
            try:
                with lock_path.open("r", encoding="utf-8") as handle:
                    existing = json.load(handle)
            except Exception:  # noqa: BLE001
                existing = {}
            pid = existing.get("pid")
            if isinstance(pid, int) and _pid_is_active(pid):
                actor = existing.get("actor_id", "unknown actor")
                started = existing.get("started_at", "unknown time")
                raise SessionLockError(
                    f"ship {ship_id} already has an active session (pid {pid}, actor {actor}, started {started})"
                )
            try:
                lock_path.unlink()
            except FileNotFoundError:
                pass
            continue
        else:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(metadata, handle)
            break

    def release() -> None:
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass

    return release


def _require_ship_knowledge(ship_id: str) -> None:
    if not KNOWLEDGE_DIR.parent.exists():
        raise RuntimeError(
            "world-data directory not found. Generate the universe before controlling corporation ships."
        )
    knowledge_path = KNOWLEDGE_DIR / f"{ship_id}.json"
    if not knowledge_path.exists():
        raise RuntimeError(
            f"Missing character knowledge for {ship_id}. Create {knowledge_path} before launching the session."
        )


COMMODITY_KEYS: Tuple[Tuple[str, str], ...] = (
    ("quantum_foam", "QF"),
    ("retro_organics", "RO"),
    ("neuro_symbolics", "NS"),
)


def _coerce_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


ANSI_ESCAPE_RE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
ALT_SCREEN_ENTER = "\x1b[?1049h"
ALT_SCREEN_EXIT = "\x1b[?1049l"


EVENT_NAMES: Tuple[str, ...] = (
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
    "ports.list",
    "character.moved",
    "trade.executed",
    "port.update",
    "warp.purchase",
    "warp.transfer",
    "garrison.deployed",
    "garrison.collected",
    "garrison.mode_changed",
    "garrison.combat_alert",
    "salvage.collected",
    "combat.round_waiting",
    "combat.round_resolved",
    "combat.ended",
    "combat.action_accepted",
    "chat.message",
    "error",
)


def _extract_player_display_name(payload: Mapping[str, Any]) -> Optional[str]:
    """Best-effort extraction of the player's display name from payloads."""

    def _clean(value: Any) -> Optional[str]:
        if isinstance(value, str):
            value = value.strip()
            if value:
                return value
        return None

    if not isinstance(payload, Mapping):
        return None

    player_block = payload.get("player")
    if isinstance(player_block, Mapping):
        for key in ("name", "display_name", "player_name"):
            cleaned = _clean(player_block.get(key))
            if cleaned:
                return cleaned

    for fallback_key in ("player_name", "name"):
        cleaned = _clean(payload.get(fallback_key))
        if cleaned:
            return cleaned

    return None


def _extract_sector_id(value: Any) -> Optional[int]:
    if isinstance(value, dict):
        return value.get("id")
    return value


class _StderrInterceptor:
    """Collect stderr writes and forward them to the SimpleTUI log."""

    def __init__(self, app: "SimpleTUI", original_stream) -> None:
        self.app = app
        self.original = original_stream
        self._buffer = ""
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._escape_buffer = ""
        self._passthrough = True

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def write(self, data: str) -> int:  # pragma: no cover - simple plumbing
        if not data:
            return 0
        text = str(data)
        self._buffer += text
        self._escape_buffer += text

        should_forward = self._passthrough
        if ALT_SCREEN_ENTER in self._escape_buffer:
            should_forward = True
            self._passthrough = False
            self._escape_buffer = self._escape_buffer.replace(ALT_SCREEN_ENTER, "")
        if ALT_SCREEN_EXIT in self._escape_buffer:
            should_forward = True
            self._passthrough = True
            self._escape_buffer = self._escape_buffer.replace(ALT_SCREEN_EXIT, "")
        if len(self._escape_buffer) > 64:
            self._escape_buffer = self._escape_buffer[-64:]

        if should_forward:
            self.original.write(text)
            if hasattr(self.original, "flush"):
                self.original.flush()

        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            self._dispatch_line(line.rstrip("\r"))
        return len(text)

    def flush(self) -> None:  # pragma: no cover - noop
        if self._buffer:
            self._dispatch_line(self._buffer.rstrip("\r"))
            self._buffer = ""
        self._escape_buffer = ""
        if self._passthrough and hasattr(self.original, "flush"):
            self.original.flush()

    def isatty(self) -> bool:  # pragma: no cover - passthrough
        return False

    @property
    def encoding(self) -> str:  # pragma: no cover - passthrough
        return getattr(self.original, "encoding", "utf-8")

    def fileno(self) -> int:  # pragma: no cover - passthrough
        if hasattr(self.original, "fileno"):
            return self.original.fileno()
        raise AttributeError("fileno not supported")

    def _dispatch_line(self, line: str) -> None:
        raw = line.rstrip()
        clean = ANSI_ESCAPE_RE.sub("", raw)
        clean = clean.strip()
        if not clean:
            return
        loop = self._loop
        if loop and loop.is_running():
            loop.call_soon_threadsafe(
                lambda: asyncio.create_task(
                    self.app._append_debug_line(
                        f"[stderr] {clean}",
                        level=self.app._log_level,
                        _external=True,
                    )
                )
            )


class AutoScrollListView(ListView):
    """ListView with auto-scroll when scrolled to bottom."""

    def append_item(self, item: ListItem) -> None:
        """Append an item and auto-scroll if at bottom."""
        # Check if we're scrolled to bottom before adding
        was_at_bottom = self._is_at_bottom()

        self.append(item)

        # Only auto-scroll if we were at bottom
        if was_at_bottom:
            self.scroll_end(animate=False)

    def _is_at_bottom(self) -> bool:
        """Check if the view is scrolled to the bottom."""
        # If there are no items yet, we're at the bottom
        if len(self) == 0:
            return True

        # Check if scroll is at or near the end
        # Allow small tolerance (1 line) for floating point issues
        max_scroll = self.max_scroll_y
        current_scroll = self.scroll_y

        return (max_scroll - current_scroll) <= 1


def extract_and_format_json(text: str) -> Optional[str]:
    """
    Extract JSON from text and return pretty-printed version.

    Returns None if no JSON found or parsing fails.
    """
    # Try to find JSON object or array in the text
    # Look for {...} or [...]
    json_pattern = r"(\{.*\}|\[.*\])"
    match = re.search(json_pattern, text, re.DOTALL)

    if not match:
        return None

    json_str = match.group(1)

    try:
        parsed = json.loads(json_str)
        pretty = json.dumps(parsed, indent=2, sort_keys=True)

        # Get prefix (text before JSON) and suffix (text after JSON)
        prefix = text[: match.start()].rstrip()
        suffix = text[match.end() :].lstrip()

        result_parts = []
        if prefix:
            result_parts.append(prefix)
        result_parts.append(pretty)
        if suffix:
            result_parts.append(suffix)

        return "\n".join(result_parts)
    except (json.JSONDecodeError, ValueError):
        return None


def copy_to_system_clipboard(text: str) -> tuple[bool, str]:
    """
    Copy text to system clipboard using pyperclip.

    Returns (success: bool, error_msg: str).
    """
    try:
        pyperclip.copy(text)
        return True, ""
    except pyperclip.PyperclipException as e:
        return False, str(e)
    except Exception as e:
        return False, f"Clipboard error: {e}"


def extract_json_only(text: str) -> Optional[str]:
    """
    Extract and return only the pretty-printed JSON from text.

    Returns None if no JSON found or parsing fails.
    Used for clipboard copy.
    """
    # Try to find JSON object or array in the text
    json_pattern = r"(\{.*\}|\[.*\])"
    match = re.search(json_pattern, text, re.DOTALL)

    if not match:
        return None

    json_str = match.group(1)

    try:
        parsed = json.loads(json_str)
        return json.dumps(parsed, indent=2, sort_keys=True)
    except (json.JSONDecodeError, ValueError):
        return None


def format_log_line(text: str, expanded: bool) -> str:
    """
    Format a log line with expand/collapse indicator.

    Args:
        text: Original log line text
        expanded: Whether the line is currently expanded

    Returns:
        Formatted text with indicator
    """
    indicator = "▼" if expanded else "▶"

    if expanded:
        # Try to extract and format JSON
        formatted = extract_and_format_json(text)
        if formatted:
            return f"{indicator} {formatted}"
        else:
            # No JSON found, just return wrapped text
            # The Static widget will handle wrapping based on CSS
            return f"{indicator} {text}"
    else:
        # Collapsed - single line
        return f"{indicator} {text}"


@dataclass
class PromptRequest:
    label: str
    placeholder: str = ""
    options: Optional[Sequence[str]] = None


class _UILogger:
    """Lightweight logger proxy that writes to the Textual log."""

    def __init__(self, app: "SimpleTUI") -> None:
        self.app = app

    def info(self, message: str, *args: Any) -> None:
        text = message % args if args else message
        asyncio.create_task(self.app._append_log(text))


class InteractionMode(Enum):
    TASK = auto()
    COMBAT = auto()


class CommandInput(Input):
    """Input widget that forwards keybindings to the parent app."""

    BINDINGS = [
        ("ctrl+x", "start_combat", "Start Combat"),
        ("ctrl+g", "cancel_task", "Cancel Task"),
    ]

    async def action_start_combat(self) -> None:  # pragma: no cover - UI glue
        app = self.app
        if app is not None and hasattr(app, "action_start_combat"):
            await app.action_start_combat()

    async def action_cancel_task(self) -> None:  # pragma: no cover - UI glue
        app = self.app
        if app is not None and hasattr(app, "action_cancel_task"):
            await app.action_cancel_task()


class SimpleTUI(App):
    """Minimal Textual UI that supports task execution and combat handling."""

    CSS = """
    Screen {
        layout: vertical;
    }

    #ws-log, #debug-log {
        height: 1fr;
    }

    #ws-log > ListItem, #debug-log > ListItem {
        height: auto;
        padding: 0 1;
    }

    #ws-log > ListItem > Static, #debug-log > ListItem > Static {
        width: 100%;
        height: auto;
    }

    #ws-log > ListItem.expanded > Static, #debug-log > ListItem.expanded > Static {
        text-wrap: wrap;
    }

    #ws-log > ListItem.collapsed > Static, #debug-log > ListItem.collapsed > Static {
        text-wrap: nowrap;
        overflow-x: hidden;
        text-overflow: ellipsis;
    }

    #status-bars {
        height: auto;
        padding: 0 1;
    }

    #task-banner {
        height: auto;
        padding: 0 1;
        color: $text;
    }

    #prompt-bar {
        height: auto;
        padding: 1 1;
    }

    #prompt-label {
        width: auto;
        padding: 0 1;
    }

    #log-panel-label {
        height: auto;
        padding: 0 1;
    }

    #prompt-input {
        width: 1fr;
    }
    """

    BINDINGS = [
        ("ctrl+c", "quit", "Quit"),
        ("ctrl+q", "quit", "Quit"),
        ("ctrl+x", "start_combat", "Start Combat"),
        ("ctrl+g", "cancel_task", "Cancel Task"),
        ("ctrl+y", "copy_log_line", "Copy Log Line"),
        ("ctrl+t", "toggle_log_panel", "Toggle Log Panel"),
    ]

    def __init__(
        self,
        *,
        server: str,
        character_id: str,
        actor_character_id: Optional[str] = None,
        sector: Optional[int] = None,
        verbose: bool = False,
        log_path: Optional[str] = None,
        max_iterations: int = 25,
        log_level: str = "INFO",
        thinking_budget: Optional[int] = None,
        idle_timeout: Optional[float] = None,
        scripted_tasks: Optional[Sequence[str]] = None,
    ) -> None:
        super().__init__()
        self.server = server.rstrip("/")
        self.character_id = character_id
        self.actor_character_id = actor_character_id
        self.display_name: str = character_id
        self.target_sector = sector
        self.verbose = verbose
        self.log_path = Path(log_path) if log_path else Path.cwd() / "simple_tui.log"
        self.client: Optional[AsyncGameClient] = None
        self.session: Optional[CombatSession] = None
        self.monitor_task: Optional[asyncio.Task] = None
        self.round_prompt_task: Optional[asyncio.Task] = None
        self.pending_input: Optional[asyncio.Future[str]] = None
        self._ensure_logger = _UILogger(self)
        self._log_file: Optional[TextIO] = None
        self._combatant_stats: Dict[str, Tuple[int, int]] = {}
        self.status_display: Optional[Static] = None
        self.occupant_display: Optional[Static] = None
        self.port_display: Optional[Static] = None
        self._last_player_stats: Tuple[int, int] = (0, 0)
        self._last_status_mode: str = "quiet"
        self._last_participants: Dict[str, Dict[str, Any]] = {}
        self._latest_defeated: List[Dict[str, Any]] = []
        self._last_opponent_labels: Tuple[str, ...] = ()
        self._combat_started_announced: bool = False
        self.mode: InteractionMode = InteractionMode.TASK
        self.task_banner: Optional[Static] = None
        self.task_agent: Optional[TaskAgent] = None
        self.task_runner: Optional[asyncio.Task] = None
        self._task_last_prompt: Optional[str] = None
        self.task_max_iterations = max(1, max_iterations)
        self._thinking_budget = thinking_budget
        self._pipeline_idle_timeout = idle_timeout
        self._last_ship_meta: Dict[str, Any] = {"credits": None, "cargo": {}}
        self.status_updater = StatusBarUpdater(character_id)
        self._log_level = (log_level or "INFO").upper()
        if self._log_level not in {
            "TRACE",
            "DEBUG",
            "INFO",
            "SUCCESS",
            "WARNING",
            "ERROR",
            "CRITICAL",
        }:
            self._log_level = "INFO"
        self._generic_event_suppressed: Set[str] = set()
        self._scripted_tasks: List[str] = [
            task.strip() for task in (scripted_tasks or []) if task and task.strip()
        ]
        self._stderr_interceptor: Optional[_StderrInterceptor] = None
        self._original_stderr = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._loguru_sink_id: Optional[int] = None
        self._log_state: Dict[str, Dict[str, Any]] = {
            "events": {"counter": 0, "lines": {}, "expanded": set()},
            "debug": {"counter": 0, "lines": {}, "expanded": set()},
        }
        self._active_log_panel: str = "events"
        self._log_views: Dict[str, AutoScrollListView] = {}
        self.events_log: Optional[AutoScrollListView] = None
        self.debug_log: Optional[AutoScrollListView] = None
        self.log_panel_label: Optional[Static] = None
        self._last_status_payload: Optional[Dict[str, Any]] = None
        self._status_snapshot_ready: Optional[asyncio.Event] = None
        self._session_lock_release: Optional[Callable[[], None]] = None

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        self.task_banner = Static("task idle", id="task-banner")
        yield self.task_banner
        self.status_display = Static("", id="status-bars")
        yield self.status_display
        self.log_panel_label = Static(
            "Log panel: Events (Ctrl+T)", id="log-panel-label"
        )
        yield self.log_panel_label
        self.events_log = AutoScrollListView(id="ws-log")
        self._log_views["events"] = self.events_log
        yield self.events_log
        self.debug_log = AutoScrollListView(id="debug-log")
        self.debug_log.display = False
        self.debug_log.styles.display = "none"
        self._log_views["debug"] = self.debug_log
        yield self.debug_log
        with Horizontal(id="prompt-bar"):
            self.prompt_label = Static("Initializing", id="prompt-label")
            self.input = CommandInput(id="prompt-input", placeholder="")
            yield self.prompt_label
            yield self.input

    def _is_corp_ship_control(self) -> bool:
        return (
            self.actor_character_id is not None
            and self.actor_character_id != self.character_id
        )

    def _corp_request_character_id(self) -> str:
        return self.actor_character_id or self.character_id

    def _prepare_corp_ship_control(self) -> None:
        if not self._is_corp_ship_control():
            return
        _require_ship_knowledge(self.character_id)
        self._session_lock_release = _acquire_ship_session_lock(
            self.character_id,
            actor_id=self.actor_character_id,
            server=self.server,
        )

    async def _handle_join_failure(self, exc: RPCError) -> None:
        detail = (getattr(exc, "detail", "") or str(exc)).strip()
        status = getattr(exc, "status", "unknown")
        await self._append_log(
            f"Join failed (status {status}): {detail}"
        )
        lower_detail = detail.lower()
        if "actor_character_id is required" in lower_detail:
            await self._append_log(
                "Provide --actor-id with a corporation member when launching this UI."
            )
        elif "not authorized" in lower_detail:
            await self._append_log(
                f"Actor {self.actor_character_id} is not authorised to control {self.character_id}."
            )
        elif "knowledge" in lower_detail:
            path = KNOWLEDGE_DIR / f"{self.character_id}.json"
            await self._append_log(f"Create {path} before retrying.")
        elif "active session" in lower_detail:
            await self._append_log(
                f"Another session is controlling {self.character_id}. Remove stale locks in {SESSION_LOCK_DIR} if needed."
            )

    async def on_mount(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._start_stderr_capture()
        self._configure_logger()
        self._set_active_log_panel("events")
        self._update_status_bar(in_combat=False, fighters=0, shields=0)
        self._update_task_banner("Connecting to server…")
        self.set_focus(self.input)
        try:
            self._prepare_corp_ship_control()
        except RuntimeError as exc:
            await self._append_log(str(exc))
            await self._append_log(
                "Run 'uv run scripts/corporation_lookup.py <member_id> --ships' to inspect knowledge files."
            )
            self.exit(1)
            return
        except SessionLockError as exc:
            await self._append_log(str(exc))
            await self._append_log(
                f"If this is stale, remove the lock file in {SESSION_LOCK_DIR}"
            )
            self.exit(1)
            return
        asyncio.create_task(self._initialize_client())

    async def _initialize_client(self) -> None:
        await self._append_log("Connecting to server...")
        await self._append_log("(Sanity check) ...")

        target_desc = (
            str(self.target_sector)
            if self.target_sector is not None
            else "stay in current sector"
        )
        actor_desc = self.actor_character_id or "self"
        await self._append_log(
            f"Configuration: server={self.server} character_id={self.character_id} "
            f"actor={actor_desc} target={target_desc} log_file={self.log_path}"
        )

        await self._append_log("Creating AsyncGameClient...") 

        async def log_frame(direction: str, frame: Mapping[str, Any]) -> None:
            text = json.dumps(frame, sort_keys=True, ensure_ascii=False)
            await self._append_log(f"{direction.upper()}: {text}")

        entity_type = (
            "corporation_ship"
            if self.actor_character_id and self.actor_character_id != self.character_id
            else "character"
        )
        self.client = AsyncGameClient(
            base_url=self.server,
            character_id=self.character_id,
            actor_character_id=self.actor_character_id,
            entity_type=entity_type,
            websocket_frame_callback=log_frame,
        )

        self._register_event_handlers()

        agent_kwargs: Dict[str, Any] = {
            "output_callback": self._handle_task_output,
        }
        if self._thinking_budget is not None:
            agent_kwargs["thinking_budget"] = self._thinking_budget
        if self._pipeline_idle_timeout is not None:
            agent_kwargs["idle_timeout_secs"] = self._pipeline_idle_timeout

        self.task_agent = TaskAgent(
            game_client=self.client,
            character_id=self.character_id,
            **agent_kwargs,
        )

        await self._append_log("AsyncGameClient created; calling join...")

        try:
            # Prepare to capture the initial status snapshot emitted during join
            self._status_snapshot_ready = asyncio.Event()
            self._last_status_payload = None

            await self.client.join(self.character_id)
        except RPCError as exc:
            await self._handle_join_failure(exc)
            await self._graceful_shutdown()
            self.exit(1)
            return

        try:
            initial_status: Optional[Mapping[str, Any]] = None
            if self._status_snapshot_ready is not None:
                try:
                    await asyncio.wait_for(
                        self._status_snapshot_ready.wait(), timeout=2.0
                    )
                    initial_status = self._last_status_payload
                except asyncio.TimeoutError:
                    await self._append_log(
                        "Timed out waiting for status snapshot after join; requesting refresh."
                    )
                    try:
                        self._status_snapshot_ready = asyncio.Event()
                        self._last_status_payload = None
                        await self.client.my_status(self.character_id)
                        if self._status_snapshot_ready is not None:
                            await asyncio.wait_for(
                                self._status_snapshot_ready.wait(), timeout=2.0
                            )
                            initial_status = self._last_status_payload
                    except Exception as exc:  # noqa: BLE001
                        await self._append_log(f"Unable to fetch initial status: {exc}")

            status_payload: Optional[Dict[str, Any]] = (
                dict(initial_status) if isinstance(initial_status, Mapping) else None
            )
            if status_payload:
                self._update_display_name_from_payload(status_payload)

            # Extract sector for logging (using format-agnostic access)
            sector_id: Any = "?"
            if isinstance(status_payload, Mapping):
                sector_info = status_payload.get("sector")
                if isinstance(sector_info, Mapping):
                    sector_id = sector_info.get("id", sector_id)
                elif sector_info is not None:
                    sector_id = sector_info

            await self._append_log(
                f"Joined as {self.display_name}; sector {sector_id}"
            )

            await self.client.subscribe_my_messages()

            # Initialize CombatSession with initial status
            self.session = CombatSession(
                self.client,
                character_id=self.character_id,
                logger=None,
                initial_status=status_payload if status_payload else None,
            )
            self.session.start()

            # Sync status bars from initial join response
            if status_payload:
                self._sync_status_bar_from_status(status_payload)

            await self._append_log("CombatSession started; spawning monitor task")
            self.monitor_task = asyncio.create_task(self._monitor_events())

            # Move to target sector if specified
            if self.target_sector is not None:
                await self._append_log(
                    f"Moving to target sector {self.target_sector}..."
                )
                # ensure_position makes RPC calls but we ignore the responses
                # All updates will come from movement.start and movement.complete events
                if status_payload:
                    await ensure_position(
                        self.client,
                        status_payload,
                        target_sector=self.target_sector,
                        logger=self._ensure_logger,
                    )
                    await self._append_log("Movement commands issued")
                else:
                    await self._append_log(
                        "Skipping initial repositioning; no status payload available yet."
                    )
            else:
                await self._append_log(
                    "No target sector specified; remaining in current sector."
                )
            self.mode = InteractionMode.TASK
            self._update_task_banner(
                "Task idle. Enter a goal and press Enter to run the TaskAgent."
            )
            await self._update_prompt("Task mode", "Describe the task you want to run")
            if self._scripted_tasks:
                asyncio.create_task(self._run_scripted_task_queue())
        except Exception as exc:  # noqa: BLE001
            await self._append_log(
                f"Initialization failed: {exc!r} ({type(exc).__name__})"
            )
            await self._graceful_shutdown()
            self.exit(1)

    def _update_display_name_from_payload(self, payload: Mapping[str, Any]) -> None:
        """Update the cached display name using a status-like payload."""
        candidate = _extract_player_display_name(payload)
        if isinstance(candidate, str) and candidate and candidate != self.display_name:
            self.display_name = candidate

    def _is_self_identifier(self, value: Any) -> bool:
        """Return True if the provided identifier refers to this character."""
        if value is None:
            return False
        candidate = str(value)
        if candidate == str(self.character_id):
            return True
        return candidate == str(self.display_name)

    def _start_stderr_capture(self) -> None:
        if self._stderr_interceptor is not None:
            return
        self._original_stderr = sys.stderr
        interceptor = _StderrInterceptor(self, sys.stderr)
        if self._loop is not None:
            interceptor.set_loop(self._loop)
        sys.stderr = interceptor  # type: ignore[assignment]
        self._stderr_interceptor = interceptor

    def _configure_logger(self) -> None:
        if self._loguru_sink_id is not None:
            return

        def sink(message) -> None:
            record = message.record
            text = record.get("message", "")
            level_obj = record.get("level")
            level_name = getattr(level_obj, "name", self._log_level)
            clean = ANSI_ESCAPE_RE.sub("", text).strip()
            if not clean:
                return
            loop = self._loop
            if loop and loop.is_running():
                loop.call_soon_threadsafe(
                    lambda: asyncio.create_task(
                        self._append_debug_line(
                            f"[log:{level_name.lower()}] {clean}",
                            level=level_name,
                            _external=True,
                        )
                    )
                )

        try:
            logger.remove()
        except ValueError:
            pass
        self._loguru_sink_id = logger.add(sink, enqueue=True, catch=False)

    def _register_event_handlers(self) -> None:
        if self.client is None:
            raise RuntimeError(
                "AsyncGameClient must be initialized before registering events"
            )

        special_handlers: Dict[str, Callable[[Dict[str, Any]], Awaitable[None]]] = {
            "status.update": self._on_status_update,
            "status.snapshot": self._on_status_snapshot,
            "movement.start": self._on_movement_start,
            "movement.complete": self._on_movement_complete,
            "sector.update": self._on_sector_update,
            "trade.executed": self._on_trade_executed,
            "port.update": self._on_port_update,
            "character.moved": self._on_character_moved,
            "garrison.deployed": self._on_garrison_event,
            "garrison.collected": self._on_garrison_event,
            "garrison.mode_changed": self._on_garrison_event,
            "garrison.combat_alert": self._on_garrison_combat_alert,
            "salvage.collected": self._on_salvage_collected,
            "bank.transaction": self._on_bank_transaction,
        }

        self._generic_event_suppressed = set(special_handlers.keys())

        for event_name in EVENT_NAMES:
            self.client.on(event_name)(self._handle_generic_event)

        for event_name, handler in special_handlers.items():
            self.client.on(event_name)(handler)

    async def _handle_generic_event(self, event: Dict[str, Any]) -> None:
        event_name = event.get("event_name", "unknown")
        if event_name in self._generic_event_suppressed:
            return

        summary = self._event_summary(event)
        if summary:
            message = f"[event] {event_name}: {summary}"
        else:
            payload = self._event_payload(event)
            try:
                payload_text = json.dumps(payload, sort_keys=True, ensure_ascii=False)
            except Exception:  # noqa: BLE001
                payload_text = str(payload)
            message = f"[event] {event_name}: {payload_text}"

        await self._append_log(message)

    async def _monitor_events(self) -> None:
        assert self.session is not None
        session = self.session

        await self._handle_occupants(session.other_players())

        occupant_task = asyncio.create_task(session.wait_for_occupant_change())
        combat_task = asyncio.create_task(session.next_combat_event())

        tasks: set[asyncio.Task] = {occupant_task, combat_task}

        try:
            while tasks:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in list(done):
                    tasks.discard(task)
                    if task is occupant_task:
                        try:
                            players = task.result()
                        except Exception as exc:  # noqa: BLE001
                            await self._append_log(
                                f"Failed to observe occupant change: {exc}"
                            )
                            players = {}
                        occupant_task = asyncio.create_task(
                            session.wait_for_occupant_change()
                        )
                        tasks.add(occupant_task)
                        await self._handle_occupants(players)
                    elif task is combat_task:
                        try:
                            event_name, state, payload = task.result()
                        except Exception as exc:  # noqa: BLE001
                            await self._append_log(f"Combat loop aborted: {exc}")
                            raise
                        combat_task = asyncio.create_task(session.next_combat_event())
                        tasks.add(combat_task)
                        await self._handle_combat_event(state, payload, event_name)
        except asyncio.CancelledError:
            for task in tasks:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
            raise

    async def _handle_occupants(self, players: Mapping[str, Dict[str, Any]]) -> None:
        session = self.session
        if session is None:
            return

        snapshot = session.sector_snapshot()
        self._update_sector_details(snapshot)

        if session.in_active_combat():
            return

        ship_snapshot = session.ship_status()
        if isinstance(ship_snapshot, Mapping):
            self._sync_status_bar_from_ship(ship_snapshot)

        garrisons: Sequence[Mapping[str, Any]] = []
        if isinstance(snapshot, Mapping):
            garrison = snapshot.get("garrison")
            if garrison and isinstance(garrison, Mapping):
                garrisons = [garrison]

        opponent_labels = self._build_opponent_labels(players, garrisons)
        labels_tuple = tuple(opponent_labels)
        previous_labels = self._last_opponent_labels
        opponents_changed = labels_tuple != previous_labels
        self._last_opponent_labels = labels_tuple

        if not opponent_labels:
            if opponents_changed and previous_labels:
                await self._append_log("Opponents departed; sector quiet.")
            if self.mode is InteractionMode.TASK and not self._is_task_running():
                self._update_task_banner(
                    "Task idle. Enter a goal and press Enter to run the TaskAgent."
                )
            if not self._is_task_running():
                await self._update_prompt(
                    "Task mode", "Describe the task you want to run"
                )
            return

        if opponents_changed:
            await self._append_log("Opponents detected: " + ", ".join(opponent_labels))
            await self._append_log("Press Ctrl+X to initiate combat.")

        if self.mode is InteractionMode.TASK and not self._is_task_running():
            self._update_task_banner(
                "Opponents present. Press Ctrl+X to initiate combat."
            )

    # ========================================================================
    # Event Handlers - All game state updates come through these handlers
    # ========================================================================

    @staticmethod
    def _event_payload(event: Mapping[str, Any]) -> Dict[str, Any]:
        payload = event.get("payload", {}) if isinstance(event, Mapping) else {}
        if isinstance(payload, dict):
            return payload
        if isinstance(payload, Mapping):
            return dict(payload)
        return {}

    @staticmethod
    def _event_summary(event: Mapping[str, Any]) -> Optional[str]:
        summary = event.get("summary") if isinstance(event, Mapping) else None
        if isinstance(summary, str):
            summary = summary.strip()
            if summary:
                return summary
        return None

    async def _on_status_update(self, event: Dict[str, Any]) -> None:
        """Handle status.update event."""
        payload = self._event_payload(event)
        self._update_display_name_from_payload(payload)
        # Update status bars
        self.status_updater.update_from_status_update(payload)
        self._refresh_status_display()

    async def _on_status_snapshot(self, event: Dict[str, Any]) -> None:
        payload = self._event_payload(event)
        self._update_display_name_from_payload(payload)
        self.status_updater.update_from_status(payload)
        self._refresh_status_display()
        self._last_status_payload = dict(payload)
        if self._status_snapshot_ready is not None:
            self._status_snapshot_ready.set()
        if self.session is not None:
            await self.session.update_from_status(payload)
            await self._handle_occupants(self.session.other_players())

    # --- Movement Events ---

    async def _on_movement_start(self, event: Dict[str, Any]) -> None:
        """Handle movement.start event."""
        payload = self._event_payload(event)
        summary = self._event_summary(event)
        sector_data = payload.get("sector", {})
        destination = sector_data.get("id", "?")
        eta = payload.get("hyperspace_time", 0)

        log_message = (
            summary or f"Entering hyperspace to sector {destination} (ETA: {eta:.1f}s)"
        )
        await self._append_log(log_message)

        # Update status bars
        self.status_updater.update_from_movement_start(payload)
        self._refresh_status_display()

    async def _on_movement_complete(self, event: Dict[str, Any]) -> None:
        """Handle movement.complete event."""
        payload = self._event_payload(event)
        summary = self._event_summary(event)
        sector_data = payload.get("sector", {})
        sector_id = sector_data.get("id", "?")

        await self._append_log(summary or f"Arrived at sector {sector_id}")

        # Update status bars
        self.status_updater.update_from_movement_complete(payload)
        self._refresh_status_display()

        # Update session with properly structured status payload
        # movement.complete has: {player, ship, sector}
        # update_from_status expects new format: {player: {...}, ship: {...}, sector: {...}}
        if self.session:
            status_for_session = {
                "player": payload.get("player", {}),
                "ship": payload.get("ship", {}),
                "sector": sector_data,
            }
            await self.session.update_from_status(status_for_session)

    # --- Trading and Economy Events ---

    async def _on_trade_executed(self, event: Dict[str, Any]) -> None:
        """Handle trade.executed event."""
        payload = self._event_payload(event)
        summary = self._event_summary(event)
        # Log the trade
        player_data = payload.get("player", {})
        ship_data = payload.get("ship", {})

        player_name = player_data.get("name", "?")
        credits = ship_data.get("credits")
        if credits is None:
            credits = player_data.get("credits_on_hand")

        # Try to extract trade details from ship cargo changes
        await self._append_log(
            summary or f"Trade executed by {player_name} (credits: {credits})"
        )

        # Update status bars
        self.status_updater.update_from_trade_executed(payload)
        self._refresh_status_display()

    async def _on_port_update(self, event: Dict[str, Any]) -> None:
        """Handle port.update event."""
        payload = self._event_payload(event)
        summary = self._event_summary(event)
        sector_ref = payload.get("sector")
        sector_id = _extract_sector_id(sector_ref)
        if sector_id is None:
            sector_id = "?"
        sector_payload = sector_ref if isinstance(sector_ref, dict) else {}
        port_data = sector_payload.get("port", {}) if isinstance(sector_payload, dict) else {}

        # Format port update message
        code = port_data.get("code", "?")
        await self._append_log(
            summary or f"Port prices updated at sector {sector_id} ({code})"
        )

        # Update status bars
        self.status_updater.update_from_port_update(payload)
        self._refresh_status_display()

    async def _on_sector_update(self, event: Dict[str, Any]) -> None:
        """Handle sector.update event."""
        payload = self._event_payload(event)
        summary = self._event_summary(event)

        self.status_updater.update_from_sector_update(payload)
        self._refresh_status_display()

        if summary:
            await self._append_log(summary)

    async def _on_garrison_event(self, event: Dict[str, Any]) -> None:
        """Handle garrison.* events."""
        payload = self._event_payload(event)
        event_name = event.get("event_name", "garrison")
        summary = self._event_summary(event)

        self.status_updater.update_from_garrison_event(event_name, payload)
        self._refresh_status_display()

        if summary:
            await self._append_log(summary)
        else:
            sector_id = _extract_sector_id(payload.get("sector")) or "?"
            await self._append_log(
                f"{event_name.replace('garrison.', 'garrison ')} in sector {sector_id}"
            )

    async def _on_garrison_combat_alert(self, event: Dict[str, Any]) -> None:
        """Handle garrison.combat_alert events emitted for corp awareness."""

        payload = self._event_payload(event)
        summary = self._event_summary(event)

        if summary:
            await self._append_log(summary)
            return

        sector_id = _extract_sector_id(payload.get("sector")) or "?"
        garrison = payload.get("garrison", {})
        owner_name = garrison.get("owner_name") or garrison.get("owner_id") or "Unknown"
        await self._append_log(
            f"Corp alert: garrison for {owner_name} is in combat at sector {sector_id}."
        )

    async def _on_salvage_collected(self, event: Dict[str, Any]) -> None:
        """Handle salvage.collected event."""
        payload = self._event_payload(event)
        summary = self._event_summary(event)

        self.status_updater.update_from_salvage_collected(payload)
        self._refresh_status_display()

        if summary:
            await self._append_log(summary)

    async def _on_bank_transaction(self, event: Dict[str, Any]) -> None:
        """Handle bank.transaction event for immediate HUD/log updates."""
        payload = self._event_payload(event)
        summary = self._event_summary(event)

        self.status_updater.update_from_bank_transaction(payload)
        self._refresh_status_display()

        if summary:
            await self._append_log(summary)
            return

        direction = payload.get("direction", "?")
        amount = payload.get("amount")
        on_hand = payload.get("ship_credits_after")
        if on_hand is None:
            on_hand = payload.get("credits_on_hand_after")
        bank_balance = payload.get("credits_in_bank_after")
        amount_text = f"{amount}" if amount is not None else "?"
        await self._append_log(
            f"Bank {direction}: {amount_text} credits → on-hand {on_hand}, bank {bank_balance}"
        )

    # --- Sector Occupant Events ---

    async def _on_character_moved(self, event: Dict[str, Any]) -> None:
        """Handle character.moved event."""
        payload = self._event_payload(event)
        summary = self._event_summary(event)
        movement = payload.get("movement")
        player = payload.get("player") or {}
        ship = payload.get("ship") or {}

        char_name = (
            player.get("name")
            or player.get("id")
            or payload.get("name")
            or "unknown pilot"
        )
        ship_name = ship.get("ship_name")
        ship_type = ship.get("ship_type") or payload.get("ship_type")

        if ship_name and ship_type:
            ship_desc = f"{ship_name} ({ship_type})"
        else:
            ship_desc = ship_name or ship_type or "unknown ship"

        # Log the movement
        if summary:
            await self._append_log(summary)
        elif movement == "arrive":
            await self._append_log(f"{char_name} in {ship_desc} arrived")
        elif movement == "depart":
            await self._append_log(f"{char_name} in {ship_desc} departed")

        # Update status bars
        self.status_updater.update_from_character_moved(payload)
        self._refresh_status_display()

    # --- Combat Events ---

    async def _handle_combat_event(
        self,
        state,
        payload: Dict[str, Any],
        event_name: str,
    ) -> None:
        if event_name != "combat.ended":
            await self._enter_combat_mode()

        if event_name == "combat.round_waiting":
            # Update StatusBarUpdater
            self.status_updater.update_from_combat_round_waiting(payload)
            self._refresh_status_display()

            # Keep legacy tracking for defeat detection
            self._update_combatant_stats(state)
            await self._announce_defeats()

            if not getattr(self, "_combat_started_announced", False):
                opponents = [
                    p.name
                    for pid, p in state.participants.items()
                    if pid != self.character_id
                ]
                await self._append_log(
                    f"Combat {state.combat_id} started vs: {', '.join(opponents) or '(none)'}"
                )
                self._combat_started_announced = True

            await self._cancel_round_prompt()
            task = asyncio.create_task(self._prompt_for_round_action(state, payload))
            self.round_prompt_task = task
            task.add_done_callback(self._on_round_prompt_complete)
            return

        if event_name == "combat.round_resolved":
            # Update StatusBarUpdater
            self.status_updater.update_from_combat_round_resolved(payload)
            self._refresh_status_display()

            await self._cancel_round_prompt()
            # Keep legacy tracking for defeat detection and action logging
            deltas = self._update_combatant_stats(state, capture_deltas=True)
            await self._announce_defeats()
            summary = summarize_round(payload)
            await self._append_log(f"Round {state.round} resolved: {summary}")
            await self._log_my_action(state, payload, deltas)
            await self._update_prompt("Waiting for next round", "")
            return

        if event_name == "combat.ended":
            # Update StatusBarUpdater
            self.status_updater.update_from_combat_ended(payload)
            self._refresh_status_display()

            await self._cancel_round_prompt()
            # Keep legacy tracking for defeat detection
            deltas = self._update_combatant_stats(state, capture_deltas=True)
            await self._announce_defeats()
            result = payload.get("result") or payload.get("end") or "no result"
            await self._append_log(f"Combat ended ({result})")
            salvage = payload.get("salvage") or []
            if salvage:
                await self._append_log(f"Salvage available: {salvage}")
            # Don't log action here - it was already logged in combat.round_resolved
            self._combatant_stats.clear()
            if self.session:
                await self._handle_occupants(self.session.other_players())
            await self._return_to_task_mode()
            # NOTE: No manual refresh needed - all updates come from events
            self._combat_started_announced = False
            return

    async def _cancel_round_prompt(self) -> None:
        if self.round_prompt_task is None:
            return
        task = self.round_prompt_task
        self.round_prompt_task = None
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    def _on_round_prompt_complete(self, task: asyncio.Task) -> None:
        if self.round_prompt_task is task:
            self.round_prompt_task = None
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            asyncio.create_task(
                self._append_log(f"Round input handler failed: {exc!r}")
            )

    def _update_combatant_stats(
        self,
        state,
        *,
        capture_deltas: bool = False,
    ) -> Dict[str, Tuple[int, int]]:
        previous_snapshot = self._last_participants
        new_snapshot: Dict[str, Dict[str, Any]] = {}
        defeated: List[Dict[str, Any]] = []

        current: Dict[str, Tuple[int, int]] = {}
        deltas: Dict[str, Tuple[int, int]] = {}
        for pid, participant in state.participants.items():
            stats = (participant.fighters, participant.shields)
            current[pid] = stats
            new_snapshot[pid] = {
                "fighters": participant.fighters,
                "shields": participant.shields,
                "type": getattr(participant, "type", None)
                or getattr(participant, "combatant_type", None),
                "name": participant.name,
                "owner": getattr(participant, "owner", None),
            }
            if capture_deltas:
                previous = self._combatant_stats.get(pid)
                if previous is None:
                    deltas[pid] = (0, 0)
                else:
                    deltas[pid] = (
                        stats[0] - previous[0],
                        stats[1] - previous[1],
                    )
        self._combatant_stats = current
        for pid, info in previous_snapshot.items():
            prev_fighters = (
                int(info.get("fighters", 0)) if isinstance(info, Mapping) else 0
            )
            prev_type = info.get("type") if isinstance(info, Mapping) else None
            prev_owner = info.get("owner") if isinstance(info, Mapping) else None
            prev_name = info.get("name") if isinstance(info, Mapping) else pid
            if prev_fighters <= 0:
                continue
            current_info = new_snapshot.get(pid)
            current_fighters = (
                int(current_info.get("fighters", 0))
                if isinstance(current_info, Mapping)
                else 0
            )
            if current_info is not None and current_fighters > 0:
                continue
            if prev_type == "character" and (
                pid == self.character_id or prev_owner == self.character_id
            ):
                continue
            if prev_type not in {"character", "garrison"}:
                continue
            defeated.append(
                {
                    "id": pid,
                    "type": prev_type,
                    "name": prev_name,
                    "owner": prev_owner,
                }
            )

        self._latest_defeated = defeated
        self._last_participants = new_snapshot
        return deltas if capture_deltas else {}

    def _player_stats_from_state(self, state) -> Tuple[int, int]:
        if state is None:
            return self._last_player_stats

        session = self.session
        candidate_ids = {str(self.character_id)}
        if self.display_name:
            candidate_ids.add(str(self.display_name))
        if session is not None:
            player_id = session.player_combatant_id()
            if player_id:
                candidate_ids.add(str(player_id))

        for pid, participant in state.participants.items():
            identifiers = {str(pid), str(participant.combatant_id)}
            if participant.owner:
                identifiers.add(str(participant.owner))
            if candidate_ids.intersection(identifiers):
                return participant.fighters, participant.shields

        return self._last_player_stats

    def _update_status_bar(
        self,
        *,
        in_combat: bool,
        fighters: Optional[int] = None,
        shields: Optional[int] = None,
        credits: Optional[int] = None,
        cargo: Optional[Mapping[str, Any]] = None,
        warp: Optional[Dict[str, int]] = None,
    ) -> None:
        # Legacy method - StatusBarUpdater handles display now
        # Keep for backward compatibility but only update internal tracking
        if fighters is None or shields is None:
            prev_fighters, prev_shields = self._last_player_stats
            fighters = prev_fighters if fighters is None else fighters
            shields = prev_shields if shields is None else shields

        if fighters is None:
            fighters = 0
        if shields is None:
            shields = 0

        self._last_player_stats = (fighters, shields)

        # Don't update display widget - StatusBarUpdater handles that now
        return
        mode = "combat" if in_combat else "quiet"
        self._last_status_mode = mode
        if credits is not None:
            try:
                self._last_ship_meta["credits"] = int(credits)
            except Exception:
                self._last_ship_meta["credits"] = credits
        if isinstance(cargo, Mapping):
            normalized: Dict[str, int] = {}
            for key in ("quantum_foam", "retro_organics", "neuro_symbolics"):
                value = cargo.get(key) if key in cargo else cargo.get(key.upper())
                try:
                    normalized[key] = int(value)
                except Exception:
                    normalized[key] = 0
            self._last_ship_meta["cargo"] = normalized
        if isinstance(warp, Mapping):
            try:
                current = int(warp.get("current", warp.get("warp_power")))
            except Exception:
                current = warp.get("current", warp.get("warp_power"))
            try:
                maximum = int(warp.get("capacity", warp.get("warp_power_capacity")))
            except Exception:
                maximum = warp.get("capacity", warp.get("warp_power_capacity"))
            self._last_ship_meta["warp"] = {"current": current, "capacity": maximum}

        credits_val = self._last_ship_meta.get("credits")
        cargo_map = self._last_ship_meta.get("cargo") or {}
        qf = cargo_map.get("quantum_foam", 0)
        ro = cargo_map.get("retro_organics", 0)
        ns = cargo_map.get("neuro_symbolics", 0)
        warp_meta = self._last_ship_meta.get("warp") or {}
        warp_now = warp_meta.get("current")
        warp_cap = warp_meta.get("capacity")

        sector = (
            self.session.sector
            if self.session and self.session.sector is not None
            else "?"
        )
        text = f"sector {sector} | {mode} | fighters: {fighters} shields: {shields}"
        if credits_val is not None:
            text += f" | credits: {credits_val}"
        text += f" | cargo QF:{qf} RO:{ro} NS:{ns}"
        if warp_now is not None and warp_cap is not None:
            text += f" | warp {warp_now}/{warp_cap}"
        if self.status_display is not None:
            self.status_display.update(text)

    def _update_task_banner(self, text: str) -> None:
        if self.task_banner is None:
            return
        self.task_banner.update(text)

    def _refresh_status_display(self) -> None:
        """Update the status-bars widget from status_updater state."""
        if self.status_display is None:
            return
        lines = self.status_updater.format_status_bars()
        text = "\n".join(lines)
        self.status_display.update(text)

    def _set_task_input_enabled(self, enabled: bool) -> None:
        if getattr(self, "input", None) is None:
            return
        self.input.disabled = not enabled
        if enabled:
            self.set_focus(self.input)

    def _update_sector_details(self, snapshot: Optional[Mapping[str, Any]]) -> None:
        players_map: Mapping[str, Dict[str, Any]] = {}
        if self.session is not None:
            players_map = self.session.other_players()

        other_players_list = []
        garrisons_list: Sequence[Mapping[str, Any]] = []
        port_info: Optional[Mapping[str, Any]] = None

        if self.session is not None:
            garrisons_list = self.session.sector_garrisons()

        if isinstance(snapshot, Mapping):
            other_players_list = snapshot.get("other_players") or []
            if not garrisons_list:
                garrison = snapshot.get("garrison")
                garrisons_list = [garrison] if garrison else []
            port_info = snapshot.get("port")

        self._update_occupant_display(players_map, other_players_list, garrisons_list)
        self._update_port_display(port_info)

    def _update_occupant_display(
        self,
        players_map: Mapping[str, Dict[str, Any]],
        other_players_list: Sequence[Mapping[str, Any]],
        garrisons: Sequence[Mapping[str, Any]],
    ) -> None:
        # Legacy method - StatusBarUpdater handles display now
        return
        if self.occupant_display is None:
            return

        players: set[str] = set()
        for pid, info in players_map.items():
            name = info.get("name") if isinstance(info, Mapping) else None
            players.add(str(name or pid))

        for entry in other_players_list:
            if not isinstance(entry, Mapping):
                continue
            name = entry.get("name")
            if name and not self._is_self_identifier(name):
                players.add(str(name))

        player_text = ", ".join(sorted(players)) if players else "none"

        garrison_segments: List[str] = []
        for garrison in garrisons:
            if not isinstance(garrison, Mapping):
                continue
            owner_name = garrison.get("owner_name") or garrison.get("owner_id")
            fighters = garrison.get("fighters")
            max_fighters = garrison.get("max_fighters")
            mode = garrison.get("mode")
            friendly = garrison.get("is_friendly")
            if fighters is None:
                continue
            owner_label = (
                "you"
                if self._is_self_identifier(owner_name)
                else str(owner_name or "?")
            )
            tag = f"{owner_label}:{fighters}"
            if isinstance(max_fighters, (int, float)) and max_fighters:
                tag += f"/{int(max_fighters)}"
            if mode:
                tag += f"({mode})"
            if friendly:
                tag += "*"
            garrison_segments.append(tag)

        garrison_text = (
            ", ".join(sorted(garrison_segments)) if garrison_segments else "none"
        )

        self.occupant_display.update(
            f"Occupants | Players: {player_text} | Garrisons: {garrison_text}"
        )

    def _update_port_display(self, port: Optional[Mapping[str, Any]]) -> None:
        # Legacy method - StatusBarUpdater handles display now
        return
        if self.port_display is None:
            return
        if not isinstance(port, Mapping):
            self.port_display.update("Port | none")
            return
        code = port.get("code") or "???"
        prices = port.get("last_seen_prices")
        stocks = port.get("last_seen_stock")
        segments: List[str] = []
        for commodity, short in (
            ("quantum_foam", "QF"),
            ("retro_organics", "RO"),
            ("neuro_symbolics", "NS"),
        ):
            price_val = None
            stock_val = None
            if isinstance(prices, Mapping) and commodity in prices:
                price_val = prices.get(commodity)
            if isinstance(stocks, Mapping) and commodity in stocks:
                stock_val = stocks.get(commodity)
            price_str = str(price_val) if price_val is not None else "?"
            stock_str = str(stock_val) if stock_val is not None else "?"
            segments.append(f"{short}:{stock_str}@{price_str}")

        prices_text = ", ".join(segments)
        self.port_display.update(f"Port | {code} | {prices_text}")

    def _is_task_running(self) -> bool:
        return self.task_runner is not None and not self.task_runner.done()

    def _handle_task_output(self, text: str, message_type: Optional[str]) -> None:
        label = (message_type or "MESSAGE").upper()
        display = f"[{label}] {text}"
        level: Optional[str] = None
        if message_type == TaskOutputType.ERROR.value:
            level = "ERROR"
        elif message_type == TaskOutputType.FINISHED.value:
            level = "SUCCESS"

        asyncio.create_task(self._append_event_line(display, level=level))
        if message_type == TaskOutputType.ERROR.value:
            asyncio.create_task(self._append_debug_line(display, level="ERROR"))

    async def _handle_command(self, raw: str) -> None:
        text = raw.lstrip("/").strip()
        if not text:
            await self._append_log("Empty command; nothing to do.")
            return

        parts = text.split()
        command = parts[0].lower()
        args = parts[1:]

        if command in {"ships", "fleet"}:
            await self._show_corp_ship_dashboard()
        elif command in {"shipcopy", "copyship"}:
            if not args:
                await self._append_log("Usage: /shipcopy <ship_id>")
                return
            await self._copy_ship_id(args[0])
        elif command == "help":
            await self._append_log("Commands: /ships, /shipcopy <ship_id>")
        else:
            await self._append_log(f"Unknown command '{command}'. Try /help.")

    @staticmethod
    def _format_ship_cargo(summary: Mapping[str, Any]) -> str:
        cargo = summary.get("cargo") or {}
        capacity = _coerce_int(summary.get("cargo_capacity"))
        used = 0
        parts: List[str] = []
        for key, label in COMMODITY_KEYS:
            amount = _coerce_int(cargo.get(key))
            used += max(amount, 0)
            parts.append(f"{label}:{amount}")
        if capacity > 0:
            empty = max(capacity - used, 0)
            prefix = f"{used}/{capacity} holds (empty {empty})"
        else:
            prefix = f"{used} holds"
        return f"{prefix} | {' '.join(parts)}"

    @staticmethod
    def _format_ship_combat(summary: Mapping[str, Any]) -> str:
        fighters = _coerce_int(summary.get("fighters"))
        max_fighters = _coerce_int(summary.get("max_fighters"))
        shields = _coerce_int(summary.get("shields"))
        max_shields = _coerce_int(summary.get("max_shields"))
        warp = _coerce_int(summary.get("warp_power"))
        warp_max = _coerce_int(summary.get("warp_power_capacity"))

        parts: List[str] = []
        if max_fighters:
            parts.append(f"fighters {fighters}/{max_fighters}")
        elif fighters:
            parts.append(f"fighters {fighters}")

        if max_shields:
            parts.append(f"shields {shields}/{max_shields}")
        elif shields:
            parts.append(f"shields {shields}")

        if warp_max:
            parts.append(f"warp {warp}/{warp_max}")
        elif warp:
            parts.append(f"warp {warp}")

        return " | ".join(parts) if parts else "no combat stats reported"

    async def _copy_ship_id(self, ship_id: str) -> None:
        normalized = ship_id.strip()
        if not normalized:
            await self._append_log("Provide a ship ID to copy.")
            return
        success, error = copy_to_system_clipboard(normalized)
        if success:
            await self._append_log(f"Copied {normalized} to clipboard.")
        else:
            await self._append_log(f"Copy failed: {error}")

    async def _show_corp_ship_dashboard(self) -> None:
        if self.client is None:
            await self._append_log("Client not ready yet; try again after join completes.")
            return

        request_character_id = self._corp_request_character_id()
        try:
            response = await self.client._request(
                "my_corporation",
                {"character_id": request_character_id},
            )
        except RPCError as exc:
            await self._append_log(f"Failed to load corporation data: {exc.detail}")
            return

        corp = response.get("corporation")
        if not corp:
            await self._append_log(
                f"No corporation membership found for {request_character_id}."
            )
            return

        ships = corp.get("ships") or []
        ready_count = sum(1 for ship in ships if ship.get("control_ready"))
        await self._append_log(
            f"Corporation ships ({len(ships)} total, {ready_count} control-ready):"
        )
        if not ships:
            return

        ships_sorted = sorted(
            ships,
            key=lambda item: (
                str(item.get("name") or "").lower(),
                str(item.get("ship_id") or ""),
            ),
        )

        for ship in ships_sorted:
            name = ship.get("name") or "Unnamed Vessel"
            ship_type = ship.get("ship_type") or "unknown"
            ship_id = ship.get("ship_id") or "unknown-id"
            sector = ship.get("sector")
            sector_display = f"sector {sector}" if sector is not None else "sector ?"
            await self._append_log(f"- {name} [{ship_type}] {sector_display}")
            await self._append_log(f"  Character ID: {ship_id}")
            await self._append_log(f"  Cargo: {self._format_ship_cargo(ship)}")
            await self._append_log(f"  Combat: {self._format_ship_combat(ship)}")
            control_ready = ship.get("control_ready")
            if control_ready is True:
                await self._append_log("  Control: READY (knowledge present)")
            elif control_ready is False:
                knowledge_path = KNOWLEDGE_DIR / f"{ship_id}.json"
                await self._append_log(
                    f"  Control: BLOCKED (missing knowledge file at {knowledge_path})"
                )
            else:
                await self._append_log("  Control: UNKNOWN")
            await self._append_log(f"  Quick copy: /shipcopy {ship_id}")

    async def _start_task(self, prompt: str) -> Optional[asyncio.Task]:
        prompt = prompt.strip()
        if not prompt:
            await self._append_log("Task input was empty; nothing to run.")
            return None
        if self.task_agent is None:
            await self._append_log("TaskAgent is not initialized yet.")
            return None
        if self._is_task_running():
            await self._append_log(
                "A task is already running. Cancel it before starting another."
            )
            return None
        if self.mode is InteractionMode.COMBAT:
            await self._append_log(
                "Combat in progress. Finish the fight before starting a new task."
            )
            return None

        self._task_last_prompt = prompt
        self._update_task_banner(f"Task running: {prompt}")
        self._set_task_input_enabled(False)
        self.mode = InteractionMode.TASK
        await self._append_log(f"Starting task: {prompt}")
        runner = asyncio.create_task(self._run_task(prompt))
        self.task_runner = runner
        runner.add_done_callback(self._on_task_complete)
        return runner

    async def _run_scripted_task_queue(self) -> None:
        if not self._scripted_tasks:
            return
        # Give the UI a moment to finish mounting widgets
        await asyncio.sleep(0)

        while self._scripted_tasks:
            if self._is_task_running():
                current = self.task_runner
                if current is not None:
                    try:
                        await current
                    except asyncio.CancelledError:
                        return
                continue

            prompt = self._scripted_tasks.pop(0)
            runner = await self._start_task(prompt)
            if runner is None:
                continue
            try:
                await runner
            except asyncio.CancelledError:
                return

    async def _run_task(self, prompt: str) -> None:
        if self.client is None or self.task_agent is None:
            await self._append_log("Client or TaskAgent unavailable; aborting task.")
            return

        # NOTE: TaskAgent internally calls my_status() - it needs the RPC response
        # to build its initial state. This is acceptable because the agent
        # needs a snapshot to start working. All updates during task execution
        # will come from events.
        paused_events = False
        try:
            await self.client.pause_event_delivery()
            paused_events = True
        except Exception as exc:  # noqa: BLE001
            await self._append_log(
                f"Failed to pause event delivery before task: {exc!r}",
                level="WARNING",
            )

        try:
            await self.client.my_status(self.character_id)
        except Exception as exc:  # noqa: BLE001
            await self._append_log(
                f"Failed to retrieve status before running task: {exc!r}"
            )
            if paused_events:
                with suppress(Exception):
                    await self.client.resume_event_delivery()
            return

        success = False
        try:
            success = await self.task_agent.run_task(
                task=prompt,
                max_iterations=self.task_max_iterations,
            )
        except asyncio.CancelledError:
            await self._append_log("Task coroutine cancelled.")
            raise
        except Exception as exc:  # noqa: BLE001
            await self._append_log(f"Task execution failed: {exc!r}")
        finally:
            if paused_events:
                with suppress(Exception):
                    await self.client.resume_event_delivery()
            await self._append_log(
                "Task completed successfully."
                if success and not self.task_agent.cancelled
                else "Task finished without success."
            )

    def _on_task_complete(self, task: asyncio.Task) -> None:
        if task is not self.task_runner:
            return
        try:
            task.result()
        except asyncio.CancelledError:
            asyncio.create_task(self._append_log("Task cancelled."))
        except Exception as exc:  # noqa: BLE001
            asyncio.create_task(self._append_log(f"Task ended with error: {exc!r}"))
        finally:
            self.task_runner = None
            if self.mode is InteractionMode.TASK:
                self._set_task_input_enabled(True)
                banner = (
                    "Task cancelled. Enter a goal and press Enter to start again."
                    if self.task_agent and self.task_agent.cancelled
                    else "Task idle. Enter a goal and press Enter to run the TaskAgent."
                )
                self._update_task_banner(banner)
        # NOTE: No manual refresh needed - all updates come from events

    async def _cancel_active_task(self, reason: str) -> bool:
        if not self._is_task_running():
            return False
        await self._append_log(f"Cancelling task: {reason}")
        if self.task_agent is not None:
            self.task_agent.cancel()
        task = self.task_runner
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self.task_runner = None
        self._update_task_banner(
            "Task cancelled. Enter a goal and press Enter to run the TaskAgent."
        )
        if self.mode is InteractionMode.TASK:
            self._set_task_input_enabled(True)
        return True

    async def _enter_combat_mode(self) -> None:
        if self.mode is InteractionMode.COMBAT:
            return
        await self._cancel_active_task("combat started")
        self.mode = InteractionMode.COMBAT
        self._update_task_banner(
            "Combat detected. Submit attack/brace/flee actions to continue."
        )
        self._set_task_input_enabled(True)

    async def _return_to_task_mode(self) -> None:
        self.mode = InteractionMode.TASK
        if self._is_task_running():
            self._update_task_banner(
                f"Task running: {self._task_last_prompt}"
                if self._task_last_prompt
                else "Task running."
            )
            self._set_task_input_enabled(False)
        else:
            self._update_task_banner(
                "Task idle. Enter a goal and press Enter to run the TaskAgent."
            )
            self._set_task_input_enabled(True)
            await self._update_prompt("Task mode", "Describe the task you want to run")

    def _sync_status_bar_from_status(self, status: Mapping[str, Any]) -> None:
        # Update StatusBarUpdater - this now handles all status display
        self._update_display_name_from_payload(status)
        self.status_updater.update_from_status(dict(status))
        self._refresh_status_display()

    def _sync_status_bar_from_ship(self, ship: Mapping[str, Any]) -> None:
        fighters = int(ship.get("fighters", 0))
        shields = int(ship.get("shields", 0))
        in_combat = False
        if self.session is not None:
            in_combat = self.session.in_active_combat()
        warp_meta = {
            "current": ship.get("warp_power"),
            "capacity": ship.get("warp_power_capacity"),
        }
        self._update_status_bar(
            in_combat=in_combat,
            fighters=fighters,
            shields=shields,
            credits=ship.get("credits"),
            cargo=ship.get("cargo") if isinstance(ship.get("cargo"), Mapping) else None,
            warp=warp_meta,
        )

    # REMOVED: _refresh_status() - We now rely entirely on events for status updates
    # All status changes are broadcast via status.update, movement.complete, trade.executed, etc.

    async def _prompt_for_round_action(self, state, payload: Dict[str, Any]) -> None:
        session = self.session
        if session is None:
            return

        actions = session.available_actions() or ["brace"]
        if "pay" in actions:
            await self._append_log(
                "Toll fighters demand payment. Choose 'pay' to satisfy the toll in full."
            )
        prompt = f"Action [{'/'.join(actions)}]"
        action = await self._prompt_choice(
            prompt, options=tuple(actions), default="brace"
        )

        commit = 0
        target_id: Optional[str] = None
        to_sector: Optional[int] = None

        if action == "attack":
            participant = state.participants.get(
                session.player_combatant_id() or self.character_id
            )
            fighters = participant.fighters if participant else 0
            if fighters <= 0:
                await self._append_log("No fighters available; defaulting to brace.")
                action = "brace"
            else:
                commit_input = await self._prompt_number(
                    f"Commit fighters [1-{fighters}] (default {fighters})",
                    default=fighters,
                    minimum=1,
                    maximum=fighters,
                )
                commit = commit_input

                potential = self._collect_attack_targets(
                    state,
                    exclude=session.player_combatant_id() or self.character_id,
                )
                if not potential:
                    await self._append_log(
                        "No valid attack targets; defaulting to brace."
                    )
                    action = "brace"
                    commit = 0
                else:
                    display = [
                        f"{idx}) {name} (fighters={fighters} shields={shields})"
                        for idx, (_, name, fighters, shields) in enumerate(
                            potential, start=1
                        )
                    ]
                    await self._append_log(
                        "Select attack target:\n" + "\n".join(display)
                    )
                    choice = await self._prompt_number(
                        f"Target [1-{len(potential)}] (default 1)",
                        default=1,
                        minimum=1,
                        maximum=len(potential),
                    )
                    target_id = potential[choice - 1][0]

        if action == "flee":
            snapshot = session.sector_snapshot()
            adjacent = sorted(
                {
                    int(value)
                    for value in snapshot.get("adjacent_sectors", [])
                    if isinstance(value, (int, str)) and str(value).isdigit()
                }
            )
            if not adjacent:
                await self._append_log(
                    "No known adjacent sectors; defaulting to brace."
                )
                action = "brace"
            else:
                if len(adjacent) == 1:
                    to_sector = adjacent[0]
                    await self._append_log(
                        f"Only one flee destination available; using {to_sector}."
                    )
                else:
                    await self._append_log(
                        "Legal flee destinations: " + ", ".join(map(str, adjacent))
                    )
                    destination = await self._prompt_number(
                        "Destination sector to flee to",
                        allowed=adjacent,
                    )
                    to_sector = destination

        try:
            # NOTE: combat_action returns immediate feedback (pay_processed, etc.)
            # This is acceptable - we use it for instant confirmation, not state updates
            # State updates come from combat.round_resolved events
            result = await self.client.combat_action(
                character_id=self.character_id,
                combat_id=state.combat_id,
                action=action,
                commit=commit,
                target_id=target_id,
                to_sector=to_sector,
                round_number=state.round,
            )
            await self._append_log(
                f"Submitted {action}"
                + (
                    f" (commit={commit})"
                    if action == "attack" and commit
                    else f" (to_sector={to_sector})"
                    if action == "flee" and to_sector is not None
                    else ""
                )
            )
            await self._update_prompt("Waiting for round resolution", "")
            await self._handle_action_outcome(result)
        except RPCError as exc:
            if (
                exc.status_code == 403
                and "not part of this combat" in exc.detail.lower()
            ):
                await self._append_log(
                    "Server reports you’re no longer part of this combat; returning to task mode."
                )
                await self._return_to_task_mode()
            else:
                await self._append_log(f"combat.action failed: {exc}")

    async def _log_my_action(
        self,
        state,
        payload: Dict[str, Any],
        deltas: Optional[Mapping[str, Tuple[int, int]]],
    ) -> None:
        actions = payload.get("actions")
        if not isinstance(actions, Mapping):
            return
        player_id = self.session.player_combatant_id() if self.session else None
        my_action = None
        if player_id and player_id in actions:
            my_action = actions.get(player_id)
        elif self.character_id in actions:
            my_action = actions.get(self.character_id)
        if isinstance(my_action, Mapping):
            action_type = str(my_action.get("action"))
            pieces = [action_type]
            if my_action.get("commit"):
                pieces.append(f"commit={my_action['commit']}")
            if my_action.get("target"):
                pieces.append(f"target={my_action['target']}")
            if my_action.get("destination_sector") is not None:
                pieces.append(f"to_sector={my_action['destination_sector']}")

            # Add explicit flee result if this was a flee action
            if action_type == "flee" and payload:
                flee_results = payload.get("flee_results")
                if isinstance(flee_results, Mapping):
                    my_id = player_id or self.character_id
                    if my_id in flee_results:
                        if flee_results[my_id]:
                            pieces.append("✓ FLEE SUCCEEDED")
                        else:
                            pieces.append("✗ FLEE FAILED - still in combat")

            deltas = deltas or {}

            def resolve_delta(identifier: str) -> Tuple[int, int]:
                if identifier in deltas:
                    return deltas[identifier]
                participant = state.participants.get(identifier)
                if participant:
                    for pid, info in state.participants.items():
                        if info.combatant_id == identifier or info.name == identifier:
                            return deltas.get(pid, (0, 0))
                for pid, info in state.participants.items():
                    if info.combatant_id == identifier:
                        return deltas.get(pid, (0, 0))
                return (0, 0)

            def format_delta(label: str, change: Tuple[int, int]) -> str:
                fighters_delta, shields_delta = change
                return (
                    f"{label} Δfighters={fighters_delta:+d} Δshields={shields_delta:+d}"
                )

            if player_id:
                player_delta = resolve_delta(player_id)
            else:
                player_delta = resolve_delta(self.character_id)
            pieces.append(format_delta("you", player_delta))

            target_identifier = my_action.get("target")
            if target_identifier:
                target_id = str(target_identifier)
                target_delta = resolve_delta(target_id)
                pieces.append(format_delta(f"target {target_id}", target_delta))

            await self._append_log("Your action recap: " + ", ".join(pieces))

    async def _prompt_choice(
        self,
        label: str,
        *,
        options: Sequence[str],
        default: Optional[str] = None,
    ) -> str:
        prompt = PromptRequest(
            label=label, placeholder="/".join(options), options=options
        )
        response = await self._request_input(prompt)
        value = response.strip().lower()
        if not value and default:
            value = default
        if value not in options:
            return default or options[0]
        return value

    async def _prompt_number(
        self,
        label: str,
        *,
        default: Optional[int] = None,
        minimum: Optional[int] = None,
        maximum: Optional[int] = None,
        allowed: Optional[Iterable[int]] = None,
    ) -> int:
        placeholder = str(default) if default is not None else ""
        prompt = PromptRequest(label=label, placeholder=placeholder)
        allowed_set = set(allowed) if allowed is not None else None
        while True:
            response = await self._request_input(prompt)
            text = response.strip()
            if not text and default is not None:
                return default
            if not text.isdigit():
                await self._append_log("Please enter a number.")
                continue
            value = int(text)
            if minimum is not None and value < minimum:
                await self._append_log(f"Value must be >= {minimum}.")
                continue
            if maximum is not None and value > maximum:
                await self._append_log(f"Value must be <= {maximum}.")
                continue
            if allowed_set is not None and value not in allowed_set:
                await self._append_log(
                    "Value must be one of: " + ", ".join(map(str, sorted(allowed_set)))
                )
                continue
            return value

    async def _request_input(self, prompt: PromptRequest) -> str:
        if self.pending_input is not None and not self.pending_input.done():
            await self._append_log("Input already pending; ignoring new request.")
            return ""

        self._set_task_input_enabled(True)
        await self._update_prompt(prompt.label, prompt.placeholder)
        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self.pending_input = future
        try:
            return await future
        finally:
            if self.pending_input is future:
                self.pending_input = None

    async def _append_panel_line(
        self,
        panel: str,
        message: str,
        *,
        level: Optional[str] = None,
        _external: bool = False,
    ) -> None:
        _ = level  # level retained for future styling; no-op assignment to avoid lint

        state = self._log_state[panel]
        line_id = state["counter"]
        state["counter"] += 1
        state["lines"][line_id] = message

        view = self._log_views.get(panel)
        if view is None:
            return

        formatted = format_log_line(message, expanded=False)
        item = ListItem(
            Static(Text(formatted), expand=False), id=f"{panel}-log-{line_id}"
        )
        item.add_class("collapsed")
        item.data_line_id = line_id  # type: ignore[attr-defined]

        view.append_item(item)
        self._mirror_to_file(f"[{panel}] {message}")

    def _mirror_to_file(self, message: str) -> None:
        if self.log_path is None:
            return
        if self._log_file is None:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            self._log_file = self.log_path.open("a", encoding="utf-8")
        timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self._log_file.write(f"{timestamp} {message}\n")
        self._log_file.flush()

    async def _append_event_line(
        self,
        message: str,
        *,
        level: Optional[str] = None,
        _external: bool = False,
    ) -> None:
        await self._append_panel_line(
            "events",
            message,
            level=level,
            _external=_external,
        )

    async def _append_debug_line(
        self,
        message: str,
        *,
        level: Optional[str] = None,
        _external: bool = False,
    ) -> None:
        await self._append_panel_line(
            "debug",
            message,
            level=level,
            _external=_external,
        )

    async def _append_log(
        self,
        message: str,
        *,
        level: Optional[str] = None,
        _external: bool = False,
    ) -> None:
        await self._append_event_line(
            message,
            level=level,
            _external=_external,
        )

    async def _update_prompt(self, label: str, placeholder: str) -> None:
        def _apply() -> None:
            self.prompt_label.update(label)
            self.input.placeholder = placeholder
            self.input.value = ""
            self.set_focus(self.input)

        _apply()

    async def _graceful_shutdown(self) -> None:
        self._restore_stderr()
        self._restore_logger()
        await self._cancel_active_task("application shutting down")
        if self.monitor_task:
            self.monitor_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.monitor_task
            self.monitor_task = None
        await self._cancel_round_prompt()
        if self.session:
            await self.session.close()
            self.session = None
        if self.client:
            await self.client.close()
            self.client = None
        if self._log_file:
            self._log_file.close()
            self._log_file = None
        if self._session_lock_release:
            self._session_lock_release()
            self._session_lock_release = None

    def _restore_stderr(self) -> None:
        if self._stderr_interceptor is None:
            return
        self._stderr_interceptor.flush()
        if self._original_stderr is not None:
            sys.stderr = self._original_stderr  # type: ignore[assignment]
        self._stderr_interceptor = None
        self._original_stderr = None

    def _restore_logger(self) -> None:
        if self._loguru_sink_id is None:
            return
        try:
            logger.remove(self._loguru_sink_id)
        except Exception:
            pass
        self._loguru_sink_id = None
        target = (
            self._original_stderr if self._original_stderr is not None else sys.stderr
        )
        logger.add(target, colorize=True)

    def on_input_submitted(self, event: Input.Submitted) -> None:
        value = event.value
        event.input.value = ""
        if self.pending_input and not self.pending_input.done():
            self.pending_input.set_result(value)
        else:
            stripped = value.strip()
            if self.mode is InteractionMode.TASK and stripped.startswith("/"):
                asyncio.create_task(self._handle_command(stripped))
            elif self.mode is InteractionMode.TASK:
                asyncio.create_task(self._start_task(value))
            else:
                asyncio.create_task(self._append_log(f"(ignored input) {value}"))

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        """Handle clicking on a log line to toggle expansion."""
        panel = self._panel_for_view(event.list_view)
        if panel is None:
            return

        item = event.item
        line_id = getattr(item, "data_line_id", None)
        if line_id is None:
            return

        state = self._log_state[panel]
        original_text = state["lines"].get(line_id)
        if original_text is None:
            return

        expanded: Set[int] = state["expanded"]
        is_expanded = line_id in expanded
        new_state = not is_expanded

        if new_state:
            expanded.add(line_id)
        else:
            expanded.discard(line_id)

        formatted = format_log_line(original_text, expanded=new_state)
        static_widget = item.query_one(Static)
        static_widget.update(Text(formatted))

        if new_state:
            item.remove_class("collapsed")
            item.add_class("expanded")
        else:
            item.remove_class("expanded")
            item.add_class("collapsed")

    async def _handle_action_outcome(self, response: Mapping[str, Any]) -> None:
        if not isinstance(response, Mapping):
            return
        session = self.session
        if session is None:
            return

        pay_processed = response.get("pay_processed")
        if isinstance(pay_processed, bool):
            if pay_processed:
                targets = session.toll_targets()
                session.mark_toll_paid(targets)
                await self._append_log(
                    "Toll paid successfully. Fighters should stand down once the round resolves."
                )
            else:
                message = response.get("message")
                await self._append_log(
                    message or "Toll payment failed; your turn counts as a brace."
                )

        outcome = response.get("outcome")
        if not isinstance(outcome, Mapping):
            return

        ended = bool(response.get("ended")) or bool(
            outcome.get("end") or outcome.get("result")
        )

        try:
            await session.apply_outcome_payload(dict(outcome), ended=ended)
        except Exception as exc:  # noqa: BLE001
            await self._append_log(f"Failed to process action outcome: {exc}")
        else:
            snapshot = session.sector_snapshot()
            self._update_sector_details(snapshot)

    async def on_key(self, event: events.Key) -> None:
        if (
            event.key == "escape"
            and self.pending_input
            and not self.pending_input.done()
        ):
            self.pending_input.set_result("")
            return
        if event.key == "escape" and self._is_task_running():
            await self._cancel_active_task("user pressed Escape")

    async def action_quit(self) -> None:
        await self._graceful_shutdown()
        self.exit()

    async def action_cancel_task(self) -> None:
        await self._cancel_active_task("user requested cancellation")

    def action_toggle_log_panel(self) -> None:
        new_panel = "debug" if self._active_log_panel == "events" else "events"
        self._set_active_log_panel(new_panel)

    def _set_active_log_panel(self, panel: str) -> None:
        if panel not in self._log_views:
            return
        self._active_log_panel = panel
        if self.events_log is not None:
            self.events_log.display = panel == "events"
            self.events_log.styles.display = "block" if panel == "events" else "none"
            if panel == "events":
                self.events_log.focus()
        if self.debug_log is not None:
            self.debug_log.display = panel == "debug"
            self.debug_log.styles.display = "block" if panel == "debug" else "none"
            if panel == "debug":
                self.debug_log.focus()
        if self.log_panel_label is not None:
            self.log_panel_label.update(f"Log panel: {panel.title()} (Ctrl+T)")

    def _panel_for_view(self, view: ListView) -> Optional[str]:
        for name, candidate in self._log_views.items():
            if candidate is view:
                return name
        return None

    async def action_copy_log_line(self) -> None:
        """Copy the currently highlighted log line to clipboard."""
        panel = self._active_log_panel
        view = self._log_views.get(panel)
        if view is None:
            return

        await self._append_debug_line("[DEBUG] action_copy_log_line called")
        await self._append_debug_line(f"[DEBUG] {panel}.index = {view.index}")

        if view.index is None:
            await self._append_debug_line("[DEBUG] No index - line not selected")
            self.notify("No log line selected", severity="warning", timeout=2)
            return

        try:
            items = list(view.children)
            await self._append_debug_line(
                f"[DEBUG] Found {len(items)} items in ListView"
            )

            if not items or view.index >= len(items):
                await self._append_debug_line("[DEBUG] Index out of range")
                self.notify("No log line selected", severity="warning", timeout=2)
                return

            item = items[view.index]
            if not isinstance(item, ListItem):
                await self._append_debug_line(
                    f"[DEBUG] Item is not ListItem: {type(item)}"
                )
                return

            line_id = getattr(item, "data_line_id", None)
            await self._append_debug_line(f"[DEBUG] line_id = {line_id}")

            if line_id is None:
                await self._append_debug_line("[DEBUG] line_id is None")
                return

            state = self._log_state[panel]
            original_text = state["lines"].get(line_id)
            if original_text is None:
                await self._append_debug_line(
                    "[DEBUG] original_text not found in log state"
                )
                return

            await self._append_debug_line(
                f"[DEBUG] Copying text (length={len(original_text)})"
            )

            json_content = extract_json_only(original_text)
            if json_content:
                await self._append_debug_line("[DEBUG] Copying JSON content")
                success, error = copy_to_system_clipboard(json_content)
                if success:
                    self.notify("JSON copied to clipboard", timeout=2)
                else:
                    await self._append_debug_line(
                        f"[DEBUG] Clipboard copy failed: {error}"
                    )
                    self.notify(f"Copy failed: {error}", severity="error", timeout=3)
            else:
                await self._append_debug_line("[DEBUG] Copying full text (no JSON)")
                success, error = copy_to_system_clipboard(original_text)
                if success:
                    self.notify("Log line copied to clipboard", timeout=2)
                else:
                    await self._append_debug_line(
                        f"[DEBUG] Clipboard copy failed: {error}"
                    )
                    self.notify(f"Copy failed: {error}", severity="error", timeout=3)

        except Exception as exc:  # noqa: BLE001
            await self._append_debug_line(f"[DEBUG] Exception: {exc!r}")
            self.notify(f"Copy failed: {exc}", severity="error", timeout=3)

    async def action_start_combat(self) -> None:
        if self.client is None or self.session is None:
            await self._append_log("Client not ready; cannot start combat.")
            return
        if self.session.in_active_combat():
            await self._append_log("Already in combat.")
            return

        if not self._sector_has_hostiles():
            await self._append_log("No hostile opponents detected in this sector.")
            return

        try:
            await self.client.combat_initiate(character_id=self.character_id)
            await self._append_log("Combat initiation requested.")
            if self.mode is InteractionMode.TASK and not self._is_task_running():
                self._update_task_banner(
                    "Combat requested. Awaiting combat start events…"
                )
        except RPCError as exc:
            await self._append_log(f"combat.initiate failed: {exc}")

    async def on_shutdown(self) -> None:
        await self._graceful_shutdown()

    def _collect_attack_targets(
        self, state, *, exclude: str
    ) -> List[Tuple[str, str, int, int]]:
        results: List[Tuple[str, str, int, int]] = []
        for pid, participant in state.participants.items():
            combatant_id = participant.combatant_id or pid
            if combatant_id == exclude:
                continue
            # Only exclude escape pods from attack targets
            if participant.type == "escape_pod":
                continue
            results.append(
                (
                    combatant_id,
                    participant.name or combatant_id,
                    participant.fighters,
                    participant.shields,
                )
            )
        return results

    async def _announce_defeats(self) -> None:
        if not self._latest_defeated:
            return
        defeated = self._latest_defeated
        self._latest_defeated = []
        for entry in defeated:
            name = str(entry.get("name") or entry.get("id"))
            owner = entry.get("owner")
            typ = entry.get("type")
            if typ == "garrison":
                owner_label = owner or name
                await self._append_log(f"Destroyed garrison for {owner_label}.")
            else:
                await self._append_log(f"Destroyed opponent ship: {name}.")

    def _build_opponent_labels(
        self,
        players: Mapping[str, Dict[str, Any]],
        garrisons: Sequence[Mapping[str, Any]],
    ) -> List[str]:
        labels: List[str] = sorted(players.keys())
        label_set = set(labels)
        for garrison in garrisons:
            owner_name = garrison.get("owner_name") or garrison.get("owner_id")
            fighters = int(garrison.get("fighters", 0))
            if (
                not owner_name
                or self._is_self_identifier(owner_name)
                or fighters <= 0
            ):
                continue
            label = f"Garrison({owner_name}, fighters={fighters})"
            if label not in label_set:
                labels.append(label)
                label_set.add(label)
        return sorted(labels)

    def _sector_has_hostiles(self) -> bool:
        snapshot = self.session.sector_snapshot() if self.session else None
        if isinstance(snapshot, Mapping):
            garrison = snapshot.get("garrison")
            if garrison and isinstance(garrison, Mapping):
                if (
                    not garrison.get("is_friendly")
                    and int(garrison.get("fighters", 0)) > 0
                ):
                    return True
        players = self.session.other_players() if self.session else {}
        for pid, pdata in players.items():
            if pid == self.character_id:
                continue
            if isinstance(pdata, Mapping) and pdata.get("is_friendly") is True:
                continue
            return True
        return False


def summarize_round(payload: Mapping[str, Any]) -> str:
    result = payload.get("result") or payload.get("end")
    flee_results = payload.get("flee_results")
    flee_text: Optional[str] = None
    if isinstance(flee_results, Mapping):
        successes = [pid for pid, fled in flee_results.items() if fled]
        failures = [pid for pid, fled in flee_results.items() if not fled]
        segments: List[str] = []
        if successes:
            actions = (
                payload.get("actions")
                if isinstance(payload.get("actions"), Mapping)
                else {}
            )
            details: List[str] = []
            for pid in successes:
                action = actions.get(pid) if isinstance(actions, Mapping) else None
                destination = None
                if isinstance(action, Mapping):
                    destination = action.get("destination_sector")
                if destination is not None:
                    details.append(f"{pid}->{destination}")
                else:
                    details.append(pid)
            segments.append("fled: " + ", ".join(details))
        if failures:
            segments.append("failed: " + ", ".join(failures))
        flee_text = "; ".join(segments) if segments else None

    if result:
        return f"Result={result}" + (f"; {flee_text}" if flee_text else "")

    fields: List[str] = []
    for label, key in (
        ("hits", "hits"),
        ("off_loss", "offensive_losses"),
        ("def_loss", "defensive_losses"),
        ("shield_loss", "shield_loss"),
    ):
        data = payload.get(key)
        if isinstance(data, Mapping) and data:
            scoreboard = ", ".join(f"{name}:{data[name]}" for name in sorted(data))
            fields.append(f"{label}({scoreboard})")

    ship_details = payload.get("ship")
    if isinstance(ship_details, Mapping):
        fighters = ship_details.get("fighters")
        shields = ship_details.get("shields")
        if fighters is not None or shields is not None:
            parts = []
            if fighters is not None:
                parts.append(f"fighters:{fighters}")
            if shields is not None:
                parts.append(f"shields:{shields}")
            if parts:
                fields.append("self(" + ", ".join(parts) + ")")

    if flee_text:
        fields.append(flee_text)

    return " ; ".join(fields) if fields else "No round details provided"


class ProgrammaticSimpleRunner:
    """Headless runner that executes scripted tasks without the Textual UI."""

    def __init__(
        self,
        *,
        server: str,
        character_id: str,
        actor_character_id: Optional[str] = None,
        tasks: Sequence[str],
        max_iterations: int,
        log_level: str = "INFO",
        log_path: Optional[str] = None,
        thinking_budget: Optional[int] = None,
        idle_timeout: Optional[float] = None,
    ) -> None:
        self.server = server.rstrip("/")
        self.character_id = character_id
        self.actor_character_id = actor_character_id
        self.display_name: str = character_id
        self.tasks = [task.strip() for task in tasks if task and task.strip()]
        self.max_iterations = max(1, max_iterations)
        self.log_level = (log_level or "INFO").upper()
        if self.log_level not in {
            "TRACE",
            "DEBUG",
            "INFO",
            "SUCCESS",
            "WARNING",
            "ERROR",
            "CRITICAL",
        }:
            self.log_level = "INFO"
        self.thinking_budget = thinking_budget
        self.idle_timeout = idle_timeout
        self.log_path = Path(log_path) if log_path else None
        self.client: Optional[AsyncGameClient] = None
        self.task_agent: Optional[TaskAgent] = None
        self._log_file: Optional[TextIO] = None
        self._all_tasks_successful = True
        self._session_lock_release: Optional[Callable[[], None]] = None

    def _update_display_name(self, payload: Mapping[str, Any]) -> None:
        candidate = _extract_player_display_name(payload)
        if isinstance(candidate, str) and candidate and candidate != self.display_name:
            self.display_name = candidate

    def _is_corp_ship_control(self) -> bool:
        return (
            self.actor_character_id is not None
            and self.actor_character_id != self.character_id
        )

    async def run(self) -> int:
        if not self.tasks:
            logger.warning("Programmatic runner received no tasks; exiting")
            return 0

        try:
            if self._is_corp_ship_control():
                _require_ship_knowledge(self.character_id)
                self._session_lock_release = _acquire_ship_session_lock(
                    self.character_id,
                    actor_id=self.actor_character_id,
                    server=self.server,
                )
        except RuntimeError as exc:
            logger.error(str(exc))
            return 1
        except SessionLockError as exc:
            logger.error(str(exc))
            logger.info("If this is stale, remove the lock file in %s", SESSION_LOCK_DIR)
            return 1

        if self.log_path is not None:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            self._log_file = self.log_path.open("a", encoding="utf-8")

        async def log_frame(direction: str, frame: Mapping[str, Any]) -> None:
            logger.debug(
                "WS %s: %s", direction.upper(), json.dumps(frame, sort_keys=True)
            )

        entity_type = "corporation_ship" if self._is_corp_ship_control() else "character"
        self.client = AsyncGameClient(
            base_url=self.server,
            character_id=self.character_id,
            actor_character_id=self.actor_character_id,
            entity_type=entity_type,
            websocket_frame_callback=log_frame,
        )
        self._register_event_handlers()

        agent_kwargs: Dict[str, Any] = {"output_callback": self._handle_task_output}
        if self.thinking_budget is not None:
            agent_kwargs["thinking_budget"] = self.thinking_budget
        if self.idle_timeout is not None:
            agent_kwargs["idle_timeout_secs"] = self.idle_timeout

        self.task_agent = TaskAgent(
            game_client=self.client,
            character_id=self.character_id,
            **agent_kwargs,
        )

        try:
            try:
                status = await self.client.join(self.character_id)
            except RPCError as exc:
                detail = (getattr(exc, "detail", "") or str(exc)).strip()
                logger.error("Join failed: %s", detail)
                lower_detail = detail.lower()
                if "actor_character_id is required" in lower_detail:
                    logger.info("Provide --actor-id with a corporation member when running headless.")
                elif "knowledge" in lower_detail:
                    path = KNOWLEDGE_DIR / f"{self.character_id}.json"
                    logger.info("Create %s before retrying.", path)
                elif "active session" in lower_detail:
                    logger.info("Another session is controlling %s. Clear locks in %s if stale.", self.character_id, SESSION_LOCK_DIR)
                return 1

            await self.client.subscribe_my_messages()
            self._update_display_name(status)
            self._log_line(
                f"Joined server as {self.display_name}; sector=\n{json.dumps(status.get('sector', {}), ensure_ascii=False)}",
                level=self.log_level,
            )

            for task in self.tasks:
                self._log_line(f"Starting scripted task: {task}")
                success = await self._execute_task(task)
                if not success:
                    self._all_tasks_successful = False
                else:
                    finished = getattr(self.task_agent, "finished_message", None)
                    if finished:
                        self._log_line(f"Task finished message: {finished}")

            return 0 if self._all_tasks_successful else 1
        finally:
            await self._shutdown()
            if self._session_lock_release:
                self._session_lock_release()
                self._session_lock_release = None

    async def _execute_task(self, prompt: str) -> bool:
        assert self.client is not None
        assert self.task_agent is not None

        paused_events = False
        try:
            await self.client.pause_event_delivery()
            paused_events = True
        except Exception as exc:  # noqa: BLE001
            self._log_line(
                f"Failed to pause events before task: {exc!r}", level="WARNING"
            )

        try:
            status = await self.client.my_status(self.character_id)
        except Exception as exc:  # noqa: BLE001
            self._log_line(
                f"Unable to fetch status for task '{prompt}': {exc!r}", level="ERROR"
            )
            if paused_events:
                with suppress(Exception):
                    await self.client.resume_event_delivery()
            return False

        initial_state = {
            "status": status,
            "time": datetime.now(timezone.utc).isoformat(),
        }

        success = False
        try:
            success = await self.task_agent.run_task(
                task=prompt,
                initial_state=initial_state,
                max_iterations=self.max_iterations,
            )
        except asyncio.CancelledError:
            self._log_line(f"Task '{prompt}' cancelled", level="WARNING")
            raise
        except Exception as exc:  # noqa: BLE001
            self._log_line(f"Task '{prompt}' failed: {exc!r}", level="ERROR")
        finally:
            if paused_events:
                with suppress(Exception):
                    await self.client.resume_event_delivery()

        result_text = "success" if success else "failure"
        self._log_line(f"Task '{prompt}' completed with {result_text}")
        return success

    async def _shutdown(self) -> None:
        if self.client is not None:
            await self.client.close()
            self.client = None
        if self._log_file is not None:
            self._log_file.close()
            self._log_file = None

    def _register_event_handlers(self) -> None:
        assert self.client is not None
        for event_name in EVENT_NAMES:
            self.client.on(event_name)(self._handle_event)

    async def _handle_event(self, event: Dict[str, Any]) -> None:
        event_name = event.get("event_name", "unknown")
        summary = SimpleTUI._event_summary(event)
        payload = SimpleTUI._event_payload(event)
        if summary:
            message = f"[event] {event_name}: {summary}"
        else:
            try:
                payload_text = json.dumps(payload, sort_keys=True, ensure_ascii=False)
            except Exception:  # noqa: BLE001
                payload_text = str(payload)
            message = f"[event] {event_name}: {payload_text}"
        self._log_line(message)

    def _handle_task_output(self, text: str, message_type: Optional[str]) -> None:
        label = (message_type or "MESSAGE").upper()
        level = (
            "ERROR" if message_type == TaskOutputType.ERROR.value else self.log_level
        )
        self._log_line(f"[{label}] {text}", level=level)

    def _log_line(self, message: str, *, level: str = "INFO") -> None:
        log_level = (level or self.log_level).upper()
        if log_level not in {
            "TRACE",
            "DEBUG",
            "INFO",
            "SUCCESS",
            "WARNING",
            "ERROR",
            "CRITICAL",
        }:
            log_level = self.log_level
        logger.log(log_level, message)
        if self._log_file is not None:
            timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
            self._log_file.write(f"{timestamp} {message}\n")
            self._log_file.flush()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Textual UI for Gradient Bang supporting task automation and combat",
    )
    parser.add_argument(
        "sector",
        type=int,
        nargs="?",
        default=None,
        help="Optional sector ID to move to after joining",
    )
    parser.add_argument(
        "--character-id",
        "--character",
        dest="character_id",
        required=False,
        default=None,
        help="Character UUID (defaults to NPC_CHARACTER_ID env var)",
    )
    parser.add_argument(
        "--actor-id",
        dest="actor_id",
        default=None,
        help="Corporation member ID when controlling a corporation ship",
    )
    parser.add_argument(
        "--server",
        default="http://localhost:8000",
        help="Game server URL",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )
    parser.add_argument(
        "--log-file",
        default=None,
        help="Path to append textual log output",
    )
    parser.add_argument(
        "--log-level",
        default=os.getenv("NPC_LOG_LEVEL", "INFO"),
        help="Logging level for stdout/file output (e.g. INFO, DEBUG, TRACE)",
    )
    parser.add_argument(
        "--max-iterations",
        type=int,
        default=int(os.getenv("NPC_MAX_ITERATIONS", "25")),
        help="Maximum TaskAgent iterations per task (default: %(default)s)",
    )
    parser.add_argument(
        "--thinking-budget",
        type=int,
        default=None,
        help="Optional thinking token budget for the TaskAgent",
    )
    parser.add_argument(
        "--idle-timeout",
        type=float,
        default=None,
        help="Optional idle timeout in seconds before cancelling agent inference",
    )
    parser.add_argument(
        "--task",
        dest="tasks",
        action="append",
        default=[],
        help="Task instruction to run automatically (repeatable)",
    )
    parser.add_argument(
        "--stdin-tasks",
        action="store_true",
        help="Read newline-delimited task instructions from STDIN",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run without the Textual UI; execute scripted tasks and exit",
    )
    args = parser.parse_args()
    if not args.character_id:
        from os import getenv

        args.character_id = getenv("NPC_CHARACTER_ID")
    if not args.character_id:
        parser.error(
            "Character must be provided via --character-id/--character or NPC_CHARACTER_ID"
        )
    if args.max_iterations <= 0:
        parser.error("--max-iterations must be greater than zero")
    if args.thinking_budget is None:
        env_thinking = os.getenv("NPC_THINKING_BUDGET")
        if env_thinking:
            try:
                args.thinking_budget = int(env_thinking)
            except ValueError:
                parser.error("NPC_THINKING_BUDGET must be an integer")
    if args.idle_timeout is None:
        env_idle = os.getenv("NPC_IDLE_TIMEOUT")
        if env_idle:
            try:
                args.idle_timeout = float(env_idle)
            except ValueError:
                parser.error("NPC_IDLE_TIMEOUT must be numeric")
    if args.verbose and str(args.log_level).upper() == "INFO":
        args.log_level = "DEBUG"
    args.log_level = str(args.log_level or "INFO").upper()
    return args


def main() -> None:
    args = parse_args()
    tasks: List[str] = list(args.tasks or [])
    if args.stdin_tasks:
        stdin_payload = [line.strip() for line in sys.stdin if line.strip()]
        tasks.extend(stdin_payload)

    if args.headless:
        runner = ProgrammaticSimpleRunner(
            server=args.server,
            character_id=args.character_id,
            actor_character_id=args.actor_id,
            tasks=tasks,
            max_iterations=args.max_iterations,
            log_level=args.log_level,
            log_path=args.log_file,
            thinking_budget=args.thinking_budget,
            idle_timeout=args.idle_timeout,
        )
        exit_code = asyncio.run(runner.run())
        raise SystemExit(exit_code)

    app = SimpleTUI(
        server=args.server,
        character_id=args.character_id,
        actor_character_id=args.actor_id,
        sector=args.sector,
        verbose=args.verbose,
        log_path=args.log_file,
        max_iterations=args.max_iterations,
        log_level=args.log_level,
        thinking_budget=args.thinking_budget,
        idle_timeout=args.idle_timeout,
        scripted_tasks=tasks,
    )
    app.run()


if __name__ == "__main__":
    main()
