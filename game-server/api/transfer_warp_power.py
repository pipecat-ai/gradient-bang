from datetime import datetime, timezone
from fastapi import HTTPException

from .utils import build_status_payload
from rpc.events import event_dispatcher


async def handle(request: dict, world) -> dict:
    from_character_id = request.get("from_character_id")
    to_character_id = request.get("to_character_id")
    units = request.get("units")

    if not all([from_character_id, to_character_id, units]):
        raise HTTPException(status_code=400, detail="Missing required parameters")
    if from_character_id not in world.characters:
        raise HTTPException(status_code=404, detail=f"Source character not found: {from_character_id}")
    if to_character_id not in world.characters:
        raise HTTPException(status_code=404, detail=f"Target character not found: {to_character_id}")

    from_character = world.characters[from_character_id]
    to_character = world.characters[to_character_id]

    if from_character.in_hyperspace:
        raise HTTPException(
            status_code=400,
            detail="Sender is in hyperspace, cannot transfer warp power",
        )
    if to_character.in_hyperspace:
        raise HTTPException(
            status_code=400,
            detail="Receiver is in hyperspace, cannot transfer warp power",
        )

    if from_character.sector != to_character.sector:
        raise HTTPException(status_code=400, detail="Characters must be in the same sector")

    from_knowledge = world.knowledge_manager.load_knowledge(from_character_id)
    to_knowledge = world.knowledge_manager.load_knowledge(to_character_id)

    if from_knowledge.ship_config.current_warp_power < units:
        return {
            "success": False,
            "units_transferred": 0,
            "from_warp_power_remaining": from_knowledge.ship_config.current_warp_power,
            "to_warp_power_current": to_knowledge.ship_config.current_warp_power,
            "message": f"Insufficient warp power. {from_character_id} only has {from_knowledge.ship_config.current_warp_power} units",
        }

    # Capacity limit for receiver
    from ships import ShipType, get_ship_stats
    to_ship_stats = get_ship_stats(ShipType(to_knowledge.ship_config.ship_type))
    receiver_capacity = to_ship_stats.warp_power_capacity - to_knowledge.ship_config.current_warp_power
    units_to_transfer = min(units, receiver_capacity)
    if units_to_transfer <= 0:
        return {
            "success": False,
            "units_transferred": 0,
            "from_warp_power_remaining": from_knowledge.ship_config.current_warp_power,
            "to_warp_power_current": to_knowledge.ship_config.current_warp_power,
            "message": f"{to_character_id}'s warp power is already at maximum",
        }

    from_knowledge.ship_config.current_warp_power -= units_to_transfer
    to_knowledge.ship_config.current_warp_power += units_to_transfer
    world.knowledge_manager.save_knowledge(from_knowledge)
    world.knowledge_manager.save_knowledge(to_knowledge)

    timestamp = datetime.now(timezone.utc).isoformat()

    await event_dispatcher.emit(
        "warp.transfer",
        {
            "from_character_id": from_character_id,
            "to_character_id": to_character_id,
            "sector": {"id": from_character.sector},
            "units": units_to_transfer,
            "timestamp": timestamp,
        },
        character_filter=[from_character_id, to_character_id],
    )

    for cid in (from_character_id, to_character_id):
        payload = await build_status_payload(world, cid)
        await event_dispatcher.emit("status.update", payload, character_filter=[cid])

    return {
        "success": True,
        "units_transferred": units_to_transfer,
        "from_warp_power_remaining": from_knowledge.ship_config.current_warp_power,
        "to_warp_power_current": to_knowledge.ship_config.current_warp_power,
        "message": f"Successfully transferred {units_to_transfer} warp power units from {from_character_id} to {to_character_id}",
    }
