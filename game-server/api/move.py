import asyncio
import logging
from typing import Tuple, TYPE_CHECKING

from fastapi import HTTPException

from .utils import (
    sector_contents,
    ensure_not_in_combat,
    player_self,
    ship_self,
    build_local_map_region,
    build_event_source,
    rpc_success,
    build_character_moved_payload,
)
from ships import ShipType, get_ship_stats, ShipStats
from rpc.events import event_dispatcher
from combat.utils import build_character_combatant, serialize_round_waiting_event
from api.combat_initiate import start_sector_combat

if TYPE_CHECKING:
    from core.world import Character
    from character_knowledge import MapKnowledge

logger = logging.getLogger("gradient-bang.api.move")


# Base delay per warp turn. A Kestrel Courier (turns_per_warp=3) takes
# 3 * 0.667 ≈ 2.0 seconds total. Faster ships (Sparrow, turns=2) take
# ~1.3s, slower ships (Atlas, turns=4) take ~2.7s.
MOVE_DELAY = 2.0 / 3  # seconds per warp turn

MAX_LOCAL_MAP_HOPS = 4
MAX_LOCAL_MAP_NODES = 28


def parse_move_destination(request: dict) -> int:
    to_sector = request.get("to_sector")
    if to_sector is None and "to" in request:
        to_sector = request.get("to")
    if to_sector is None:
        raise HTTPException(status_code=400, detail="Missing destination sector")
    try:
        to_sector_int = int(to_sector)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=422, detail="Invalid destination sector"
        ) from exc
    if to_sector_int < 0:
        raise HTTPException(status_code=422, detail="Invalid destination sector")
    return to_sector_int


def validate_move_destination(
    world, character_id: str, to_sector: int
) -> Tuple["Character", "MapKnowledge", ShipStats]:
    if not world.universe_graph:
        raise HTTPException(status_code=503, detail="Game world not loaded")

    if character_id not in world.characters:
        raise HTTPException(
            status_code=404,
            detail=f"Character '{character_id}' not found. Join the game first.",
        )

    character = world.characters[character_id]
    current_sector = character.sector

    if to_sector >= world.universe_graph.sector_count:
        raise HTTPException(status_code=400, detail=f"Invalid sector: {to_sector}")

    adjacent_sectors = world.universe_graph.adjacency.get(current_sector, [])
    if to_sector not in adjacent_sectors:
        raise HTTPException(
            status_code=400,
            detail=f"Sector {to_sector} is not adjacent to current sector {current_sector}",
        )

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

    request_id = request.get("request_id")
    await ensure_not_in_combat(world, character_id)

    to_sector = parse_move_destination(request)

    character, knowledge, ship_stats = validate_move_destination(
        world, character_id, to_sector
    )

    # Check character is not already in hyperspace
    if character.in_hyperspace:
        raise HTTPException(
            status_code=400,
            detail="Character is in hyperspace, cannot initiate new move",
        )

    warp_cost = ship_stats.turns_per_warp
    delay_seconds = ship_stats.turns_per_warp * MOVE_DELAY

    # Set in_hyperspace flag BEFORE sector update to prevent race conditions
    character.in_hyperspace = True

    try:
        # Deduct warp power (already validated, won't fail)
        knowledge.ship_config.current_warp_power -= warp_cost
        world.knowledge_manager.save_knowledge(knowledge)

        # Store old sector and update to new sector
        old_sector = character.sector
        character.sector = to_sector
        character.update_activity()

        # Send character.moved with movement: "depart" to old sector observers
        observer_payload = build_character_moved_payload(
            world,
            character_id,
            move_type="normal",
            movement="depart",
            timestamp=character.last_active,
            knowledge=knowledge,
        )
        departing_observers = [
            cid
            for cid, info in world.characters.items()
            if info.sector == old_sector and cid != character_id
        ]
        if departing_observers:
            await event_dispatcher.emit(
                "character.moved",
                observer_payload,
                character_filter=departing_observers,
            )

        logger.info(
            "Character %s entering hyperspace to sector %s (ETA: %.2fs)",
            character_id,
            to_sector,
            delay_seconds,
        )

        # Send movement.start event to the character
        destination_sector_contents = await sector_contents(
            world, to_sector, character_id
        )
        await event_dispatcher.emit(
            "movement.start",
            {
                "sector": destination_sector_contents,
                "hyperspace_time": delay_seconds,
            },
            character_filter=[character_id],
        )

        # Wait for hyperspace transit
        await asyncio.sleep(delay_seconds)

        logger.info(
            "Character %s emerging from hyperspace at sector %s",
            character_id,
            to_sector,
        )

        # Update character activity timestamp after arrival
        character.update_activity()

        # Send movement.complete and map.local events to the character
        # get sector contents again in case things changed
        new_sector_contents = await sector_contents(world, to_sector, character_id)
        await event_dispatcher.emit(
            "movement.complete",
            {
                "player": player_self(world, character_id),
                "ship": ship_self(world, character_id),
                "sector": new_sector_contents,
            },
            character_filter=[character_id],
        )

        # Update sector visit in knowledge manager before sending map data so the
        # newly discovered sector is included in the BFS expansion.
        world.knowledge_manager.update_sector_visit(
            character_id=character_id,
            sector_id=character.sector,
            port=new_sector_contents.get("port"),
            planets=new_sector_contents.get("planets", []),
            adjacent_sectors=new_sector_contents.get("adjacent_sectors", []),
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
        )

        # Check/join combat encounters (if any exist in destination)
        active_encounter = None
        if world.combat_manager:
            active_encounter = await world.combat_manager.find_encounter_for(
                character_id
            )
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

            # Clear hyperspace flag before auto-garrison combat (so character is counted as present)
            character.in_hyperspace = False

            # Execute auto-garrison combat logic
            auto_garrisons = []
            if world.garrisons is not None:
                for garrison in await world.garrisons.list_sector(character.sector):
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
                active_encounter = await world.combat_manager.find_encounter_for(
                    character_id
                )
                if not active_encounter:
                    active_encounter = await world.combat_manager.find_encounter_in_sector(
                        character.sector
                    )

            if active_encounter and not active_encounter.ended:
                round_waiting_payload = await serialize_round_waiting_event(
                    world,
                    active_encounter,
                    viewer_id=character_id,
                )
                if request_id:
                    round_waiting_payload["source"] = build_event_source(
                        "move", request_id
                    )
                await event_dispatcher.emit(
                    "combat.round_waiting",
                    round_waiting_payload,
                    character_filter=[character_id],
                )

        # Send character.moved with movement: "arrive" to new sector observers
        observer_payload = build_character_moved_payload(
            world,
            character_id,
            move_type="normal",
            movement="arrive",
            timestamp=character.last_active,
            knowledge=knowledge,
        )
        arriving_observers = [
            cid
            for cid, info in world.characters.items()
            if info.sector == to_sector
            and cid != character_id
            and not info.in_hyperspace
        ]
        if arriving_observers:
            await event_dispatcher.emit(
                "character.moved",
                observer_payload,
                character_filter=arriving_observers,
            )

        # Return minimal RPC acknowledgment; movement.complete carries status payload
        return rpc_success()
    finally:
        # Always clear hyperspace flag, even if move fails
        if character_id in world.characters:
            world.characters[character_id].in_hyperspace = False
            logger.debug("Cleared in_hyperspace flag for %s", character_id)
