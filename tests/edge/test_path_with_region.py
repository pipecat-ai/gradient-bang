import os
from typing import Any, Dict

import httpx
import pytest

API_URL = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
EDGE_URL = os.environ.get('EDGE_FUNCTIONS_URL', f"{API_URL}/functions/v1")
REST_URL = f"{API_URL}/rest/v1"
CHARACTER_ID = '00000000-0000-0000-0000-000000000001'


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
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY is required for REST lookups')
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


def _reset_character(sector: int = 0) -> None:
    resp = _call('join', {'character_id': CHARACTER_ID, 'sector': sector})
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
    data = resp.json()
    if not data:
        raise AssertionError(f'No {event_type} events recorded')
    return data[0]


@pytest.mark.edge
def test_path_with_region_returns_payload():
    _reset_character(sector=0)
    resp = _call('path_with_region', {'character_id': CHARACTER_ID, 'to_sector': 2})
    assert resp.status_code == 200
    body = resp.json()
    assert body['success'] is True

    event = _latest_event('path.region')
    payload = event['payload']
    assert payload['path'][-1] == 2
    assert payload['distance'] == len(payload['path']) - 1
    assert payload['total_sectors'] >= len(payload['path'])


@pytest.mark.edge
def test_path_with_region_invalid_sector_returns_error():
    _reset_character(sector=0)
    resp = _call('path_with_region', {'character_id': CHARACTER_ID, 'to_sector': -5})
    assert resp.status_code == 400
    data = resp.json()
    assert data['success'] is False
