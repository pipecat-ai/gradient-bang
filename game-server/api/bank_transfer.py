"""Move credits between ship and megaport bank accounts."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException

from .utils import (
    build_event_source,
    build_status_payload,
    emit_error_event,
    ensure_not_in_combat,
    rpc_success,
)
from rpc.events import event_dispatcher


VALID_DIRECTIONS = {"deposit", "withdraw"}


async def _fail(character_id: str, request_id: str, detail: str, *, status: int = 400):
    await emit_error_event(
        event_dispatcher,
        character_id,
        "bank_transfer",
        request_id,
        detail,
    )
    raise HTTPException(status_code=status, detail=detail)


async def handle(request: dict, world, credit_locks) -> dict:
    if credit_locks is None:
        raise RuntimeError("bank_transfer requires a credit lock manager")

    character_id = request.get("character_id")
    direction = request.get("direction")
    amount = request.get("amount")
    request_id = request.get("request_id") or "missing-request-id"

    if not all([character_id, direction, amount]):
        raise HTTPException(status_code=400, detail="Missing required parameters")

    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail="Character not found")

    if direction not in VALID_DIRECTIONS:
        raise HTTPException(status_code=400, detail="direction must be 'deposit' or 'withdraw'")

    if not isinstance(amount, int) or amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be a positive integer")

    character = world.characters[character_id]

    if character.in_hyperspace:
        raise HTTPException(status_code=400, detail="Character is in hyperspace, cannot access the bank")

    knowledge_sector = world.knowledge_manager.get_current_sector(character_id)
    knowledge_mismatch = (
        knowledge_sector is not None and knowledge_sector != 0
    )
    if character.sector != 0 or knowledge_mismatch:
        raise HTTPException(status_code=400, detail="Banking operations are only available in sector 0")

    await ensure_not_in_combat(world, character_id)

    async with credit_locks.lock(character_id):
        on_hand_before = world.knowledge_manager.get_credits(character_id)
        bank_before = world.knowledge_manager.get_bank_credits(character_id)

        if direction == "deposit":
            if on_hand_before < amount:
                await _fail(
                    character_id,
                    request_id,
                    f"Insufficient on-hand credits. Available: {on_hand_before}",
                )
            new_on_hand = on_hand_before - amount
            new_bank = bank_before + amount
        else:  # withdraw
            if bank_before < amount:
                await _fail(
                    character_id,
                    request_id,
                    f"Insufficient bank balance. Available: {bank_before}",
                )
            new_on_hand = on_hand_before + amount
            new_bank = bank_before - amount

        world.knowledge_manager.update_credits(character_id, new_on_hand)
        world.knowledge_manager.update_bank_credits(character_id, new_bank)

    timestamp = datetime.now(timezone.utc).isoformat()

    await event_dispatcher.emit(
        "bank.transaction",
        {
            "source": build_event_source("bank_transfer", request_id),
            "character_id": character_id,
            "sector": {"id": 0},
            "direction": direction,
            "amount": amount,
            "timestamp": timestamp,
            "credits_on_hand_before": on_hand_before,
            "credits_on_hand_after": new_on_hand,
            "credits_in_bank_before": bank_before,
            "credits_in_bank_after": new_bank,
        },
        character_filter=[character_id],
    )

    payload = await build_status_payload(world, character_id)
    await event_dispatcher.emit("status.update", payload, character_filter=[character_id])

    return rpc_success()
