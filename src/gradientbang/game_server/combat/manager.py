"""Runtime manager for active combat encounters."""

from __future__ import annotations

import asyncio
import copy
import logging
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass, field, replace
from typing import Awaitable, Callable, Dict, Optional

from gradientbang.game_server.combat.engine import resolve_round
from gradientbang.game_server.combat.models import (
    CombatEncounter,
    CombatRoundLog,
    CombatRoundOutcome,
    CombatantAction,
    RoundAction,
)
from gradientbang.game_server.api.utils import compute_combatant_deltas

RoundResolvedCallback = Callable[[CombatEncounter, CombatRoundOutcome], Awaitable[None]]
RoundWaitingCallback = Callable[[CombatEncounter], Awaitable[None]]
CombatEndedCallback = Callable[[CombatEncounter, CombatRoundOutcome], Awaitable[None]]
PayHandler = Callable[[str, int], Awaitable[bool]]


logger = logging.getLogger("gradient-bang.combat.manager")


TERMINAL_STATES = {"mutual_defeat", "stalemate", "victory", "toll_satisfied"}
MAX_COMPLETED_ENCOUNTERS = 1000  # Maximum completed encounters to keep in memory


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
        on_pay_action: Optional[PayHandler] = None,
    ) -> None:
        self._encounters: Dict[str, CombatEncounter] = {}
        self._completed: Dict[str, CombatEncounter] = {}
        self._registry_lock = asyncio.Lock()  # Lock for encounter registry operations
        self._locks: Dict[str, asyncio.Lock] = {}  # Per-combat locks for fine-grained concurrency
        self._timers: Dict[str, asyncio.Task[None]] = {}
        self._round_timeout = round_timeout
        self._on_round_waiting = on_round_waiting
        self._on_round_resolved = on_round_resolved
        self._on_combat_ended = on_combat_ended
        self._on_pay_action = on_pay_action

    def configure_callbacks(
        self,
        *,
        on_round_waiting: Optional[RoundWaitingCallback] = None,
        on_round_resolved: Optional[RoundResolvedCallback] = None,
        on_combat_ended: Optional[CombatEndedCallback] = None,
        on_pay_action: Optional[PayHandler] = None,
    ) -> None:
        """Update callback hooks at runtime."""

        if on_round_waiting is not None:
            self._on_round_waiting = on_round_waiting
        if on_round_resolved is not None:
            self._on_round_resolved = on_round_resolved
        if on_combat_ended is not None:
            self._on_combat_ended = on_combat_ended
        if on_pay_action is not None:
            self._on_pay_action = on_pay_action

    def _get_lock(self, combat_id: str) -> asyncio.Lock:
        """Get or create a lock for the specified combat_id.

        This enables per-combat locking so independent combats don't serialize on a global lock.
        """
        if combat_id not in self._locks:
            self._locks[combat_id] = asyncio.Lock()
        return self._locks[combat_id]

    async def _process_toll_payment(
        self,
        encounter: CombatEncounter,
        payer_id: str,
        target_id: Optional[str],
    ) -> tuple[bool, Optional[str]]:
        if not isinstance(encounter.context, dict):
            return False, None
        registry = encounter.context.get("toll_registry")
        if not isinstance(registry, dict) or not registry:
            return False, None

        garrison_id = None
        if target_id and target_id in registry:
            garrison_id = target_id
        else:
            for gid in registry.keys():
                garrison_id = gid
                break
        if not garrison_id:
            return False, None

        entry = registry.get(garrison_id)
        if not isinstance(entry, dict):
            return False, None

        amount = int(entry.get("toll_amount", 0))
        owner_id = entry.get("owner_id") if isinstance(entry.get("owner_id"), str) else None

        if amount < 0:
            amount = 0

        if amount > 0:
            if not self._on_pay_action or not await self._on_pay_action(payer_id, amount):
                return False, None

        entry["paid"] = True
        entry["paid_round"] = encounter.round_number
        current_balance = int(entry.get("toll_balance", 0))
        entry["toll_balance"] = current_balance + amount
        payments = entry.setdefault("payments", [])
        if isinstance(payments, list):
            payments.append({
                "payer": payer_id,
                "amount": amount,
                "round": encounter.round_number,
            })

        # Keep garrison source metadata in sync for redeployment bookkeeping
        sources = encounter.context.get("garrison_sources")
        if isinstance(sources, list) and owner_id:
            for source in sources:
                if source.get("owner_id") == owner_id:
                    source["toll_balance"] = entry["toll_balance"]

        return True, garrison_id

    def _check_toll_standdown(self, encounter: CombatEncounter, outcome: CombatRoundOutcome) -> bool:
        if not isinstance(encounter.context, dict):
            return False
        registry = encounter.context.get("toll_registry")
        if not isinstance(registry, dict) or not registry:
            return False

        for garrison_id, entry in registry.items():
            if not entry.get("paid"):
                continue
            paid_round = entry.get("paid_round")
            if paid_round != encounter.round_number:
                continue
            action = outcome.effective_actions.get(garrison_id)
            if action and action.action not in {CombatantAction.BRACE, CombatantAction.PAY}:
                continue
            others_braced = True
            for pid, participant_action in outcome.effective_actions.items():
                if pid == garrison_id:
                    continue
                if participant_action.action not in {CombatantAction.BRACE, CombatantAction.PAY}:
                    others_braced = False
                    break
            if others_braced:
                return True
        return False

    def _require_toll_followup(self, encounter: CombatEncounter) -> bool:
        if not isinstance(encounter.context, dict):
            return False
        registry = encounter.context.get("toll_registry")
        if not isinstance(registry, dict) or not registry:
            return False
        for garrison_id, entry in registry.items():
            if not isinstance(entry, dict):
                continue
            if entry.get("paid"):
                continue
            participant = encounter.participants.get(garrison_id)
            if not participant or participant.fighters <= 0:
                continue

            # Check if the garrison's original target is still present and attackable
            target_id = entry.get("target_id")
            if target_id and isinstance(target_id, str):
                target_state = encounter.participants.get(target_id)
                # If target fled or became unable to fight (e.g., escape pod), end toll demand
                if not target_state or target_state.fighters <= 0 or target_state.max_fighters == 0:
                    continue  # This garrison's toll demand is satisfied/abandoned

            # Check if ANY character with fighters > 0 remains (potential payment source)
            for pid, state in encounter.participants.items():
                if pid == garrison_id:
                    continue
                if state.combatant_type == "character" and state.fighters > 0 and state.max_fighters > 0:
                    return True
        return False


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

        async with self._get_lock(encounter.combat_id):
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
        async with self._get_lock(combat_id):
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

            if action == CombatantAction.PAY:
                success, resolved_target = await self._process_toll_payment(
                    encounter,
                    combatant_id,
                    target_id,
                )
                if not success:
                    logger.info(
                        "Pay action treated as brace: combat_id=%s combatant=%s",
                        combat_id,
                        combatant_id,
                    )
                    action = CombatantAction.BRACE
                    target_id = None
                else:
                    target_id = resolved_target
                    # Any toll garrison that still has an attack queued this round should stand down.
                    if isinstance(encounter.context, dict):
                        registry = encounter.context.get("toll_registry")
                        if isinstance(registry, dict):
                            for gid, entry in registry.items():
                                if not isinstance(entry, dict) or not entry.get("paid"):
                                    continue
                                paid_round = entry.get("paid_round")
                                if paid_round != encounter.round_number:
                                    continue
                                pending = encounter.pending_actions.get(gid)
                                if pending and pending.action == CombatantAction.ATTACK:
                                    encounter.pending_actions[gid] = replace(
                                        pending,
                                        action=CombatantAction.BRACE,
                                        commit=0,
                                        target_id=None,
                                    )
                commit = 0
            elif action == CombatantAction.ATTACK:
                commit = max(0, commit)
            else:
                commit = 0

            encounter.pending_actions[combatant_id] = RoundAction(
                action=action,
                commit=commit,
                target_id=target_id,
                destination_sector=destination_sector,
            )
            if len(encounter.pending_actions) == len(encounter.participants):
                round_to_resolve = True
        if round_to_resolve:
            return await self._resolve_round(combat_id)
        return None

    async def get_encounter(self, combat_id: str) -> Optional[CombatEncounter]:
        async with self._registry_lock:
            encounter = self._encounters.get(combat_id)
            if encounter:
                return encounter
            return self._completed.get(combat_id)

    async def find_encounter_for(self, combatant_id: str) -> Optional[CombatEncounter]:
        async with self._registry_lock:
            for encounter in self._encounters.values():
                if encounter.ended:
                    continue
                if combatant_id in encounter.participants:
                    return encounter
        return None

    async def find_encounter_in_sector(self, sector_id: int) -> Optional[CombatEncounter]:
        async with self._registry_lock:
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
        """Add a participant to an active combat encounter.

        Note: This method does NOT emit combat.round_waiting event.
        Callers are responsible for emitting events at the appropriate time.
        """
        async with self._get_lock(combat_id):
            encounter = self._require_encounter(combat_id)
            if encounter.ended:
                raise ValueError("Cannot add participant to completed encounter")
            if state.combatant_id in encounter.participants:
                return encounter
            encounter.participants[state.combatant_id] = state
        return encounter

    async def cancel_encounter(self, combat_id: str) -> None:
        async with self._get_lock(combat_id):
            encounter = self._encounters.pop(combat_id, None)
            if not encounter:
                encounter = self._completed.pop(combat_id, None)
            if not encounter:
                return
            self._cancel_timer_locked(combat_id)
            # Clean up the lock for this combat
            self._locks.pop(combat_id, None)

    async def emit_round_waiting(self, combat_id: str) -> None:
        async with self._registry_lock:
            encounter = self._encounters.get(combat_id)
        if encounter:
            await self._emit_round_waiting(encounter)

    # ------------------------------------------------------------------
    # Internal mechanics
    # ------------------------------------------------------------------
    async def _resolve_round(self, combat_id: str) -> Optional[CombatRoundOutcome]:
        callbacks = []
        async with self._get_lock(combat_id):
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
            # Save previous state for delta computation (before resolve_round modifies anything)
            previous_encounter = copy.deepcopy(encounter)
            outcome = resolve_round(encounter, action_map)
            round_result = outcome.end_state
            if round_result == "stalemate" and self._require_toll_followup(encounter):
                logger.info(
                    "Toll demand unresolved for combat_id=%s; continuing after stalemate",
                    combat_id,
                )
                round_result = None
                outcome.end_state = None
            logger.info(
                "Round result computed: combat_id=%s round=%s result=%s",
                combat_id,
                encounter.round_number,
                round_result,
            )

            if self._check_toll_standdown(encounter, outcome):
                round_result = "toll_satisfied"
                outcome.end_state = round_result

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

            # Compute deltas after applying updates
            deltas = compute_combatant_deltas(encounter, previous_encounter)
            outcome.participant_deltas = deltas

            for pid, fled in outcome.flee_results.items():
                if not fled:
                    continue
                encounter.participants.pop(pid, None)
                encounter.pending_actions.pop(pid, None)

            encounter.pending_actions.clear()

            # Check if combat should end due to insufficient combatants
            active_participants = [
                (pid, state)
                for pid, state in encounter.participants.items()
                if outcome.fighters_remaining.get(pid, 0) > 0
            ]

            if not round_result and len(active_participants) <= 2:
                should_end = False
                if len(active_participants) == 1:
                    # Only one participant remains - end as stalemate (all others fled)
                    should_end = True
                    logger.info(
                        "Combat ending: only one participant remains after flee: combat_id=%s participant=%s",
                        combat_id,
                        active_participants[0][0],
                    )
                elif len(active_participants) == 2:
                    # Check if garrison + owner (can't fight each other)
                    p1_id, p1_state = active_participants[0]
                    p2_id, p2_state = active_participants[1]

                    if (
                        p1_state.combatant_type == "garrison"
                        and p2_state.combatant_type == "character"
                        and p1_state.owner_character_id == p2_id
                    ) or (
                        p2_state.combatant_type == "garrison"
                        and p1_state.combatant_type == "character"
                        and p2_state.owner_character_id == p1_id
                    ):
                        should_end = True
                        logger.info(
                            "Combat ending: only garrison and owner remain: combat_id=%s participants=%s",
                            combat_id,
                            [p1_id, p2_id],
                        )

                if should_end:
                    round_result = "stalemate"
                    outcome.end_state = "stalemate"

            if _is_terminal_state(round_result):
                encounter.ended = True
                encounter.end_state = round_result
                callbacks.append(("resolved", encounter, outcome))
                callbacks.append(("ended", encounter, outcome))
                self._encounters.pop(combat_id, None)
                self._completed[combat_id] = encounter
                # Evict oldest completed encounter if we exceed max size
                if len(self._completed) > MAX_COMPLETED_ENCOUNTERS:
                    oldest_id = next(iter(self._completed))
                    self._completed.pop(oldest_id)
                    logger.debug(
                        "Evicted oldest completed encounter %s (total: %s)",
                        oldest_id, len(self._completed)
                    )
                schedule_next_timeout = False
            else:
                outcome.end_state = None
                encounter.round_number += 1
                encounter.deadline = self._next_deadline()
                # Don't schedule timeout yet - will do after callbacks to avoid self-cancellation
                callbacks.append(("resolved", encounter, outcome))
                callbacks.append(("waiting", encounter, outcome))
                schedule_next_timeout = True
        tags = [tag for tag, _, _ in callbacks]
        logger.info(
            "Callbacks prepared for combat_id=%s: %s",
            combat_id,
            tags,
        )

        # Emit callbacks outside the lock
        current_task_id = id(asyncio.current_task())
        logger.info(
            "RESOLVE: Starting callbacks for combat_id=%s round=%s task_id=%s",
            combat_id,
            encounter.round_number if callbacks else "N/A",
            current_task_id,
        )
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
                    "RESOLVE: Callback %s completed for combat_id=%s round=%s task_id=%s",
                    tag,
                    enc.combat_id,
                    out.round_number,
                    current_task_id,
                )
            except asyncio.CancelledError:
                import traceback as tb
                logger.warning(
                    "Callback cancelled: combat_id=%s round=%s tag=%s task_id=%s\nStack trace:\n%s",
                    enc.combat_id,
                    out.round_number,
                    tag,
                    current_task_id,
                    "".join(tb.format_stack()),
                )
                # Don't re-raise for resolved callbacks - let waiting/ended continue
                if tag == "ended":
                    logger.info("Re-raising CancelledError for ended callback")
                    raise
                logger.info("Continuing to next callback despite cancellation")
                continue
            except Exception:
                logger.exception(
                    "Callback failure: combat_id=%s round=%s tag=%s",
                    enc.combat_id,
                    out.round_number,
                    tag,
                )
                raise
        logger.info(
            "RESOLVE: All callbacks completed for combat_id=%s round=%s task_id=%s",
            combat_id,
            encounter.round_number if callbacks else "N/A",
            current_task_id,
        )

        # Schedule next timeout AFTER callbacks complete to avoid self-cancellation
        if schedule_next_timeout:
            async with self._get_lock(combat_id):
                # Re-check encounter still exists and needs timeout
                enc = self._encounters.get(combat_id)
                if enc and not enc.ended:
                    logger.info(
                        "RESOLVE: Scheduling next timeout for combat_id=%s round=%s",
                        combat_id,
                        enc.round_number,
                    )
                    self._schedule_timeout_locked(enc)

        return outcome

    async def _timeout_worker(self, combat_id: str, round_number: int, sleep_seconds: float) -> None:
        current = asyncio.current_task()
        try:
            await asyncio.sleep(max(0.0, sleep_seconds))
            async with self._get_lock(combat_id):
                encounter = self._encounters.get(combat_id)
                if (
                    not encounter
                    or encounter.ended
                    or encounter.round_number != round_number
                ):
                    return
            logger.info(
                "TIMEOUT: Firing for combat_id=%s round=%s task_id=%s",
                combat_id,
                round_number,
                id(asyncio.current_task()),
            )
            await self._resolve_round(combat_id)
        except asyncio.CancelledError:
            return
        finally:
            async with self._get_lock(combat_id):
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
            # Don't cancel the current task (would cause self-cancellation)
            current = asyncio.current_task()
            if task is not current:
                task.cancel()
            else:
                logger.debug(
                    "Skipping cancellation of current task for combat_id=%s",
                    combat_id,
                )

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
            await self._on_combat_ended(encounter, outcome)
