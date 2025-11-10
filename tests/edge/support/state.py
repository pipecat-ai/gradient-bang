"""Helpers for manipulating Supabase state without hitting gameplay RPCs."""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import httpx
import pytest

from tests.edge.support.characters import char_id

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
) -> str:
    """Place an existing character/ship pair into a known state without calling join."""

    character_id = _canonical_character_id(character)
    headers = _service_headers()
    ship_id = _fetch_ship_id(character_id, headers)

    updates: Dict[str, Any] = {
        'current_sector': sector,
        'in_hyperspace': in_hyperspace,
    }
    if credits is not None:
        updates['credits'] = credits
    if ship_updates:
        updates.update(ship_updates)

    _patch('ship_instances', headers, {'ship_id': f'eq.{ship_id}'}, updates)

    knowledge = map_knowledge if map_knowledge is not None else _default_map_knowledge(sector)
    _patch('characters', headers, {'character_id': f'eq.{character_id}'}, {'map_knowledge': knowledge})

    return character_id
