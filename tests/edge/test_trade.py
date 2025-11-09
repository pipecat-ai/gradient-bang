import os
from typing import Any, Dict

import httpx
import pytest

from tests.edge.support.characters import char_id

API_URL = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
EDGE_URL = os.environ.get('EDGE_FUNCTIONS_URL', f"{API_URL}/functions/v1")
REST_URL = f"{API_URL}/rest/v1"
CHARACTER_ID = char_id('test_2p_player1')


def _edge_headers():
    anon = os.environ.get('SUPABASE_ANON_KEY', 'anon-key')
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f"Bearer {anon}",
        'apikey': anon,
    }
    token = os.environ.get('EDGE_API_TOKEN') or os.environ.get('SUPABASE_API_TOKEN', 'local-dev-token')
    headers['x-api-token'] = token
    return headers


def _rest_headers():
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not key:
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY is required for trade edge tests')
    return {
        'apikey': key,
        'Authorization': f"Bearer {key}",
        'accept': 'application/json',
    }


def _call(function: str, payload: dict) -> httpx.Response:
    return httpx.post(
        f"{EDGE_URL}/{function}",
        headers=_edge_headers(),
        json=payload,
        timeout=30.0,
    )


def _reset_character(sector: int = 0) -> None:
    resp = _call('join', {'character_id': CHARACTER_ID, 'sector': sector})
    resp.raise_for_status()


def _rest_single(path: str, params: Dict[str, Any]) -> Dict[str, Any]:
    headers = _rest_headers()
    resp = httpx.get(
        f"{REST_URL}/{path}",
        headers=headers,
        params=params,
        timeout=10.0,
    )
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, list):
        if not data:
            raise RuntimeError(f"No rows returned for {path} with params {params}")
        return data[0]
    if isinstance(data, dict):
        return data
    raise RuntimeError(f"Unexpected response shape for {path}: {data}")


def _ship_state() -> Dict[str, Any]:
    char_row = _rest_single('characters', {
        'select': 'character_id,current_ship_id',
        'character_id': f'eq.{CHARACTER_ID}',
    })
    ship_id = char_row['current_ship_id']
    return _rest_single('ship_instances', {
        'select': 'ship_id,credits,cargo_qf,cargo_ro,cargo_ns',
        'ship_id': f'eq.{ship_id}',
    })


def _latest_event(event_type: str) -> Dict[str, Any]:
    headers = _rest_headers()
    resp = httpx.get(
        f"{REST_URL}/events",
        headers=headers,
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
        raise RuntimeError(f"No events found for {event_type}")
    return rows[0]


@pytest.mark.edge
def test_trade_buy_updates_ship_and_events():
    _reset_character(sector=2)
    before = _ship_state()

    resp = _call('trade', {
        'character_id': CHARACTER_ID,
        'commodity': 'quantum_foam',
        'quantity': 5,
        'trade_type': 'buy',
    })
    assert resp.status_code == 200

    after = _ship_state()
    event = _latest_event('trade.executed')
    trade_payload = event['payload']['trade']

    assert after['cargo_qf'] == before['cargo_qf'] + 5
    assert trade_payload['units'] == 5
    assert trade_payload['trade_type'] == 'buy'
    assert after['credits'] == trade_payload['new_credits']


@pytest.mark.edge
def test_trade_rejects_invalid_commodity():
    _reset_character(sector=0)
    resp = _call('trade', {
        'character_id': CHARACTER_ID,
        'commodity': 'invalidium',
        'quantity': 1,
        'trade_type': 'buy',
    })
    assert resp.status_code == 400
    body = resp.json()
    assert body['success'] is False


@pytest.mark.edge
def test_trade_requires_port_presence():
    _reset_character(sector=4)
    ship_row = _rest_single('ship_instances', {
        'select': 'current_sector',
        'owner_character_id': f'eq.{CHARACTER_ID}',
    })
    assert ship_row['current_sector'] == 4
    resp = _call('trade', {
        'character_id': CHARACTER_ID,
        'commodity': 'quantum_foam',
        'quantity': 1,
        'trade_type': 'buy',
    })
    assert resp.status_code == 400
    body = resp.json()
    assert 'port' in body['error']
