import os
import time
from datetime import datetime, timezone

import httpx
import pytest

from tests.edge.support.characters import char_id

API_URL = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
EDGE_URL = os.environ.get('EDGE_FUNCTIONS_URL', f"{API_URL}/functions/v1")
CHARACTER_ID = char_id('test_2p_player1')


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


def _service_headers() -> dict:
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not key:
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY is required for map knowledge assertions')
    return {
        'Content-Type': 'application/json',
        'accept': 'application/json',
        'apikey': key,
        'Authorization': f"Bearer {key}",
        'Prefer': 'return=representation',
    }


def _overwrite_map_knowledge(headers: dict, *, sector: int) -> dict:
    timestamp = datetime.now(timezone.utc).isoformat()
    knowledge = {
        'current_sector': sector,
        'total_sectors_visited': 1,
        'sectors_visited': {
            str(sector): {
                'last_visited': timestamp,
                'adjacent_sectors': [],
                'position': [0, 0],
            },
        },
    }
    resp = httpx.patch(
        f"{API_URL}/rest/v1/characters",
        headers=headers,
        params={'character_id': f'eq.{CHARACTER_ID}'},
        json={'map_knowledge': knowledge},
        timeout=15.0,
    )
    resp.raise_for_status()
    return knowledge


def _fetch_map_knowledge(headers: dict) -> dict:
    resp = httpx.get(
        f"{API_URL}/rest/v1/characters",
        headers=headers,
        params={'select': 'map_knowledge', 'character_id': f'eq.{CHARACTER_ID}'},
        timeout=15.0,
    )
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        pytest.fail('character row missing when fetching map knowledge')
    return rows[0].get('map_knowledge') or {}


def _wait_for_sector_visit(headers: dict, *, destination: int, previous_total: int, timeout: float = 3.0) -> dict:
    deadline = time.time() + timeout
    latest = {}
    while time.time() < deadline:
        knowledge = _fetch_map_knowledge(headers)
        latest = knowledge
        visited = knowledge.get('sectors_visited') or {}
        total = knowledge.get('total_sectors_visited') or 0
        if str(destination) in visited and total >= previous_total + 1:
            return knowledge
        time.sleep(0.05)
    pytest.fail(f"timed out waiting for sector {destination} visit; last state: {latest}")


@pytest.mark.edge
def test_move_requires_adjacent_sector():
    _reset_character(sector=0)
    resp = _call('move', {'character_id': CHARACTER_ID, 'to_sector': 4})
    assert resp.status_code == 400
    body = resp.json()
    assert body['success'] is False
    assert 'not adjacent' in body['error']


@pytest.mark.edge
def test_move_succeeds_between_adjacent_sectors():
    _reset_character(sector=0)
    resp = _call('move', {'character_id': CHARACTER_ID, 'to_sector': 1})
    assert resp.status_code == 200
    data = resp.json()
    assert data['success'] is True
    assert data['request_id']


@pytest.mark.edge
def test_local_map_region_returns_success():
    _reset_character(sector=0)
    resp = _call('local_map_region', {'character_id': CHARACTER_ID})
    assert resp.status_code == 200
    data = resp.json()
    assert data['success'] is True


@pytest.mark.edge
def test_list_known_ports_returns_success():
    _reset_character(sector=0)
    resp = _call('list_known_ports', {'character_id': CHARACTER_ID, 'max_hops': 5})
    assert resp.status_code == 200
    data = resp.json()
    assert data['success'] is True


@pytest.mark.edge
def test_movement_preview_does_not_mark_destination_as_visited():
    headers = _service_headers()
    _reset_character(sector=0)
    _overwrite_map_knowledge(headers, sector=0)

    try:
        initial_knowledge = _fetch_map_knowledge(headers)
        initial_total = initial_knowledge.get('total_sectors_visited', 0)
        assert initial_total == 1
        assert str(1) not in (initial_knowledge.get('sectors_visited') or {})

        resp = _call('move', {'character_id': CHARACTER_ID, 'to_sector': 1})
        assert resp.status_code == 200
        data = resp.json()
        assert data['success'] is True

        updated_knowledge = _wait_for_sector_visit(headers, destination=1, previous_total=initial_total)
        assert updated_knowledge.get('total_sectors_visited') == initial_total + 1
        assert str(1) in (updated_knowledge.get('sectors_visited') or {})
        entry = updated_knowledge['sectors_visited'][str(1)]
        assert entry.get('last_visited')
    finally:
        _reset_character(sector=0)
        _overwrite_map_knowledge(headers, sector=0)
