import os
import uuid
from datetime import datetime, timezone
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
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY is required for ship_purchase edge tests')
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
        'select': 'ship_id,ship_type,credits,current_fighters,current_sector',
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


def _patch_character(character_id: str, payload: Dict[str, Any]) -> None:
    resp = httpx.patch(
        f"{REST_URL}/characters",
        headers=_rest_headers(),
        params={'character_id': f'eq.{character_id}'},
        json=payload,
        timeout=10.0,
    )
    resp.raise_for_status()


def _create_corporation(name: str, founder_id: str) -> str:
    corp_id = str(uuid.uuid4())
    payload = {
        'corp_id': corp_id,
        'name': name,
        'founder_id': founder_id,
        'invite_code': uuid.uuid4().hex[:8],
        'invite_code_generated_by': founder_id,
    }
    resp = httpx.post(
        f"{REST_URL}/corporations",
        headers=_rest_headers(),
        json=payload,
        timeout=10.0,
    )
    resp.raise_for_status()
    return corp_id


def _add_corporation_member(corp_id: str, character_id: str) -> None:
    resp = httpx.post(
        f"{REST_URL}/corporation_members",
        headers=_rest_headers(),
        json={'corp_id': corp_id, 'character_id': character_id},
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
def test_ship_purchase_success_trades_in_current_ship():
    _reset_character(CHAR_ONE, sector=0)
    current_ship = _ship_state(CHAR_ONE)
    _patch_ship(current_ship['ship_id'], {
        'credits': 60000,
        'current_fighters': 100,
    })
    ship_before = _ship_state(CHAR_ONE)

    try:
        resp = _call('ship_purchase', {
            'character_id': CHAR_ONE,
            'ship_type': 'sparrow_scout',
            'ship_name': 'Scout Supreme',
        })
        assert resp.status_code == 200
        payload = resp.json()
        assert payload['success'] is True
        assert payload['ship_type'] == 'sparrow_scout'

        ship_after = _ship_state(CHAR_ONE)
        assert ship_after['ship_id'] != ship_before['ship_id']
        assert ship_after['ship_type'] == 'sparrow_scout'
        assert ship_after['credits'] < ship_before['credits']

        event = _latest_event(CHAR_ONE, 'ship.traded_in')
        event_payload = event['payload']
        assert event_payload['old_ship_id'] == ship_before['ship_id']
        assert event_payload['new_ship_id'] == ship_after['ship_id']
        assert event_payload['price'] > 0
    finally:
        _restore_ship_defaults()


@pytest.mark.edge
def test_ship_purchase_requires_credits():
    _reset_character(CHAR_ONE, sector=0)
    ship = _ship_state(CHAR_ONE)
    _patch_ship(ship['ship_id'], {'credits': 10, 'current_fighters': 0})

    try:
        resp = _call('ship_purchase', {'character_id': CHAR_ONE, 'ship_type': 'sparrow_scout'})
        assert resp.status_code == 400
        data = resp.json()
        assert data['success'] is False
    finally:
        _restore_ship_defaults()


@pytest.mark.edge
def test_ship_purchase_rejects_autonomous_types():
    _reset_character(CHAR_ONE, sector=0)
    try:
        resp = _call('ship_purchase', {'character_id': CHAR_ONE, 'ship_type': 'autonomous_probe'})
        assert resp.status_code == 400
        data = resp.json()
        assert data['success'] is False
    finally:
        _restore_ship_defaults()


@pytest.mark.edge
def test_ship_purchase_corporation_flow_creates_corp_ship():
    _reset_character(CHAR_ONE, sector=0)
    _patch_character(CHAR_ONE, {'credits_in_megabank': 500000})
    corp_id = _create_corporation('Edge Test Corp', CHAR_ONE)
    _add_corporation_member(corp_id, CHAR_ONE)
    _patch_character(CHAR_ONE, {
        'corporation_id': corp_id,
        'corporation_joined_at': datetime.now(timezone.utc).isoformat(),
    })

    resp = _call('ship_purchase', {
        'character_id': CHAR_ONE,
        'ship_type': 'autonomous_probe',
        'purchase_type': 'corporation',
        'ship_name': 'Sentry Alpha',
        'initial_ship_credits': 5000,
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data['success'] is True
    corp_id = data['corp_id']
    ship_id = data['ship_id']
    assert corp_id

    ship_row = _rest_single('ship_instances', {
        'select': 'ship_id,owner_type,owner_corporation_id,credits,ship_type',
        'ship_id': f'eq.{ship_id}',
    })
    assert ship_row['owner_type'] == 'corporation'
    assert ship_row['owner_corporation_id'] == corp_id
    assert ship_row['credits'] == 5000
    assert ship_row['ship_type'] == 'autonomous_probe'

    corp_ship_row = _rest_single('corporation_ships', {
        'select': 'corp_id,ship_id',
        'ship_id': f'eq.{ship_id}',
    })
    assert corp_ship_row['corp_id'] == corp_id

    corp_character = _rest_single('characters', {
        'select': 'character_id,name,player_metadata,corporation_id,current_ship_id',
        'character_id': f'eq.{ship_id}',
    })
    assert corp_character['current_ship_id'] == ship_id
    assert corp_character['corporation_id'] == corp_id
    assert (corp_character['player_metadata'] or {}).get('player_type') == 'corporation_ship'
