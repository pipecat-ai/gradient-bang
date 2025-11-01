"""Convert dumped cargo into salvage containers."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, Mapping, Optional

from fastapi import HTTPException

from .utils import (
    build_event_source,
    build_status_payload,
    emit_error_event,
    ensure_not_in_combat,
    rpc_success,
    sector_contents,
)
from rpc.events import event_dispatcher, EventLogContext

VALID_COMMODITIES = {"quantum_foam", "retro_organics", "neuro_symbolics"}


async def _fail(
    character_id: Optional[str], request_id: str, detail: str, *, status: int = 400
):
    if character_id:
        await emit_error_event(
            event_dispatcher,
            character_id,
            "dump_cargo",
            request_id,
            detail,
        )
    raise HTTPException(status_code=status, detail=detail)


def _parse_manifest(raw_manifest) -> Dict[str, int]:
    manifest: Dict[str, int] = {}
    if isinstance(raw_manifest, Mapping):
        iterator = raw_manifest.items()
    elif isinstance(raw_manifest, list):
        iterator = []
        for entry in raw_manifest:
            if not isinstance(entry, Mapping):
                raise HTTPException(
                    status_code=400, detail="Each item must be an object"
                )
            iterator.append((entry.get("commodity"), entry.get("units")))
    else:
        raise HTTPException(
            status_code=400, detail="cargo/items must be an object or list"
        )

    for commodity, units in iterator:
        if commodity not in VALID_COMMODITIES:
            raise HTTPException(
                status_code=400, detail=f"Invalid commodity: {commodity}"
            )
        if not isinstance(units, int) or units <= 0:
            raise HTTPException(
                status_code=400, detail="Units must be positive integers"
            )
        manifest[commodity] = manifest.get(commodity, 0) + units

    if not manifest:
        raise HTTPException(status_code=400, detail="No cargo specified to dump")

    return manifest


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    raw_manifest = request.get("items") or request.get("cargo")
    request_id = request.get("request_id") or "missing-request-id"

    if not character_id or raw_manifest is None:
        raise HTTPException(
            status_code=400, detail="Missing character_id or cargo manifest"
        )

    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail="Character not found")

    character = world.characters[character_id]
    if character.in_hyperspace:
        raise HTTPException(
            status_code=400, detail="Character is in hyperspace, cannot dump cargo"
        )

    await ensure_not_in_combat(world, character_id)

    salvage_manager = getattr(world, "salvage_manager", None)
    if salvage_manager is None:
        raise HTTPException(status_code=503, detail="Salvage system unavailable")

    manifest = _parse_manifest(raw_manifest)

    ship = world.knowledge_manager.get_ship(character_id)
    state = ship.get("state", {})
    current_cargo = dict(state.get("cargo", {}))

    removed: Dict[str, int] = {}
    for commodity, requested_units in manifest.items():
        available = current_cargo.get(commodity, 0)
        if available <= 0:
            continue
        units_to_dump = min(requested_units, available)
        if units_to_dump <= 0:
            continue
        world.knowledge_manager.update_cargo(character_id, commodity, -units_to_dump)
        removed[commodity] = removed.get(commodity, 0) + units_to_dump

    if not removed:
        await _fail(character_id, request_id, "No cargo available to dump")

    metadata = {
        "ship_name": ship.get("name"),
        "ship_type": ship["ship_type"],
    }

    salvage = salvage_manager.create(
        sector=character.sector,
        cargo=removed,
        scrap=0,
        credits=0,
        metadata=metadata,
    )

    log_context = EventLogContext(sender=character_id, sector=character.sector)
    timestamp = datetime.now(timezone.utc).isoformat()

    # Build standardized salvage.created event (private - only dumper sees it)
    salvage_dict = salvage.to_dict()

    await event_dispatcher.emit(
        "salvage.created",
        {
            "action": "dumped",
            "salvage_details": {
                "salvage_id": salvage_dict["salvage_id"],
                "cargo": salvage_dict["cargo"],
                "scrap": salvage_dict["scrap"],
                "credits": salvage_dict["credits"],
                "expires_at": salvage_dict["expires_at"],
            },
            "sector": {"id": character.sector},
            "timestamp": timestamp,
            "source": build_event_source("dump_cargo", request_id),
        },
        character_filter=[character_id],
        log_context=log_context,
    )

    # Emit status.update after dumping cargo
    status_payload = await build_status_payload(world, character_id)
    await event_dispatcher.emit(
        "status.update",
        status_payload,
        character_filter=[character_id],
        log_context=log_context,
    )

    sector_payload = await sector_contents(
        world, character.sector, current_character_id=None
    )
    characters_in_sector = [
        cid
        for cid, other in world.characters.items()
        if other.sector == character.sector and not other.in_hyperspace
    ]

    if characters_in_sector:
        await event_dispatcher.emit(
            "sector.update",
            sector_payload,
            character_filter=characters_in_sector,
            log_context=log_context,
        )

    return rpc_success()
