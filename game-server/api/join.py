import logging
from fastapi import HTTPException

from .utils import build_status_payload, sector_contents
from ships import ShipType, get_ship_stats, validate_ship_type
from rpc.events import event_dispatcher
from combat.utils import build_character_combatant
from api.combat_initiate import start_sector_combat

logger = logging.getLogger("gradient-bang.api.join")


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    if character_id is None or character_id == "":
        raise HTTPException(status_code=422, detail="Invalid or missing character_id")

    ship_type = request.get("ship_type")
    credits = request.get("credits")
    sector = request.get("sector")

    is_connected = character_id in world.characters
    # Determine if we have prior knowledge on disk
    has_saved = world.knowledge_manager.has_knowledge(character_id)
    knowledge = (
        world.knowledge_manager.load_knowledge(character_id) if has_saved else None
    )
    if not is_connected:
        # Decide the starting sector
        if sector is not None:
            start_sector = sector
        elif has_saved:
            # Use last known sector if available
            last_sector = world.knowledge_manager.get_current_sector(character_id)
            start_sector = last_sector if last_sector is not None else 0
        else:
            start_sector = 0

        if start_sector < 0 or start_sector >= world.universe_graph.sector_count:
            raise HTTPException(
                status_code=400, detail=f"Invalid sector: {start_sector}"
            )

        from core.world import Character

        if not has_saved:
            validated_ship_type = None
            if ship_type:
                validated_ship_type = validate_ship_type(ship_type)
                if not validated_ship_type:
                    raise HTTPException(
                        status_code=400, detail=f"Invalid ship type: {ship_type}"
                    )
            world.knowledge_manager.initialize_ship(character_id, validated_ship_type)
            knowledge = world.knowledge_manager.load_knowledge(character_id)
        else:
            knowledge = knowledge or world.knowledge_manager.load_knowledge(
                character_id
            )

        ship_stats = get_ship_stats(ShipType(knowledge.ship_config.ship_type))
        character = Character(
            character_id,
            sector=start_sector,
            fighters=knowledge.ship_config.current_fighters,
            shields=knowledge.ship_config.current_shields,
            max_fighters=ship_stats.fighters,
            max_shields=ship_stats.shields,
            connected=True,
            in_hyperspace=False,  # Ensure character is not in hyperspace on join
        )
        world.characters[character_id] = character
        character.update_activity()
        if credits is not None:
            world.knowledge_manager.update_credits(character_id, credits)

        await event_dispatcher.emit(
            "character.joined",
            {
                "character_id": character_id,
                "sector": start_sector,
                "timestamp": character.last_active.isoformat(),
            },
        )
    else:
        character = world.characters[character_id]
        character.update_activity()
        knowledge = world.knowledge_manager.load_knowledge(character_id)
        ship_stats = get_ship_stats(ShipType(knowledge.ship_config.ship_type))
        character.update_ship_state(
            fighters=knowledge.ship_config.current_fighters,
            shields=knowledge.ship_config.current_shields,
            max_fighters=ship_stats.fighters,
            max_shields=ship_stats.shields,
        )
        character.connected = True
        character.in_hyperspace = (
            False  # Clear hyperspace on rejoin (e.g., after disconnect)
        )
        if sector is not None:
            if sector < 0 or sector >= world.universe_graph.sector_count:
                raise HTTPException(status_code=400, detail=f"Invalid sector: {sector}")
            old_sector = character.sector
            if old_sector != sector:
                character.sector = sector

                mover_payload = {
                    "character_id": character_id,
                    "from_sector": old_sector,
                    "to_sector": sector,
                    "timestamp": character.last_active.isoformat(),
                    "move_type": "teleport",
                }
                await event_dispatcher.emit(
                    "character.moved",
                    mover_payload,
                    character_filter=[character_id],
                )

                observer_payload = {
                    "name": character.id,
                    "ship_type": knowledge.ship_config.ship_type,
                    "timestamp": character.last_active.isoformat(),
                    "move_type": "teleport",
                }

                arriving_observers = [
                    cid
                    for cid, info in world.characters.items()
                    if info.sector == sector and cid != character_id
                ]
                departing_observers = [
                    cid
                    for cid, info in world.characters.items()
                    if info.sector == old_sector and cid != character_id
                ]
                if arriving_observers:
                    await event_dispatcher.emit(
                        "character.moved",
                        {**observer_payload, "movement": "arrive"},
                        character_filter=arriving_observers,
                    )
                if departing_observers:
                    await event_dispatcher.emit(
                        "character.moved",
                        {**observer_payload, "movement": "depart"},
                        character_filter=departing_observers,
                    )
            else:
                character.sector = sector
        if credits is not None:
            world.knowledge_manager.update_credits(character_id, credits)

    contents = await sector_contents(world, character.sector, character_id)
    world.knowledge_manager.update_sector_visit(
        character_id=character_id,
        sector_id=character.sector,
        port=contents.get("port"),
        position=contents.get("position", (0, 0)),
        planets=contents.get("planets", []),
        adjacent_sectors=contents.get("adjacent_sectors", []),
    )
    status_payload = await build_status_payload(world, character_id)

    if world.combat_manager:
        existing_encounter = await world.combat_manager.find_encounter_for(character_id)
        if not existing_encounter:
            encounter = await world.combat_manager.find_encounter_in_sector(
                character.sector
            )
            if encounter and character_id not in encounter.participants:
                combatant_state = build_character_combatant(world, character_id)
                await world.combat_manager.add_participant(
                    encounter.combat_id, combatant_state
                )

        auto_garrisons = []
        if world.garrisons is not None:
            for garrison in await world.garrisons.list_sector(character.sector):
                if garrison.owner_id == character_id:
                    continue
                if garrison.mode == "offensive":
                    auto_garrisons.append(garrison)

        if auto_garrisons:
            logger.info(
                "Auto-engaging sector combat in %s due to garrison encounter.",
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

    # Note: We don't emit map.local here because the RTVI pipeline may not be
    # started yet. Clients should request the map explicitly after they're ready,
    # or rely on move events to trigger map updates.
    return status_payload
