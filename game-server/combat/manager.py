"""Runtime manager for active combat encounters."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Dict, Optional

from .engine import resolve_round
from .models import (
    CombatEncounter,
    CombatRoundLog,
    CombatRoundOutcome,
    CombatantAction,
    RoundAction,
)

RoundResolvedCallback = Callable[[CombatEncounter, CombatRoundOutcome], Awaitable[None]]
RoundWaitingCallback = Callable[[CombatEncounter], Awaitable[None]]
CombatEndedCallback = Callable[[CombatEncounter, CombatRoundOutcome], Awaitable[None]]


logger = logging.getLogger("gradient-bang.combat.manager")


TERMINAL_STATES = {"mutual_defeat", "stalemate", "victory"}


def _is_terminal_state(end_state: str | None) -> bool:
    if not end_state:
        return False
    if end_state in TERMINAL_STATES:
        return True
    return end_state.endswith("_defeated") or end_state.endswith("_fled")


class CombatManager:
    """Coordinates active combats and round deadlines."""

    def __init__(
        self,
        *,
        round_timeout: float = 15.0,
        on_round_waiting: Optional[RoundWaitingCallback] = None,
        on_round_resolved: Optional[RoundResolvedCallback] = None,
        on_combat_ended: Optional[CombatEndedCallback] = None,
    ) -> None:
        self._encounters: Dict[str, CombatEncounter] = {}
        self._completed: Dict[str, CombatEncounter] = {}
        self._lock = asyncio.Lock()
        self._timers: Dict[str, asyncio.Task[None]] = {}
        self._round_timeout = round_timeout
        self._on_round_waiting = on_round_waiting
        self._on_round_resolved = on_round_resolved
        self._on_combat_ended = on_combat_ended

    def configure_callbacks(
        self,
        *,
        on_round_waiting: Optional[RoundWaitingCallback] = None,
        on_round_resolved: Optional[RoundResolvedCallback] = None,
        on_combat_ended: Optional[CombatEndedCallback] = None,
    ) -> None:
        """Update callback hooks at runtime."""

        if on_round_waiting is not None:
            self._on_round_waiting = on_round_waiting
        if on_round_resolved is not None:
            self._on_round_resolved = on_round_resolved
        if on_combat_ended is not None:
            self._on_combat_ended = on_combat_ended


    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    async def start_encounter(
        self,
        encounter: CombatEncounter,
        *,
        emit_waiting: bool = True,
    ) -> CombatEncounter:
        """Register a new encounter and begin waiting for round 1 actions."""

        async with self._lock:
            if encounter.combat_id in self._encounters:
                raise ValueError(f"Combat ID already exists: {encounter.combat_id}")
            self._completed.pop(encounter.combat_id, None)
            if encounter.base_seed is None:
                encounter.base_seed = hash(encounter.combat_id)
            encounter.round_number = 1
            encounter.pending_actions.clear()
            encounter.ended = False
            encounter.end_state = None
            encounter.deadline = self._next_deadline()
            self._encounters[encounter.combat_id] = encounter
            self._schedule_timeout_locked(encounter)

        if emit_waiting:
            await self._emit_round_waiting(encounter)
        return encounter

    async def submit_action(
        self,
        combat_id: str,
        combatant_id: str,
        action: CombatantAction,
        commit: int = 0,
        *,
        target_id: Optional[str] = None,
        destination_sector: Optional[int] = None,
    ) -> Optional[CombatRoundOutcome]:
        """Submit or replace an action for the current round.

        Returns a :class:`CombatRoundOutcome` if the round is resolved by this action.
        """

        round_to_resolve = False
        async with self._lock:
            encounter = self._require_encounter(combat_id)
            if encounter.ended:
                raise ValueError("Combat encounter already ended")
            if combatant_id not in encounter.participants:
                raise ValueError(f"Combatant {combatant_id} not part of encounter {combat_id}")
            if action == CombatantAction.ATTACK:
                if not target_id:
                    raise ValueError("Attack action requires target_id")
                if target_id not in encounter.participants:
                    raise ValueError(f"Target {target_id} not part of encounter {combat_id}")
            else:
                target_id = None

            encounter.pending_actions[combatant_id] = RoundAction(
                action=action,
                commit=max(0, commit),
                target_id=target_id,
                destination_sector=destination_sector,
            )
            if len(encounter.pending_actions) == len(encounter.participants):
                round_to_resolve = True
        if round_to_resolve:
            return await self._resolve_round(combat_id)
        return None

    async def get_encounter(self, combat_id: str) -> Optional[CombatEncounter]:
        async with self._lock:
            encounter = self._encounters.get(combat_id)
            if encounter:
                return encounter
            return self._completed.get(combat_id)

    async def find_encounter_for(self, combatant_id: str) -> Optional[CombatEncounter]:
        async with self._lock:
            for encounter in self._encounters.values():
                if encounter.ended:
                    continue
                if combatant_id in encounter.participants:
                    return encounter
        return None

    async def find_encounter_in_sector(self, sector_id: int) -> Optional[CombatEncounter]:
        async with self._lock:
            for encounter in self._encounters.values():
                if encounter.ended:
                    continue
                if encounter.sector_id == sector_id:
                    return encounter
        return None

    async def add_participant(
        self,
        combat_id: str,
        state: CombatantState,
    ) -> CombatEncounter:
        async with self._lock:
            encounter = self._require_encounter(combat_id)
            if encounter.ended:
                raise ValueError("Cannot add participant to completed encounter")
            if state.combatant_id in encounter.participants:
                return encounter
            encounter.participants[state.combatant_id] = state
        await self._emit_round_waiting(encounter)
        return encounter

    async def cancel_encounter(self, combat_id: str) -> None:
        async with self._lock:
            encounter = self._encounters.pop(combat_id, None)
            if not encounter:
                encounter = self._completed.pop(combat_id, None)
            if not encounter:
                return
            self._cancel_timer_locked(combat_id)

    async def emit_round_waiting(self, combat_id: str) -> None:
        async with self._lock:
            encounter = self._encounters.get(combat_id)
        if encounter:
            await self._emit_round_waiting(encounter)

    # ------------------------------------------------------------------
    # Internal mechanics
    # ------------------------------------------------------------------
    async def _resolve_round(self, combat_id: str) -> Optional[CombatRoundOutcome]:
        callbacks = []
        async with self._lock:
            encounter = self._require_encounter(combat_id)
            if encounter.ended:
                return None

            # Build action map, defaulting to brace on timeouts
            action_map: Dict[str, RoundAction] = {}
            for pid in encounter.participants.keys():
                action = encounter.pending_actions.get(pid)
                if action is None:
                    action = RoundAction(
                        action=CombatantAction.BRACE,
                        commit=0,
                        timed_out=True,
                        destination_sector=None,
                    )
                action_map[pid] = action

            self._cancel_timer_locked(combat_id)

            logger.debug(
                "Resolving round: combat_id=%s round=%s actions=%s",
                combat_id,
                encounter.round_number,
                {pid: action_map[pid].action.value for pid in action_map},
            )
            outcome = resolve_round(encounter, action_map)
            round_result = outcome.end_state
            logger.info(
                "Round result computed: combat_id=%s round=%s result=%s",
                combat_id,
                encounter.round_number,
                round_result,
            )
            setattr(outcome, "round_result", round_result)

            log = CombatRoundLog(
                round_number=encounter.round_number,
                actions=outcome.effective_actions,
                hits=outcome.hits,
                offensive_losses=outcome.offensive_losses,
                defensive_losses=outcome.defensive_losses,
                shield_loss=outcome.shield_loss,
                result=getattr(outcome, "round_result", outcome.end_state),
            )
            encounter.logs.append(log)

            # Apply fighter/shield updates
            for pid, fighters in outcome.fighters_remaining.items():
                state = encounter.participants[pid]
                state.fighters = fighters
                state.shields = outcome.shields_remaining.get(pid, state.shields)

            for pid, fled in outcome.flee_results.items():
                if not fled:
                    continue
                encounter.participants.pop(pid, None)
                encounter.pending_actions.pop(pid, None)

            encounter.pending_actions.clear()

            if _is_terminal_state(round_result):
                encounter.ended = True
                encounter.end_state = round_result
                callbacks.append(("resolved", encounter, outcome))
                callbacks.append(("ended", encounter, outcome))
                self._encounters.pop(combat_id, None)
                self._completed[combat_id] = encounter
            else:
                outcome.end_state = None
                encounter.round_number += 1
                encounter.deadline = self._next_deadline()
                self._schedule_timeout_locked(encounter)
                callbacks.append(("resolved", encounter, outcome))
                callbacks.append(("waiting", encounter, outcome))
        tags = [tag for tag, _, _ in callbacks]
        logger.info(
            "Callbacks prepared for combat_id=%s: %s",
            combat_id,
            tags,
        )

        # Emit callbacks outside the lock
        for tag, enc, out in list(callbacks):
            logger.info("Processing callback entry: tag=%s for combat_id=%s", tag, enc.combat_id)
            logger.info(
                "Callback dispatch: combat_id=%s round=%s tag=%s end_state=%s",
                enc.combat_id,
                out.round_number,
                tag,
                out.end_state,
            )
            try:
                if tag == "resolved":
                    await self._emit_round_resolved(enc, out)
                elif tag == "waiting":
                    await self._emit_round_waiting(enc)
                elif tag == "ended":
                    logger.info(
                        "Dispatching ended callback for combat_id=%s",
                        enc.combat_id,
                    )
                    await self._emit_combat_ended(enc, out)
                logger.info(
                    "Callback completed: combat_id=%s round=%s tag=%s",
                    enc.combat_id,
                    out.round_number,
                    tag,
                )
            except asyncio.CancelledError:
                logger.warning(
                    "Callback cancelled: combat_id=%s round=%s tag=%s",
                    enc.combat_id,
                    out.round_number,
                    tag,
                )
                continue
            except Exception:
                logger.exception(
                    "Callback failure: combat_id=%s round=%s tag=%s",
                    enc.combat_id,
                    out.round_number,
                    tag,
                )
                raise
        return outcome

    async def _timeout_worker(self, combat_id: str, round_number: int, sleep_seconds: float) -> None:
        current = asyncio.current_task()
        try:
            await asyncio.sleep(max(0.0, sleep_seconds))
            async with self._lock:
                encounter = self._encounters.get(combat_id)
                if (
                    not encounter
                    or encounter.ended
                    or encounter.round_number != round_number
                ):
                    return
            await self._resolve_round(combat_id)
        except asyncio.CancelledError:
            return
        finally:
            async with self._lock:
                task = self._timers.get(combat_id)
                if task is current and task.done():
                    self._timers.pop(combat_id, None)

    def _schedule_timeout_locked(self, encounter: CombatEncounter) -> None:
        self._cancel_timer_locked(encounter.combat_id)
        deadline = encounter.deadline or self._next_deadline()
        now = datetime.now(timezone.utc)
        delay = max(0.0, (deadline - now).total_seconds())
        task = asyncio.create_task(
            self._timeout_worker(encounter.combat_id, encounter.round_number, delay)
        )
        self._timers[encounter.combat_id] = task

    def _cancel_timer_locked(self, combat_id: str) -> None:
        task = self._timers.pop(combat_id, None)
        if task and not task.done():
            task.cancel()

    def _next_deadline(self) -> datetime:
        return datetime.now(timezone.utc) + timedelta(seconds=self._round_timeout)

    def _require_encounter(self, combat_id: str) -> CombatEncounter:
        encounter = self._encounters.get(combat_id)
        if not encounter:
            raise ValueError(f"Unknown combat encounter: {combat_id}")
        return encounter

    async def _emit_round_waiting(self, encounter: CombatEncounter) -> None:
        if self._on_round_waiting:
            await self._on_round_waiting(encounter)

    async def _emit_round_resolved(
        self, encounter: CombatEncounter, outcome: CombatRoundOutcome
    ) -> None:
        if self._on_round_resolved:
            await self._on_round_resolved(encounter, outcome)

    async def _emit_combat_ended(
        self, encounter: CombatEncounter, outcome: CombatRoundOutcome
    ) -> None:
        if self._on_combat_ended:
            asyncio.create_task(self._on_combat_ended(encounter, outcome))
