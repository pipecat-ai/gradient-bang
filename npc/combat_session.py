"""Combat session helper built on top of AsyncGameClient."""

from __future__ import annotations

import asyncio
import logging
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Set, Tuple

from utils.api_client import AsyncGameClient


@dataclass
class CombatParticipant:
    """Lightweight representation of a combat participant."""

    combatant_id: str
    name: str
    type: str
    fighters: int
    shields: int
    max_fighters: int
    max_shields: int
    turns_per_warp: int
    owner: Optional[str] = None

    def copy(self) -> "CombatParticipant":
        return CombatParticipant(
            combatant_id=self.combatant_id,
            name=self.name,
            type=self.type,
            fighters=self.fighters,
            shields=self.shields,
            max_fighters=self.max_fighters,
            max_shields=self.max_shields,
            turns_per_warp=self.turns_per_warp,
            owner=self.owner,
        )


@dataclass
class CombatState:
    """State snapshot for an active or recently completed combat."""

    combat_id: str
    sector: Optional[int]
    round: int
    participants: Dict[str, CombatParticipant] = field(default_factory=dict)
    deadline: Optional[str] = None
    last_event: Optional[str] = None
    last_round: Optional[Dict[str, Any]] = None
    history: List[Dict[str, Any]] = field(default_factory=list)
    result: Optional[str] = None
    salvage: List[Dict[str, Any]] = field(default_factory=list)

    def clone(self) -> "CombatState":
        return CombatState(
            combat_id=self.combat_id,
            sector=self.sector,
            round=self.round,
            participants={pid: participant.copy() for pid, participant in self.participants.items()},
            deadline=self.deadline,
            last_event=self.last_event,
            last_round=deepcopy(self.last_round) if self.last_round else None,
            history=[deepcopy(item) for item in self.history],
            result=self.result,
            salvage=[deepcopy(item) for item in self.salvage],
        )


