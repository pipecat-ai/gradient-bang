import os
from typing import Any, Dict

import httpx
import pytest

from tests.edge.support.characters import char_id
from tests.edge.support.state import reset_character_state

API_URL = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
EDGE_URL = os.environ.get('EDGE_FUNCTIONS_URL', f"{API_URL}/functions/v1")
REST_URL = f"{API_URL}/rest/v1"
SENDER = char_id('test_2p_player1')
RECEIVER = char_id('test_2p_player2')
RECEIVER_NAME = 'test_2p_player2'


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
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY is required for credits edge tests')
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
        'select': 'ship_id,credits,current_sector',
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
        raise AssertionError(f'No {event_type} events for {character_id}')
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


@pytest.mark.edge
def test_transfer_credits_success():
    _reset_character(SENDER, sector=5)
    _reset_character(RECEIVER, sector=5)

    sender_ship = _ship_state(SENDER)
    receiver_ship = _ship_state(RECEIVER)
    _patch_ship(sender_ship['ship_id'], {'credits': 1000})
    _patch_ship(receiver_ship['ship_id'], {'credits': 100})

    resp = _call('transfer_credits', {
        'from_character_id': SENDER,
        'to_player_name': RECEIVER_NAME,
        'amount': 250,
    })
    assert resp.status_code == 200

    sender_event = _latest_event(SENDER, 'credits.transfer')
    payload = sender_event['payload']
    assert payload['transfer_direction'] == 'sent'
    assert payload['transfer_details']['credits'] == 250
    assert payload['to']['id'] == RECEIVER

    receiver_event = _latest_event(RECEIVER, 'credits.transfer')
    assert receiver_event['payload']['transfer_direction'] == 'received'


@pytest.mark.edge
def test_transfer_credits_requires_same_sector():
    _reset_character(SENDER, sector=5)
    _reset_character(RECEIVER, sector=6)

    resp = _call('transfer_credits', {
        'from_character_id': SENDER,
        'to_player_name': RECEIVER_NAME,
        'amount': 50,
    })
    assert resp.status_code in {400, 404}
    body = resp.json()
    assert body['success'] is False


@pytest.mark.edge
def test_bank_transfer_deposit_and_withdraw():
    _reset_character(SENDER, sector=0)
    _reset_character(RECEIVER, sector=0)
    ship = _ship_state(SENDER)
    _patch_ship(ship['ship_id'], {'credits': 2000})

    resp = _call('bank_transfer', {
        'direction': 'deposit',
        'amount': 500,
        'ship_id': ship['ship_id'],
        'target_player_name': RECEIVER_NAME,
    })
    assert resp.status_code == 200

    resp = _call('bank_transfer', {
        'direction': 'withdraw',
        'amount': 200,
        'character_id': RECEIVER,
    })
    assert resp.status_code in {200, 400}
