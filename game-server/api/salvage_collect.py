from __future__ import annotations

from fastapi import HTTPException
from rpc.events import event_dispatcher
from api.utils import sector_contents, rpc_success, build_event_source
from ships import ShipType

VALID_COMMODITIES = {"quantum_foam", "retro_organics", "neuro_symbolics"}


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    salvage_id = request.get("salvage_id")

    if not character_id or not salvage_id:
        raise HTTPException(status_code=400, detail="Missing character_id or salvage_id")

    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail="Character not found")

    character = world.characters[character_id]
    if character.in_hyperspace:
        raise HTTPException(
            status_code=400,
            detail="Character is in hyperspace, cannot collect salvage",
        )

    if world.salvage_manager is None:
        raise HTTPException(status_code=503, detail="Salvage system unavailable")

    knowledge = world.knowledge_manager.load_knowledge(character_id)
    ship_type = ShipType(knowledge.ship_config.ship_type)
    if ship_type == ShipType.ESCAPE_POD:
        raise HTTPException(status_code=400, detail="Escape pods cannot collect salvage")

    container = world.salvage_manager.claim(salvage_id, character_id)
    if not container:
        raise HTTPException(status_code=404, detail="Salvage not available")

    # Get ship stats for cargo capacity
    from ships import get_ship_stats
    ship_stats = get_ship_stats(ship_type)

    # Calculate available cargo space
    knowledge = world.knowledge_manager.load_knowledge(character_id)
    cargo_used = sum(knowledge.ship_config.cargo.values())
    available_space = ship_stats.cargo_holds - cargo_used

    # Track what we collect vs. what remains
    collected_credits = 0
    collected_cargo = {}
    remaining_cargo = {}
    remaining_scrap = 0

    # Always collect credits (no cargo space needed)
    if container.credits:
        collected_credits = container.credits
        existing = world.knowledge_manager.get_credits(character_id)
        world.knowledge_manager.update_credits(character_id, existing + container.credits)

    # Collect scrap first (highest priority - always collectible as neuro_symbolics)
    if container.scrap and available_space > 0:
        collectible_scrap = min(container.scrap, available_space)
        world.knowledge_manager.update_cargo(character_id, "neuro_symbolics", collectible_scrap)
        collected_cargo["neuro_symbolics"] = collected_cargo.get("neuro_symbolics", 0) + collectible_scrap
        available_space -= collectible_scrap
        remaining_scrap = container.scrap - collectible_scrap
    else:
        remaining_scrap = container.scrap

    # Collect cargo in alphabetical order (deterministic)
    for commodity in sorted(container.cargo.keys()):
        amount = container.cargo[commodity]
        if amount <= 0:
            continue

        if available_space <= 0:
            # No space left, add to remaining
            remaining_cargo[commodity] = amount
            continue

        if commodity in VALID_COMMODITIES:
            # Valid commodity - collect what fits
            collectible = min(amount, available_space)
            world.knowledge_manager.update_cargo(character_id, commodity, collectible)
            collected_cargo[commodity] = collected_cargo.get(commodity, 0) + collectible
            available_space -= collectible

            if amount > collectible:
                remaining_cargo[commodity] = amount - collectible
        else:
            # Unknown commodity - treat as neuro_symbolics scrap
            collectible = min(amount, available_space)
            world.knowledge_manager.update_cargo(character_id, "neuro_symbolics", collectible)
            collected_cargo["neuro_symbolics"] = collected_cargo.get("neuro_symbolics", 0) + collectible
            available_space -= collectible

            if amount > collectible:
                remaining_cargo[commodity] = amount - collectible

    # Determine if salvage should be removed or updated
    salvage_removed = False
    if not remaining_cargo and remaining_scrap == 0:
        # Everything collected - remove salvage
        world.salvage_manager.remove(salvage_id)
        salvage_removed = True
    else:
        # Partial collection - update container and unclaim for others
        world.salvage_manager.update(
            salvage_id,
            cargo=remaining_cargo,
            scrap=remaining_scrap,
            credits=0  # Credits always collected
        )
        world.salvage_manager.unclaim(salvage_id)

    knowledge_after = world.knowledge_manager.load_knowledge(character_id)
    cargo_after = knowledge_after.ship_config.cargo
    credits_after = world.knowledge_manager.get_credits(character_id)

    # Emit salvage.collected event with collection details
    sector_id = character.sector
    request_id = request.get("request_id") or "missing-request-id"

    await event_dispatcher.emit(
        "salvage.collected",
        {
            "source": build_event_source("salvage.collect", request_id),
            "sector": {"id": sector_id},
            "salvage": {
                "salvage_id": salvage_id,
                "original": container.to_dict(),
            },
            "collected": {
                "credits": collected_credits,
                "cargo": collected_cargo,
            },
            "remaining": {
                "cargo": remaining_cargo,
                "scrap": remaining_scrap,
            },
            "salvage_removed": salvage_removed,
            "cargo_after": cargo_after,
            "credits_after": credits_after,
        },
        character_filter=[character_id],
    )

    # Emit sector.update to all characters in the sector
    sector_update_payload = await sector_contents(world, sector_id, current_character_id=None)

    characters_in_sector = [
        cid
        for cid, char in world.characters.items()
        if char.sector == sector_id and not char.in_hyperspace
    ]

    if characters_in_sector:
        await event_dispatcher.emit(
            "sector.update",
            sector_update_payload,
            character_filter=characters_in_sector,
        )

    # Return detailed response
    return {
        "success": True,
        "collected": {
            "credits": collected_credits,
            "cargo": collected_cargo,
        },
        "remaining": {
            "cargo": remaining_cargo,
            "scrap": remaining_scrap,
        },
        "salvage_removed": salvage_removed,
    }
