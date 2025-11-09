import os

import httpx
import pytest

from tests.edge.support.characters import char_id

API_URL = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
EDGE_URL = os.environ.get('EDGE_FUNCTIONS_URL', f"{API_URL}/functions/v1")


def _expected_token() -> str:
    return os.environ.get('EDGE_API_TOKEN') or os.environ.get('SUPABASE_API_TOKEN', 'local-dev-token')


def _call_my_status(character_id: str, token: str | None = None, json_body: dict | None = None) -> httpx.Response:
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f"Bearer {os.environ.get('SUPABASE_ANON_KEY', 'anon-key')}",
        'apikey': os.environ.get('SUPABASE_ANON_KEY', 'anon-key'),
    }
    if token is not None:
        headers['x-api-token'] = token

    payload = json_body or {'character_id': character_id}

    return httpx.post(
        f"{EDGE_URL}/my_status",
        headers=headers,
        json=payload,
        timeout=10.0,
    )


def _set_ship_state(character_id: str, **fields: object) -> None:
    service_headers = {
        'apikey': os.environ.get('SUPABASE_SERVICE_ROLE_KEY', ''),
        'Authorization': f"Bearer {os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')}",
        'accept': 'application/json',
    }
    if not service_headers['apikey']:
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY is required for hyperspace tests')
    resp = httpx.get(
        f"{API_URL}/rest/v1/characters",
        headers=service_headers,
        params={'select': 'current_ship_id', 'character_id': f'eq.{character_id}'},
        timeout=10.0,
    )
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        raise AssertionError('character not found')
    ship_id = rows[0]['current_ship_id']
    patch_resp = httpx.patch(
        f"{API_URL}/rest/v1/ship_instances",
        headers=service_headers,
        params={'ship_id': f'eq.{ship_id}'},
        json=fields,
        timeout=10.0,
    )
    patch_resp.raise_for_status()


@pytest.mark.edge
def test_my_status_requires_token():
    resp = _call_my_status(char_id('test_2p_player1'), token='invalid')
    assert resp.status_code == 401
    data = resp.json()
    assert data['success'] is False
    assert data['error'] == 'unauthorized'


@pytest.mark.edge
def test_my_status_returns_request_id():
    resp = _call_my_status(char_id('test_2p_player1'), token=_expected_token())
    assert resp.status_code == 200
    data = resp.json()
    assert data['success'] is True
    assert isinstance(data.get('request_id'), str)
    assert data['request_id']


@pytest.mark.edge
def test_my_status_hyperspace_conflict():
    target = char_id('test_2p_player2')
    _set_ship_state(target, current_sector=5, in_hyperspace=True)
    resp = _call_my_status(target, token=_expected_token())
    assert resp.status_code == 409
    data = resp.json()
    assert data['success'] is False
    assert 'hyperspace' in data['error'].lower()
