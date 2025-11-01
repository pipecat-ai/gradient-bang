from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException

from ships import ShipType, get_ship_stats
from .utils import (
    rpc_success,
    build_status_payload,
    ensure_not_in_combat,
    resolve_character_name,
)
from rpc.events import event_dispatcher, EventLogContext


PERSONAL_PURCHASE = "personal"
CORPORATION_PURCHASE = "corporation"


async def handle(request: dict, world, credit_locks) -> dict:
    if credit_locks is None:
        raise RuntimeError("ship_purchase requires a credit lock manager")

    character_id = request.get("character_id")
    ship_type_value = request.get("ship_type")
    purchase_type = request.get("purchase_type") or (
        CORPORATION_PURCHASE if request.get("for_corporation") else PERSONAL_PURCHASE
    )
    ship_name = request.get("ship_name")
    trade_in_ship_id = request.get("trade_in_ship_id")

    if not character_id or not ship_type_value:
        raise HTTPException(status_code=400, detail="Missing character_id or ship_type")

    if purchase_type not in {PERSONAL_PURCHASE, CORPORATION_PURCHASE}:
        raise HTTPException(
            status_code=400,
            detail="purchase_type must be 'personal' or 'corporation'",
        )

    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail="Character not found")

    character = world.characters[character_id]
    if getattr(character, "in_hyperspace", False):
        raise HTTPException(status_code=400, detail="Cannot purchase ships in hyperspace")

    await ensure_not_in_combat(world, character_id)

    try:
        ship_type = ShipType(ship_type_value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Unknown ship type: {ship_type_value}") from exc

    ship_stats = get_ship_stats(ship_type)
    now_dt = datetime.now(timezone.utc)
    now_iso = now_dt.isoformat()

    if purchase_type == CORPORATION_PURCHASE:
        return await _purchase_for_corporation(
            request=request,
            world=world,
            credit_locks=credit_locks,
            character=character,
            character_id=character_id,
            ship_stats=ship_stats,
            ship_type=ship_type,
            ship_name=ship_name,
            timestamp=now_dt,
        )

    return await _purchase_for_personal_use(
        request=request,
        world=world,
        credit_locks=credit_locks,
        character=character,
        character_id=character_id,
        ship_stats=ship_stats,
        ship_type=ship_type,
        ship_name=ship_name,
        trade_in_ship_id=trade_in_ship_id,
        timestamp=now_iso,
    )


async def _purchase_for_personal_use(
    request: dict,
    *,
    world,
    credit_locks,
    character,
    character_id: str,
    ship_stats,
    ship_type: ShipType,
    ship_name: str | None,
    trade_in_ship_id: str | None,
    timestamp: str,
) -> dict:
    async with credit_locks.lock(character_id):
        knowledge = world.knowledge_manager.load_knowledge(character_id)
        current_ship_id = knowledge.current_ship_id

        explicit_trade_in = trade_in_ship_id is not None
        candidate_ship_id = trade_in_ship_id if trade_in_ship_id is not None else current_ship_id

        if candidate_ship_id and candidate_ship_id != current_ship_id:
            raise HTTPException(
                status_code=400,
                detail="Trade-in ship must match your current ship",
            )

        trade_in_ship = (
            world.ships_manager.get_ship(candidate_ship_id)
            if candidate_ship_id
            else None
        )

        trade_in_value = 0
        old_ship_type = None
        old_ship_id = None
        should_mark_unowned = False

        if trade_in_ship is not None:
            owner_type = trade_in_ship.get("owner_type")
            owner_id = trade_in_ship.get("owner_id")
            if owner_type == "corporation":
                if explicit_trade_in:
                    raise HTTPException(
                        status_code=400,
                        detail="Cannot trade in a corporation-owned ship",
                    )
                trade_in_ship = None
            elif owner_type == "character" and owner_id != character_id:
                raise HTTPException(
                    status_code=403,
                    detail="Cannot trade in a ship you do not own",
                )
            elif owner_type == "character" and owner_id == character_id:
                should_mark_unowned = True
                try:
                    old_ship_type = ShipType(trade_in_ship["ship_type"])
                    trade_in_value = get_ship_stats(old_ship_type).trade_in_value
                except (KeyError, ValueError):
                    trade_in_value = 0
                old_ship_id = trade_in_ship.get("ship_id")
        elif knowledge.current_ship_id:
            # Current ship missing from store; treat as no trade-in
            old_ship_id = knowledge.current_ship_id

        price = ship_stats.price
        net_cost = max(0, price - trade_in_value)

        credits_before = knowledge.credits
        if credits_before < net_cost:
            raise HTTPException(
                status_code=400,
                detail=f"Insufficient credits (need {net_cost:,})",
            )

        knowledge.credits = credits_before - net_cost
        knowledge.last_update = timestamp

        new_ship_id = world.ships_manager.create_ship(
            ship_type=ship_type.value,
            sector=getattr(character, "sector", 0),
            owner_type="character",
            owner_id=character_id,
            name=ship_name,
        )

        knowledge.current_ship_id = new_ship_id
        world.knowledge_manager.save_knowledge(knowledge)

        if should_mark_unowned and old_ship_id:
            display_name = resolve_character_name(world, character_id)
            world.ships_manager.mark_as_unowned(
                old_ship_id,
                display_name,
            )

        character.update_ship_state(
            fighters=ship_stats.fighters,
            shields=ship_stats.shields,
            max_fighters=ship_stats.fighters,
            max_shields=ship_stats.shields,
        )

        status_payload = await build_status_payload(world, character_id)
        await event_dispatcher.emit(
            "status.update",
            status_payload,
            character_filter=[character_id],
            log_context=EventLogContext(
                sender=character_id,
                sector=getattr(character, "sector", None),
                timestamp=datetime.fromisoformat(timestamp),
            ),
        )

        if should_mark_unowned and old_ship_id and old_ship_type is not None:
            await event_dispatcher.emit(
                "ship.traded_in",
                {
                    "character_id": character_id,
                    "old_ship_id": old_ship_id,
                    "old_ship_type": old_ship_type.value,
                    "new_ship_id": new_ship_id,
                    "new_ship_type": ship_type.value,
                    "trade_in_value": trade_in_value,
                    "price": price,
                    "net_cost": net_cost,
                    "credits_before": credits_before,
                    "credits_after": knowledge.credits,
                    "timestamp": timestamp,
                },
                character_filter=[character_id],
                log_context=EventLogContext(
                    sender=character_id,
                    sector=getattr(character, "sector", None),
                    timestamp=datetime.fromisoformat(timestamp),
                ),
            )

    return rpc_success(
        {
            "ship_id": new_ship_id,
            "ship_type": ship_type.value,
            "net_cost": net_cost,
            "credits_after": knowledge.credits,
        }
    )


async def _purchase_for_corporation(
    request: dict,
    *,
    world,
    credit_locks,
    character,
    character_id: str,
    ship_stats,
    ship_type: ShipType,
    ship_name: str | None,
    timestamp: datetime,
) -> dict:
    corp_id = request.get("corp_id") or world.character_to_corp.get(character_id)
    if not corp_id:
        raise HTTPException(status_code=400, detail="Not in a corporation")

    try:
        corp = world.corporation_manager.load(corp_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Corporation not found") from exc

    if character_id not in corp.get("members", []):
        raise HTTPException(
            status_code=403, detail="Not authorized to purchase for this corporation"
        )

    async with credit_locks.lock(character_id):
        bank_before = world.knowledge_manager.get_bank_credits(character_id)
        price = ship_stats.price
        if bank_before < price:
            raise HTTPException(
                status_code=400,
                detail=f"Insufficient bank balance (need {price:,})",
            )

        bank_after = bank_before - price
        world.knowledge_manager.update_bank_credits(character_id, bank_after)

        new_ship_id = world.ships_manager.create_ship(
            ship_type=ship_type.value,
            sector=getattr(character, "sector", 0),
            owner_type="corporation",
            owner_id=corp_id,
            name=ship_name,
        )

        world.corporation_manager.add_ship(corp_id, new_ship_id)

        status_payload = await build_status_payload(world, character_id)
        await event_dispatcher.emit(
            "status.update",
            status_payload,
            character_filter=[character_id],
            log_context=EventLogContext(
                sender=character_id,
                sector=getattr(character, "sector", None),
                timestamp=timestamp,
                meta={"corporation_id": corp_id},
            ),
        )

    updated_corp = world.corporation_manager.load(corp_id)
    members = list(updated_corp.get("members", []))
    buyer_name = resolve_character_name(world, character_id)

    await event_dispatcher.emit(
        "corporation.ship_purchased",
        {
            "corp_id": corp_id,
            "ship_id": new_ship_id,
            "ship_type": ship_type.value,
            "ship_name": ship_name,
            "purchase_price": ship_stats.price,
            "bank_before": bank_before,
            "bank_after": bank_after,
            "buyer_id": character_id,
            "buyer_name": buyer_name,
            "member_count": len(members),
            "sector": getattr(character, "sector", None),
            "timestamp": timestamp.isoformat(),
        },
        character_filter=members,
        log_context=EventLogContext(
            sender=character_id,
            sector=getattr(character, "sector", None),
            timestamp=timestamp,
            meta={"corporation_id": corp_id},
        ),
    )

    return rpc_success(
        {
            "corp_id": corp_id,
            "ship_id": new_ship_id,
            "ship_type": ship_type.value,
            "bank_after": bank_after,
        }
    )
