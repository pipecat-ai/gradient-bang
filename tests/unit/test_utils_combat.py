"""Tests for ``gradientbang.utils.combat`` shared helpers."""

from __future__ import annotations

import pytest

from gradientbang.utils.combat import (
    COMBAT_EVENT_NAMES,
    build_combat_task_description,
    combat_id_from_payload,
    is_combat_participant,
    owned_corp_ship_participant_ids,
    own_ship_id_from_participants,
    should_inject_combat_preamble,
)


PLAYER_ID = "11111111-1111-1111-1111-111111111111"
CORP_SHIP_1 = "22222222-2222-2222-2222-222222222222"
CORP_SHIP_2 = "33333333-3333-3333-3333-333333333333"
HOSTILE = "99999999-9999-9999-9999-999999999999"
CORP_ID = "corp-1"


def _payload(participants, *, round_no: int = 1) -> dict:
    return {"round": round_no, "participants": participants}


@pytest.mark.unit
class TestCombatEventNames:
    def test_canonical_set_covers_runtime_consumers(self):
        # If new combat events are added to EventRelay's EVENT_CONFIGS, this
        # set has to grow too so TaskAgent's participant-matching path keeps
        # them in scope. Locking the set asserts that callers stay aligned.
        assert COMBAT_EVENT_NAMES == frozenset(
            {
                "combat.round_waiting",
                "combat.round_resolved",
                "combat.ended",
                "combat.action_accepted",
                "combat.round_timeout",
            }
        )


@pytest.mark.unit
class TestIsCombatParticipant:
    def test_matches_participant_by_id(self):
        payload = _payload([{"id": PLAYER_ID, "name": "Pilot"}])
        assert is_combat_participant(payload, PLAYER_ID) is True

    def test_no_match_returns_false(self):
        payload = _payload([{"id": HOSTILE, "name": "Reaver"}])
        assert is_combat_participant(payload, PLAYER_ID) is False

    def test_missing_character_id_returns_false(self):
        payload = _payload([{"id": PLAYER_ID}])
        assert is_combat_participant(payload, None) is False
        assert is_combat_participant(payload, "") is False

    def test_non_mapping_payload_returns_false(self):
        assert is_combat_participant(None, PLAYER_ID) is False
        assert is_combat_participant("not a dict", PLAYER_ID) is False

    def test_missing_participants_returns_false(self):
        assert is_combat_participant({}, PLAYER_ID) is False


@pytest.mark.unit
class TestOwnShipIdFromParticipants:
    def test_ship_id_on_participant_directly(self):
        payload = _payload([{"id": CORP_SHIP_1, "ship_id": "ship-abc"}])
        assert own_ship_id_from_participants(payload, CORP_SHIP_1) == "ship-abc"

    def test_ship_id_nested_under_ship(self):
        payload = _payload([{"id": CORP_SHIP_1, "ship": {"ship_id": "ship-nested"}}])
        assert own_ship_id_from_participants(payload, CORP_SHIP_1) == "ship-nested"

    def test_trims_whitespace(self):
        payload = _payload([{"id": CORP_SHIP_1, "ship_id": "  ship-padded  "}])
        assert own_ship_id_from_participants(payload, CORP_SHIP_1) == "ship-padded"

    def test_returns_none_when_not_participant(self):
        payload = _payload([{"id": HOSTILE, "ship_id": "ship-hostile"}])
        assert own_ship_id_from_participants(payload, PLAYER_ID) is None

    def test_returns_none_for_blank_id(self):
        payload = _payload([{"id": CORP_SHIP_1, "ship_id": "   "}])
        assert own_ship_id_from_participants(payload, CORP_SHIP_1) is None


