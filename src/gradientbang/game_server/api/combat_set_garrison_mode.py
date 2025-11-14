from __future__ import annotations

from fastapi import HTTPException

from gradientbang.game_server.rpc.events import event_dispatcher
from gradientbang.game_server.api.utils import (
    serialize_garrison_for_client,
    sector_contents,
    build_event_source,
    rpc_success,
    enforce_actor_authorization,
    build_log_context,
)


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    sector = request.get("sector")
    mode = (request.get("mode") or "offensive").lower()
    toll_amount = int(request.get("toll_amount") or 0)

    if not character_id or sector is None:
        raise HTTPException(status_code=400, detail="Missing character_id or sector")

    enforce_actor_authorization(
        world,
        target_character_id=character_id,
        actor_character_id=request.get("actor_character_id"),
        admin_override=bool(request.get("admin_override")),
    )

    if mode not in {"offensive", "defensive", "toll"}:
        raise HTTPException(status_code=400, detail="Invalid garrison mode")

    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail="Character not found")

    character = world.characters[character_id]
    if character.in_hyperspace:
        raise HTTPException(
            status_code=400,
            detail="Character is in hyperspace, cannot set garrison mode",
        )

    if world.garrisons is None:
        raise HTTPException(status_code=503, detail="Garrison system unavailable")

    garrisons = await world.garrisons.list_sector(sector)
    garrison = next((g for g in garrisons if g.owner_id == character_id), None)
    if not garrison:
        raise HTTPException(
            status_code=404, detail="No garrison found for character in this sector"
        )

    updated = await world.garrisons.set_mode(
        sector_id=sector,
        owner_id=character_id,
        mode=mode,
        toll_amount=toll_amount,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Failed to update garrison mode")

    request_id = request.get("request_id") or "missing-request-id"
    garrison_payload = (
        serialize_garrison_for_client(
            world, updated, sector, current_character_id=character_id
        )
        if updated
        else None
    )

    base_context = build_log_context(
        character_id=character_id,
        world=world,
        sector=sector,
    )

    await event_dispatcher.emit(
        "garrison.mode_changed",
        {
            "source": build_event_source("combat.set_garrison_mode", request_id),
            "sector": {"id": sector},
            "garrison": garrison_payload,
        },
        character_filter=[character_id],
        log_context=base_context,
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
            log_context=build_log_context(character_id=cid, world=world, sector=sector),
        )

    return rpc_success()
