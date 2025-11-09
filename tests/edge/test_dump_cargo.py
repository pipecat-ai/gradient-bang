import os
from typing import Any, Dict

import httpx
import pytest

from tests.edge.support.characters import char_id

API_URL = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
EDGE_URL = os.environ.get('EDGE_FUNCTIONS_URL', f"{API_URL}/functions/v1")
REST_URL = f"{API_URL}/rest/v1"
CHARACTER_ID = char_id('test_2p_player1')


def _edge_headers() -> Dict[str, str]:
    anon = os.environ.get('SUPABASE_ANON_KEY', 'anon-key')
    token = os.environ.get('EDGE_API_TOKEN') or os.environ.get('SUPABASE_API_TOKEN', 'local-dev-token')
    return {
        'Content-Type': 'application/json',
        'Authorization': f"Bearer {anon}",
        'apikey': anon,
        'x-api-token': token,
    }


def _rest_headers() -> Dict[str, str]:
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not key:
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY is required for dump_cargo edge tests')
    return {
        'apikey': key,
        'Authorization': f"Bearer {key}",
        'accept': 'application/json',
    }


def _call(function: str, payload: Dict[str, Any]) -> httpx.Response:
    return httpx.post(
        f"{EDGE_URL}/{function}",
        headers=_edge_headers(),
        json=payload,
        timeout=30.0,
    )


def _rest_single(path: str, params: Dict[str, Any]) -> Dict[str, Any]:
    resp = httpx.get(
        f"{REST_URL}/{path}",
        headers=_rest_headers(),
        params=params,
        timeout=10.0,
    )
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, list):
        if not data:
            raise AssertionError(f'No rows returned for {path} with {params}')
        return data[0]
    return data


def _ship_state() -> Dict[str, Any]:
    char_row = _rest_single('characters', {
        'select': 'character_id,current_ship_id',
        'character_id': f'eq.{CHARACTER_ID}',
    })
    return _rest_single('ship_instances', {
        'select': 'ship_id,cargo_qf,cargo_ro,cargo_ns,current_sector',
        'ship_id': f"eq.{char_row['current_ship_id']}",
    })


def _patch_ship(ship_id: str, payload: Dict[str, Any]) -> None:
    resp = httpx.patch(
        f"{REST_URL}/ship_instances",
        headers=_rest_headers(),
        params={'ship_id': f'eq.{ship_id}'},
        json=payload,
        timeout=10.0,
    )
    resp.raise_for_status()


def _latest_event(event_type: str) -> Dict[str, Any]:
    resp = httpx.get(
        f"{REST_URL}/events",
        headers=_rest_headers(),
        params={
            'select': 'event_type,payload,character_id',
            'character_id': f'eq.{CHARACTER_ID}',
            'event_type': f'eq.{event_type}',
            'order': 'id.desc',
            'limit': 1,
        },
        timeout=10.0,
    )
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        raise AssertionError(f'No {event_type} events recorded')
    return rows[0]


def _reset_character(sector: int) -> None:
    resp = _call('join', {'character_id': CHARACTER_ID, 'sector': sector})
    resp.raise_for_status()


@pytest.mark.edge
def test_dump_cargo_creates_salvage_and_updates_status():
    _reset_character(sector=0)
    before = _ship_state()
    _patch_ship(before['ship_id'], {'cargo_qf': 5})

    resp = _call('dump_cargo', {
        'character_id': CHARACTER_ID,
        'items': {'quantum_foam': 5},
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data['success'] is True

    after = _ship_state()
    assert after['cargo_qf'] <= before['cargo_qf']

    event = _latest_event('salvage.created')
    payload = event['payload']
    assert payload['salvage_details']['salvage_id']
    assert payload['salvage_details']['cargo']['quantum_foam'] > 0


@pytest.mark.edge
def test_dump_cargo_rejects_invalid_manifest():
    _reset_character(sector=0)
    resp = _call('dump_cargo', {
        'character_id': CHARACTER_ID,
        'items': {'invalidium': 3},
    })
    assert resp.status_code == 400
    body = resp.json()
    assert body['success'] is False
