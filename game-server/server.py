#!/usr/bin/env python3
"""Gradient Bang WebSocket server with unified event dispatch."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections import deque
from contextlib import asynccontextmanager
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Optional

import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from core.world import lifespan as world_lifespan, world
from api import (
    plot_course as api_plot_course,
    join as api_join,
    move as api_move,
    my_status as api_my_status,
    my_map as api_my_map,
    local_map as api_local_map,
    check_trade as api_check_trade,
    trade as api_trade,
    recharge_warp_power as api_recharge,
    transfer_warp_power as api_transfer,
    reset_ports as api_reset_ports,
    regenerate_ports as api_regen_ports,
    send_message as api_send_message,
    combat_initiate as api_combat_initiate,
    combat_action as api_combat_action,
    combat_status as api_combat_status,
    combat_leave_fighters as api_combat_leave_fighters,
    combat_collect_fighters as api_combat_collect_fighters,
    combat_set_garrison_mode as api_combat_set_garrison_mode,
    salvage_collect as api_salvage_collect,
)
from api.utils import build_status_payload
from core.config import get_world_data_path
from events import EventSink, event_dispatcher
from messaging.store import MessageStore
from schemas.generated_events import ServerEventName
from combat.models import CombatantAction
from combat.utils import serialize_encounter, serialize_round
from ships import ShipType, get_ship_stats

logger = logging.getLogger("gradient-bang.server")
logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def app_lifespan(app: FastAPI):
    async with world_lifespan(app):
        if world.combat_manager:
            world.combat_manager.configure_callbacks(
                on_round_waiting=_combat_round_waiting,
                on_round_resolved=_combat_round_resolved,
                on_combat_ended=_combat_ended,
                on_pay_action=_handle_toll_payment,
            )
        yield


app = FastAPI(title="Gradient Bang", version="0.2.0", lifespan=app_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


RPCHandler = Callable[[Dict[str, Any]], Awaitable[Dict[str, Any]]]


# Initialise messaging store + rate limits for chat
_MESSAGES = MessageStore(get_world_data_path() / "messages")
_RATE_LIMIT_LAST: Dict[str, float] = {}

# Per-character locks for atomic credit operations
_CREDIT_LOCKS: Dict[str, asyncio.Lock] = {}


async def _handle_send_message(payload: Dict[str, Any]) -> Dict[str, Any]:
    def _rate_limit(from_id: str) -> None:
        now = asyncio.get_running_loop().time()
        last = _RATE_LIMIT_LAST.get(from_id, 0.0)
        if now - last < 1.0:
            raise HTTPException(status_code=429, detail="Rate limit 1 msg/sec")
        _RATE_LIMIT_LAST[from_id] = now

    record = await api_send_message.handle(
        payload,
        world,
        _MESSAGES,
        rate_limit_check=_rate_limit,
    )

    public_record = {k: v for k, v in record.items() if k != "from_character_id"}
    name_filter: Optional[Iterable[str]]
    if public_record.get("type") == "direct":
        to_name = public_record.get("to_name")
        from_name = public_record.get("from_name")
        name_filter = [n for n in (to_name, from_name) if n]
    else:
        name_filter = []
    await event_dispatcher.emit(
        "chat.message",
        public_record,
        name_filter=name_filter,
    )
    return {"id": record["id"]}


async def _rpc_server_status(_: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "name": "Gradient Bang",
        "version": "0.2.0",
        "status": "running",
        "sectors": world.universe_graph.sector_count if world.universe_graph else 0,
    }


RPC_HANDLERS: Dict[str, RPCHandler] = {
    "plot_course": lambda payload: api_plot_course.handle(payload, world),
    "join": lambda payload: api_join.handle(payload, world),
    "move": lambda payload: api_move.handle(payload, world),
    "my_status": lambda payload: api_my_status.handle(payload, world),
    "my_map": lambda payload: api_my_map.handle(payload, world),
    "local_map": lambda payload: api_local_map.handle(payload, world),
    "check_trade": lambda payload: api_check_trade.handle(payload, world),
    "trade": lambda payload: api_trade.handle(payload, world),
    "recharge_warp_power": lambda payload: api_recharge.handle(payload, world),
    "transfer_warp_power": lambda payload: api_transfer.handle(payload, world),
    "reset_ports": lambda payload: api_reset_ports.handle(payload, world),
    "regenerate_ports": lambda payload: api_regen_ports.handle(payload, world),
    "send_message": _handle_send_message,
    "combat.initiate": lambda payload: api_combat_initiate.handle(payload, world),
    "combat.action": lambda payload: api_combat_action.handle(payload, world),
    "combat.status": lambda payload: api_combat_status.handle(payload, world),
    "combat.leave_fighters": lambda payload: api_combat_leave_fighters.handle(payload, world),
    "combat.collect_fighters": lambda payload: api_combat_collect_fighters.handle(payload, world),
    "combat.set_garrison_mode": lambda payload: api_combat_set_garrison_mode.handle(payload, world),
    "salvage.collect": lambda payload: api_salvage_collect.handle(payload, world),
    "server_status": _rpc_server_status,
}

def _combat_character_filter(encounter) -> list[str]:
    ids: set[str] = set()
    for state in encounter.participants.values():
        if state.owner_character_id:
            ids.add(state.owner_character_id)
        elif state.combatant_type == "character":
            ids.add(state.combatant_id)
    return list(ids)


def _garrison_commit_for_mode(mode: str, fighters: int) -> int:
    if fighters <= 0:
        return 0
    mode = (mode or "offensive").lower()
    if mode == "defensive":
        return max(1, min(fighters, max(25, fighters // 4)))
    if mode == "toll":
        return max(1, min(fighters, max(50, fighters // 3)))
    return max(1, min(fighters, max(50, fighters // 2)))


async def _handle_toll_payment(payer_id: str, amount: int) -> bool:
    """Handle toll payment with atomic credit operations.

    Uses per-character locking to prevent race conditions between concurrent
    toll payments, trades, or other credit operations.
    """
    if amount <= 0:
        return True

    # Get or create per-character lock
    if payer_id not in _CREDIT_LOCKS:
        _CREDIT_LOCKS[payer_id] = asyncio.Lock()

    async with _CREDIT_LOCKS[payer_id]:
        try:
            credits = world.knowledge_manager.get_credits(payer_id)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Unable to read credits for %s during toll payment: %s", payer_id, exc)
            return False

        if credits < amount:
            logger.info(
                "Toll payment declined for %s (credits=%s, required=%s)",
                payer_id,
                credits,
                amount,
            )
            return False

        world.knowledge_manager.update_credits(payer_id, credits - amount)
        await _emit_status_update(payer_id)
        logger.info("Toll payment accepted: payer=%s amount=%s", payer_id, amount)
        return True


async def _combat_round_waiting(encounter) -> None:
    payload = serialize_encounter(encounter)
    payload["sector"] = encounter.sector_id
    character_filter = _combat_character_filter(encounter)
    logger.info(
        "Emitting combat.round_waiting: combat_id=%s round=%s participants=%s filter=%s",
        encounter.combat_id,
        encounter.round_number,
        list(encounter.participants.keys()),
        character_filter,
    )
    await event_dispatcher.emit(
        "combat.round_waiting",
        payload,
        character_filter=character_filter,
    )
    await _auto_submit_garrisons(encounter)


async def _auto_submit_garrisons(encounter) -> None:
    manager = world.combat_manager
    if not manager:
        return
    garrison_sources: List[dict] = []
    if isinstance(encounter.context, dict):
        ctx = encounter.context
        sources = ctx.get("garrison_sources")
        if isinstance(sources, list):
            garrison_sources = [dict(item) for item in sources]
        else:
            single = ctx.get("garrison_source")
            if isinstance(single, dict):
                garrison_sources = [dict(single)]

    if not isinstance(encounter.context, dict):
        encounter.context = {}
    ctx: dict[str, object] = encounter.context  # type: ignore[assignment]
    toll_registry: dict[str, dict[str, object]] = ctx.setdefault("toll_registry", {})  # type: ignore[arg-type]

    for state in encounter.participants.values():
        if state.combatant_type != "garrison":
            continue
        if state.fighters <= 0:
            continue
        source = next(
            (entry for entry in garrison_sources if entry.get("owner_id") == state.owner_character_id),
            {},
        )
        mode = source.get("mode", "offensive")
        mode = (mode or "offensive").lower()

        if mode != "toll":
            commit = _garrison_commit_for_mode(mode, state.fighters)
            if commit <= 0:
                continue
            target_candidates = [
                participant
                for participant in encounter.participants.values()
                if participant.combatant_type == "character"
                and participant.combatant_id != state.combatant_id
                and participant.fighters > 0
                and participant.owner_character_id != state.owner_character_id
            ]
            if not target_candidates:
                continue
            target_candidates.sort(
                key=lambda participant: (
                    participant.fighters,
                    participant.shields,
                    participant.combatant_id,
                ),
                reverse=True,
            )
            try:
                await manager.submit_action(
                    combat_id=encounter.combat_id,
                    combatant_id=state.combatant_id,
                    action=CombatantAction.ATTACK,
                    commit=commit,
                    target_id=target_candidates[0].combatant_id,
                )
            except ValueError:
                continue
            continue

        # Toll-specific automation
        entry = toll_registry.setdefault(
            state.combatant_id,
            {
                "owner_id": state.owner_character_id,
                "toll_amount": source.get("toll_amount", 0),
                "toll_balance": source.get("toll_balance", 0),
                "target_id": None,
                "paid": False,
                "paid_round": None,
                "demand_round": encounter.round_number,
            },
        )

        # Ensure initial target selection
        if entry.get("target_id") is None:
            initiator_id = ctx.get("initiator") if isinstance(ctx.get("initiator"), str) else None
            if (
                initiator_id
                and initiator_id in encounter.participants
                and encounter.participants[initiator_id].combatant_type == "character"
                and encounter.participants[initiator_id].owner_character_id != state.owner_character_id
                and encounter.participants[initiator_id].fighters > 0
            ):
                entry["target_id"] = initiator_id

            if entry.get("target_id") is None:
                target_candidates = [
                    participant
                    for participant in encounter.participants.values()
                    if participant.combatant_type == "character"
                    and participant.owner_character_id != state.owner_character_id
                    and participant.fighters > 0
                ]
                target_candidates.sort(
                    key=lambda participant: (
                        participant.fighters,
                        participant.shields,
                        participant.combatant_id,
                    ),
                    reverse=True,
                )
                if target_candidates:
                    entry["target_id"] = target_candidates[0].combatant_id

        target_id = entry.get("target_id")
        target_state = (
            encounter.participants.get(target_id) if isinstance(target_id, str) else None
        )

        # First round demand (brace)
        demand_round = entry.setdefault("demand_round", encounter.round_number)
        already_paid = bool(entry.get("paid"))
        paid_round = entry.get("paid_round")
        target_available = bool(target_state and target_state.fighters > 0)

        action = CombatantAction.BRACE
        commit = 0
        submit_target: Optional[str] = None

        if already_paid and (paid_round is None or paid_round <= encounter.round_number):
            action = CombatantAction.BRACE
        elif not already_paid and target_available:
            if encounter.round_number == demand_round:
                action = CombatantAction.BRACE
            else:
                action = CombatantAction.ATTACK
                commit = state.fighters
                submit_target = target_state.combatant_id
        else:
            action = CombatantAction.BRACE

        try:
            await manager.submit_action(
                combat_id=encounter.combat_id,
                combatant_id=state.combatant_id,
                action=action,
                commit=commit,
                target_id=submit_target,
            )
        except ValueError:
            continue


async def _combat_round_resolved(encounter, outcome) -> None:
    logger.debug(
        "_combat_round_resolved start: combat_id=%s round=%s end_state=%s",
        encounter.combat_id,
        outcome.round_number,
        outcome.end_state,
    )
    flee_followups: List[Dict[str, Any]] = []
    recent_flee_ids: List[str] = []
    if outcome.flee_results:
        logger.info(
            "Processing flee_results: %s",
            {pid: fled for pid, fled in outcome.flee_results.items()},
        )
        for pid, fled in outcome.flee_results.items():
            if not fled:
                continue
            action = outcome.effective_actions.get(pid)
            logger.info(
                "Flee successful for %s: action=%s destination_sector=%s",
                pid,
                action,
                getattr(action, "destination_sector", None) if action else None,
            )
            destination = getattr(action, "destination_sector", None) if action else None
            if destination is None:
                logger.warning(
                    "Flee successful for %s but no destination recorded; skipping move.",
                    pid,
                )
                continue
            flee_followups.append(
                {
                    "character_id": pid,
                    "destination": destination,
                    "fighters": outcome.fighters_remaining.get(pid),
                    "shields": outcome.shields_remaining.get(pid),
                }
            )
            recent_flee_ids.append(str(pid))
        logger.info("flee_followups populated: %s entries", len(flee_followups))

    if recent_flee_ids:
        # Accumulate fled character IDs across all rounds so they receive combat.ended
        existing_fled = encounter.context.get("recent_flee_character_ids")
        if isinstance(existing_fled, list):
            # Extend with new fled IDs, avoiding duplicates
            all_fled = list(existing_fled)
            for fid in recent_flee_ids:
                if fid not in all_fled:
                    all_fled.append(fid)
            encounter.context["recent_flee_character_ids"] = all_fled
        else:
            encounter.context["recent_flee_character_ids"] = recent_flee_ids.copy()

    payload = serialize_round(encounter, outcome, include_logs=True)
    payload["combat_id"] = encounter.combat_id
    payload["sector"] = encounter.sector_id
    logger.info(
        "round_resolved payload combat_id=%s round=%s result=%s end=%s",
        encounter.combat_id,
        payload.get("round"),
        payload.get("result"),
        payload.get("end"),
    )
    logger.info("payload dump %s", payload)
    logger.debug(
        "Emitting combat.round_resolved: combat_id=%s round=%s end_state=%s",
        encounter.combat_id,
        outcome.round_number,
        outcome.end_state,
    )
    base_filter = _combat_character_filter(encounter)
    notify_ids = set(base_filter)
    notify_ids.update(recent_flee_ids)
    await event_dispatcher.emit(
        "combat.round_resolved",
        payload,
        character_filter=sorted(notify_ids),
    )
    logger.debug("combat.round_resolved emitted, syncing participants")

    # Sync knowledge + push status updates
    for state in encounter.participants.values():
        owner_id = state.owner_character_id or state.combatant_id
        if state.combatant_type != "character" or not owner_id:
            continue
        logger.debug(
            "Updating knowledge for owner_id=%s fighters=%s shields=%s",
            owner_id,
            state.fighters,
            state.shields,
        )
        world.knowledge_manager.set_fighters(owner_id, state.fighters, max_fighters=state.max_fighters)
        world.knowledge_manager.set_shields(owner_id, state.shields, max_shields=state.max_shields)
        character = world.characters.get(owner_id)
        if character:
            character.update_ship_state(
                fighters=state.fighters,
                shields=state.shields,
                max_fighters=state.max_fighters,
                max_shields=state.max_shields,
            )
        logger.debug("Emitting status update for owner_id=%s", owner_id)
        await _emit_status_update(owner_id)

    for entry in flee_followups:
        character_id = entry["character_id"]
        fighters = entry.get("fighters")
        shields = entry.get("shields")
        if fighters is not None:
            world.knowledge_manager.set_fighters(character_id, fighters)
        if shields is not None:
            world.knowledge_manager.set_shields(character_id, shields)
        character = world.characters.get(character_id)
        if character:
            character.update_ship_state(fighters=fighters, shields=shields)

    # Execute flee movements immediately (now that self-cancellation bug is fixed)
    logger.info("Starting flee movements: %s entries to process", len(flee_followups))
    for entry in flee_followups:
        character_id = entry["character_id"]
        destination = entry["destination"]
        logger.info(
            "Executing flee movement: character=%s from sector=%s to sector=%s",
            character_id,
            encounter.sector_id,
            destination,
        )
        try:
            await api_move.handle(
                {
                    "character_id": character_id,
                    "to_sector": destination,
                },
                world,
            )
            logger.info("Flee movement completed: character=%s now in sector=%s", character_id, destination)
        except HTTPException as exc:  # pragma: no cover - defensive logging
            logger.warning(
                "Failed to move fleeing character %s to sector %s: %s",
                character_id,
                destination,
                exc,
            )
    logger.debug("_combat_round_resolved complete")

async def _combat_ended(encounter, outcome) -> None:
    logger.debug(
        "_combat_ended start: combat_id=%s round=%s result=%s",
        encounter.combat_id,
        outcome.round_number,
        outcome.end_state,
    )
    salvage = await _finalize_combat(encounter, outcome)
    payload = serialize_round(encounter, outcome, include_logs=True)
    payload["combat_id"] = encounter.combat_id
    payload["sector"] = encounter.sector_id
    payload["result"] = outcome.end_state
    if salvage:
        payload["salvage"] = [container.to_dict() for container in salvage]
    logger.debug(
        "Emitting combat.ended: combat_id=%s round=%s result=%s",
        encounter.combat_id,
        outcome.round_number,
        outcome.end_state,
    )
    logger.info(
        "combat.ended payload %s",
        payload,
    )
    base_filter = _combat_character_filter(encounter)
    recent_flee_ids = encounter.context.pop("recent_flee_character_ids", [])
    notify_ids = set(base_filter)
    if isinstance(recent_flee_ids, list):
        notify_ids.update(str(cid) for cid in recent_flee_ids if cid)
    await event_dispatcher.emit(
        "combat.ended",
        payload,
        character_filter=sorted(notify_ids),
    )
    logger.debug("_combat_ended complete: combat_id=%s", encounter.combat_id)



async def _emit_status_update(character_id: str) -> None:
    if character_id not in world.characters:
        logger.debug("_emit_status_update skipped; character %s not connected", character_id)
        return
    logger.debug("_emit_status_update building status for %s", character_id)
    payload = await build_status_payload(world, character_id)
    await event_dispatcher.emit(
        "status.update",
        payload,
        character_filter=[character_id],
    )
    logger.debug("_emit_status_update sent for %s", character_id)


def _resolve_participant_owner(encounter, participant_id: str) -> Optional[str]:
    state = encounter.participants.get(participant_id)
    if not state:
        return None
    return state.owner_character_id or (state.combatant_id if state.combatant_type == "character" else None)


async def _finalize_combat(encounter, outcome):
    salvages = []

    fighters_remaining = outcome.fighters_remaining if outcome.fighters_remaining else {}
    flee_results = outcome.flee_results if outcome.flee_results else {}

    losers = [pid for pid, remaining in fighters_remaining.items() if remaining <= 0]
    winners = [
        pid
        for pid, remaining in fighters_remaining.items()
        if remaining > 0 and not flee_results.get(pid, False)
    ]

    winner_owner = None
    for pid in winners:
        owner = _resolve_participant_owner(encounter, pid)
        if owner:
            winner_owner = owner
            break

    # Reinsert garrisons or record their defeat
    garrison_sources: List[dict] = []
    if isinstance(encounter.context, dict):
        ctx = encounter.context
        sources = ctx.get("garrison_sources")
        if isinstance(sources, list):
            garrison_sources = [dict(item) for item in sources]
        else:
            single = ctx.get("garrison_source")
            if isinstance(single, dict):
                garrison_sources = [dict(single)]

    garrison_lookup = {entry.get("owner_id"): entry for entry in garrison_sources if entry.get("owner_id")}
    notified_owners: set[str] = set()
    toll_winnings: Dict[str, int] = {}

    for pid, state in encounter.participants.items():
        if state.combatant_type != "garrison":
            continue
        owner = state.owner_character_id
        if not owner or not world.garrisons:
            continue

        if state.fighters > 0:
            # Update garrison fighter count using deploy (garrison stays in store)
            source_info = garrison_lookup.get(owner, {})
            mode = source_info.get("mode", "offensive")
            toll_amount = source_info.get("toll_amount", 0)
            toll_balance = source_info.get("toll_balance", 0)
            try:
                await world.garrisons.deploy(
                    sector_id=encounter.sector_id,
                    owner_id=owner,
                    fighters=state.fighters,
                    mode=mode,
                    toll_amount=toll_amount,
                    toll_balance=toll_balance,
                )
                await _emit_status_update(owner)
                notified_owners.add(owner)
            except Exception as exc:
                logger.warning(
                    "Failed to update garrison for owner=%s sector=%s: %s",
                    owner,
                    encounter.sector_id,
                    exc,
                )
        else:
            # Remove destroyed garrison from store
            try:
                await world.garrisons.remove(encounter.sector_id, owner)
                logger.info(
                    "Removed destroyed garrison for owner=%s from sector=%s",
                    owner,
                    encounter.sector_id,
                )
                await _emit_status_update(owner)
                notified_owners.add(owner)
            except Exception:
                # Garrison already removed or never existed in store
                pass

    surviving_garrison_owners = {
        state.owner_character_id
        for state in encounter.participants.values()
        if state.combatant_type == "garrison" and state.owner_character_id and state.fighters > 0
    }

    for source in garrison_sources:
        owner = source.get("owner_id")
        if not owner or owner in surviving_garrison_owners:
            continue
        balance = int(source.get("toll_balance", 0) or 0)
        if balance <= 0 or not winner_owner:
            continue
        toll_winnings[winner_owner] = toll_winnings.get(winner_owner, 0) + balance

    if garrison_sources and world.garrisons:
        await event_dispatcher.emit(
            "sector.garrison_updated",
            {
                "sector": encounter.sector_id,
                "garrisons": await world.garrisons.to_payload(encounter.sector_id),
            },
            character_filter=[source.get("owner_id") for source in garrison_sources if source.get("owner_id")],
        )
        for source in garrison_sources:
            owner = source.get("owner_id")
            if owner and owner not in notified_owners:
                await _emit_status_update(owner)

    for recipient, amount in toll_winnings.items():
        credits = world.knowledge_manager.get_credits(recipient)
        world.knowledge_manager.update_credits(recipient, credits + amount)
        logger.info(
            "Awarded %s toll credits to victor %s from destroyed garrisons",
            amount,
            recipient,
        )
        await _emit_status_update(recipient)

    # Handle defeated characters -> salvage + escape pod conversion
    for loser_pid in losers:
        state = encounter.participants.get(loser_pid)
        if not state or state.combatant_type != "character":
            continue
        owner_id = state.owner_character_id or state.combatant_id
        if not owner_id:
            continue
        knowledge = world.knowledge_manager.load_knowledge(owner_id)
        ship_type = ShipType(knowledge.ship_config.ship_type)
        if ship_type == ShipType.ESCAPE_POD:
            continue
        stats = get_ship_stats(ship_type)
        cargo = {k: v for k, v in knowledge.ship_config.cargo.items() if v > 0}
        credits = world.knowledge_manager.get_credits(owner_id)
        scrap = max(5, stats.price // 1000)

        if winner_owner and credits > 0:
            winner_credits = world.knowledge_manager.get_credits(winner_owner)
            world.knowledge_manager.update_credits(winner_owner, winner_credits + credits)
        world.knowledge_manager.update_credits(owner_id, 0)

        if world.salvage_manager and (cargo or scrap):
            salvages.append(
                world.salvage_manager.create(
                    sector=encounter.sector_id,
                    victor_id=winner_owner,
                    cargo=cargo,
                    scrap=scrap,
                    credits=0,
                    metadata={
                        "loser": owner_id,
                        "ship_type": ship_type.value,
                        "combat_id": encounter.combat_id,
                    },
                )
            )

        world.knowledge_manager.initialize_ship(owner_id, ShipType.ESCAPE_POD)
        await _emit_status_update(owner_id)
        if winner_owner:
            await _emit_status_update(winner_owner)

    return salvages
def _rpc_success(
    frame_id: str, endpoint: str, result: Dict[str, Any]
) -> Dict[str, Any]:
    return {
        "frame_type": "rpc",
        "id": frame_id,
        "endpoint": endpoint,
        "ok": True,
        "result": result,
    }


def _rpc_error(
    frame_id: str, endpoint: str, exc: HTTPException | Exception
) -> Dict[str, Any]:
    status = exc.status_code if isinstance(exc, HTTPException) else 500
    detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
    code = getattr(exc, "code", None)
    payload = {
        "frame_type": "rpc",
        "id": frame_id,
        "endpoint": endpoint,
        "ok": False,
        "error": {"status": status, "detail": detail},
    }
    if code:
        payload["error"]["code"] = code
    return payload


class Connection(EventSink):
    """Represents a connected WebSocket client."""

    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self.connection_id = str(uuid.uuid4())
        self.status_subscriptions: set[str] = set()
        self.known_character_ids: set[str] = set()
        self.controlled_character_ids: set[str] = set()
        self.known_names: set[str] = set()
        self.chat_subscribed = False
        self._send_lock = asyncio.Lock()
        self.character_sectors: dict[str, int] = {}

    async def send_event(self, envelope: dict) -> None:
        logger.debug(
            "Connection %s sending event %s", self.connection_id, envelope.get("event")
        )
        async with self._send_lock:
            await self.websocket.send_json(envelope)
        logger.debug(
            "Connection %s sent event %s", self.connection_id, envelope.get("event")
        )
        if envelope.get("event") == "status.update":
            payload = envelope.get("payload", {})
            sector = payload.get("sector")
            if isinstance(sector, int):
                for character_id in envelope.get("character_filter", []) or []:
                    if character_id:
                        self.character_sectors[str(character_id)] = sector

    def matches_characters(self, character_ids: Iterable[str]) -> bool:
        tracked = self.status_subscriptions | self.known_character_ids
        return any(cid in tracked for cid in character_ids)

    def matches_names(self, names: Iterable[str]) -> bool:
        if not self.chat_subscribed:
            return False
        names = list(names)
        if not names:
            return True
        return any(name in self.known_names for name in names)

    def matches_sectors(self, sectors: Iterable[int]) -> bool:
        sectors = list(sectors)
        if not sectors:
            return True
        return any(
            sector in sectors for sector in self.character_sectors.values()
        )

    def register_character(self, character_id: str | None, name: str | None) -> None:
        if character_id:
            cid = str(character_id)
            self.known_character_ids.add(cid)
            self.status_subscriptions.add(cid)
        if name:
            self.known_names.add(str(name))
        self.chat_subscribed = True


async def _send_initial_status(connection: Connection, character_id: str) -> None:
    if character_id not in world.characters:
        raise HTTPException(
            status_code=404, detail=f"Character '{character_id}' not found"
        )
    payload = await build_status_payload(world, character_id)
    envelope = {
        "frame_type": "event",
        "event": "status.update",
        "payload": payload,
        "gg-action": "status.update",
        "character_filter": [character_id],
    }
    await connection.send_event(envelope)


@app.get("/")
async def root() -> Dict[str, Any]:
    return {
        "name": "Gradient Bang",
        "version": "0.2.0",
        "status": "running",
        "sectors": world.universe_graph.sector_count if world.universe_graph else 0,
    }


# For testing - http://localhost:5173/map-demo.html
@app.get("/api/local_map")
async def local_map_get(center: int = 0, max_hops: int = 3, max_nodes: int = 25):
    if not world.universe_graph:
        return {"node_list": []}

    visited = set()
    queue = deque([(center, 0)])
    nodes_by_id: Dict[int, Dict[str, Any]] = {}

    while queue and len(nodes_by_id) < max_nodes:
        sector_id, distance = queue.popleft()
        if sector_id in visited or distance > max_hops:
            continue

        visited.add(sector_id)
        adjacent = world.universe_graph.adjacency.get(sector_id, [])
        if sector_id not in world.universe_graph.adjacency:
            continue

        port_type = None
        if world.port_manager:
            port_state = world.port_manager.load_port_state(sector_id)
            if port_state:
                port_type = port_state.code

        nodes_by_id[sector_id] = {
            "id": sector_id,
            "visited": True,
            "port_type": port_type,
            "adjacent": adjacent,
        }

        if distance < max_hops:
            for neighbor in adjacent:
                if neighbor not in visited:
                    queue.append((neighbor, distance + 1))

    node_list = []
    for node_id in sorted(nodes_by_id.keys()):
        node = nodes_by_id[node_id]
        node["adjacent"] = [adj for adj in node["adjacent"] if adj in nodes_by_id]
        node_list.append(node)

    return {"node_list": node_list}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    connection = Connection(websocket)
    await event_dispatcher.register(connection)
    logger.info("WebSocket connected id=%s", connection.connection_id)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json(
                    _rpc_error(
                        str(uuid.uuid4()),
                        "unknown",
                        HTTPException(status_code=400, detail="Invalid JSON"),
                    )
                )
                continue

            frame_id = str(frame.get("id") or uuid.uuid4())
            message_type = frame.get("type", "rpc")

            if message_type == "identify":
                name = frame.get("name")
                character_id = frame.get("character_id")
                if not name and not character_id:
                    await websocket.send_json(
                        _rpc_error(
                            frame_id,
                            "identify",
                            HTTPException(
                                status_code=400, detail="Missing name or character_id"
                            ),
                        )
                    )
                    continue
                connection.register_character(character_id, name)
                await websocket.send_json(
                    _rpc_success(frame_id, "identify", {"identified": True})
                )
                continue

            if message_type == "subscribe":
                event_name = frame.get("event")
                if event_name == "status.update":
                    character_id = frame.get("character_id")
                    if not character_id:
                        await websocket.send_json(
                            _rpc_error(
                                frame_id,
                                "subscribe",
                                HTTPException(
                                    status_code=400, detail="Missing character_id"
                                ),
                            )
                        )
                        continue
                    connection.status_subscriptions.add(str(character_id))
                    connection.register_character(character_id, frame.get("name"))
                    await websocket.send_json(
                        _rpc_success(
                            frame_id,
                            "subscribe",
                            {
                                "subscribed": "status.update",
                                "character_id": character_id,
                            },
                        )
                    )
                    try:
                        await _send_initial_status(connection, str(character_id))
                    except HTTPException as exc:
                        await websocket.send_json(
                            _rpc_error(frame_id, "subscribe", exc)
                        )
                    continue
                if event_name == "chat.message":
                    connection.chat_subscribed = True
                    await websocket.send_json(
                        _rpc_success(
                            frame_id, "subscribe", {"subscribed": "chat.message"}
                        )
                    )
                    continue
                await websocket.send_json(
                    _rpc_error(
                        frame_id,
                        "subscribe",
                        HTTPException(
                            status_code=404,
                            detail=f"Unknown event subscription: {event_name}",
                        ),
                    )
                )
                continue

            if message_type != "rpc":
                await websocket.send_json(
                    _rpc_error(
                        frame_id,
                        message_type,
                        HTTPException(
                            status_code=400,
                            detail=f"Unknown frame type: {message_type}",
                        ),
                    )
                )
                continue

            endpoint = frame.get("endpoint")
            payload = frame.get("payload", {})
            handler = RPC_HANDLERS.get(endpoint)
            if not handler:
                await websocket.send_json(
                    _rpc_error(
                        frame_id,
                        endpoint or "unknown",
                        HTTPException(
                            status_code=404, detail=f"Unknown endpoint: {endpoint}"
                        ),
                    )
                )
                continue

            try:
                result = await handler(payload)
                if endpoint in {"join", "my_status"}:
                    # Register the character for subsequent targeted events
                    character_id = payload.get("character_id")
                    if character_id:
                        connection.register_character(character_id, result.get("name"))
                        if endpoint == "join":
                            connection.controlled_character_ids.add(str(character_id))
                await websocket.send_json(_rpc_success(frame_id, endpoint, result))
            except HTTPException as exc:
                await websocket.send_json(_rpc_error(frame_id, endpoint, exc))
            except Exception as exc:  # noqa: BLE001
                logger.exception("RPC handler error endpoint=%s", endpoint)
                await websocket.send_json(_rpc_error(frame_id, endpoint, exc))
    except WebSocketDisconnect:
        logger.info("WebSocket disconnected id=%s", connection.connection_id)
    finally:
        for character_id in connection.controlled_character_ids:
            character = world.characters.get(character_id)
            if character:
                character.connected = False
        await event_dispatcher.unregister(connection)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