class CombatSession:
    """Utility to track combat-relevant events for a single character."""

    COMBAT_EVENTS = (
        "combat.started",
        "combat.round_waiting",
        "combat.round_resolved",
        "combat.ended",
    )

    def __init__(
        self,
        client: AsyncGameClient,
        *,
        character_id: str,
        logger: Optional[logging.Logger] = None,
        initial_status: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.client = client
        self.character_id = character_id
        self.logger = logger or logging.getLogger("npc.combat.session")
        self._handler_tokens: List[Tuple[str, Callable[[Dict[str, Any]], Any]]] = []
        self._started = False

        self._status_lock = asyncio.Lock()
        self._combat_condition = asyncio.Condition()
        self._occupant_condition = asyncio.Condition()
        self._combat_event_queue: asyncio.Queue[
            Tuple[str, CombatState, Dict[str, Any]]
        ] = asyncio.Queue()

        self._combat_state: Optional[CombatState] = None
        self._combat_active: bool = False
        self._player_combatant_id: Optional[str] = None

        self._current_sector: Optional[int] = None
        self._other_players: Dict[str, Dict[str, Any]] = {}
        self._occupant_version: int = 0
        self._sector_state: Dict[str, Any] = {}
        self._ship_status: Optional[Dict[str, Any]] = None
        self._last_status: Optional[Dict[str, Any]] = None
        self._last_injected_payloads: set[Tuple[str, int, str]] = set()
        self._toll_paid: Set[str] = set()

        if initial_status:
            self._apply_status(initial_status)

    async def __aenter__(self) -> "CombatSession":
        self.start()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self.close()

    def start(self) -> None:
        """Register event handlers if not already active."""

        if self._started:
            return

        self._started = True
        self._handler_tokens.append(
            self.client.add_event_handler("status.update", self._on_status_event)
        )
        self._handler_tokens.append(
            self.client.add_event_handler(
                "sector.garrison_updated", self._on_garrison_event
            )
        )
        self._handler_tokens.append(
            self.client.add_event_handler(
                "character.moved", self._on_character_moved
            )
        )

        for event_name in self.COMBAT_EVENTS:
            async def handler(payload: Dict[str, Any], ev: str = event_name) -> None:
                await self._handle_combat_event(ev, payload)

            self._handler_tokens.append(
                self.client.add_event_handler(event_name, handler)
            )

    async def close(self) -> None:
        """Remove registered handlers and drain pending events."""

        if not self._started:
            return

        for token in self._handler_tokens:
            self.client.remove_event_handler(token)
        self._handler_tokens.clear()
        self._started = False

        # Drain queue to unblock waiters
        while not self._combat_event_queue.empty():
            try:
                self._combat_event_queue.get_nowait()
            except asyncio.QueueEmpty:  # pragma: no cover - defensive
                break

    # ------------------------------------------------------------------
    # Public inspection helpers
    # ------------------------------------------------------------------

    @property
    def sector(self) -> Optional[int]:
        return self._current_sector

    def sector_snapshot(self) -> Dict[str, Any]:
        return deepcopy(self._sector_state)

    def sector_garrisons(self) -> List[Dict[str, Any]]:
        entries: Dict[str, Dict[str, Any]] = {}
        base_entries = self._sector_state.get("garrisons") or []
        for raw in base_entries:
            if not isinstance(raw, Mapping):
                continue
            entry = dict(raw)
            owner = entry.get("owner_id")
            key = (
                f"garrison:{self._current_sector}:{owner}"
                if owner is not None and self._current_sector is not None
                else str(owner)
            )
            entries[key] = entry

        if self._combat_state:
            for pid, participant in self._combat_state.participants.items():
                participant_type = getattr(participant, "type", None) or getattr(
                    participant, "combatant_type", None
                )
                if participant_type != "garrison":
                    continue
                merged = dict(entries.get(pid, {}))
                merged.setdefault("owner_id", participant.owner)
                merged.setdefault(
                    "is_friendly", participant.owner == self.character_id
                )
                merged["fighters"] = participant.fighters
                merged["max_fighters"] = participant.max_fighters
                entries[pid] = merged

        return list(entries.values())

    def ship_status(self) -> Optional[Dict[str, Any]]:
        return deepcopy(self._ship_status) if self._ship_status else None

    def other_players(self) -> Dict[str, Dict[str, Any]]:
        return deepcopy(self._other_players)

    def current_combat_state(self) -> Optional[CombatState]:
        return self._combat_state.clone() if self._combat_state else None

    def player_combatant_id(self) -> Optional[str]:
        return self._player_combatant_id

    def in_active_combat(self) -> bool:
        return self._combat_active

    def available_actions(self) -> List[str]:
        if not self._combat_state or not self._combat_active:
            return []
        participant_id = self._player_combatant_id or self.character_id
        participant = self._combat_state.participants.get(participant_id)
        if not participant:
            return []
        actions: List[str] = []
        opponents = [
            sid
            for sid in self._combat_state.participants.keys()
            if sid != participant_id
        ]
        if participant.fighters > 0 and opponents:
            actions.append("attack")
        actions.extend(["brace", "flee"])
        toll_targets = self.toll_targets()
        if toll_targets and "pay" not in actions:
            actions.insert(0, "pay")
        return actions

    def toll_targets(self) -> Set[str]:
        if not self._combat_state:
            return set()
        return {
            gid
            for gid in self._compute_toll_targets()
            if gid in self._combat_state.participants
            and gid not in self._toll_paid
            and self._combat_state.participants[gid].fighters > 0
        }

    def mark_toll_paid(self, combatant_ids: Iterable[str]) -> None:
        for cid in combatant_ids:
            if cid:
                self._toll_paid.add(str(cid))

    def _compute_toll_targets(self) -> Set[str]:
        if self._current_sector is None:
            return set()
        garrisons = self._sector_state.get("garrisons") or []
        targets: Set[str] = set()
        for entry in garrisons:
            if not isinstance(entry, Mapping):
                continue
            if str(entry.get("mode")) != "toll":
                continue
            if entry.get("is_friendly"):
                continue
            fighters = int(entry.get("fighters", 0) or 0)
            if fighters <= 0:
                continue
            owner_id = entry.get("owner_id")
            if not owner_id:
                continue
            targets.add(f"garrison:{self._current_sector}:{owner_id}")
        return targets

    async def apply_outcome_payload(
        self,
        payload: Dict[str, Any],
        *,
        ended: Optional[bool] = None,
    ) -> None:
        if not payload or self._combat_state is None:
            return

        combat_id = str(payload.get("combat_id"))
        if combat_id != self._combat_state.combat_id:
            return

        round_number = int(payload.get("round", self._combat_state.round))
        outcome_type = (
            "combat.ended"
            if ended or payload.get("end") or payload.get("result")
            else "combat.round_resolved"
        )
        token = (combat_id, round_number, outcome_type)
        if token in self._last_injected_payloads:
            return

        self._last_injected_payloads.add(token)

        if outcome_type == "combat.ended":
            await self._on_combat_ended(payload)
        else:
            await self._on_combat_round_resolved(payload)

    # ------------------------------------------------------------------
    # Awaitables
    # ------------------------------------------------------------------

    async def wait_for_other_player(
        self, *, timeout: Optional[float] = None
    ) -> Dict[str, Dict[str, Any]]:
        loop = asyncio.get_running_loop()
        end_time = None if timeout is None else loop.time() + timeout

        while True:
            await self._refresh_status()
            if self._other_players:
                return deepcopy(self._other_players)

            wait_timeout: Optional[float]
            if end_time is None:
                wait_timeout = 1.0
            else:
                remaining = end_time - loop.time()
                if remaining <= 0:
                    raise asyncio.TimeoutError
                wait_timeout = min(1.0, remaining)

            try:
                async with self._occupant_condition:
                    await asyncio.wait_for(self._occupant_condition.wait(), wait_timeout)
            except asyncio.TimeoutError:
                continue

    async def wait_for_occupant_change(
        self, *, timeout: Optional[float] = None
    ) -> Dict[str, Dict[str, Any]]:
        async with self._occupant_condition:
            current_version = self._occupant_version

            def has_changed() -> bool:
                return self._occupant_version != current_version

            if timeout is not None:
                await asyncio.wait_for(
                    self._occupant_condition.wait_for(has_changed), timeout
                )
            else:
                await self._occupant_condition.wait_for(has_changed)
            return deepcopy(self._other_players)

    async def wait_for_combat_start(
        self, *, timeout: Optional[float] = None
    ) -> CombatState:
        async with self._combat_condition:
            predicate = lambda: self._combat_state is not None and self._combat_active
            if predicate():
                return self._combat_state.clone()
            if timeout is not None:
                await asyncio.wait_for(self._combat_condition.wait_for(predicate), timeout)
            else:
                await self._combat_condition.wait_for(predicate)
            return self._combat_state.clone()  # type: ignore[return-value]

    async def wait_for_combat_end(
        self, *, timeout: Optional[float] = None
    ) -> CombatState:
        async with self._combat_condition:
            predicate = (
                lambda: self._combat_state is not None
                and not self._combat_active
                and self._combat_state.last_event == "combat.ended"
            )
            if predicate():
                return self._combat_state.clone()  # type: ignore[return-value]
            if timeout is not None:
                await asyncio.wait_for(self._combat_condition.wait_for(predicate), timeout)
            else:
                await self._combat_condition.wait_for(predicate)
            return self._combat_state.clone()  # type: ignore[return-value]

    async def next_combat_event(
        self, *, timeout: Optional[float] = None
    ) -> Tuple[str, CombatState, Dict[str, Any]]:
        if timeout is not None:
            return await asyncio.wait_for(self._combat_event_queue.get(), timeout)
        return await self._combat_event_queue.get()

    # ------------------------------------------------------------------
    # Event handlers
    # ------------------------------------------------------------------

    async def _on_status_event(self, payload: Dict[str, Any]) -> None:
        if payload.get("character_id") != self.character_id:
            return

        async with self._status_lock:
            changed = self._apply_status(payload)

        if changed:
            async with self._occupant_condition:
                self._occupant_version += 1
                self._occupant_condition.notify_all()

    async def _on_garrison_event(self, payload: Dict[str, Any]) -> None:
        sector = payload.get("sector")
        if sector is None or (self._current_sector is not None and sector != self._current_sector):
            return

        async with self._status_lock:
            self._sector_state.setdefault("garrisons", [])
            self._sector_state["garrisons"] = deepcopy(payload.get("garrisons") or [])

        async with self._occupant_condition:
            self._occupant_version += 1
            self._occupant_condition.notify_all()

    async def _on_character_moved(self, payload: Dict[str, Any]) -> None:
        if not payload:
            return

        current_sector = self._current_sector
        if current_sector is None:
            return

        movement = payload.get("movement")
        mover_identifier = payload.get("character_id")
        mover_name = payload.get("name")

        # Ignore self-movement regardless of identifier format
        if mover_identifier == self.character_id or mover_name == self.character_id:
            return

        to_sector = payload.get("to_sector")
        from_sector = payload.get("from_sector")

        arriving = False
        departing = False

        if movement == "arrive":
            arriving = True
        elif movement == "depart":
            departing = True
        else:
            if to_sector == current_sector:
                arriving = True
            if from_sector == current_sector:
                departing = True
            if not arriving and not departing:
                return

        key_source = mover_identifier or mover_name
        if not key_source:
            return
        key = str(key_source)
        display_name = str(mover_name or mover_identifier or key)

        self.logger.debug(
            "Movement event detected: movement=%s from=%s to=%s identifier=%s",
            movement,
            from_sector,
            to_sector,
            key,
        )

        changed = False
        async with self._status_lock:
            if departing and self._other_players.pop(key, None) is not None:
                changed = True
            if arriving:
                # placeholder entry until refresh fills details
                entry = self._other_players.setdefault(key, {"name": display_name})
                entry["name"] = display_name
                changed = True

        if changed:
            async with self._occupant_condition:
                self._occupant_version += 1
                self._occupant_condition.notify_all()

        await self._refresh_status()

    async def _handle_combat_event(
        self, event_name: str, payload: Dict[str, Any]
    ) -> None:
        if not self._event_involves_me(payload):
            return

        if event_name == "combat.started":
            await self._on_combat_started(payload)
        elif event_name == "combat.round_waiting":
            await self._on_combat_round_waiting(payload)
        elif event_name == "combat.round_resolved":
            await self._on_combat_round_resolved(payload)
        elif event_name == "combat.ended":
            await self._on_combat_ended(payload)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _apply_status(self, status: Dict[str, Any]) -> bool:
        previous_players = set(self._other_players.keys())

        self._last_status = deepcopy(status)
        self._current_sector = status.get("sector")
        self._ship_status = deepcopy(status.get("ship"))

        contents = status.get("sector_contents") or {}
        other_players = contents.get("other_players") or []
        new_players: Dict[str, Dict[str, Any]] = {}
        for entry in other_players:
            name = entry.get("name")
            if not name:
                continue
            new_players[str(name)] = deepcopy(entry)
        self._other_players = new_players

        self.logger.debug(
            "Status applied; sector=%s other_players=%s",
            self._current_sector,
            list(self._other_players.keys()),
        )

        self._sector_state = {
            "sector": self._current_sector,
            "other_players": [deepcopy(entry) for entry in other_players],
            "garrisons": deepcopy(contents.get("garrisons") or []),
            "salvage": deepcopy(contents.get("salvage") or []),
            "port": deepcopy(contents.get("port")),
            "planets": deepcopy(contents.get("planets") or []),
            "adjacent_sectors": list(contents.get("adjacent_sectors") or []),
        }

        updated_players = set(self._other_players.keys())
        return updated_players != previous_players

    async def _refresh_status(self) -> None:
        try:
            status = await self.client.my_status(force_refresh=True)
        except Exception:  # noqa: BLE001
            self.logger.exception("Failed to refresh status after movement event")
            return

        await self.update_from_status(status)

    async def update_from_status(self, status: Mapping[str, Any]) -> None:
        if not isinstance(status, Mapping):
            return
        status_dict = dict(status)
        async with self._status_lock:
            changed = self._apply_status(status_dict)
        if changed:
            async with self._occupant_condition:
                self._occupant_version += 1
                self._occupant_condition.notify_all()

    def _event_involves_me(self, payload: Dict[str, Any]) -> bool:
        participants = payload.get("participants") or {}
        for info in participants.values():
            combatant_id = info.get("combatant_id")
            owner = info.get("owner")
            if combatant_id == self.character_id or owner == self.character_id:
                return True
        combat_id = payload.get("combat_id")
        if self._combat_state and combat_id == self._combat_state.combat_id:
            return True
        return False

    def _build_participants(
        self, participants: Dict[str, Dict[str, Any]]
    ) -> Dict[str, CombatParticipant]:
        parsed: Dict[str, CombatParticipant] = {}
        for pid, info in participants.items():
            combatant_id = str(info.get("combatant_id") or pid)
            parsed[pid] = CombatParticipant(
                combatant_id=combatant_id,
                name=str(info.get("name") or combatant_id),
                type=str(info.get("type") or "character"),
                fighters=int(info.get("fighters", 0)),
                shields=int(info.get("shields", 0)),
                max_fighters=int(info.get("max_fighters", 0)),
                max_shields=int(info.get("max_shields", 0)),
                turns_per_warp=int(info.get("turns_per_warp", 0)),
                owner=str(info.get("owner")) if info.get("owner") else None,
            )
        return parsed

    def _resolve_player_combatant_id(
        self, participants: Dict[str, CombatParticipant]
    ) -> Optional[str]:
        for participant in participants.values():
            if participant.combatant_id == self.character_id:
                return participant.combatant_id
        for participant in participants.values():
            if participant.owner == self.character_id:
                return participant.combatant_id
        return None

    async def _on_combat_started(self, payload: Dict[str, Any]) -> None:
        participants = self._build_participants(payload.get("participants") or {})
        state = CombatState(
            combat_id=str(payload.get("combat_id")),
            sector=payload.get("sector"),
            round=int(payload.get("round", 1)),
            participants=participants,
            deadline=payload.get("deadline"),
            last_event="combat.started",
        )
        self._combat_state = state
        self._player_combatant_id = self._resolve_player_combatant_id(participants)
        self._combat_active = True
        self._last_injected_payloads.clear()
        self._toll_paid.clear()

        async with self._combat_condition:
            self._combat_condition.notify_all()

        await self._enqueue_combat_event("combat.started", payload)

    async def _on_combat_round_waiting(self, payload: Dict[str, Any]) -> None:
        combat_id = payload.get("combat_id")
        participants = self._build_participants(payload.get("participants") or {})

        if not self._combat_state:
            state = CombatState(
                combat_id=str(combat_id),
                sector=payload.get("sector"),
                round=int(payload.get("round", 1)),
                participants=participants,
                deadline=payload.get("deadline"),
                last_event="combat.round_waiting",
            )
            self._combat_state = state
            self._player_combatant_id = self._resolve_player_combatant_id(participants)
            self._combat_active = True
        elif combat_id != self._combat_state.combat_id:
            return
        else:
            if participants:
                self._combat_state.participants.update(participants)
            self._combat_state.round = int(payload.get("round", self._combat_state.round))
            self._combat_state.deadline = payload.get("deadline")
            self._combat_state.last_event = "combat.round_waiting"

        await self._enqueue_combat_event("combat.round_waiting", payload)

        async with self._combat_condition:
            self._combat_condition.notify_all()

    async def _on_combat_round_resolved(self, payload: Dict[str, Any]) -> None:
        if not self._combat_state or payload.get("combat_id") != self._combat_state.combat_id:
            return

        fighters_remaining = payload.get("fighters_remaining") or {}
        shields_remaining = payload.get("shields_remaining") or {}
        for pid, remaining in fighters_remaining.items():
            participant = self._combat_state.participants.get(pid)
            if participant is not None:
                participant.fighters = int(remaining)
        for gid in list(self._toll_paid):
            participant = self._combat_state.participants.get(gid)
            if participant is None or participant.fighters <= 0:
                self._toll_paid.discard(gid)
        for pid, remaining in shields_remaining.items():
            participant = self._combat_state.participants.get(pid)
            if participant is not None:
                participant.shields = int(remaining)

        self._combat_state.round = int(payload.get("round", self._combat_state.round))
        round_payload = deepcopy(payload)
        self._combat_state.last_round = round_payload
        self._combat_state.history.append(round_payload)
        self._combat_state.last_event = "combat.round_resolved"

        await self._enqueue_combat_event("combat.round_resolved", payload)

        async with self._combat_condition:
            self._combat_condition.notify_all()

    async def _on_combat_ended(self, payload: Dict[str, Any]) -> None:
        if not self._combat_state or payload.get("combat_id") != self._combat_state.combat_id:
            return

        fighters_remaining = payload.get("fighters_remaining") or {}
        shields_remaining = payload.get("shields_remaining") or {}
        for pid, remaining in fighters_remaining.items():
            participant = self._combat_state.participants.get(pid)
            if participant is not None:
                participant.fighters = int(remaining)
        for pid, remaining in shields_remaining.items():
            participant = self._combat_state.participants.get(pid)
            if participant is not None:
                participant.shields = int(remaining)

        end_payload = deepcopy(payload)
        self._combat_state.last_round = end_payload
        self._combat_state.history.append(end_payload)
        self._combat_state.result = payload.get("result") or payload.get("end")
        self._combat_state.salvage = deepcopy(payload.get("salvage") or [])
        self._combat_state.last_event = "combat.ended"
        self._combat_active = False
        self._toll_paid.clear()

        await self._enqueue_combat_event("combat.ended", payload)

        async with self._combat_condition:
            self._combat_condition.notify_all()

    async def _enqueue_combat_event(
        self, event_name: str, payload: Dict[str, Any]
    ) -> None:
        snapshot = self._combat_state.clone() if self._combat_state else None
        if snapshot is None:
            return
        await self._combat_event_queue.put(
            (event_name, snapshot, deepcopy(payload))
        )


__all__ = [
    "CombatParticipant",
    "CombatState",
    "CombatSession",
]
