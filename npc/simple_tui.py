"""Textual UI that can run tasks or handle sector combat automatically."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from contextlib import suppress
from dataclasses import dataclass
from enum import Enum, auto
from datetime import datetime
from pathlib import Path

import pyperclip
from typing import (
    Any,
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

from npc.combat_session import CombatSession
from npc.combat_utils import ensure_position
from npc.status_bars import StatusBarUpdater
from utils.api_client import AsyncGameClient, RPCError
from utils.base_llm_agent import LLMConfig
from utils.task_agent import TaskAgent


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

    #ws-log {
        height: 1fr;
    }

    #ws-log > ListItem {
        height: auto;
        padding: 0 1;
    }

    #ws-log > ListItem > Static {
        width: 100%;
        height: auto;
    }

    #ws-log > ListItem.expanded > Static {
        text-wrap: wrap;
    }

    #ws-log > ListItem.collapsed > Static {
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
    ]

    def __init__(
        self,
        *,
        server: str,
        character: str,
        sector: Optional[int] = None,
        verbose: bool = False,
        log_path: Optional[str] = None,
        model: str = "gpt-5",
        verbose_prompts: bool = False,
        max_iterations: int = 25,
    ) -> None:
        super().__init__()
        self.server = server.rstrip("/")
        self.character = character
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
        self.mode: InteractionMode = InteractionMode.TASK
        self.task_banner: Optional[Static] = None
        self.task_agent: Optional[TaskAgent] = None
        self.task_runner: Optional[asyncio.Task] = None
        self.task_model = model
        self.task_verbose_prompts = verbose_prompts
        self._task_last_prompt: Optional[str] = None
        self.task_max_iterations = max(1, max_iterations)
        self._last_ship_meta: Dict[str, Any] = {"credits": None, "cargo": {}}
        self.status_updater = StatusBarUpdater(character)
        self._expanded_lines: Set[int] = set()
        self._line_counter = 0
        self._log_lines: Dict[int, str] = {}  # Map line_id -> original text

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        self.task_banner = Static("task idle", id="task-banner")
        yield self.task_banner
        self.status_display = Static("", id="status-bars")
        yield self.status_display
        self.ws_log = AutoScrollListView(id="ws-log")
        yield self.ws_log
        with Horizontal(id="prompt-bar"):
            self.prompt_label = Static("Initializing", id="prompt-label")
            self.input = CommandInput(id="prompt-input", placeholder="")
            yield self.prompt_label
            yield self.input

    async def on_mount(self) -> None:
        self._update_status_bar(in_combat=False, fighters=0, shields=0)
        self._update_task_banner("Connecting to server…")
        self.set_focus(self.input)
        asyncio.create_task(self._initialize_client())

    async def _initialize_client(self) -> None:
        await self._append_log("Connecting to server...")
        await self._append_log("(Sanity check) ...")

        target_desc = (
            str(self.target_sector)
            if self.target_sector is not None
            else "stay in current sector"
        )
        await self._append_log(
            f"Configuration: server={self.server} character={self.character} "
            f"target={target_desc} log_file={self.log_path}"
        )

        await self._append_log("Creating AsyncGameClient...")

        async def log_frame(direction: str, frame: Mapping[str, Any]) -> None:
            text = json.dumps(frame, sort_keys=True, ensure_ascii=False)
            await self._append_log(f"{direction.upper()}: {text}")

        self.client = AsyncGameClient(
            base_url=self.server,
            character_id=self.character,
            websocket_frame_callback=log_frame,
        )

        # Register event handlers for real-time events
        self.client.on("status.update")(self._on_status_update)
        self.client.on("movement.start")(self._on_movement_start)
        self.client.on("movement.complete")(self._on_movement_complete)
        self.client.on("trade.executed")(self._on_trade_executed)
        self.client.on("port.update")(self._on_port_update)
        self.client.on("character.moved")(self._on_character_moved)

        llm_config = LLMConfig(api_key=None, model=self.task_model)
        self.task_agent = TaskAgent(
            config=llm_config,
            game_client=self.client,
            character_id=self.character,
            verbose_prompts=self.task_verbose_prompts,
            output_callback=self._handle_task_output,
        )

        await self._append_log("AsyncGameClient created; calling join...")

        try:
            # Call join RPC - we use the response ONLY for initial setup
            # All subsequent updates will come from events
            status = await self.client.join(self.character)

            # Extract sector for logging (using format-agnostic access)
            sector_info = status.get('sector')
            if isinstance(sector_info, dict):
                sector_id = sector_info.get('id', '?')
            else:
                sector_id = sector_info

            await self._append_log(f"Joined as {self.character}; sector {sector_id}")

            # Initialize CombatSession with initial status
            self.session = CombatSession(
                self.client,
                character_id=self.character,
                logger=None,
                initial_status=status,
            )
            self.session.start()

            # Sync status bars from initial join response
            self._sync_status_bar_from_status(status)

            await self._append_log("CombatSession started; spawning monitor task")
            self.monitor_task = asyncio.create_task(self._monitor_events())

            # Move to target sector if specified
            if self.target_sector is not None:
                await self._append_log(
                    f"Moving to target sector {self.target_sector}..."
                )
                # ensure_position makes RPC calls but we ignore the responses
                # All updates will come from movement.start and movement.complete events
                await ensure_position(
                    self.client,
                    status,
                    target_sector=self.target_sector,
                    logger=self._ensure_logger,
                )
                await self._append_log(f"Movement commands issued")
            else:
                await self._append_log(
                    "No target sector specified; remaining in current sector."
                )
            self.mode = InteractionMode.TASK
            self._update_task_banner(
                "Task idle. Enter a goal and press Enter to run the TaskAgent."
            )
            await self._update_prompt("Task mode", "Describe the task you want to run")
        except Exception as exc:  # noqa: BLE001
            await self._append_log(
                f"Initialization failed: {exc!r} ({type(exc).__name__})"
            )
            await self._graceful_shutdown()
            self.exit(1)

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
            raw = snapshot.get("garrisons") or []
            if isinstance(raw, Sequence):
                garrisons = [g for g in raw if isinstance(g, Mapping)]

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

    async def _on_status_update(self, payload: Dict[str, Any]) -> None:
        """Handle status.update event."""
        # Update status bars
        self.status_updater.update_from_status_update(payload)
        self._refresh_status_display()

    # --- Movement Events ---

    async def _on_movement_start(self, payload: Dict[str, Any]) -> None:
        """Handle movement.start event."""
        sector_data = payload.get("sector", {})
        destination = sector_data.get("id", "?")
        eta = payload.get("hyperspace_time", 0)

        await self._append_log(f"Entering hyperspace to sector {destination} (ETA: {eta:.1f}s)")

        # Update status bars
        self.status_updater.update_from_movement_start(payload)
        self._refresh_status_display()

    async def _on_movement_complete(self, payload: Dict[str, Any]) -> None:
        """Handle movement.complete event."""
        sector_data = payload.get("sector", {})
        sector_id = sector_data.get("id", "?")

        await self._append_log(f"Arrived at sector {sector_id}")

        # Update status bars
        self.status_updater.update_from_movement_complete(payload)
        self._refresh_status_display()

        # Update session with properly structured status payload
        # movement.complete has: {player, ship, sector}
        # update_from_status expects: {sector: int, ship: {...}, sector_contents: {...}}
        if self.session:
            status_for_session = {
                "sector": sector_id,
                "ship": payload.get("ship", {}),
                "sector_contents": sector_data,
            }
            await self.session.update_from_status(status_for_session)

    # --- Trading and Economy Events ---

    async def _on_trade_executed(self, payload: Dict[str, Any]) -> None:
        """Handle trade.executed event."""
        # Log the trade
        player_data = payload.get("player", {})
        ship_data = payload.get("ship", {})

        player_name = player_data.get("name", "?")
        credits = player_data.get("credits_on_hand")

        # Try to extract trade details from ship cargo changes
        await self._append_log(f"Trade executed by {player_name} (credits: {credits})")

        # Update status bars
        self.status_updater.update_from_trade_executed(payload)
        self._refresh_status_display()

    async def _on_port_update(self, payload: Dict[str, Any]) -> None:
        """Handle port.update event."""
        sector_id = payload.get("sector_id", "?")
        port_data = payload.get("port", {})

        # Format port update message
        code = port_data.get("code", "?")
        await self._append_log(f"Port prices updated at sector {sector_id} ({code})")

        # Update status bars
        self.status_updater.update_from_port_update(payload)
        self._refresh_status_display()

    # --- Sector Occupant Events ---

    async def _on_character_moved(self, payload: Dict[str, Any]) -> None:
        """Handle character.moved event."""
        movement = payload.get("movement")
        char_name = payload.get("name")
        ship_type = payload.get("ship_type", "unknown")

        # Log the movement
        if movement == "arrive":
            await self._append_log(f"{char_name} ({ship_type}) arrived")
        elif movement == "depart":
            await self._append_log(f"{char_name} ({ship_type}) departed")

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

        if event_name == "combat.started":
            # Update StatusBarUpdater
            self.status_updater.update_from_combat_started(payload)
            self._refresh_status_display()

            # Keep legacy tracking for defeat detection
            self._update_combatant_stats(state)
            await self._announce_defeats()
            opponents = [
                p.name for pid, p in state.participants.items() if pid != self.character
            ]
            await self._append_log(
                f"Combat {state.combat_id} started vs: {', '.join(opponents) or '(none)'}"
            )
            await self._update_prompt("Awaiting next round", "")
            return

        if event_name == "combat.round_waiting":
            # Update StatusBarUpdater
            self.status_updater.update_from_combat_round_waiting(payload)
            self._refresh_status_display()

            # Keep legacy tracking for defeat detection
            self._update_combatant_stats(state)
            await self._announce_defeats()
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
                pid == self.character or prev_owner == self.character
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
        candidate_ids = {str(self.character)}
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
            for key in ("fuel_ore", "organics", "equipment"):
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
        fo = cargo_map.get("fuel_ore", 0)
        og = cargo_map.get("organics", 0)
        eq = cargo_map.get("equipment", 0)
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
        text += f" | cargo FO:{fo} OG:{og} EQ:{eq}"
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
                garrisons_list = snapshot.get("garrisons") or []
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
            if name and name != self.character:
                players.add(str(name))

        player_text = ", ".join(sorted(players)) if players else "none"

        garrison_segments: List[str] = []
        for garrison in garrisons:
            if not isinstance(garrison, Mapping):
                continue
            owner_id = garrison.get("owner_id")
            fighters = garrison.get("fighters")
            max_fighters = garrison.get("max_fighters")
            mode = garrison.get("mode")
            friendly = garrison.get("is_friendly")
            if fighters is None:
                continue
            owner_label = "you" if owner_id == self.character else str(owner_id or "?")
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
            ("fuel_ore", "FO"),
            ("organics", "OG"),
            ("equipment", "EQ"),
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
        prefix = f"[{message_type}] " if message_type else ""
        asyncio.create_task(self._append_log(prefix + text))

    async def _start_task(self, prompt: str) -> None:
        prompt = prompt.strip()
        if not prompt:
            await self._append_log("Task input was empty; nothing to run.")
            return
        if self.task_agent is None:
            await self._append_log("TaskAgent is not initialized yet.")
            return
        if self._is_task_running():
            await self._append_log(
                "A task is already running. Cancel it before starting another."
            )
            return
        if self.mode is InteractionMode.COMBAT:
            await self._append_log(
                "Combat in progress. Finish the fight before starting a new task."
            )
            return

        self._task_last_prompt = prompt
        self._update_task_banner(f"Task running: {prompt}")
        self._set_task_input_enabled(False)
        self.mode = InteractionMode.TASK
        await self._append_log(f"Starting task: {prompt}")
        runner = asyncio.create_task(self._run_task(prompt))
        self.task_runner = runner
        runner.add_done_callback(self._on_task_complete)

    async def _run_task(self, prompt: str) -> None:
        if self.client is None or self.task_agent is None:
            await self._append_log("Client or TaskAgent unavailable; aborting task.")
            return

        # NOTE: TaskAgent internally calls my_status() - it needs the RPC response
        # to build its initial state. This is acceptable because the agent
        # needs a snapshot to start working. All updates during task execution
        # will come from events.
        try:
            status = await self.client.my_status(self.character)
        except Exception as exc:  # noqa: BLE001
            await self._append_log(
                f"Failed to retrieve status before running task: {exc!r}"
            )
            return

        initial_state = {
            "status": status,
            "time": datetime.utcnow().isoformat(),
        }

        snapshot = (
            status.get("sector_contents") if isinstance(status, Mapping) else None
        )
        self._update_sector_details(snapshot)

        success = False
        try:
            success = await self.task_agent.run_task(
                task=prompt,
                initial_state=initial_state,
                max_iterations=self.task_max_iterations,
            )
        except asyncio.CancelledError:
            await self._append_log("Task coroutine cancelled.")
            raise
        except Exception as exc:  # noqa: BLE001
            await self._append_log(f"Task execution failed: {exc!r}")
        finally:
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
                session.player_combatant_id() or self.character
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
                    exclude=session.player_combatant_id() or self.character,
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
                character_id=self.character,
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
        elif self.character in actions:
            my_action = actions.get(self.character)
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
                    my_id = player_id or self.character
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
                player_delta = resolve_delta(self.character)
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

    async def _append_log(self, message: str) -> None:
        self._mirror_to_file(message)

        # Create new log line with unique ID
        line_id = self._line_counter
        self._line_counter += 1
        self._log_lines[line_id] = message

        # Format the line (collapsed by default)
        formatted = format_log_line(message, expanded=False)

        # Create ListItem with Static content
        item = ListItem(Static(formatted), id=f"log-{line_id}")
        item.add_class("collapsed")

        # Store line_id as metadata on the item
        item.data_line_id = line_id  # type: ignore

        # Append to the list view with auto-scroll
        self.ws_log.append_item(item)

    def _mirror_to_file(self, message: str) -> None:
        if self.log_path is None:
            return
        if self._log_file is None:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            self._log_file = self.log_path.open("a", encoding="utf-8")
        timestamp = datetime.utcnow().isoformat(timespec="seconds")
        self._log_file.write(f"{timestamp} {message}\n")
        self._log_file.flush()

    async def _update_prompt(self, label: str, placeholder: str) -> None:
        def _apply() -> None:
            self.prompt_label.update(label)
            self.input.placeholder = placeholder
            self.input.value = ""
            self.set_focus(self.input)

        _apply()

    async def _graceful_shutdown(self) -> None:
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

    def on_input_submitted(self, event: Input.Submitted) -> None:
        value = event.value
        event.input.value = ""
        if self.pending_input and not self.pending_input.done():
            self.pending_input.set_result(value)
        else:
            if self.mode is InteractionMode.TASK:
                asyncio.create_task(self._start_task(value))
            else:
                asyncio.create_task(self._append_log(f"(ignored input) {value}"))

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        """Handle clicking on a log line to toggle expansion."""
        item = event.item

        # Get the line_id from the item's metadata
        line_id = getattr(item, "data_line_id", None)
        if line_id is None:
            return

        # Get the original text
        original_text = self._log_lines.get(line_id)
        if original_text is None:
            return

        # Toggle expansion state
        is_expanded = line_id in self._expanded_lines
        new_state = not is_expanded

        if new_state:
            self._expanded_lines.add(line_id)
        else:
            self._expanded_lines.discard(line_id)

        # Format the line with new state
        formatted = format_log_line(original_text, expanded=new_state)

        # Update the Static widget inside the ListItem
        static_widget = item.query_one(Static)
        static_widget.update(formatted)

        # Update CSS classes
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

    async def action_copy_log_line(self) -> None:
        """Copy the currently highlighted log line to clipboard."""
        await self._append_log("[DEBUG] action_copy_log_line called")

        # Get the currently highlighted item in the ListView
        await self._append_log(f"[DEBUG] ws_log.index = {self.ws_log.index}")

        if self.ws_log.index is None:
            await self._append_log("[DEBUG] No index - line not selected")
            self.notify("No log line selected", severity="warning", timeout=2)
            return

        # Get the ListItem at the current index
        try:
            items = list(self.ws_log.children)
            await self._append_log(f"[DEBUG] Found {len(items)} items in ListView")

            if not items or self.ws_log.index >= len(items):
                await self._append_log("[DEBUG] Index out of range")
                self.notify("No log line selected", severity="warning", timeout=2)
                return

            item = items[self.ws_log.index]
            if not isinstance(item, ListItem):
                await self._append_log(f"[DEBUG] Item is not ListItem: {type(item)}")
                return

            # Get the line_id from the item's metadata
            line_id = getattr(item, "data_line_id", None)
            await self._append_log(f"[DEBUG] line_id = {line_id}")

            if line_id is None:
                await self._append_log("[DEBUG] line_id is None")
                return

            # Get the original text
            original_text = self._log_lines.get(line_id)
            if original_text is None:
                await self._append_log("[DEBUG] original_text not found in _log_lines")
                return

            await self._append_log(
                f"[DEBUG] Copying text (length={len(original_text)})"
            )

            # Try to extract JSON - if found, copy only the JSON
            json_content = extract_json_only(original_text)
            if json_content:
                await self._append_log("[DEBUG] Copying JSON content")
                success, error = copy_to_system_clipboard(json_content)
                if success:
                    self.notify("JSON copied to clipboard", timeout=2)
                else:
                    await self._append_log(f"[DEBUG] xclip failed: {error}")
                    self.notify(f"Copy failed: {error}", severity="error", timeout=3)
            else:
                await self._append_log("[DEBUG] Copying full text (no JSON)")
                # No JSON found, copy the full text
                success, error = copy_to_system_clipboard(original_text)
                if success:
                    self.notify("Log line copied to clipboard", timeout=2)
                else:
                    await self._append_log(f"[DEBUG] xclip failed: {error}")
                    self.notify(f"Copy failed: {error}", severity="error", timeout=3)

        except Exception as exc:  # noqa: BLE001
            await self._append_log(f"[DEBUG] Exception: {exc}")
            self.notify(f"Copy failed: {exc}", severity="error", timeout=3)

    async def action_start_combat(self) -> None:
        if self.client is None or self.session is None:
            await self._append_log("Client not ready; cannot start combat.")
            return
        if self.session.in_active_combat():
            await self._append_log("Already in combat.")
            return

        opponents_present = False
        players = self.session.other_players()
        for pid in players.keys():
            if pid != self.character:
                opponents_present = True
                break

        snapshot = self.session.sector_snapshot()
        if isinstance(snapshot, Mapping):
            for garrison in snapshot.get("garrisons") or []:
                if not isinstance(garrison, Mapping):
                    continue
                if (
                    not garrison.get("is_friendly")
                    and int(garrison.get("fighters", 0)) > 0
                ):
                    opponents_present = True
                    break

        if not opponents_present:
            await self._append_log("No hostile opponents detected in this sector.")
            return

        try:
            await self.client.combat_initiate(character_id=self.character)
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
            if participant.fighters <= 0:
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
            owner_id = (
                str(garrison.get("owner_id")) if garrison.get("owner_id") else None
            )
            fighters = int(garrison.get("fighters", 0))
            if not owner_id or owner_id == self.character or fighters <= 0:
                continue
            label = f"Garrison({owner_id}, fighters={fighters})"
            if label not in label_set:
                labels.append(label)
                label_set.add(label)
        return sorted(labels)


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

    fighters = payload.get("fighters_remaining")
    if isinstance(fighters, Mapping) and fighters:
        scoreboard = ", ".join(f"{name}:{fighters[name]}" for name in sorted(fighters))
        fields.append(f"fighters({scoreboard})")

    if flee_text:
        fields.append(flee_text)

    return " ; ".join(fields) if fields else "No round details provided"


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
        "--character",
        required=False,
        default=None,
        help="Character ID (defaults to NPC_CHARACTER_ID env var)",
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
        "--model",
        default=os.getenv("NPC_MODEL", "gpt-5"),
        help="OpenAI model for TaskAgent (default: %(default)s)",
    )
    parser.add_argument(
        "--verbose-prompts",
        action="store_true",
        help="Echo TaskAgent prompts/responses (or set NPC_VERBOSE_PROMPTS=true)",
    )
    parser.add_argument(
        "--max-iterations",
        type=int,
        default=int(os.getenv("NPC_MAX_ITERATIONS", "25")),
        help="Maximum TaskAgent iterations per task (default: %(default)s)",
    )
    args = parser.parse_args()
    if not args.character:
        from os import getenv

        args.character = getenv("NPC_CHARACTER_ID")
    if not args.character:
        parser.error("Character must be provided via --character or NPC_CHARACTER_ID")
    env_verbose_prompts = os.getenv("NPC_VERBOSE_PROMPTS")
    if env_verbose_prompts:
        args.verbose_prompts = env_verbose_prompts.lower() == "true"
    if args.max_iterations <= 0:
        parser.error("--max-iterations must be greater than zero")
    return args


def main() -> None:
    args = parse_args()
    app = SimpleTUI(
        server=args.server,
        character=args.character,
        sector=args.sector,
        verbose=args.verbose,
        log_path=args.log_file,
        model=args.model,
        verbose_prompts=args.verbose_prompts,
        max_iterations=args.max_iterations,
    )
    app.run()


if __name__ == "__main__":
    main()
