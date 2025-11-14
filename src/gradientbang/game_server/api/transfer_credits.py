"""Transfer liquid credits between two characters in the same sector."""

from __future__ import annotations

from contextlib import AsyncExitStack
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException

from gradientbang.game_server.ships import ShipType
from gradientbang.game_server.api.utils import (
    build_event_source,
    build_public_player_data,
    build_status_payload,
    emit_error_event,
    ensure_not_in_combat,
    resolve_sector_character_id,
    rpc_success,
    enforce_actor_authorization,
    build_log_context,
)
from gradientbang.game_server.rpc.events import event_dispatcher


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
            "transfer_credits",
            request_id,
            detail,
        )
    raise HTTPException(status_code=status, detail=detail)


async def handle(request: dict, world, credit_locks) -> dict:  # noqa: D401
    """Handle POST /api/transfer_credits requests."""

    if credit_locks is None:
        raise RuntimeError("transfer_credits requires a credit lock manager")

    from_character_id = request.get("from_character_id")
    to_player_name = request.get("to_player_name")
    amount = request.get("amount")
    request_id = request.get("request_id") or "missing-request-id"

    if not all([from_character_id, amount]):
        raise HTTPException(status_code=400, detail="Missing required parameters")

    enforce_actor_authorization(
        world,
        target_character_id=from_character_id,
        actor_character_id=request.get("actor_character_id"),
        admin_override=bool(request.get("admin_override")),
    )

    if not isinstance(to_player_name, str) or not to_player_name.strip():
        raise HTTPException(
            status_code=400,
            detail="transfer_credits requires to_player_name",
        )

    if not isinstance(amount, int) or amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be a positive integer")

    if from_character_id not in world.characters:
        raise HTTPException(status_code=404, detail=f"Source character not found: {from_character_id}")

    to_character_id = resolve_sector_character_id(
        world,
        source_character_id=from_character_id,
        to_player_name=to_player_name,
        endpoint="transfer_credits",
    )

    if from_character_id == to_character_id:
        raise HTTPException(status_code=400, detail="Cannot transfer credits to yourself")

    from_character = world.characters[from_character_id]
    to_character = world.characters[to_character_id]

    if from_character.in_hyperspace:
        raise HTTPException(status_code=400, detail="Sender is in hyperspace, cannot transfer credits")
    if to_character.in_hyperspace:
        raise HTTPException(status_code=400, detail="Receiver is in hyperspace, cannot transfer credits")

    if from_character.sector != to_character.sector:
        raise HTTPException(status_code=400, detail="Characters must be in the same sector")

    await ensure_not_in_combat(world, from_character_id)
    await ensure_not_in_combat(world, to_character_id)

    # Lock both credit balances in a deterministic order to prevent deadlocks
    lock_order = sorted({from_character_id, to_character_id})

    async with AsyncExitStack() as stack:
        for cid in lock_order:
            await stack.enter_async_context(credit_locks.lock(cid))

        from_ship = world.knowledge_manager.get_ship(from_character_id)
        to_ship = world.knowledge_manager.get_ship(to_character_id)

        from_ship_id = from_ship["ship_id"]
        to_ship_id = to_ship["ship_id"]

        from_balance_before = int(from_ship.get("state", {}).get("credits", 0))
        if from_balance_before < amount:
            await _fail(
                from_character_id,
                request_id,
                f"Insufficient credits. {from_character_id} only has {from_balance_before}",
            )

        if ShipType(to_ship["ship_type"]) == ShipType.ESCAPE_POD:
            await _fail(
                to_character_id,
                request_id,
                "Cannot transfer credits to an escape pod",
            )

        to_balance_before = int(to_ship.get("state", {}).get("credits", 0))

        world.ships_manager.transfer_credits_between_ships(from_ship_id, to_ship_id, amount)

    timestamp = datetime.now(timezone.utc).isoformat()

    sender_context = build_log_context(
        character_id=from_character_id,
        world=world,
        sector=from_character.sector,
    )
    receiver_context = build_log_context(
        character_id=to_character_id,
        world=world,
        sector=from_character.sector,
    )

    # Build reusable data for new unified transfer payload
    source = build_event_source("transfer_credits", request_id)
    from_player_data = build_public_player_data(world, from_character_id)
    to_player_data = build_public_player_data(world, to_character_id)
    transfer_details = {"credits": amount}
    sector_data = {"id": from_character.sector}

    # Emit to sender with direction="sent"
    await event_dispatcher.emit(
        "credits.transfer",
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
        log_context=sender_context,
    )

    # Emit to receiver with direction="received"
    await event_dispatcher.emit(
        "credits.transfer",
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
        log_context=receiver_context,
    )

    for cid in (from_character_id, to_character_id):
        payload = await build_status_payload(world, cid)
        await event_dispatcher.emit(
            "status.update",
            payload,
            character_filter=[cid],
            log_context=(sender_context if cid == from_character_id else receiver_context),
        )

    return rpc_success()
