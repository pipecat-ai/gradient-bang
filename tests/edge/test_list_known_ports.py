import os
from typing import Any, Dict

import httpx
import pytest

from tests.edge.support.characters import char_id
from tests.edge.support.state import reset_character_state

API_URL = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
EDGE_URL = os.environ.get('EDGE_FUNCTIONS_URL', f"{API_URL}/functions/v1")
REST_URL = f"{API_URL}/rest/v1"
CHARACTER_ID = char_id('test_2p_player1')  # Use an existing registered character


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
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY is required for list_known_ports edge tests')
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
    reset_character_state(CHARACTER_ID, sector=sector)


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


def test_list_known_ports_basic():
    """Test basic list_known_ports with default parameters"""
    # Join to establish character state (creates character if doesn't exist)
    join_resp = _call('join', {'character_id': CHARACTER_ID})
    assert join_resp.status_code == 200, f"Join failed: {join_resp.text}"

    # List known ports from current location
    resp = _call('list_known_ports', {
        'character_id': CHARACTER_ID,
        'request_id': 'test_basic_list',
    })
    assert resp.status_code == 200, f"list_known_ports failed: {resp.text}"

    # Check event was emitted
    event = _latest_event('ports.list')
    payload = event['payload']
    assert 'from_sector' in payload
    assert 'ports' in payload
    assert 'total_ports_found' in payload
    assert 'searched_sectors' in payload
    assert isinstance(payload['ports'], list)


def test_list_known_ports_with_max_hops():
    """Test list_known_ports with custom max_hops"""
    # Join to establish character state
    join_resp = _call('join', {'character_id': CHARACTER_ID})
    assert join_resp.status_code == 200

    # List ports with max_hops=2
    resp = _call('list_known_ports', {
        'character_id': CHARACTER_ID,
        'max_hops': 2,
        'request_id': 'test_max_hops',
    })
    assert resp.status_code == 200, f"list_known_ports failed: {resp.text}"

    # Check event
    event = _latest_event('ports.list')
    payload = event['payload']

    # All ports should be within 2 hops
    for port_entry in payload['ports']:
        assert port_entry['hops_from_start'] <= 2, \
            f"Port at sector {port_entry['sector']['id']} is {port_entry['hops_from_start']} hops away"


def test_list_known_ports_with_from_sector():
    """Test list_known_ports with explicit from_sector"""
    # Join and explore to sector 1
    join_resp = _call('join', {'character_id': CHARACTER_ID})
    assert join_resp.status_code == 200

    move_resp = _call('move', {
        'character_id': CHARACTER_ID,
        'to_sector': 1,
        'request_id': 'test_move_to_1',
    })
    assert move_resp.status_code == 200

    # List ports from sector 0 (not current location)
    resp = _call('list_known_ports', {
        'character_id': CHARACTER_ID,
        'from_sector': 0,
        'request_id': 'test_from_sector',
    })
    assert resp.status_code == 200, f"list_known_ports failed: {resp.text}"

    # Check event
    event = _latest_event('ports.list')
    payload = event['payload']
    assert payload['from_sector'] == 0


def test_list_known_ports_port_type_filter():
    """Test list_known_ports with port_type filter"""
    # Join to establish state
    join_resp = _call('join', {'character_id': CHARACTER_ID})
    assert join_resp.status_code == 200

    # List only BBS ports
    resp = _call('list_known_ports', {
        'character_id': CHARACTER_ID,
        'port_type': 'BBS',
        'request_id': 'test_port_type',
    })
    assert resp.status_code == 200, f"list_known_ports failed: {resp.text}"

    # Check that all returned ports match the filter
    event = _latest_event('ports.list')
    payload = event['payload']

    for port_entry in payload['ports']:
        port_code = port_entry['sector']['port']['code']
        assert port_code == 'BBS', f"Port {port_code} doesn't match filter BBS"


def test_list_known_ports_commodity_filter():
    """Test list_known_ports with commodity + trade_type filter"""
    # Join to establish state
    join_resp = _call('join', {'character_id': CHARACTER_ID})
    assert join_resp.status_code == 200

    # List ports that sell quantum_foam
    resp = _call('list_known_ports', {
        'character_id': CHARACTER_ID,
        'commodity': 'quantum_foam',
        'trade_type': 'buy',  # We want to buy from port (port sells)
        'request_id': 'test_commodity',
    })
    assert resp.status_code == 200, f"list_known_ports failed: {resp.text}"

    # Check event
    event = _latest_event('ports.list')
    payload = event['payload']

    # Verify each port can sell quantum_foam (has 'S' in position 0)
    for port_entry in payload['ports']:
        port_code = port_entry['sector']['port']['code']
        assert len(port_code) > 0, "Port code should have at least 1 character"
        assert port_code[0] == 'S', f"Port {port_code} doesn't sell quantum_foam"


def test_list_known_ports_unvisited_sector_error():
    """Test that list_known_ports fails when from_sector is unvisited"""
    # Join to establish state
    join_resp = _call('join', {'character_id': CHARACTER_ID})
    assert join_resp.status_code == 200

    # Try to list from an unvisited sector (sector 999)
    resp = _call('list_known_ports', {
        'character_id': CHARACTER_ID,
        'from_sector': 999,
        'request_id': 'test_unvisited',
    })

    # Should fail with 400
    assert resp.status_code == 400, f"Expected 400, got {resp.status_code}: {resp.text}"
    error = resp.json()
    assert 'must be a visited sector' in error.get('error', '').lower()


def test_list_known_ports_invalid_max_hops():
    """Test that list_known_ports validates max_hops range"""
    # Join to establish state
    join_resp = _call('join', {'character_id': CHARACTER_ID})
    assert join_resp.status_code == 200

    # Try with max_hops > 10
    resp = _call('list_known_ports', {
        'character_id': CHARACTER_ID,
        'max_hops': 15,
        'request_id': 'test_invalid_hops',
    })

    # Should fail with 400
    assert resp.status_code == 400, f"Expected 400, got {resp.status_code}: {resp.text}"
    error = resp.json()
    assert 'max_hops' in error.get('error', '').lower()


def test_list_known_ports_invalid_trade_filter():
    """Test that list_known_ports requires both commodity and trade_type together"""
    # Join to establish state
    join_resp = _call('join', {'character_id': CHARACTER_ID})
    assert join_resp.status_code == 200

    # Try with commodity but no trade_type
    resp = _call('list_known_ports', {
        'character_id': CHARACTER_ID,
        'commodity': 'quantum_foam',
        'request_id': 'test_invalid_filter',
    })

    # Should fail with 400
    assert resp.status_code == 400, f"Expected 400, got {resp.status_code}: {resp.text}"
    error = resp.json()
    assert 'together' in error.get('error', '').lower()
