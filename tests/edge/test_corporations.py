import os
import uuid
from typing import Any, Dict

import httpx
import pytest

from tests.edge.support.characters import char_id
from tests.edge.support.state import reset_character_state

API_URL = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
EDGE_URL = os.environ.get('EDGE_FUNCTIONS_URL', f"{API_URL}/functions/v1")
REST_URL = f"{API_URL}/rest/v1"


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
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY is required for corporation edge tests')
    return {
        'Content-Type': 'application/json',
        'accept': 'application/json',
        'apikey': key,
        'Authorization': f"Bearer {key}",
        'Prefer': 'return=representation',
    }


def _call(function: str, payload: Dict[str, Any]) -> httpx.Response:
    return httpx.post(
        f"{EDGE_URL}/{function}",
        headers=_edge_headers(),
        json=payload,
        timeout=30.0,
    )


def _rest_get(path: str, params: Dict[str, Any]) -> httpx.Response:
    return httpx.get(
        f"{REST_URL}/{path}",
        headers=_rest_headers(),
        params=params,
        timeout=15.0,
    )


def _rest_patch(path: str, params: Dict[str, Any], payload: Dict[str, Any]) -> None:
    resp = httpx.patch(
        f"{REST_URL}/{path}",
        headers=_rest_headers(),
        params=params,
        json=payload,
        timeout=15.0,
    )
    resp.raise_for_status()


def _rest_delete(path: str, params: Dict[str, Any]) -> None:
    resp = httpx.delete(
        f"{REST_URL}/{path}",
        headers=_rest_headers(),
        params=params,
        timeout=15.0,
    )
    resp.raise_for_status()


def _reset_character(label: str, *, credits: int, sector: int = 0) -> str:
    character_id = char_id(label)
    reset_character_state(label, sector=sector, credits=credits)
    _clear_corporation_state(character_id)
    return character_id


def _clear_corporation_state(character_id: str) -> None:
    _rest_patch('characters', {'character_id': f'eq.{character_id}'}, {
        'corporation_id': None,
        'corporation_joined_at': None,
    })
    _rest_delete('corporation_members', {'character_id': f'eq.{character_id}'})


def _fetch_ship(character_id: str) -> Dict[str, Any]:
    resp = _rest_get('characters', {
        'select': 'current_ship_id',
        'character_id': f'eq.{character_id}',
    })
    resp.raise_for_status()
    rows = resp.json()
    ship_id = rows[0]['current_ship_id']
    ship_resp = _rest_get('ship_instances', {
        'select': 'ship_id,credits',
        'ship_id': f'eq.{ship_id}',
    })
    ship_resp.raise_for_status()
    return ship_resp.json()[0]


def _fetch_corporation(corp_id: str) -> Dict[str, Any]:
    resp = _rest_get('corporations', {
        'select': 'corp_id,name,invite_code',
        'corp_id': f'eq.{corp_id}',
    })
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        raise AssertionError(f'Corporation {corp_id} not found')
    return rows[0]


def _fetch_character(character_id: str) -> Dict[str, Any]:
    resp = _rest_get('characters', {'character_id': f'eq.{character_id}'})
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        raise AssertionError(f'Character {character_id} missing')
    return rows[0]


@pytest.mark.edge
def test_corporation_create_deducts_credits():
    founder = _reset_character('corp_events_founder_create', credits=25000)
    corp_name = f"CreateTest-{uuid.uuid4().hex[:6]}"

    resp = _call('corporation_create', {
        'character_id': founder,
        'name': corp_name,
    })
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload['success'] is True
    assert payload['corp_id']

    ship = _fetch_ship(founder)
    assert ship['credits'] == 15000


@pytest.mark.edge
def test_corporation_join_adds_member():
    founder = _reset_character('corp_events_founder_join', credits=30000)
    joiner = _reset_character('corp_events_joiner', credits=12000)
    corp_name = f"JoinTest-{uuid.uuid4().hex[:6]}"

    create = _call('corporation_create', {'character_id': founder, 'name': corp_name})
    create.raise_for_status()
    corp_payload = create.json()

    join_resp = _call('corporation_join', {
        'character_id': joiner,
        'corp_id': corp_payload['corp_id'],
        'invite_code': corp_payload['invite_code'],
    })
    assert join_resp.status_code == 200, join_resp.text
    join_payload = join_resp.json()
    assert join_payload['name'] == corp_name

    joiner_row = _fetch_character(joiner)
    assert joiner_row['corporation_id'] == corp_payload['corp_id']


