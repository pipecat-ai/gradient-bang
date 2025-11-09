import os

import httpx
import pytest

API_URL = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
EDGE_URL = os.environ.get('EDGE_FUNCTIONS_URL', f"{API_URL}/functions/v1")
CHARACTER_ID = '00000000-0000-0000-0000-000000000001'


def _headers():
    anon = os.environ.get('SUPABASE_ANON_KEY', 'anon-key')
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f"Bearer {anon}",
        'apikey': anon,
    }
    token = os.environ.get('EDGE_API_TOKEN') or os.environ.get('SUPABASE_API_TOKEN', 'local-dev-token')
    headers['x-api-token'] = token
    return headers


def _call(function: str, payload: dict) -> httpx.Response:
    return httpx.post(
        f"{EDGE_URL}/{function}",
        headers=_headers(),
        json=payload,
        timeout=30.0,
    )


def _reset_character(sector: int = 0) -> None:
    resp = _call('join', {'character_id': CHARACTER_ID, 'sector': sector})
    resp.raise_for_status()


@pytest.mark.edge
def test_plot_course_generates_valid_path():
    _reset_character(sector=0)
    resp = _call('plot_course', {'character_id': CHARACTER_ID, 'to_sector': 3})
    assert resp.status_code == 200
    data = resp.json()
    assert data['success'] is True
    assert data['request_id']


@pytest.mark.edge
def test_plot_course_rejects_spoofed_from_sector():
    _reset_character(sector=0)
    resp = _call('plot_course', {
        'character_id': CHARACTER_ID,
        'from_sector': 5,
        'to_sector': 3,
    })
    assert resp.status_code == 403
    body = resp.json()
    assert body['success'] is False
    assert 'from_sector' in body['error']
