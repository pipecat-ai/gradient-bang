from __future__ import annotations

from fastapi import HTTPException

from rpc.events import event_dispatcher
from .utils import (
    serialize_garrison_for_client,
    sector_contents,
    build_event_source,
    rpc_success,
    build_status_payload,
)


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    sector = request.get("sector")
    quantity = int(request.get("quantity") or 0)

    if not character_id or sector is None:
        raise HTTPException(status_code=400, detail="Missing character_id or sector")

    if quantity <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be positive")

    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail="Character not found")

    character = world.characters[character_id]
    if character.in_hyperspace:
        raise HTTPException(
            status_code=400,
            detail="Character is in hyperspace, cannot collect fighters",
        )

    if world.garrisons is None:
        raise HTTPException(status_code=503, detail="Garrison system unavailable")

    garrisons = await world.garrisons.list_sector(sector)
    garrison = next((g for g in garrisons if g.owner_id == character_id), None)

    corp_cache = getattr(world, "character_to_corp", None)
    collector_corp = None
    if not garrison and isinstance(corp_cache, dict):
        collector_corp = corp_cache.get(character_id)
        if collector_corp:
            garrison = next(
                (
                    g
                    for g in garrisons
                    if corp_cache.get(getattr(g, "owner_id", None)) == collector_corp
                ),
                None,
            )
    else:
        collector_corp = (
            corp_cache.get(character_id)
            if isinstance(corp_cache, dict)
            else None
        )

    if not garrison:
        raise HTTPException(
            status_code=404,
            detail="No friendly garrison found in this sector",
        )

    if quantity > garrison.fighters:
        raise HTTPException(
            status_code=400, detail="Cannot collect more fighters than stationed"
        )

    owner_id = garrison.owner_id
    owner_corp = (
        corp_cache.get(owner_id)
        if isinstance(corp_cache, dict) and owner_id
        else None
    )

    is_owner = owner_id == character_id
    is_corp_member = bool(collector_corp and collector_corp == owner_corp)

    if not (is_owner or is_corp_member):
        raise HTTPException(
            status_code=403,
            detail="Not your garrison or corporation member's garrison",
        )

    remaining_fighters = garrison.fighters - quantity
    toll_payout = garrison.toll_balance if garrison.mode == "toll" else 0
    if toll_payout > 0:
        current_credits = world.knowledge_manager.get_credits(character_id)
        world.knowledge_manager.update_credits(
            character_id, current_credits + toll_payout
        )
        status_payload = await build_status_payload(world, character_id)
        await event_dispatcher.emit(
            "status.update",
            status_payload,
            character_filter=[character_id],
        )

    updated_garrison = None
    if remaining_fighters > 0:
        updated_garrison = await world.garrisons.deploy(
            sector_id=sector,
            owner_id=owner_id,
            fighters=remaining_fighters,
            mode=garrison.mode,
            toll_amount=garrison.toll_amount,
            toll_balance=0,
        )
    else:
        await world.garrisons.remove(sector, owner_id)

    world.knowledge_manager.adjust_fighters(character_id, quantity)
    updated_ship = world.knowledge_manager.get_ship(character_id)
    ship_state = updated_ship.get("state", {})
    character = world.characters.get(character_id)
    if character:
        character.update_ship_state(
            fighters=ship_state.get("fighters", character.max_fighters),
            max_fighters=character.max_fighters,
        )

    request_id = request.get("request_id") or "missing-request-id"
    garrison_payload = (
        serialize_garrison_for_client(
            world,
            updated_garrison,
            sector,
            current_character_id=character_id,
        )
        if remaining_fighters > 0
        else None
    )

    await event_dispatcher.emit(
        "garrison.collected",
        {
            "source": build_event_source("combat.collect_fighters", request_id),
            "sector": {"id": sector},
            "credits_collected": toll_payout,
            "garrison": garrison_payload,
            "fighters_on_ship": ship_state.get("fighters", 0),
        },
        character_filter=[character_id],
    )

    characters_in_sector = [
        cid
        for cid, char in world.characters.items()
        if char.sector == sector and not char.in_hyperspace
    ]

    for cid in characters_in_sector:
        sector_payload = await sector_contents(world, sector, current_character_id=cid)
        await event_dispatcher.emit(
            "sector.update",
            sector_payload,
            character_filter=[cid],
        )

    return rpc_success()
