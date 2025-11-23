import os
from typing import Any, Dict

import httpx
import pytest

from tests.edge.support.characters import char_id
from tests.edge.support.state import reset_character_state

API_URL = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
EDGE_URL = os.environ.get('EDGE_FUNCTIONS_URL', f"{API_URL}/functions/v1")
REST_URL = f"{API_URL}/rest/v1"
CHAR_ONE = char_id('test_2p_player1')


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
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY is required for purchase_fighters edge tests')
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


def _ship_state(character_id: str) -> Dict[str, Any]:
    char_row = _rest_single('characters', {
        'select': 'character_id,current_ship_id',
        'character_id': f'eq.{character_id}',
    })
    return _rest_single('ship_instances', {
        'select': 'ship_id,credits,current_fighters,current_sector',
        'ship_id': f"eq.{char_row['current_ship_id']}",
    })


def _latest_event(character_id: str, event_type: str) -> Dict[str, Any]:
    resp = httpx.get(
        f"{REST_URL}/events",
        headers=_rest_headers(),
        params={
            'select': 'event_type,payload,character_id',
            'character_id': f'eq.{character_id}',
            'event_type': f'eq.{event_type}',
            'order': 'id.desc',
            'limit': 1,
        },
        timeout=10.0,
    )
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        raise AssertionError(f'No {event_type} events recorded for {character_id}')
    return rows[0]


def _reset_character(character_id: str, *, sector: int) -> None:
    reset_character_state(character_id, sector=sector)


def _patch_ship(ship_id: str, payload: Dict[str, Any]) -> None:
    resp = httpx.patch(
        f"{REST_URL}/ship_instances",
        headers=_rest_headers(),
        params={'ship_id': f'eq.{ship_id}'},
        json=payload,
        timeout=10.0,
    )
    resp.raise_for_status()


def _restore_ship_defaults() -> None:
    ship = _ship_state(CHAR_ONE)
    _patch_ship(ship['ship_id'], {
        'ship_type': 'kestrel_courier',
        'ship_name': 'Aurora Prime',
        'credits': 15000,
        'current_fighters': 280,
        'current_sector': 0,
        'current_warp_power': 250,
        'current_shields': 150,
    })


@pytest.mark.edge
def test_purchase_fighters_increases_fighters_and_logs_event():
    _reset_character(CHAR_ONE, sector=0)
    initial_ship = _ship_state(CHAR_ONE)
    _patch_ship(initial_ship['ship_id'], {
        'credits': 100000,
        'current_fighters': max(0, initial_ship.get('current_fighters', 0) - 150),
    })
    ship_before = _ship_state(CHAR_ONE)

    try:
        resp = _call('purchase_fighters', {'character_id': CHAR_ONE, 'units': 120})
        assert resp.status_code == 200
        data = resp.json()
        assert data['success'] is True

        ship_after = _ship_state(CHAR_ONE)
        assert ship_after['current_fighters'] > ship_before['current_fighters']
        assert ship_after['credits'] < ship_before['credits']

        event = _latest_event(CHAR_ONE, 'fighter.purchase')
        payload = event['payload']
        assert payload['units'] <= 120
        assert payload['price_per_unit'] == 50
        assert payload['fighters_after'] == ship_after['current_fighters']
    finally:
        _restore_ship_defaults()


@pytest.mark.edge
def test_purchase_fighters_requires_sector_zero():
    _reset_character(CHAR_ONE, sector=2)
    try:
        resp = _call('purchase_fighters', {'character_id': CHAR_ONE, 'units': 10})
        assert resp.status_code == 400
        data = resp.json()
        assert data['success'] is False
    finally:
        _restore_ship_defaults()


@pytest.mark.edge
def test_purchase_fighters_requires_credits():
    _reset_character(CHAR_ONE, sector=0)
    ship = _ship_state(CHAR_ONE)
    _patch_ship(ship['ship_id'], {'credits': 5})

    try:
        resp = _call('purchase_fighters', {'character_id': CHAR_ONE, 'units': 10})
        assert resp.status_code == 400
        body = resp.json()
        assert body['success'] is False
    finally:
        _restore_ship_defaults()
