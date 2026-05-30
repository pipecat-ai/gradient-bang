from __future__ import annotations

from collections import deque

from gradientbang.utils.event_ordering import (
    extract_event_context,
    extract_event_id,
    extract_event_id_from_context,
    extract_internal_payload_event_context,
    extract_internal_payload_event_id,
    extract_payload_event_context,
    extract_payload_event_id,
    record_recent_event_id,
    sort_by_event_id_id_first,
    sort_by_event_id_preserving_no_id_positions,
)


def test_event_envelope_id_matches_pre_util_relay_and_task_agent_shape() -> None:
    assert extract_event_id({"event_context": {"event_id": 42}, "payload": {}}) == 42
    assert extract_event_id({"event_context": {"event_id": "42"}, "payload": {}}) == 42
    assert extract_event_id({"event_context": {"event_id": "not-a-number"}, "payload": {}}) is None

    event = {
        "event_context": {"event_id": 10},
        "payload": {"__event_context": {"event_id": 20}},
    }
    assert extract_event_context(event) == {"event_id": 10}
    assert extract_event_id(event) == 10

    assert extract_event_id({"payload": {"__event_context": {"event_id": 7}}}) == 7
    assert extract_event_id({"payload": {"event_context": {"event_id": 8}}}) == 8


def test_event_envelope_does_not_read_top_level_internal_payload_context() -> None:
    assert extract_event_context({"__event_context": {"event_id": 1}}) is None
    assert extract_event_id({"__event_context": {"event_id": 1}}) is None


def test_event_id_int_check_preserves_pre_util_bool_behavior() -> None:
    assert extract_event_id({"event_context": {"event_id": True}}) is True


def test_payload_context_matches_pre_util_relay_payload_helper() -> None:
    assert extract_payload_event_context({"__event_context": {"scope": "direct"}}) == {
        "scope": "direct"
    }
    assert extract_payload_event_context({"event_context": {"scope": "public"}}) == {
        "scope": "public"
    }
    assert extract_payload_event_context(
        {
            "__event_context": {"scope": "internal"},
            "event_context": {"scope": "public"},
        }
    ) == {"scope": "internal"}
    assert extract_payload_event_context(
        {
            "__event_context": {},
            "event_context": {"scope": "public"},
        }
    ) == {"scope": "public"}
    assert extract_payload_event_context(
        {
            "__event_context": "bad-context",
            "event_context": {"scope": "public"},
        }
    ) is None


def test_internal_payload_context_matches_pre_util_polling_and_client_shape() -> None:
    payload = {
        "__event_context": {"event_id": 11},
        "event_context": {"event_id": 12},
    }

    assert extract_internal_payload_event_context(payload) == {"event_id": 11}
    assert extract_internal_payload_event_id(payload, parse_strings=False) == 11
    assert extract_internal_payload_event_id({"event_context": {"event_id": 12}}) is None


def test_string_event_id_parsing_can_be_disabled_for_polling_and_client_paths() -> None:
    ctx = {"event_id": "123"}
    payload = {"__event_context": ctx}

    assert extract_event_id_from_context(ctx) == 123
    assert extract_event_id_from_context(ctx, parse_strings=False) is None
    assert extract_payload_event_id({"event_context": ctx}) == 123
    assert extract_internal_payload_event_id(payload, parse_strings=False) is None


def test_preserving_no_id_sort_matches_pre_util_relay_and_task_agent_order() -> None:
    events = [
        {"event_name": "no-id-a", "payload": {}},
        {"event_name": "id-3", "event_context": {"event_id": 3}, "payload": {}},
        {"event_name": "no-id-b", "payload": {}},
        {"event_name": "id-1", "event_context": {"event_id": 1}, "payload": {}},
        {"event_name": "id-1-later", "event_context": {"event_id": 1}, "payload": {}},
    ]

    ordered = sort_by_event_id_preserving_no_id_positions(
        events,
        event_id_of=extract_event_id,
    )

    assert [event["event_name"] for event in ordered] == [
        "no-id-a",
        "id-1",
        "no-id-b",
        "id-1-later",
        "id-3",
    ]


def test_preserving_no_id_sort_supports_task_agent_tuple_shape() -> None:
    ready = [
        ({"event_name": "id-5", "event_context": {"event_id": 5}}, False),
        ({"event_name": "id-2", "payload": {"__event_context": {"event_id": 2}}}, True),
    ]

    ordered = sort_by_event_id_preserving_no_id_positions(
        ready,
        event_id_of=lambda item: extract_event_id(item[0]),
    )

    assert [event["event_name"] for event, _originated in ordered] == ["id-2", "id-5"]
    assert [originated for _event, originated in ordered] == [True, False]


def test_id_first_sort_matches_pre_util_pubsub_message_order() -> None:
    messages = [
        {"event_type": "no-id-a"},
        {"event_type": "id-3", "event_context": {"event_id": 3}},
        {"event_type": "id-1", "event_context": {"event_id": 1}},
        {"event_type": "no-id-b"},
        {"event_type": "id-1-later", "event_context": {"event_id": 1}},
    ]

    ordered = sort_by_event_id_id_first(
        messages,
        event_id_of=lambda message: extract_event_id_from_context(message.get("event_context")),
    )

    assert [message["event_type"] for message in ordered] == [
        "id-1",
        "id-1-later",
        "id-3",
        "no-id-a",
        "no-id-b",
    ]


def test_id_first_sort_supports_pubsub_row_shape() -> None:
    rows = [
        (30, 1, {"event_type": "id-30", "event_context": {"event_id": 30}}),
        (10, 1, {"event_type": "id-10", "event_context": {"event_id": 10}}),
        (20, 1, {"event_type": "no-id"}),
    ]

    ordered = sort_by_event_id_id_first(
        rows,
        event_id_of=lambda row: extract_event_id_from_context(row[2].get("event_context")),
    )

    assert [row[0] for row in ordered] == [10, 30, 20]


def test_record_recent_event_id_matches_pre_util_polling_dedupe_ring() -> None:
    recent_ids = deque([1, 2])

    assert record_recent_event_id(
        recent_ids,
        {"__event_context": {"event_id": 3}},
        max_size=3,
        event_id_of=lambda value: extract_internal_payload_event_id(value, parse_strings=False),
    )
    assert list(recent_ids) == [1, 2, 3]

    assert not record_recent_event_id(
        recent_ids,
        {"__event_context": {"event_id": 2}},
        max_size=3,
        event_id_of=lambda value: extract_internal_payload_event_id(value, parse_strings=False),
    )
    assert list(recent_ids) == [1, 2, 3]

    assert record_recent_event_id(
        recent_ids,
        {"__event_context": {"event_id": "4"}},
        max_size=3,
        event_id_of=lambda value: extract_internal_payload_event_id(value, parse_strings=False),
    )
    assert list(recent_ids) == [1, 2, 3]

    assert record_recent_event_id(
        recent_ids,
        {"event_context": {"event_id": 5}},
        max_size=3,
        event_id_of=lambda value: extract_internal_payload_event_id(value, parse_strings=False),
    )
    assert list(recent_ids) == [1, 2, 3]

    assert record_recent_event_id(
        recent_ids,
        {"__event_context": {"event_id": 6}},
        max_size=3,
        event_id_of=lambda value: extract_internal_payload_event_id(value, parse_strings=False),
    )
    assert list(recent_ids) == [2, 3, 6]
