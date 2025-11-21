"""Combat session helper built on top of AsyncGameClient."""

from __future__ import annotations

import asyncio
import logging
import os
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional, Set, Tuple

if os.getenv("SUPABASE_URL"):
    from gradientbang.utils.supabase_client import AsyncGameClient
else:
    from gradientbang.utils.api_client import AsyncGameClient


def _extract_sector_id(value: Any) -> Optional[int]:
    if isinstance(value, dict):
        return value.get("id")
    return value


def _coerce_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


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

    @staticmethod
    def _event_payload(event: Any) -> Dict[str, Any]:
        if isinstance(event, Mapping) and "payload" in event:
            payload = event.get("payload")
            if isinstance(payload, Mapping):
                return dict(payload)
            return payload or {}
        return event if isinstance(event, Mapping) else {}

    def _wrap_event_handler(
        self,
        handler: Callable[[Dict[str, Any]], Awaitable[None]],
    ) -> Callable[[Dict[str, Any]], Awaitable[None]]:
        async def _wrapped(event: Dict[str, Any]) -> None:
            payload = self._event_payload(event)
            await handler(payload)

        return _wrapped

    def start(self) -> None:
        """Register event handlers if not already active."""

        if self._started:
            return

        self._started = True
        self._handler_tokens.append(
            self.client.add_event_handler(
                "status.update", self._wrap_event_handler(self._on_status_event)
            )
        )
        handler = self.client.add_event_handler(
            "sector.update", self._wrap_event_handler(self._on_sector_update)
        )
        self._handler_tokens.append(handler)
        # Backward compatibility: handle legacy garrison update events if received
        self._handler_tokens.append(
            self.client.add_event_handler(
                "sector.garrison_updated", self._wrap_event_handler(self._on_sector_update)
            )
        )
        self._handler_tokens.append(
            self.client.add_event_handler(
                "character.moved", self._wrap_event_handler(self._on_character_moved)
            )
        )

        for event_name in self.COMBAT_EVENTS:
            async def handler(event: Dict[str, Any], ev: str = event_name) -> None:
                payload = self._event_payload(event)
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
        garrison = self._sector_state.get("garrison")
        base_entries = [garrison] if garrison else []
        for raw in base_entries:
            if not isinstance(raw, Mapping):
                continue
            entry = dict(raw)
            owner = entry.get("owner_name") or entry.get("owner_id")
            if owner is not None and self._current_sector is not None:
                key = f"garrison:{self._current_sector}:{owner}"
            else:
                key = f"garrison:{len(entries)}"
            entries[key] = entry

        if self._combat_state:
            for pid, participant in self._combat_state.participants.items():
                participant_type = getattr(participant, "type", None) or getattr(
                    participant, "combatant_type", None
                )
                if participant_type != "garrison":
                    continue
                merged = dict(entries.get(pid, {}))
                merged.setdefault("owner_name", participant.name)
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
        """Return garrison IDs that are toll garrisons we can pay.

        Since there can only be one garrison per sector, we just look for
        any garrison participant in combat that is in toll mode, not friendly,
        and hasn't been paid yet.
        """
        if not self._combat_state:
            return set()

        targets: Set[str] = set()
        for gid, participant in self._combat_state.participants.items():
            # Only consider garrison participants
            if participant.type != "garrison":
                continue
            # Skip if already paid
            if gid in self._toll_paid:
                continue
            # Skip if no fighters
            if participant.fighters <= 0:
                continue
            # Check sector state to verify it's a toll garrison and not friendly
            garrison = self._sector_state.get("garrison")
            if garrison and isinstance(garrison, Mapping):
                if str(garrison.get("mode")) != "toll":
                    continue
                if garrison.get("is_friendly"):
                    continue
                # Found a toll garrison in sector - this is it (only one per sector)
                targets.add(gid)
                break

        return targets

    def mark_toll_paid(self, combatant_ids: Iterable[str]) -> None:
        for cid in combatant_ids:
            if cid:
                self._toll_paid.add(str(cid))

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

    async def _on_sector_update(self, payload: Dict[str, Any]) -> None:
        sector_payload: Optional[Mapping[str, Any]] = None
        sector_id = None

        if isinstance(payload, Mapping):
            candidate = payload.get("sector")
            if isinstance(candidate, Mapping):
                sector_payload = candidate
                sector_id = _extract_sector_id(candidate)
            else:
                sector_payload = payload
                sector_id = _extract_sector_id(payload) or payload.get("id")

        if sector_id is None or (
            self._current_sector is not None and sector_id != self._current_sector
        ):
            return

        async with self._status_lock:
            if sector_payload is not None:
                self._sector_state = deepcopy(sector_payload)

            garrison_entry = None
            if isinstance(payload, Mapping):
                garrison_entry = payload.get("garrison")

            if garrison_entry:
                self._sector_state["garrison"] = deepcopy(garrison_entry)
            else:
                self._sector_state["garrison"] = None
            self._current_sector = sector_id

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
        player = payload.get("player") or {}
        mover_identifier = player.get("id") or payload.get("character_id")
        mover_name = player.get("name") or payload.get("name")

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

        if event_name == "combat.round_waiting":
            await self._on_combat_round_waiting(payload)
        elif event_name == "combat.round_resolved":
            await self._on_combat_round_resolved(payload)
        elif event_name == "combat.ended":
            await self._on_combat_ended(payload)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _apply_status(self, status: Dict[str, Any]) -> bool:
        """Apply status update, handling both format styles.

        Format 1 (new): {"player": {...}, "ship": {...}, "sector": {"id": int, "players": [...]}}
        Format 2 (legacy): {"sector": int, "ship": {...}, "sector_contents": {"other_players": [...]}}
        """
        previous_players = set(self._other_players.keys())

        self._last_status = deepcopy(status)
        self._ship_status = deepcopy(status.get("ship"))

        # Detect format and normalize
        if "player" in status:
            # New format from build_status_payload
            sector_data = status.get("sector", {})
            if isinstance(sector_data, dict):
                self._current_sector = sector_data.get("id")
                # Field is "players" in new format
                other_players = sector_data.get("players", [])

                # Build sector_state from new format
                self._sector_state = {
                    "sector": self._current_sector,
                    "other_players": [deepcopy(entry) for entry in other_players],
                    "garrison": deepcopy(sector_data.get("garrison")),
                    "salvage": deepcopy(sector_data.get("salvage") or []),
                    "port": deepcopy(sector_data.get("port")),
                    "planets": deepcopy(sector_data.get("planets") or []),
                    "adjacent_sectors": list(sector_data.get("adjacent_sectors") or []),
                }
            else:
                # Fallback if sector is somehow still an int
                self._current_sector = sector_data
                other_players = []
                self._sector_state = {
                    "sector": self._current_sector,
                    "other_players": [],
                    "garrison": None,
                    "salvage": [],
                    "port": None,
                    "planets": [],
                    "adjacent_sectors": [],
                }
        else:
            # Legacy format - sector_contents style
            self._current_sector = status.get("sector")
            contents = status.get("sector_contents") or {}
            # Field is "other_players" in legacy format
            other_players = contents.get("other_players") or []

            self._sector_state = {
                "sector": self._current_sector,
                "other_players": [deepcopy(entry) for entry in other_players],
                "garrison": deepcopy(contents.get("garrison")),
                "salvage": deepcopy(contents.get("salvage") or []),
                "port": deepcopy(contents.get("port")),
                "planets": deepcopy(contents.get("planets") or []),
                "adjacent_sectors": list(contents.get("adjacent_sectors") or []),
            }

        # Build other_players dict
        new_players: Dict[str, Dict[str, Any]] = {}
        for entry in other_players:
            name = entry.get("name")
            if not name:
                continue
            new_players[str(name)] = deepcopy(entry)
        self._other_players = new_players

        self.logger.debug(
            "Status applied; sector=%s other_players=%s format=%s",
            self._current_sector,
            list(self._other_players.keys()),
            "new" if "player" in status else "legacy",
        )

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
        """Check if this combat event involves our character.

        Handles both participant formats:
        - Dict: {"participant_id": {"combatant_id": "...", "owner": "..."}}
        - Array: [{"name": "...", ...}]
        """
        participants = payload.get("participants")

        if isinstance(participants, dict):
            # Dict format (combat.round_resolved, combat.ended)
            for info in participants.values():
                combatant_id = info.get("combatant_id")
                owner = info.get("owner")
                if combatant_id == self.character_id or owner == self.character_id:
                    return True
        elif isinstance(participants, list):
            # Array format (combat.round_waiting)
            for info in participants:
                name = info.get("name")
                if name == self.character_id:
                    return True

        # Also check if we're already in this combat
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

    def _build_participants_from_array(
        self, participants: List[Dict[str, Any]]
    ) -> Dict[str, CombatParticipant]:
        parsed: Dict[str, CombatParticipant] = {}
        for entry in participants:
            if not isinstance(entry, Mapping):
                continue
            name = entry.get("name")
            combatant_id = entry.get("combatant_id") or name
            if not combatant_id:
                continue
            identifier = str(combatant_id)
            parsed[identifier] = CombatParticipant(
                combatant_id=identifier,
                name=str(name or identifier),
                type=str(entry.get("player_type") or "character"),
                fighters=0,
                shields=0,
                max_fighters=0,
                max_shields=0,
                turns_per_warp=0,
                owner=None,
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

    async def _on_combat_round_waiting(self, payload: Dict[str, Any]) -> None:
        """Handle combat.round_waiting event.

        Server currently sends participants as array format in this event. We only
        update round/deadline and synthesise lightweight participants as needed.
        """
        combat_id = payload.get("combat_id")

        # Only parse participants if they're in dict format (for defensive/fallback case)
        participants_data = payload.get("participants")
        participants: Dict[str, CombatParticipant] = {}
        if isinstance(participants_data, dict):
            participants = self._build_participants(participants_data)
        elif isinstance(participants_data, list):
            participants = self._build_participants_from_array(participants_data)

        # Also check for garrison in the payload and add it as a participant
        # Since there can only be one garrison per sector, use simple ID derived from sector and owner name
        garrison_data = payload.get("garrison")
        if garrison_data and isinstance(garrison_data, Mapping):
            sector = _extract_sector_id(payload.get("sector"))
            owner_name = garrison_data.get("owner_name")
            fighters = garrison_data.get("fighters", 0)
            if sector is not None and owner_name and fighters > 0:
                garrison_id = f"garrison:{sector}:{owner_name}"

                participants[garrison_id] = CombatParticipant(
                    combatant_id=garrison_id,
                    name=f"{owner_name}'s garrison",
                    type="garrison",
                    fighters=int(fighters),
                    shields=0,
                    max_fighters=int(fighters),
                    max_shields=0,
                    turns_per_warp=0,
                    owner=str(owner_name),
                )

        if not self._combat_state:
            # Defensive: shouldn't happen, but create minimal state
            state = CombatState(
                combat_id=str(combat_id),
                sector=_extract_sector_id(payload.get("sector")),
                round=int(payload.get("round", 1)),
                participants=participants,
                deadline=payload.get("deadline"),
                last_event="combat.round_waiting",
            )
            self._combat_state = state
            if participants:
                self._player_combatant_id = self._resolve_player_combatant_id(participants)
            self._combat_active = True
            self._last_injected_payloads.clear()
            self._toll_paid.clear()
        elif combat_id != self._combat_state.combat_id:
            # New combat started - replace old combat state
            state = CombatState(
                combat_id=str(combat_id),
                sector=_extract_sector_id(payload.get("sector")),
                round=int(payload.get("round", 1)),
                participants=participants,
                deadline=payload.get("deadline"),
                last_event="combat.round_waiting",
            )
            self._combat_state = state
            if participants:
                self._player_combatant_id = self._resolve_player_combatant_id(participants)
            self._combat_active = True
            self._last_injected_payloads.clear()
            self._toll_paid.clear()
        else:
            if participants:
                for pid, participant in participants.items():
                    if pid not in self._combat_state.participants:
                        self._combat_state.participants[pid] = participant
                if self._player_combatant_id is None:
                    self._player_combatant_id = self._resolve_player_combatant_id(
                        self._combat_state.participants
                    )
            self._combat_state.round = int(payload.get("round", self._combat_state.round))
            self._combat_state.deadline = payload.get("deadline")
            self._combat_state.last_event = "combat.round_waiting"

        ship_info = payload.get("ship") or {}
        if ship_info and self._combat_state and self._player_combatant_id:
            participant = self._combat_state.participants.get(self._player_combatant_id)
            if participant is not None:
                participant.fighters = _coerce_int(ship_info.get("fighters"), participant.fighters)
                participant.max_fighters = _coerce_int(ship_info.get("max_fighters"), participant.max_fighters)
                participant.shields = _coerce_int(ship_info.get("shields"), participant.shields)
                participant.max_shields = _coerce_int(ship_info.get("max_shields"), participant.max_shields)

        # Update garrison participant if present
        if self._combat_state and garrison_data and isinstance(garrison_data, Mapping):
            sector = self._combat_state.sector
            fighters = garrison_data.get("fighters")
            if sector is not None and fighters is not None:
                owner_name = garrison_data.get("owner_name") or "garrison"
                garrison_id = f"garrison:{sector}:{owner_name}"
                garrison_participant = self._combat_state.participants.get(garrison_id)
                if garrison_participant is not None:
                    garrison_participant.fighters = int(fighters)

        await self._enqueue_combat_event("combat.round_waiting", payload)

        async with self._combat_condition:
            self._combat_condition.notify_all()

    async def _on_combat_round_resolved(self, payload: Dict[str, Any]) -> None:
        """Handle combat.round_resolved event.

        Note: Server sends participants as array format (same as round_waiting).
        Legacy format had fighters_remaining/shields_remaining dicts - new format doesn't.
        """
        if not self._combat_state or payload.get("combat_id") != self._combat_state.combat_id:
            return

        ship_info = payload.get("ship") or {}
        if ship_info and self._player_combatant_id:
            participant = self._combat_state.participants.get(self._player_combatant_id)
            if participant is not None:
                participant.fighters = _coerce_int(ship_info.get("fighters"), participant.fighters)
                participant.max_fighters = _coerce_int(ship_info.get("max_fighters"), participant.max_fighters)
                participant.shields = _coerce_int(ship_info.get("shields"), participant.shields)
                participant.max_shields = _coerce_int(ship_info.get("max_shields"), participant.max_shields)

        # Update garrison participant if present
        garrison_data = payload.get("garrison")
        if garrison_data and isinstance(garrison_data, Mapping):
            sector = self._combat_state.sector
            fighters = garrison_data.get("fighters")
            if sector is not None and fighters is not None:
                owner_name = garrison_data.get("owner_name") or "garrison"
                garrison_id = f"garrison:{sector}:{owner_name}"
                garrison_participant = self._combat_state.participants.get(garrison_id)
                if garrison_participant is not None:
                    garrison_participant.fighters = int(fighters)

        for gid in list(self._toll_paid):
            participant = self._combat_state.participants.get(gid)
            if participant is None or participant.fighters <= 0:
                self._toll_paid.discard(gid)

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

        ship_info = payload.get("ship") or {}
        if ship_info and self._player_combatant_id:
            participant = self._combat_state.participants.get(self._player_combatant_id)
            if participant is not None:
                participant.fighters = _coerce_int(ship_info.get("fighters"), participant.fighters)
                participant.max_fighters = _coerce_int(ship_info.get("max_fighters"), participant.max_fighters)
                participant.shields = _coerce_int(ship_info.get("shields"), participant.shields)
                participant.max_shields = _coerce_int(ship_info.get("max_shields"), participant.max_shields)

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