@pytest.mark.edge
def test_corporation_leave_disbands_last_member():
    founder = _reset_character('corp_events_founder_leave', credits=30000)
    corp_name = f"LeaveTest-{uuid.uuid4().hex[:6]}"

    create = _call('corporation_create', {'character_id': founder, 'name': corp_name})
    create.raise_for_status()
    corp_payload = create.json()

    leave_resp = _call('corporation_leave', {'character_id': founder})
    assert leave_resp.status_code == 200, leave_resp.text

    corp_resp = _rest_get('corporations', {'corp_id': f"eq.{corp_payload['corp_id']}"})
    corp_resp.raise_for_status()
    assert corp_resp.json() == []


@pytest.mark.edge
def test_corporation_kick_removes_target():
    founder = _reset_character('corp_events_founder_kick', credits=30000)
    target = _reset_character('corp_events_target', credits=16000)
    corp_name = f"KickTest-{uuid.uuid4().hex[:6]}"

    create = _call('corporation_create', {'character_id': founder, 'name': corp_name})
    create.raise_for_status()
    corp_payload = create.json()

    join_resp = _call('corporation_join', {
        'character_id': target,
        'corp_id': corp_payload['corp_id'],
        'invite_code': corp_payload['invite_code'],
    })
    join_resp.raise_for_status()

    kick_resp = _call('corporation_kick', {'character_id': founder, 'target_id': target})
    assert kick_resp.status_code == 200, kick_resp.text

    target_row = _fetch_character(target)
    assert target_row['corporation_id'] is None


@pytest.mark.edge
def test_regenerate_invite_code_changes_value():
    founder = _reset_character('corp_events_founder_log', credits=28000)
    corp_name = f"InviteTest-{uuid.uuid4().hex[:6]}"

    create = _call('corporation_create', {'character_id': founder, 'name': corp_name})
    create.raise_for_status()
    corp_payload = create.json()
    before_code = corp_payload['invite_code']

    regen_resp = _call('corporation_regenerate_invite_code', {'character_id': founder})
    regen_resp.raise_for_status()
    new_code = regen_resp.json()['new_invite_code']
    assert new_code != before_code

    corp_row = _fetch_corporation(corp_payload['corp_id'])
    assert corp_row['invite_code'] == new_code


@pytest.mark.edge
def test_corporation_info_public_and_member_views():
    founder = _reset_character('corp_events_founder_ship', credits=32000)
    member = _reset_character('corp_events_member_a', credits=15000)
    outsider = _reset_character('corp_events_member_b', credits=15000)
    corp_name = f"InfoTest-{uuid.uuid4().hex[:6]}"

    create = _call('corporation_create', {'character_id': founder, 'name': corp_name})
    create.raise_for_status()
    corp_payload = create.json()

    join_resp = _call('corporation_join', {
        'character_id': member,
        'corp_id': corp_payload['corp_id'],
        'invite_code': corp_payload['invite_code'],
    })
    join_resp.raise_for_status()

    member_info = _call('corporation_info', {
        'character_id': founder,
        'corp_id': corp_payload['corp_id'],
    })
    member_info.raise_for_status()
    member_payload = member_info.json()
    assert len(member_payload['members']) == 2
    assert member_payload['invite_code'] == corp_payload['invite_code']

    public_info = _call('corporation_info', {
        'character_id': outsider,
        'corp_id': corp_payload['corp_id'],
    })
    public_info.raise_for_status()
    public_payload = public_info.json()
    assert 'invite_code' not in public_payload
    assert public_payload['member_count'] == 2


@pytest.mark.edge
def test_my_corporation_returns_membership_payload():
    founder = _reset_character('corp_events_founder_abandon', credits=35000)
    member = _reset_character('corp_events_joiner', credits=18000, sector=1)
    corp_name = f"StatusTest-{uuid.uuid4().hex[:6]}"

    create = _call('corporation_create', {'character_id': founder, 'name': corp_name})
    create.raise_for_status()
    corp_payload = create.json()

    join_resp = _call('corporation_join', {
        'character_id': member,
        'corp_id': corp_payload['corp_id'],
        'invite_code': corp_payload['invite_code'],
    })
    join_resp.raise_for_status()

    my_resp = _call('my_corporation', {'character_id': member})
    my_resp.raise_for_status()
    my_payload = my_resp.json()
    assert my_payload['corporation']['corp_id'] == corp_payload['corp_id']
    assert my_payload['corporation']['member_count'] >= 1
    assert my_payload['corporation']['joined_at'] is not None
