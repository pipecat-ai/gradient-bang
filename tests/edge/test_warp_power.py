import os
from typing import Any, Dict

import httpx
import pytest

from tests.edge.support.characters import char_id

API_URL = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
EDGE_URL = os.environ.get('EDGE_FUNCTIONS_URL', f"{API_URL}/functions/v1")
REST_URL = f"{API_URL}/rest/v1"
CHAR_ONE = char_id('test_2p_player1')
CHAR_TWO = char_id('test_2p_player2')
CHAR_TWO_NAME = 'test_2p_player2'


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
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY is required for warp power edge tests')
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
        'select': 'ship_id,credits,current_warp_power,current_sector',
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
    resp = _call('join', {'character_id': character_id, 'sector': sector})
    resp.raise_for_status()


def _patch_ship(ship_id: str, payload: Dict[str, Any]) -> None:
    resp = httpx.patch(
        f"{REST_URL}/ship_instances",
        headers=_rest_headers(),
        params={'ship_id': f'eq.{ship_id}'},
        json=payload,
        timeout=10.0,
    )
    resp.raise_for_status()


@pytest.mark.edge
def test_recharge_warp_power_increases_warp_and_logs_event():
    _reset_character(CHAR_ONE, sector=0)
    ship = _ship_state(CHAR_ONE)
    _patch_ship(ship['ship_id'], {
        'current_warp_power': max(0, ship['current_warp_power'] - 50),
    })
    before = _ship_state(CHAR_ONE)

    resp = _call('recharge_warp_power', {'character_id': CHAR_ONE, 'units': 25})
    assert resp.status_code == 200
    body = resp.json()
    assert body['success'] is True

    after = _ship_state(CHAR_ONE)
    assert after['current_warp_power'] > before['current_warp_power']
    assert after['credits'] < before['credits']

    event = _latest_event(CHAR_ONE, 'warp.purchase')
    payload = event['payload']
    assert payload['units'] <= 25
    assert payload['price_per_unit'] == 2
    assert payload['new_warp_power'] == after['current_warp_power']


@pytest.mark.edge
def test_recharge_warp_power_requires_depot_sector():
    _reset_character(CHAR_ONE, sector=2)
    resp = _call('recharge_warp_power', {'character_id': CHAR_ONE, 'units': 5})
    assert resp.status_code == 400
    data = resp.json()
    assert data['success'] is False


@pytest.mark.edge
def test_transfer_warp_power_success():
    _reset_character(CHAR_ONE, sector=0)
    _reset_character(CHAR_TWO, sector=0)

    receiver_ship = _ship_state(CHAR_TWO)
    _patch_ship(receiver_ship['ship_id'], {
        'current_warp_power': max(0, receiver_ship['current_warp_power'] - 20),
    })

    resp = _call('transfer_warp_power', {
        'from_character_id': CHAR_ONE,
        'to_player_name': CHAR_TWO_NAME,
        'units': 10,
    })
    assert resp.status_code == 200

    sender_event = _latest_event(CHAR_ONE, 'warp.transfer')
    payload = sender_event['payload']
    assert payload['transfer_direction'] == 'sent'
    assert payload['transfer_details']['warp_power'] <= 10
    assert payload['to']['id'] == CHAR_TWO

    receiver_event = _latest_event(CHAR_TWO, 'warp.transfer')
    assert receiver_event['payload']['transfer_direction'] == 'received'


@pytest.mark.edge
def test_transfer_warp_power_requires_same_sector():
    _reset_character(CHAR_ONE, sector=0)
    _reset_character(CHAR_TWO, sector=5)

    resp = _call('transfer_warp_power', {
        'from_character_id': CHAR_ONE,
        'to_player_name': CHAR_TWO_NAME,
        'units': 5,
    })
    assert resp.status_code in {400, 404}
    data = resp.json()
    assert data['success'] is False
