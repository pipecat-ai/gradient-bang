"""Textual-based combat debugging utility showing raw WebSocket traffic."""

from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import uuid
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import (
    Any,
    Callable,
    Dict,
    Iterable,
    List,
    Mapping,
    Optional,
    Sequence,
    Tuple,
    TextIO,
)

from textual import events
from textual.app import App, ComposeResult
from textual.containers import Horizontal
from textual.widgets import Header, Input, Log, Static

from npc.combat_session import CombatSession
from npc.combat_utils import ensure_position
from utils.api_client import AsyncGameClient, RPCError


class LoggingAsyncGameClient(AsyncGameClient):
    """AsyncGameClient variant that surfaces raw WebSocket frames."""

    def __init__(
        self,
        *,
        on_frame: Optional[Callable[[str, Mapping[str, Any]], Any]] = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._frame_callback = on_frame

    async def _emit_frame(self, direction: str, frame: Mapping[str, Any]) -> None:
        if self._frame_callback is None:
            return
        try:
            result = self._frame_callback(direction, frame)
            if inspect.isawaitable(result):
                await result
        except Exception:  # pragma: no cover - logging must never crash the client
            pass

    async def _request(self, endpoint: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        await self._ensure_ws()
        req_id = str(uuid.uuid4())
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        frame = {
            "id": req_id,
            "type": "rpc",
            "endpoint": endpoint,
            "payload": payload,
        }
        await self._emit_frame("send", frame)
        await self._ws.send(json.dumps(frame))
        msg = await fut
        if not msg.get("ok"):
            err = msg.get("error", {})
            raise RPCError(
                endpoint,
                int(err.get("status", 500)),
                str(err.get("detail", "Unknown error")),
                err.get("code"),
            )
        return msg.get("result", {})

    async def _send_command(self, frame: Dict[str, Any]) -> Dict[str, Any]:
        await self._ensure_ws()
        req_id = frame.setdefault("id", str(uuid.uuid4()))
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        await self._emit_frame("send", frame)
        await self._ws.send(json.dumps(frame))
        msg = await fut
        if not msg.get("ok"):
            err = msg.get("error", {})
            raise RPCError(
                frame.get("type", "command"),
                int(err.get("status", 500)),
                str(err.get("detail", "Unknown error")),
                err.get("code"),
            )
        return msg.get("result", {})

    async def _ws_reader(self):
        try:
            async for raw in self._ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                await self._emit_frame("recv", msg)
                frame_type = msg.get("frame_type")
                if frame_type == "event":
                    event_name = msg.get("event")
                    payload = msg.get("payload", {})
                    if event_name:
                        asyncio.create_task(self._dispatch_event(event_name, payload))
                    continue
                req_id = msg.get("id")
                fut = self._pending.pop(req_id, None)
                if fut and not fut.done():
                    fut.set_result(msg)
        except asyncio.CancelledError:
            pass
        except Exception:
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(RuntimeError("WebSocket connection lost"))
            self._pending.clear()


@dataclass
class PromptRequest:
    label: str
    placeholder: str = ""
    options: Optional[Sequence[str]] = None


class _UILogger:
    """Lightweight logger proxy that writes to the Textual log."""

    def __init__(self, app: "CombatInteractiveTUI") -> None:
        self.app = app

    def info(self, message: str, *args: Any) -> None:
        text = message % args if args else message
        asyncio.create_task(self.app._append_log(text))


class CombatInteractiveTUI(App):
    """Minimal Textual UI for stepping through combat with raw WS visibility."""

    CSS = """
    Screen {
        layout: vertical;
    }

    #ws-log {
        height: 1fr;
    }

    #status-bar {
        height: auto;
        padding: 0 1;
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

    BINDINGS = [("ctrl+c", "quit", "Quit"), ("ctrl+q", "quit", "Quit")]

    def __init__(
        self,
        *,
        server: str,
        character: str,
        sector: int,
        verbose: bool = False,
        log_path: Optional[str] = None,
    ) -> None:
        super().__init__()
        self.server = server.rstrip("/")
        self.character = character
        self.target_sector = sector
        self.verbose = verbose
        self.log_path = (
            Path(log_path) if log_path else Path.cwd() / "combat_interactive_tui.log"
        )
        self.client: Optional[LoggingAsyncGameClient] = None
        self.session: Optional[CombatSession] = None
        self.monitor_task: Optional[asyncio.Task] = None
        self.round_prompt_task: Optional[asyncio.Task] = None
        self.pending_input: Optional[asyncio.Future[str]] = None
        self._ensure_logger = _UILogger(self)
        self._log_file: Optional[TextIO] = None
        self._combatant_stats: Dict[str, Tuple[int, int]] = {}
        self.status_display: Optional[Static] = None
        self._last_player_stats: Tuple[int, int] = (0, 0)
        self._last_status_mode: str = "quiet"
        self._last_participants: Dict[str, Dict[str, Any]] = {}
        self._latest_defeated: List[Dict[str, Any]] = []
        self._engage_prompt_task: Optional[asyncio.Task[str]] = None
        self._last_opponent_labels: Tuple[str, ...] = ()

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        self.status_display = Static("quiet | fighters: 0 shields: 0", id="status-bar")
        yield self.status_display
        self.ws_log = Log(id="ws-log", highlight=True)
        yield self.ws_log
        with Horizontal(id="prompt-bar"):
            self.prompt_label = Static("Initializing", id="prompt-label")
            self.input = Input(id="prompt-input", placeholder="")
            yield self.prompt_label
            yield self.input

    async def on_mount(self) -> None:
        self._update_status_bar(in_combat=False, fighters=0, shields=0)
        self.set_focus(self.input)
        asyncio.create_task(self._initialize_client())

    async def _initialize_client(self) -> None:
        await self._append_log("Connecting to server...")
        await self._append_log("(Sanity check) ...")

        await self._append_log(
            f"Configuration: server={self.server} character={self.character} "
            f"sector={self.target_sector} log_file={self.log_path}"
        )

        await self._append_log("Creating AsyncGameClient...")

        async def log_frame(direction: str, frame: Mapping[str, Any]) -> None:
            text = json.dumps(frame, sort_keys=True, ensure_ascii=False)
            await self._append_log(f"{direction.upper()}: {text}")

        self.client = LoggingAsyncGameClient(
            base_url=self.server,
            character_id=self.character,
            on_frame=log_frame,
        )

        await self._append_log("AsyncGameClient created; calling join...")

        try:
            status = await self.client.join(self.character)
            await self._append_log(f"Join call returned: {status!r}")
            await self._append_log(
                f"Joined as {self.character}; sector {status.get('sector')}"
            )

            self.session = CombatSession(
                self.client,
                character_id=self.character,
                logger=None,
                initial_status=status,
            )
            self.session.start()
            self._sync_status_bar_from_status(status)
            await self._append_log("CombatSession started; spawning monitor task")
            self.monitor_task = asyncio.create_task(self._monitor_events())
            await self._update_prompt("Waiting for opponents", "")

            await self._append_log(
                "Ensuring position at target sector via ensure_position..."
            )
            status = await ensure_position(
                self.client,
                status,
                target_sector=self.target_sector,
                logger=self._ensure_logger,
            )
            await self._append_log(f"ensure_position returned: {status!r}")
            await self._append_log(f"Positioned in sector {status.get('sector')}")
            self._sync_status_bar_from_status(status)
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
        if session is None or session.in_active_combat():
            return

        ship_snapshot = session.ship_status()
        if isinstance(ship_snapshot, Mapping):
            self._sync_status_bar_from_ship(ship_snapshot)

        snapshot = session.sector_snapshot()
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
            if (
                self._engage_prompt_task
                and not self._engage_prompt_task.done()
            ):
                self._engage_prompt_task.cancel()
                with suppress(asyncio.CancelledError):
                    await self._engage_prompt_task
                self._engage_prompt_task = None
            await self._append_log("Sector clear; waiting for opponents.")
            await self._update_prompt("Waiting for opponents", "")
            self._update_status_bar(in_combat=False)
            return

        prompt_label_text = f"Opponents present ({', '.join(opponent_labels)}). Engage?"

        if (
            self._engage_prompt_task
            and not self._engage_prompt_task.done()
        ):
            if opponents_changed:
                await self._append_log(
                    "Opponents updated: " + ", ".join(opponent_labels)
                )
            await self._update_prompt(prompt_label_text, "fight/wait")
            return

        if opponents_changed:
            await self._append_log("Opponents detected: " + ", ".join(opponent_labels))
        prompt_task = asyncio.create_task(
            self._prompt_choice(
                prompt_label_text,
                options=("fight", "wait"),
                default="wait",
            )
        )
        combat_task = asyncio.create_task(session.wait_for_combat_start())

        self._engage_prompt_task = prompt_task
        prompt_task.add_done_callback(self._on_engage_prompt_complete)

        done, pending = await asyncio.wait(
            {prompt_task, combat_task}, return_when=asyncio.FIRST_COMPLETED
        )

        if combat_task in done:
            prompt_task.cancel()
            with suppress(asyncio.CancelledError):
                await prompt_task
            await self._append_log(
                "Combat detected while awaiting input; switching to combat mode."
            )
            await self._update_prompt("Awaiting next round", "")
            self._update_status_bar(in_combat=True)
            return

        combat_task.cancel()
        with suppress(asyncio.CancelledError):
            await combat_task

        try:
            choice = await prompt_task
        except asyncio.CancelledError:
            await self._append_log("Engagement prompt cancelled.")
            return

        if choice == "fight":
            try:
                await self.client.combat_initiate(character_id=self.character)
                await self._append_log("Entered combat stance; awaiting prompts.")
            except RPCError as exc:
                await self._append_log(f"combat.initiate failed: {exc}")
        else:
            await self._append_log("Holding position; waiting for incoming attack.")
            self._update_status_bar(in_combat=False)

    async def _handle_combat_event(
        self,
        state,
        payload: Dict[str, Any],
        event_name: str,
    ) -> None:
        if event_name == "combat.started":
            self._update_combatant_stats(state)
            fighters, shields = self._player_stats_from_state(state)
            self._update_status_bar(
                in_combat=True, fighters=fighters, shields=shields
            )
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
            self._update_combatant_stats(state)
            fighters, shields = self._player_stats_from_state(state)
            self._update_status_bar(
                in_combat=True, fighters=fighters, shields=shields
            )
            await self._announce_defeats()
            await self._cancel_round_prompt()
            task = asyncio.create_task(self._prompt_for_round_action(state, payload))
            self.round_prompt_task = task
            task.add_done_callback(self._on_round_prompt_complete)
            return

        if event_name == "combat.round_resolved":
            await self._cancel_round_prompt()
            deltas = self._update_combatant_stats(state, capture_deltas=True)
            fighters, shields = self._player_stats_from_state(state)
            self._update_status_bar(
                in_combat=True, fighters=fighters, shields=shields
            )
            await self._announce_defeats()
            summary = summarize_round(payload)
            await self._append_log(f"Round {state.round} resolved: {summary}")
            await self._log_my_action(state, payload, deltas)
            await self._update_prompt("Waiting for next round", "")
            return

        if event_name == "combat.ended":
            await self._cancel_round_prompt()
            deltas = self._update_combatant_stats(state, capture_deltas=True)
            fighters, shields = self._player_stats_from_state(state)
            self._update_status_bar(
                in_combat=False, fighters=fighters, shields=shields
            )
            await self._announce_defeats()
            result = payload.get("result") or payload.get("end") or "no result"
            await self._append_log(f"Combat ended ({result})")
            salvage = payload.get("salvage") or []
            if salvage:
                await self._append_log(f"Salvage available: {salvage}")
            current_sector = self.session.sector if self.session else None
            if current_sector is not None:
                await self._append_log(f"Current sector: {current_sector}")
            await self._log_my_action(state, payload, deltas)
            self._combatant_stats.clear()
            self._last_player_stats = (fighters, shields)
            await self._update_prompt("Waiting for opponents", "")
            if self.session:
                await self._handle_occupants(self.session.other_players())
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

    def _on_engage_prompt_complete(self, task: asyncio.Task) -> None:
        if self._engage_prompt_task is task:
            self._engage_prompt_task = None

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
                "type": getattr(participant, "type", None) or getattr(participant, "combatant_type", None),
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
            prev_fighters = int(info.get("fighters", 0)) if isinstance(info, Mapping) else 0
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
            if prev_type == "character" and (pid == self.character or prev_owner == self.character):
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
    ) -> None:
        if fighters is None or shields is None:
            prev_fighters, prev_shields = self._last_player_stats
            fighters = prev_fighters if fighters is None else fighters
            shields = prev_shields if shields is None else shields

        if fighters is None:
            fighters = 0
        if shields is None:
            shields = 0

        self._last_player_stats = (fighters, shields)
        mode = "combat" if in_combat else "quiet"
        self._last_status_mode = mode
        text = f"{mode} | fighters: {fighters} shields: {shields}"
        if self.status_display is not None:
            self.status_display.update(text)

    def _sync_status_bar_from_status(self, status: Mapping[str, Any]) -> None:
        ship = status.get("ship") if isinstance(status, Mapping) else None
        if isinstance(ship, Mapping):
            self._sync_status_bar_from_ship(ship)
        else:
            self._update_status_bar(in_combat=False)

    def _sync_status_bar_from_ship(self, ship: Mapping[str, Any]) -> None:
        fighters = int(ship.get("fighters", 0))
        shields = int(ship.get("shields", 0))
        in_combat = False
        if self.session is not None:
            in_combat = self.session.in_active_combat()
        self._update_status_bar(
            in_combat=in_combat,
            fighters=fighters,
            shields=shields,
        )

    async def _prompt_for_round_action(self, state, payload: Dict[str, Any]) -> None:
        session = self.session
        if session is None:
            return

        actions = session.available_actions() or ["brace"]
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
                await self._append_log(
                    "Legal flee destinations: " + ", ".join(map(str, adjacent))
                )
                destination = await self._prompt_number(
                    "Destination sector to flee to",
                    allowed=adjacent,
                )
                to_sector = destination

        try:
            result = await self.client.combat_action(
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
            pieces = [str(my_action.get("action"))]
            if my_action.get("commit"):
                pieces.append(f"commit={my_action['commit']}")
            if my_action.get("target"):
                pieces.append(f"target={my_action['target']}")
            if my_action.get("destination_sector") is not None:
                pieces.append(f"to_sector={my_action['destination_sector']}")
            deltas = deltas or {}

            def resolve_delta(identifier: str) -> Tuple[int, int]:
                if identifier in deltas:
                    return deltas[identifier]
                participant = state.participants.get(identifier)
                if participant:
                    for pid, info in state.participants.items():
                        if (
                            info.combatant_id == identifier
                            or info.name == identifier
                        ):
                            return deltas.get(pid, (0, 0))
                for pid, info in state.participants.items():
                    if info.combatant_id == identifier:
                        return deltas.get(pid, (0, 0))
                return (0, 0)

            def format_delta(label: str, change: Tuple[int, int]) -> str:
                fighters_delta, shields_delta = change
                return f"{label} Δfighters={fighters_delta:+d} Δshields={shields_delta:+d}"

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
        self.ws_log.write_line(message)

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
            asyncio.create_task(self._append_log(f"(ignored input) {value}"))

    async def _handle_action_outcome(self, response: Mapping[str, Any]) -> None:
        if not isinstance(response, Mapping):
            return
        session = self.session
        if session is None:
            return

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

    async def on_key(self, event: events.Key) -> None:
        if (
            event.key == "escape"
            and self.pending_input
            and not self.pending_input.done()
        ):
            self.pending_input.set_result("")

    async def action_quit(self) -> None:
        await self._graceful_shutdown()
        self.exit()

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
            owner_id = str(garrison.get("owner_id")) if garrison.get("owner_id") else None
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
        description="Textual combat utility with WebSocket logging",
    )
    parser.add_argument("sector", type=int, help="Sector ID to monitor")
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
    args = parser.parse_args()
    if not args.character:
        from os import getenv

        args.character = getenv("NPC_CHARACTER_ID")
    if not args.character:
        parser.error("Character must be provided via --character or NPC_CHARACTER_ID")
    return args


def main() -> None:
    args = parse_args()
    app = CombatInteractiveTUI(
        server=args.server,
        character=args.character,
        sector=args.sector,
        verbose=args.verbose,
        log_path=args.log_file,
    )
    app.run()


if __name__ == "__main__":
    main()
