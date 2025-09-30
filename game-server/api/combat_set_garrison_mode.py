from __future__ import annotations

from fastapi import HTTPException

from events import event_dispatcher



async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    sector = request.get("sector")
    mode = (request.get("mode") or "offensive").lower()
    toll_amount = int(request.get("toll_amount") or 0)

    if not character_id or sector is None:
        raise HTTPException(status_code=400, detail="Missing character_id or sector")

    if mode not in {"offensive", "defensive", "toll"}:
        raise HTTPException(status_code=400, detail="Invalid garrison mode")

    if world.garrisons is None:
        raise HTTPException(status_code=503, detail="Garrison system unavailable")

    garrisons = await world.garrisons.list_sector(sector)
    garrison = next((g for g in garrisons if g.owner_id == character_id), None)
    if not garrison:
        raise HTTPException(status_code=404, detail="No garrison found for character in this sector")

    updated = await world.garrisons.set_mode(
        sector_id=sector,
        owner_id=character_id,
        mode=mode,
        toll_amount=toll_amount,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Failed to update garrison mode")

    await event_dispatcher.emit(
        "sector.garrison_updated",
        {
            "sector": sector,
            "garrisons": await world.garrisons.to_payload(sector) if world.garrisons else [],
        },
        character_filter=[character_id],
    )

    return {
        "sector": sector,
        "garrison": updated.to_dict(),
    }
