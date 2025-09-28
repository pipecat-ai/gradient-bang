import logging
from typing import Tuple, TYPE_CHECKING

from fastapi import HTTPException

from .utils import sector_contents, build_status_payload, ensure_not_in_combat
from ships import ShipType, get_ship_stats, ShipStats
from events import event_dispatcher
from combat.utils import build_character_combatant
from api.combat_initiate import start_sector_combat

if TYPE_CHECKING:
    from core.world import Character
    from character_knowledge import MapKnowledge

logger = logging.getLogger("gradient-bang.api.move")


def parse_move_destination(request: dict) -> int:
    to_sector = request.get("to_sector")
    if to_sector is None and "to" in request:
        to_sector = request.get("to")
    if to_sector is None:
        raise HTTPException(status_code=400, detail="Missing destination sector")
    try:
        to_sector_int = int(to_sector)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Invalid destination sector") from exc
    if to_sector_int < 0:
        raise HTTPException(status_code=422, detail="Invalid destination sector")
    return to_sector_int


def validate_move_destination(world, character_id: str, to_sector: int) -> Tuple["Character", "MapKnowledge", ShipStats]:
    if not world.universe_graph:
        raise HTTPException(status_code=503, detail="Game world not loaded")

    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail=f"Character '{character_id}' not found. Join the game first.")

    character = world.characters[character_id]
    current_sector = character.sector

    if to_sector >= world.universe_graph.sector_count:
        raise HTTPException(status_code=400, detail=f"Invalid sector: {to_sector}")

    adjacent_sectors = world.universe_graph.adjacency.get(current_sector, [])
    if to_sector not in adjacent_sectors:
        raise HTTPException(status_code=400, detail=f"Sector {to_sector} is not adjacent to current sector {current_sector}")

    knowledge = world.knowledge_manager.load_knowledge(character_id)
    ship_stats = get_ship_stats(ShipType(knowledge.ship_config.ship_type))
    warp_cost = ship_stats.turns_per_warp
    if knowledge.ship_config.current_warp_power < warp_cost:
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient warp power. Need {warp_cost} units but only have {knowledge.ship_config.current_warp_power}",
        )

    return character, knowledge, ship_stats


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    if not character_id:
        raise HTTPException(status_code=400, detail="Missing character_id")

    await ensure_not_in_combat(world, character_id)

    to_sector = parse_move_destination(request)

    character, knowledge, ship_stats = validate_move_destination(world, character_id, to_sector)
    warp_cost = ship_stats.turns_per_warp

    knowledge.ship_config.current_warp_power -= warp_cost
    world.knowledge_manager.save_knowledge(knowledge)

    old_sector = character.sector
    character.sector = to_sector
    character.update_activity()

    contents = sector_contents(world, character.sector, character_id)
    world.knowledge_manager.update_sector_visit(
        character_id=character_id,
        sector_id=character.sector,
        port=contents.get("port"),
        planets=contents.get("planets", []),
        adjacent_sectors=contents.get("adjacent_sectors", []),
    )
    status_payload = build_status_payload(
        world, character_id, sector_snapshot=contents
    )

    if world.combat_manager:
        existing_encounter = await world.combat_manager.find_encounter_for(character_id)
        if not existing_encounter:
            encounter = await world.combat_manager.find_encounter_in_sector(character.sector)
            if encounter and character_id not in encounter.participants:
                combatant_state = build_character_combatant(world, character_id)
                await world.combat_manager.add_participant(encounter.combat_id, combatant_state)

        auto_garrisons = []
        if world.garrisons is not None:
            for garrison in world.garrisons.list_sector(character.sector):
                if garrison.owner_id == character_id:
                    continue
                if garrison.mode in {"offensive", "toll"}:
                    auto_garrisons.append(garrison)

        if auto_garrisons:
            logger.info(
                "Auto-engaging sector combat in %s due to garrison encounter during move.",
                character.sector,
            )
            try:
                await start_sector_combat(
                    world,
                    sector_id=character.sector,
                    initiator_id=character_id,
                    garrisons_to_include=auto_garrisons,
                    reason="garrison_auto",
                )
            except HTTPException as exc:
                logger.warning(
                    "Failed to auto-engage combat in sector %s: %s",
                    character.sector,
                    exc,
                )

    await event_dispatcher.emit(
        "status.update",
        status_payload,
        character_filter=[character_id],
    )

    await event_dispatcher.emit(
        "character.moved",
        {
            "character_id": character_id,
            "from_sector": old_sector,
            "to_sector": to_sector,
            "timestamp": character.last_active.isoformat(),
            "move_type": "normal",
        },
    )

    return status_payload
