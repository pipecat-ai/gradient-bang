import os
import uuid
from datetime import datetime, timezone

import httpx
import pytest

API_URL = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
EDGE_URL = os.environ.get('EDGE_FUNCTIONS_URL', f"{API_URL}/functions/v1")


def _edge_headers(include_token: bool = True) -> dict:
    anon = os.environ.get('SUPABASE_ANON_KEY', 'anon-key')
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f"Bearer {anon}",
        'apikey': anon,
    }
    if include_token:
        headers['x-api-token'] = os.environ.get('EDGE_API_TOKEN') or os.environ.get('SUPABASE_API_TOKEN', 'local-dev-token')
    return headers


def _service_headers() -> dict:
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not key:
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY is required')
    return {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': f"Bearer {key}",
        'accept': 'application/json',
        'Prefer': 'return=representation',
    }


def _create_character_with_ship(name: str, *, sector: int = 0) -> str:
    character_id = _canonical_id(name)
    _delete_character_if_exists(character_id)
    ship_id = str(uuid.uuid4())
    timestamp = datetime.now(timezone.utc).isoformat()
    map_knowledge = {
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

    ship_payload = {
        'ship_id': ship_id,
        'owner_id': character_id,
        'owner_character_id': character_id,
        'ship_type': 'kestrel_courier',
        'ship_name': f"{name}-ship",
        'current_sector': sector,
        'in_hyperspace': False,
        'credits': 15000,
        'cargo_qf': 0,
        'cargo_ro': 0,
        'cargo_ns': 0,
        'current_warp_power': 250,
        'current_shields': 150,
        'current_fighters': 280,
        'metadata': {},
        'owner_type': 'character',
        'owner_corporation_id': None,
    }

    character_payload = {
        'character_id': character_id,
        'name': name,
        'credits_in_megabank': 20000,
        'map_knowledge': map_knowledge,
        'player_metadata': {},
        'is_npc': False,
        'created_at': timestamp,
        'last_active': timestamp,
        'first_visit': timestamp,
    }

    resp = httpx.post(
        f"{API_URL}/rest/v1/characters",
        headers=_service_headers(),
        json=character_payload,
        timeout=10.0,
    )
    resp.raise_for_status()

    resp = httpx.post(
        f"{API_URL}/rest/v1/ship_instances",
        headers=_service_headers(),
        json=ship_payload,
        timeout=10.0,
    )
    resp.raise_for_status()

    resp = httpx.patch(
        f"{API_URL}/rest/v1/characters",
        headers=_service_headers(),
        params={'character_id': f'eq.{character_id}'},
        json={'current_ship_id': ship_id},
        timeout=10.0,
    )
    resp.raise_for_status()

    return character_id


def _delete_character_if_exists(character_id: str) -> None:
    httpx.delete(
        f"{API_URL}/rest/v1/ship_instances",
        headers=_service_headers(),
        params={'owner_character_id': f'eq.{character_id}'},
        timeout=10.0,
    )
    httpx.delete(
        f"{API_URL}/rest/v1/characters",
        headers=_service_headers(),
        params={'character_id': f'eq.{character_id}'},
        timeout=10.0,
    )


def _call_test_reset(payload: dict | None = None, *, include_token: bool = True) -> httpx.Response:
    return httpx.post(
        f"{EDGE_URL}/test_reset",
        headers=_edge_headers(include_token=include_token),
        json=payload or {},
        timeout=120.0,
    )


def _call_join(character_id: str) -> httpx.Response:
    canonical = _canonical_id(character_id)
    return httpx.post(
        f"{EDGE_URL}/join",
        headers=_edge_headers(),
        json={'character_id': canonical},
        timeout=30.0,
    )


def _character_exists(character_id: str) -> bool:
    canonical = _canonical_id(character_id)
    resp = httpx.get(
        f"{API_URL}/rest/v1/characters",
        headers=_service_headers(),
        params={'select': 'character_id,name', 'character_id': f'eq.{canonical}'},
        timeout=15.0,
    )
    resp.raise_for_status()
    return bool(resp.json())


def _list_character_names() -> list[str]:
    resp = httpx.get(
        f"{API_URL}/rest/v1/characters",
        headers=_service_headers(),
        params={'select': 'name'},
        timeout=30.0,
    )
    resp.raise_for_status()
    rows = resp.json()
    return sorted(row.get('name') for row in rows if isinstance(row, dict) and row.get('name'))


def _reset_to_default() -> None:
    resp = _call_test_reset({})
    resp.raise_for_status()


@pytest.mark.edge
def test_test_reset_requires_token():
    resp = _call_test_reset({}, include_token=False)
    assert resp.status_code == 401
    data = resp.json()
    assert data['success'] is False
    assert data['error'] == 'unauthorized'


@pytest.mark.edge
def test_test_reset_clears_custom_character():
    _reset_to_default()
    temp_id = 'edge_reset_temp'
    _create_character_with_ship(temp_id)
    join_resp = _call_join(temp_id)
    assert join_resp.status_code == 200
    assert _character_exists(temp_id)

    resp = _call_test_reset({})
    assert resp.status_code == 200
    data = resp.json()
    assert data['success'] is True
    assert not _character_exists(temp_id)


@pytest.mark.edge
def test_test_reset_accepts_character_ids_override():
    custom_ids = ['edge_reset_custom_a', 'edge_reset_custom_b']
    resp = _call_test_reset({'character_ids': custom_ids})
    assert resp.status_code == 200
    payload = resp.json()
    assert payload['success'] is True

    names = _list_character_names()
    assert names == sorted(custom_ids)

    _reset_to_default()
LEGACY_NAMESPACE = os.environ.get('SUPABASE_LEGACY_ID_NAMESPACE', '5a53c4f5-8f16-4be6-8d3d-2620f4c41b3b')


def _canonical_id(value: str) -> str:
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return str(uuid.uuid5(uuid.UUID(LEGACY_NAMESPACE), value))
