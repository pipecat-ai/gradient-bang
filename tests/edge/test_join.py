import os
import secrets

import httpx
import pytest

from tests.edge.support.characters import char_id


API_URL = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
EDGE_URL = os.environ.get('EDGE_FUNCTIONS_URL', f"{API_URL}/functions/v1")


def _expected_token() -> str:
    return os.environ.get('EDGE_API_TOKEN') or os.environ.get('SUPABASE_API_TOKEN', 'local-dev-token')


def _call_join(character_id: str, token: str | None = None, json_body: dict | None = None) -> httpx.Response:
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f"Bearer {os.environ.get('SUPABASE_ANON_KEY', 'anon-key')}",
        'apikey': os.environ.get('SUPABASE_ANON_KEY', 'anon-key'),
    }
    if token is not None:
        headers['x-api-token'] = token

    payload = json_body or {'character_id': character_id}

    return httpx.post(
        f"{EDGE_URL}/join",
        headers=headers,
        json=payload,
        timeout=10.0,
    )


@pytest.mark.edge
def test_join_requires_token():
    resp = _call_join(KNOWN_CHARACTER, token='invalid')
    assert resp.status_code == 401
    data = resp.json()
    assert data['success'] is False
    assert data['error'] == 'unauthorized'


@pytest.mark.edge
def test_join_returns_character_snapshot():
    resp = _call_join(KNOWN_CHARACTER, token=_expected_token())
    assert resp.status_code == 200
    data = resp.json()
    assert data['success'] is True
    assert isinstance(data.get('request_id'), str)
    assert data['request_id']


@pytest.mark.edge
def test_join_not_found():
    resp = _call_join(MISSING_CHARACTER, token=_expected_token())
    assert resp.status_code == 404
    data = resp.json()
    assert data['success'] is False
    assert 'not found' in data['error']
KNOWN_CHARACTER = char_id('test_2p_player1')
MISSING_CHARACTER = char_id('missing_join_character')
