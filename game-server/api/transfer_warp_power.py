from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException

from .utils import (
    build_status_payload,
    build_public_player_data,
    rpc_success,
    build_event_source,
    emit_error_event,
    resolve_sector_character_id,
    ensure_not_in_combat,
)
from rpc.events import event_dispatcher, EventLogContext


async def _fail(
    character_id: Optional[str],
    request_id: str,
    detail: str,
    *,
    status: int = 400,
) -> None:
    if character_id:
        await emit_error_event(
            event_dispatcher,
            character_id,
            "transfer_warp_power",
            request_id,
            detail,
        )
    raise HTTPException(status_code=status, detail=detail)


async def handle(request: dict, world) -> dict:
    from_character_id = request.get("from_character_id")
    to_player_name = request.get("to_player_name")
    units = request.get("units")
    request_id = request.get("request_id") or "missing-request-id"

    if not all([from_character_id, units]):
        raise HTTPException(status_code=400, detail="Missing required parameters")
    if not isinstance(to_player_name, str) or not to_player_name.strip():
        raise HTTPException(
            status_code=400,
            detail="transfer_warp_power requires to_player_name",
        )
    if from_character_id not in world.characters:
        raise HTTPException(status_code=404, detail=f"Source character not found: {from_character_id}")
    to_character_id = resolve_sector_character_id(
        world,
        source_character_id=from_character_id,
        to_player_name=to_player_name,
        endpoint="transfer_warp_power",
    )

    from_character = world.characters[from_character_id]
    to_character = world.characters[to_character_id]

    # Prevent self-transfer
    if from_character_id == to_character_id:
        raise HTTPException(status_code=400, detail="Cannot transfer warp power to yourself")

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

    # Block transfers during combat
    await ensure_not_in_combat(world, [from_character_id, to_character_id])

    if from_character.sector != to_character.sector:
        raise HTTPException(status_code=400, detail="Characters must be in the same sector")

    from_ship = world.knowledge_manager.get_ship(from_character_id)
    to_ship = world.knowledge_manager.get_ship(to_character_id)
    from_state = from_ship.get("state", {})
    to_state = to_ship.get("state", {})

    if from_state.get("warp_power", 0) < units:
        await _fail(
            from_character_id,
            request_id,
            f"Insufficient warp power. {from_character_id} only has {from_state.get('warp_power', 0)} units",
        )

    # Capacity limit for receiver
    from ships import ShipType, get_ship_stats
    to_ship_stats = get_ship_stats(ShipType(to_ship["ship_type"]))
    receiver_capacity = to_ship_stats.warp_power_capacity - to_state.get("warp_power", 0)
    units_to_transfer = min(units, receiver_capacity)
    if units_to_transfer <= 0:
        await _fail(
            from_character_id,
            request_id,
            f"{to_character_id}'s warp power is already at maximum",
        )

    world.ships_manager.update_ship_state(
        from_ship["ship_id"],
        warp_power=from_state.get("warp_power", 0) - units_to_transfer,
    )
    world.ships_manager.update_ship_state(
        to_ship["ship_id"],
        warp_power=to_state.get("warp_power", 0) + units_to_transfer,
    )

    timestamp = datetime.now(timezone.utc).isoformat()
    log_context = EventLogContext(sender=from_character_id, sector=from_character.sector)

    # Build reusable data for new unified transfer payload
    source = build_event_source("transfer_warp_power", request_id)
    from_player_data = build_public_player_data(world, from_character_id)
    to_player_data = build_public_player_data(world, to_character_id)
    transfer_details = {"warp_power": units_to_transfer}
    sector_data = {"id": from_character.sector}

    # Emit to sender with direction="sent"
    await event_dispatcher.emit(
        "warp.transfer",
        {
            "transfer_direction": "sent",
            "transfer_details": transfer_details,
            "from": from_player_data,
            "to": to_player_data,
            "sector": sector_data,
            "timestamp": timestamp,
            "source": source,
        },
        character_filter=[from_character_id],
        log_context=log_context,
    )

    # Emit to receiver with direction="received"
    await event_dispatcher.emit(
        "warp.transfer",
        {
            "transfer_direction": "received",
            "transfer_details": transfer_details,
            "from": from_player_data,
            "to": to_player_data,
            "sector": sector_data,
            "timestamp": timestamp,
            "source": source,
        },
        character_filter=[to_character_id],
        log_context=log_context,
    )
    for cid in (from_character_id, to_character_id):
        payload = await build_status_payload(world, cid)
        await event_dispatcher.emit("status.update", payload, character_filter=[cid], log_context=log_context)

    return rpc_success()
