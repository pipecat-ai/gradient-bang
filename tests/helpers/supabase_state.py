"""Helpers for manipulating Supabase state without hitting gameplay RPCs."""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import httpx
import pytest

from tests.helpers.character import char_id

API_URL = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
REST_URL = f"{API_URL}/rest/v1"



def _service_headers() -> Dict[str, str]:
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not key:
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY is required for Supabase state helpers')
    return {
        'Content-Type': 'application/json',
        'accept': 'application/json',
        'apikey': key,
        'Authorization': f"Bearer {key}",
        'Prefer': 'return=representation',
    }


def _canonical_character_id(value: str) -> str:
    try:
        uuid.UUID(value)
        return value
    except ValueError:
        return char_id(value)


def _fetch_ship_id(character_id: str, headers: Dict[str, str]) -> str:
    resp = httpx.get(
        f"{REST_URL}/characters",
        headers=headers,
        params={'select': 'current_ship_id', 'character_id': f'eq.{character_id}'},
        timeout=15.0,
    )
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        raise AssertionError(f'character {character_id} not found while resetting state')
    ship_id = rows[0].get('current_ship_id')
    if not ship_id:
        raise AssertionError(f'character {character_id} is missing current_ship_id')
    return ship_id


def _patch(table: str, headers: Dict[str, str], params: Dict[str, str], body: Dict[str, Any]) -> None:
    resp = httpx.patch(
        f"{REST_URL}/{table}",
        headers=headers,
        params=params,
        json=body,
        timeout=15.0,
    )
    resp.raise_for_status()


def _upsert(table: str, headers: Dict[str, str], body: Dict[str, Any], key_field: str) -> None:
    """Insert or update a row using Supabase's upsert functionality.

    First tries to delete existing row, then inserts fresh. This avoids
    409 Conflict errors from malformed existing data.
    """
    # Delete existing row if present
    key_value = body.get(key_field)
    if key_value:
        delete_resp = httpx.delete(
            f"{REST_URL}/{table}?{key_field}=eq.{key_value}",
            headers=headers,
            timeout=15.0,
        )
        # Ignore 404 (not found) and 409 (conflict) - both are safe to proceed
        if delete_resp.status_code not in (200, 204, 404, 409):
            delete_resp.raise_for_status()

    # Insert fresh row
    insert_resp = httpx.post(
        f"{REST_URL}/{table}",
        headers={**headers, 'Prefer': 'return=representation'},
        json=body,
        timeout=15.0,
    )
    if not insert_resp.is_success:
        # 409 means row already exists - use PATCH to update it instead
        if insert_resp.status_code == 409:
            print(f"Upsert for {table}: row already exists (409), patching instead")
            _patch(table, headers, {key_field: f'eq.{key_value}'}, body)
            return
        # Include response body for debugging other errors
        print(f"Insert failed for {table}: {insert_resp.status_code} - {insert_resp.text[:500]}")
        insert_resp.raise_for_status()


def _default_map_knowledge(sector: int) -> Dict[str, Any]:
    timestamp = datetime.now(timezone.utc).isoformat()
    return {
        'current_sector': sector,
        'total_sectors_visited': 1,
        'sectors_visited': {
            str(sector): {
                'last_visited': timestamp,
                'adjacent_sectors': [],
                'position': [0, 0],
            },
        },
    }


def reset_character_state(
    character: str,
    *,
    sector: int,
    credits: Optional[int] = None,
    in_hyperspace: bool = False,
    ship_updates: Optional[Dict[str, Any]] = None,
    map_knowledge: Optional[Dict[str, Any]] = None,
    bank_credits: Optional[int] = None,
) -> str:
    """Place a character/ship pair into a known state, creating if necessary."""

    character_id = _canonical_character_id(character)
    headers = _service_headers()

    # Generate deterministic ship_id
    from gradientbang.utils.legacy_ids import deterministic_ship_id
    ship_id = deterministic_ship_id(f"{character}-ship")

    # Handle circular FK: character → ship, ship → character
    # 1. Insert character WITHOUT ship reference first
    knowledge = map_knowledge if map_knowledge is not None else _default_map_knowledge(sector)
    character_data: Dict[str, Any] = {
        'character_id': character_id,
        'name': character,
        'current_ship_id': None,  # Will update after ship exists
        'map_knowledge': knowledge,
        'credits_in_megabank': bank_credits if bank_credits is not None else 0,
        'is_npc': False,
    }

    _upsert('characters', headers, character_data, 'character_id')

    # 2. Insert ship with character reference (now character exists)
    ship_data: Dict[str, Any] = {
        'ship_id': ship_id,
        'owner_id': character_id,
        'owner_character_id': character_id,
        'owner_corporation_id': None,
        'owner_type': 'character',
        'ship_type': 'kestrel_courier',
        'ship_name': f"{character}-ship",
        'current_sector': sector,
        'in_hyperspace': in_hyperspace,
        'credits': credits if credits is not None else 1000,
        'current_fighters': 300,
        'current_shields': 150,
        'current_warp_power': 300,
        'cargo_qf': 0,
        'cargo_ro': 0,
        'cargo_ns': 0,
    }
    if ship_updates:
        ship_data.update(ship_updates)

    _upsert('ship_instances', headers, ship_data, 'ship_id')

    # 3. Update character to link to ship (now ship exists)
    _patch('characters', headers, {'character_id': f'eq.{character_id}'}, {'current_ship_id': ship_id})

    return character_id


def update_ship_state(
    character: str,
    *,
    cargo: Optional[Dict[str, int]] = None,
    credits: Optional[int] = None,
    fighters: Optional[int] = None,
    shields: Optional[int] = None,
    warp_power: Optional[int] = None,
) -> None:
    """Patch ship_instances row for an existing character."""

    character_id = _canonical_character_id(character)
    headers = _service_headers()
    ship_id = _fetch_ship_id(character_id, headers)
    updates: Dict[str, Any] = {}
    if cargo is not None:
        updates['cargo_qf'] = int(cargo.get('quantum_foam', 0))
        updates['cargo_ro'] = int(cargo.get('retro_organics', 0))
        updates['cargo_ns'] = int(cargo.get('neuro_symbolics', 0))
    if credits is not None:
        updates['credits'] = int(credits)
    if fighters is not None:
        updates['current_fighters'] = int(fighters)
    if shields is not None:
        updates['current_shields'] = int(shields)
    if warp_power is not None:
        updates['current_warp_power'] = int(warp_power)
    if not updates:
        return
    _patch('ship_instances', headers, {'ship_id': f'eq.{ship_id}'}, updates)
