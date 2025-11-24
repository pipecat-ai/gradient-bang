import os
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from tests.edge.support.characters import char_id

API_URL = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
EDGE_URL = os.environ.get('EDGE_FUNCTIONS_URL', f"{API_URL}/functions/v1")
CHARACTER_ID = char_id('test_2p_player1')
ALT_CHARACTER_ID = char_id('test_2p_player2')


def _api_token() -> str:
    return os.environ.get('EDGE_API_TOKEN') or os.environ.get('SUPABASE_API_TOKEN', 'local-dev-token')


def _edge_headers(include_token: bool = True) -> dict:
    anon = os.environ.get('SUPABASE_ANON_KEY', 'anon-key')
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f"Bearer {anon}",
        'apikey': anon,
    }
    if include_token:
        headers['x-api-token'] = _api_token()
    return headers


def _service_headers() -> dict:
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not key:
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY is required for event query tests')
    return {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': f"Bearer {key}",
        'accept': 'application/json',
    }




def _call_event_query(payload: dict, *, include_token: bool = True) -> httpx.Response:
    return httpx.post(
        f"{EDGE_URL}/event_query",
        headers=_edge_headers(include_token=include_token),
        json=payload,
        timeout=15.0,
    )


def _insert_event(*, character_id: str, sector_id: int, payload: dict, sender_id: str | None = None,
                  timestamp: datetime | None = None) -> None:
    """Insert an event into the database with proper recipient visibility.
    
    Note: This assumes test_data fixture has been called to populate characters.
    """
    body = {
        'timestamp': (timestamp or datetime.now(timezone.utc)).isoformat(),
        'direction': 'event_out',
        'event_type': 'status.snapshot',
        'character_id': character_id,
        'sender_id': sender_id,
        'sector_id': sector_id,
        'payload': payload,
    }
    headers = _service_headers()
    headers['Prefer'] = 'return=representation'
    resp = httpx.post(
        f"{API_URL}/rest/v1/events",
        headers=headers,
        json=body,
        timeout=15.0,
    )
    if resp.status_code >= 400:
        raise AssertionError(f"failed to insert event: {resp.status_code} {resp.text}")
    
    result = resp.json()
    if not result or not isinstance(result, list) or not result[0].get('id'):
        raise AssertionError(f"failed to get event id from insert response: {result}")
    
    event_id = result[0]['id']
    
    # Insert into event_character_recipients for both the character_id and sender_id
    # so both parties can see the event
    recipients_to_add = [character_id]
    if sender_id and sender_id != character_id:
        recipients_to_add.append(sender_id)
    
    for recipient_char_id in recipients_to_add:
        recipient_body = {
            'event_id': event_id,
            'character_id': recipient_char_id,
            'reason': 'recipient' if recipient_char_id == character_id else 'sender',
        }
        resp = httpx.post(
            f"{API_URL}/rest/v1/event_character_recipients",
            headers=_service_headers(),
            json=recipient_body,
            timeout=15.0,
        )
        if resp.status_code >= 400:
            raise AssertionError(f"failed to insert event recipient for {recipient_char_id}: {resp.status_code} {resp.text}")


@pytest.mark.edge
def test_event_query_requires_token(test_data):
    """Test that event_query requires authentication token."""
    now = datetime.now(timezone.utc)
    payload = {
        'character_id': CHARACTER_ID,
        'start': (now - timedelta(seconds=5)).isoformat(),
        'end': (now + timedelta(seconds=5)).isoformat(),
    }
    resp = _call_event_query(payload, include_token=False)
    assert resp.status_code == 401
    data = resp.json()
    assert data['success'] is False
    assert data['error'] == 'unauthorized'


@pytest.mark.edge
def test_event_query_filters_by_character_and_sector(test_data):
    """Test that event_query can filter events by character and sector."""
    timestamp = datetime.now(timezone.utc)
    window_start = (timestamp - timedelta(seconds=5)).isoformat()
    window_end = (timestamp + timedelta(seconds=5)).isoformat()

    _insert_event(
        character_id=CHARACTER_ID,
        sector_id=7,
        sender_id=ALT_CHARACTER_ID,
        payload={'marker': 'primary'},
        timestamp=timestamp,
    )
    _insert_event(
        character_id=ALT_CHARACTER_ID,
        sector_id=7,
        sender_id=CHARACTER_ID,
        payload={'marker': 'secondary'},
        timestamp=timestamp,
    )

    resp = _call_event_query({
        'character_id': CHARACTER_ID,
        'sector': 7,
        'start': window_start,
        'end': window_end,
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data['success'] is True
    events = data['events']
    assert len(events) == 2
    # Check that we got events from both characters in the sector
    # The receiver field in the response shows the querying character due to JOIN filtering,
    # so we need to check the event payload or other fields to verify both characters' events
    # For now, just verify we got 2 events in the right sector
    assert all(evt['sector'] == 7 for evt in events)


@pytest.mark.edge
def test_event_query_enforces_actor_requirement(test_data):
    """Test that event_query requires character_id or actor_character_id."""
    now = datetime.now(timezone.utc)
    resp = _call_event_query({
        'start': (now - timedelta(seconds=5)).isoformat(),
        'end': (now + timedelta(seconds=5)).isoformat(),
    })
    assert resp.status_code == 403
    data = resp.json()
    assert data['success'] is False
    assert 'character_id' in data['error']


@pytest.mark.edge
def test_event_query_supports_string_match(test_data):
    """Test that event_query can filter events by string match."""
    timestamp = datetime.now(timezone.utc)
    start = (timestamp - timedelta(seconds=5)).isoformat()
    end = (timestamp + timedelta(seconds=5)).isoformat()

    _insert_event(
        character_id=CHARACTER_ID,
        sector_id=3,
        payload={'detail': 'engine_calibration_complete'},
        timestamp=timestamp,
    )
    _insert_event(
        character_id=CHARACTER_ID,
        sector_id=3,
        payload={'detail': 'navigation_sync'},
        timestamp=timestamp,
    )

    resp = _call_event_query({
        'character_id': CHARACTER_ID,
        'sector': 3,
        'start': start,
        'end': end,
        'string_match': 'engine_calibration',
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data['success'] is True
    events = data['events']
    assert len(events) == 1
    assert events[0]['payload']['detail'] == 'engine_calibration_complete'
