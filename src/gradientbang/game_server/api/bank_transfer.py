"""Move credits between ship and megaport bank accounts."""

from __future__ import annotations

from contextlib import AsyncExitStack
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException

from .utils import (
    build_event_source,
    build_status_payload,
    emit_error_event,
    ensure_not_in_combat,
    rpc_success,
    enforce_actor_authorization,
    build_log_context,
)
from rpc.events import event_dispatcher
from core.credits import transfer_credits_to_bank, resolve_character_id_by_name


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

    direction = request.get("direction")
    amount = request.get("amount")
    request_id = request.get("request_id") or "missing-request-id"

    if direction not in VALID_DIRECTIONS:
        raise HTTPException(status_code=400, detail="direction must be 'deposit' or 'withdraw'")

    if not isinstance(amount, int) or amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be a positive integer")

    actor_character_id = request.get("actor_character_id")
    admin_override = bool(request.get("admin_override"))

    if direction == "deposit":
        target_player_name = request.get("target_player_name")
        if not isinstance(target_player_name, str) or not target_player_name.strip():
            raise HTTPException(status_code=400, detail="deposit requires target_player_name")

        target_character_id = resolve_character_id_by_name(world, target_player_name)

        source_ship_id = request.get("ship_id")
        source_character_id = request.get("character_id")

        if source_character_id:
            enforce_actor_authorization(
                world,
                target_character_id=source_character_id,
                actor_character_id=actor_character_id,
                admin_override=admin_override,
            )
        if source_ship_id:
            enforce_actor_authorization(
                world,
                target_character_id=source_ship_id,
                actor_character_id=actor_character_id,
                admin_override=admin_override,
            )

        ship_record: Optional[dict] = None
        owner_character_id: Optional[str] = None

        if source_ship_id:
            ship_record = world.ships_manager.get_ship(source_ship_id)
            if ship_record is None:
                raise HTTPException(status_code=404, detail="Ship not found")
        if source_character_id:
            ship_from_character = world.knowledge_manager.get_ship(source_character_id)
            if ship_from_character is None:
                raise HTTPException(status_code=404, detail="Source character has no active ship")
            if ship_record is None:
                ship_record = ship_from_character
                source_ship_id = ship_from_character.get("ship_id")
            elif ship_from_character.get("ship_id") != ship_record.get("ship_id"):
                raise HTTPException(
                    status_code=400,
                    detail="Character ship_id mismatch; provide either character_id or ship_id",
                )

        if ship_record is None or not source_ship_id:
            raise HTTPException(status_code=400, detail="deposit requires ship_id or character_id")

        if ship_record.get("owner_type") == "character":
            owner_character_id = ship_record.get("owner_id")

        lock_ids = []
        if owner_character_id:
            lock_ids.append(owner_character_id)
        if source_character_id:
            lock_ids.append(source_character_id)
        lock_ids.append(target_character_id)
        lock_ids = sorted({cid for cid in lock_ids if cid})
        fail_character_id = source_character_id or owner_character_id or target_character_id

        if credit_locks is not None and lock_ids:
            async with AsyncExitStack() as stack:
                for cid in lock_ids:
                    await stack.enter_async_context(credit_locks.lock(cid))
                try:
                    deposit_result = transfer_credits_to_bank(
                        world=world,
                        ships_manager=world.ships_manager,
                        amount=amount,
                        target_player_name=target_player_name,
                        target_character_id=target_character_id,
                        source_ship_id=source_ship_id,
                        source_character_id=source_character_id,
                    )
                except ValueError as exc:
                    await _fail(
                        fail_character_id or target_character_id,
                        request_id,
                        str(exc),
                    )
        else:
            try:
                deposit_result = transfer_credits_to_bank(
                    world=world,
                    ships_manager=world.ships_manager,
                    amount=amount,
                    target_player_name=target_player_name,
                    target_character_id=target_character_id,
                    source_ship_id=source_ship_id,
                    source_character_id=source_character_id,
                )
            except ValueError as exc:
                await _fail(
                    fail_character_id or target_character_id,
                    request_id,
                    str(exc),
                )

        ship_credits_before = deposit_result["ship_credits_before"]
        ship_credits_after = deposit_result["ship_credits_after"]
        bank_after = deposit_result["bank_credits_after"]
        bank_before = bank_after - amount
        resolved_source_ship = deposit_result["source_ship_id"]
        resolved_source_character = deposit_result.get("source_character_id")

        timestamp = datetime.now(timezone.utc).isoformat()

        log_context = build_log_context(
            character_id=target_character_id,
            world=world,
            sector=0,
        )

        await event_dispatcher.emit(
            "bank.transaction",
            {
                "source": build_event_source("bank_transfer", request_id),
                "target_character_id": target_character_id,
                "source_character_id": resolved_source_character,
                "ship_id": resolved_source_ship,
                "direction": direction,
                "amount": amount,
                "timestamp": timestamp,
                "ship_credits_before": ship_credits_before,
                "ship_credits_after": ship_credits_after,
                "credits_in_bank_before": bank_before,
                "credits_in_bank_after": bank_after,
            },
            character_filter=[target_character_id],
            log_context=log_context,
        )

        payload = await build_status_payload(world, target_character_id)
        await event_dispatcher.emit(
            "status.update",
            payload,
            character_filter=[target_character_id],
            log_context=log_context,
        )

        if resolved_source_character and resolved_source_character != target_character_id:
            owner_payload = await build_status_payload(world, resolved_source_character)
            owner_context = build_log_context(
                character_id=resolved_source_character,
                world=world,
                sector=0,
            )
            await event_dispatcher.emit(
                "status.update",
                owner_payload,
                character_filter=[resolved_source_character],
                log_context=owner_context,
            )

        return rpc_success(
            {
                "ship_id": resolved_source_ship,
                "target_character_id": target_character_id,
                "ship_credits_after": ship_credits_after,
                "credits_in_bank_after": bank_after,
                "source_character_id": resolved_source_character,
            }
        )

    # Withdraw path (legacy) ---------------------------------------------

    character_id = request.get("character_id")
    if not all([character_id, direction, amount]):
        raise HTTPException(status_code=400, detail="Missing required parameters")

    enforce_actor_authorization(
        world,
        target_character_id=character_id,
        actor_character_id=actor_character_id,
        admin_override=admin_override,
    )

    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail="Character not found")

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
        ship_credits_before = world.knowledge_manager.get_ship_credits(character_id)
        bank_before = world.knowledge_manager.get_bank_credits(character_id)

        if bank_before < amount:
            await _fail(
                character_id,
                request_id,
                f"Insufficient bank balance. Available: {bank_before}",
            )
        new_ship_credits = ship_credits_before + amount
        new_bank = bank_before - amount

        world.knowledge_manager.update_ship_credits(character_id, new_ship_credits)
        world.knowledge_manager.update_bank_credits(character_id, new_bank)

    timestamp = datetime.now(timezone.utc).isoformat()

    log_context = build_log_context(
        character_id=character_id,
        world=world,
        sector=0,
    )

    await event_dispatcher.emit(
        "bank.transaction",
        {
            "source": build_event_source("bank_transfer", request_id),
            "character_id": character_id,
            "sector": {"id": 0},
            "direction": direction,
            "amount": amount,
            "timestamp": timestamp,
            "ship_credits_before": ship_credits_before,
            "ship_credits_after": new_ship_credits,
            "credits_in_bank_before": bank_before,
            "credits_in_bank_after": new_bank,
        },
        character_filter=[character_id],
        log_context=log_context,
    )

    payload = await build_status_payload(world, character_id)
    await event_dispatcher.emit("status.update", payload, character_filter=[character_id], log_context=log_context)

    return rpc_success()