@pytest.mark.unit
class TestOwnedCorpShipParticipantIds:
    def test_matches_owned_corp_ship_participants(self):
        payload = _payload(
            [
                {"id": PLAYER_ID, "name": "Player", "player_type": "human", "corp_id": CORP_ID},
                {
                    "id": CORP_SHIP_1,
                    "name": "Hauler",
                    "player_type": "corporation_ship",
                    "corp_id": CORP_ID,
                },
                {
                    "id": HOSTILE,
                    "name": "Reaver",
                    "player_type": "human",
                    "corp_id": "corp-2",
                },
                {
                    "id": CORP_SHIP_2,
                    "name": "Scout",
                    "player_type": "corporation_ship",
                    "corp_id": CORP_ID,
                },
            ]
        )
        result = owned_corp_ship_participant_ids(payload, CORP_ID)
        # Order follows participants[] for deterministic round handling.
        assert result == [CORP_SHIP_1, CORP_SHIP_2]

    def test_missing_corp_id_returns_empty(self):
        payload = _payload(
            [{"id": CORP_SHIP_1, "player_type": "corporation_ship", "corp_id": CORP_ID}]
        )
        assert owned_corp_ship_participant_ids(payload, None) == []

    def test_no_owned_participants_returns_empty(self):
        payload = _payload(
            [{"id": CORP_SHIP_1, "player_type": "corporation_ship", "corp_id": "corp-2"}]
        )
        assert owned_corp_ship_participant_ids(payload, CORP_ID) == []

    def test_deduplicates_repeated_ids(self):
        # Defensive: if the server ever emits a participant twice, we don't
        # double-spawn for it.
        payload = _payload(
            [
                {"id": CORP_SHIP_1, "player_type": "corporation_ship", "corp_id": CORP_ID},
                {"id": CORP_SHIP_1, "player_type": "corporation_ship", "corp_id": CORP_ID},
                {"id": CORP_SHIP_2, "player_type": "corporation_ship", "corp_id": CORP_ID},
            ]
        )
        result = owned_corp_ship_participant_ids(payload, CORP_ID)
        assert result == [CORP_SHIP_1, CORP_SHIP_2]


@pytest.mark.unit
class TestShouldInjectCombatPreamble:
    def test_round_one_participant_fires(self):
        payload = _payload([{"id": PLAYER_ID}], round_no=1)
        assert should_inject_combat_preamble("combat.round_waiting", payload, PLAYER_ID)

    def test_round_two_allowed(self):
        # The caller handles once-per-combat suppression. Allowing round two
        # lets a newly woken task recover if it missed the first event.
        payload = _payload([{"id": PLAYER_ID}], round_no=2)
        assert should_inject_combat_preamble("combat.round_waiting", payload, PLAYER_ID)

    def test_non_round_waiting_event_skipped(self):
        payload = _payload([{"id": PLAYER_ID}], round_no=1)
        assert not should_inject_combat_preamble("combat.round_resolved", payload, PLAYER_ID)

    def test_not_participant_skipped(self):
        # A corp-ship task agent should not load combat.md just because some
        # other ship in the sector is fighting.
        payload = _payload([{"id": HOSTILE}], round_no=1)
        assert not should_inject_combat_preamble("combat.round_waiting", payload, PLAYER_ID)


@pytest.mark.unit
class TestCombatTaskHelpers:
    def test_combat_id_accepts_current_and_legacy_keys(self):
        assert combat_id_from_payload({"combat_id": "cbt-1"}) == "cbt-1"
        assert combat_id_from_payload({"encounter_id": "enc-1"}) == "enc-1"

    def test_build_description_mentions_combat_context(self):
        payload = {
            "combat_id": "cbt-1",
            "sector": {"id": 42},
            "participants": [
                {"id": CORP_SHIP_1, "name": "Hauler"},
                {"id": HOSTILE, "name": "Raider"},
            ],
        }
        text = build_combat_task_description(payload, CORP_SHIP_1)

        assert "Combat has started in sector 42." in text
        assert "Encounter: cbt-1." in text
        assert "Visible opponents: Raider." in text
        assert "combat_action" in text
