import logging
from fastapi import HTTPException

from gradientbang.game_server.api.utils import (
    build_status_payload,
    sector_contents,
    build_event_source,
    rpc_success,
    build_character_moved_payload,
    build_local_map_region,
    build_log_context,
    enforce_actor_authorization,
    emit_garrison_character_moved_event,
)
from gradientbang.game_server.ships import ShipType, get_ship_stats, validate_ship_type
from gradientbang.game_server.rpc.events import event_dispatcher
from gradientbang.game_server.combat.utils import build_character_combatant, serialize_round_waiting_event
from api.combat_initiate import start_sector_combat

logger = logging.getLogger("gradient-bang.api.join")

MAX_LOCAL_MAP_HOPS = 4
MAX_LOCAL_MAP_NODES = 28


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    if character_id is None or character_id == "":
        raise HTTPException(status_code=422, detail="Invalid or missing character_id")

    request_id = request.get("request_id") or "missing-request-id"
    ship_type = request.get("ship_type")
    credits = request.get("credits")
    sector = request.get("sector")
    actor_character_id = request.get("actor_character_id")
    admin_override = bool(request.get("admin_override"))

    enforce_actor_authorization(
        world,
        target_character_id=character_id,
        actor_character_id=actor_character_id,
        admin_override=admin_override,
    )

    registry = getattr(world, "character_registry", None)
    if registry is None:
        raise HTTPException(status_code=500, detail="Character registry unavailable")

    profile = registry.get_profile(character_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Character is not registered")

    display_name = profile.name

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

        from gradientbang.game_server.core.world import Character

        if not has_saved:
            ship_type_enum = ShipType.KESTREL_COURIER
            if ship_type:
                validated_ship_type = validate_ship_type(ship_type)
                if not validated_ship_type:
                    raise HTTPException(
                        status_code=400, detail=f"Invalid ship type: {ship_type}"
                    )
                ship_type_enum = validated_ship_type
            world.knowledge_manager.create_ship_for_character(
                character_id,
                ship_type_enum,
                sector=start_sector,
                credits=credits,
            )
            knowledge = world.knowledge_manager.load_knowledge(character_id)
        else:
            knowledge = knowledge or world.knowledge_manager.load_knowledge(
                character_id
            )

        ship = world.knowledge_manager.get_ship(character_id)
        player_type = "human"
        if ship and ship.get("ship_id") == character_id and ship.get("owner_type") == "corporation":
            player_type = "corporation_ship"
        ship_stats = get_ship_stats(ShipType(ship["ship_type"]))
        ship_state = ship.get("state", {})
        character = Character(
            character_id,
            sector=start_sector,
            name=display_name,
            fighters=ship_state.get("fighters", ship_stats.fighters),
            shields=ship_state.get("shields", ship_stats.shields),
            max_fighters=ship_stats.fighters,
            max_shields=ship_stats.shields,
            player_type=player_type,
            connected=True,
            in_hyperspace=False,  # Ensure character is not in hyperspace on join
        )
        world.characters[character_id] = character
        character.update_activity()
        if credits is not None:
            world.knowledge_manager.update_ship_credits(character_id, credits)

    else:
        # special admin path to skip normal move and put a player in a new sector
        # todo: maybe lock this down a bit?
        character = world.characters[character_id]
        character.update_activity()
        character.name = display_name
        knowledge = world.knowledge_manager.load_knowledge(character_id)
        ship = world.knowledge_manager.get_ship(character_id)
        ship_stats = get_ship_stats(ShipType(ship["ship_type"]))
        ship_state = ship.get("state", {})
        player_type = "human"
        if ship and ship.get("ship_id") == character_id and ship.get("owner_type") == "corporation":
            player_type = "corporation_ship"
        character.update_ship_state(
            fighters=ship_state.get("fighters", ship_stats.fighters),
            shields=ship_state.get("shields", ship_stats.shields),
            max_fighters=ship_stats.fighters,
            max_shields=ship_stats.shields,
        )
        character.player_type = player_type
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

                mover_payload = build_character_moved_payload(
                    world,
                    character_id,
                    move_type="teleport",
                    timestamp=character.last_active,
                    knowledge=knowledge,
                    extra_fields={
                        "from_sector": old_sector,
                        "to_sector": sector,
                    },
                )
                arrival_context = build_log_context(
                    character_id=character_id,
                    world=world,
                    sector=sector,
                )
                depart_context = build_log_context(
                    character_id=character_id,
                    world=world,
                    sector=old_sector,
                )
                await event_dispatcher.emit(
                    "character.moved",
                    mover_payload,
                    character_filter=[character_id],
                    log_context=arrival_context,
                )

                observer_payload = build_character_moved_payload(
                    world,
                    character_id,
                    move_type="teleport",
                    timestamp=character.last_active,
                    knowledge=knowledge,
                )

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
                arriving_payload = {
                    **observer_payload,
                    "movement": "arrive",
                    "to_sector": sector,
                }
                if arriving_observers:
                    await event_dispatcher.emit(
                        "character.moved",
                        arriving_payload,
                        character_filter=arriving_observers,
                        log_context=arrival_context,
                    )
                await emit_garrison_character_moved_event(
                    world,
                    event_dispatcher,
                    sector_id=sector,
                    payload=arriving_payload,
                )

                departing_payload = {
                    **observer_payload,
                    "movement": "depart",
                    "from_sector": old_sector,
                }
                if departing_observers:
                    await event_dispatcher.emit(
                        "character.moved",
                        departing_payload,
                        character_filter=departing_observers,
                        log_context=depart_context,
                    )
                await emit_garrison_character_moved_event(
                    world,
                    event_dispatcher,
                    sector_id=old_sector,
                    payload=departing_payload,
                )
            else:
                character.sector = sector
        if credits is not None:
            world.knowledge_manager.update_ship_credits(character_id, credits)

    corp_cache = getattr(world, "character_to_corp", None)
    if isinstance(corp_cache, dict):
        corp_membership = getattr(knowledge, "corporation", None)
        if corp_membership and isinstance(corp_membership, dict):
            corp_id = corp_membership.get("corp_id")
            if corp_id:
                corp_cache[character_id] = corp_id
            else:
                corp_cache.pop(character_id, None)
        else:
            corp_cache.pop(character_id, None)

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
    status_payload["source"] = build_event_source("join", request_id)
    base_log_context = build_log_context(
        character_id=character_id,
        world=world,
        sector=character.sector,
    )

    active_encounter = None
    if world.combat_manager:
        active_encounter = await world.combat_manager.find_encounter_for(character_id)
        if not active_encounter:
            encounter = await world.combat_manager.find_encounter_in_sector(
                character.sector
            )
            if encounter and character_id not in encounter.participants:
                combatant_state = build_character_combatant(world, character_id)
                encounter = await world.combat_manager.add_participant(
                    encounter.combat_id, combatant_state
                )
            active_encounter = encounter
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
            active_encounter = await world.combat_manager.find_encounter_for(
                character_id
            )
            if not active_encounter:
                active_encounter = await world.combat_manager.find_encounter_in_sector(
                    character.sector
                )

    await event_dispatcher.emit(
        "status.snapshot",
        status_payload,
        character_filter=[character_id],
        log_context=base_log_context,
    )

    map_data = await build_local_map_region(
        world,
        character_id=character_id,
        center_sector=character.sector,
        max_hops=MAX_LOCAL_MAP_HOPS,
        max_sectors=MAX_LOCAL_MAP_NODES,
    )
    await event_dispatcher.emit(
        "map.local",
        map_data,
        character_filter=[character_id],
        log_context=base_log_context,
    )

    # Check for active combat and send combat.round_waiting last
    if active_encounter and not active_encounter.ended:
        round_waiting_payload = await serialize_round_waiting_event(
            world,
            active_encounter,
            viewer_id=character_id,
        )
        round_waiting_payload["source"] = build_event_source("join", request_id)

        await event_dispatcher.emit(
            "combat.round_waiting",
            round_waiting_payload,
            character_filter=[character_id],
            log_context=base_log_context,
        )

    return rpc_success()
