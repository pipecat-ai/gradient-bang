"""Tests for bounded summary formatter behavior."""

import pytest

from gradientbang.utils.summary_formatters import (
    _EVENT_QUERY_MAX_EVENTS,
    _EVENT_QUERY_MAX_TOTAL_CHARS,
    event_query_summary,
)


def _nested_summary(event_name: str, payload: dict) -> str:
    detail = payload.get("detail", "")
    return f"{event_name} {detail}".strip()


@pytest.mark.unit
class TestEventQuerySummary:
    def test_empty_query_summary(self):
        result = event_query_summary({"events": [], "count": 0}, _nested_summary)
        assert result == "Query returned 0 events."

    def test_caps_events_and_keeps_more_available_note(self):
        events = [
            {
                "event": f"movement.complete.{idx}",
                "timestamp": f"2026-03-29T12:00:{idx:02d}Z",
                "payload": {"detail": f"event {idx}"},
            }
            for idx in range(_EVENT_QUERY_MAX_EVENTS + 5)
        ]

        result = event_query_summary(
            {
                "events": events,
                "count": len(events),
                "has_more": True,
                "filters": {
                    "start": "2026-03-29T12:00:00Z",
                    "end": "2026-03-29T13:00:00Z",
                    "sort_direction": "forward",
                },
            },
            _nested_summary,
        )

        lines = result.splitlines()
        assert lines[0].startswith("Query returned 25 events (window=2026-03-29T12:00:00Z")
        assert "sort=forward" in lines[0]
        event_lines = [line for line in lines if line.startswith("  [")]
        assert len(event_lines) == _EVENT_QUERY_MAX_EVENTS
        assert "... 5 more events omitted." in result
        assert "More events available (use offset/limit to paginate)." in result

    def test_truncates_long_event_lines_and_total_summary(self):
        events = [
            {
                "event": "chat.message",
                "timestamp": f"2026-03-29T12:00:{idx:02d}Z",
                "payload": {
                    "type": "broadcast",
                    "from_name": "VeryLongName",
                    "content": "x" * 2000,
                },
            }
            for idx in range(_EVENT_QUERY_MAX_EVENTS)
        ]

        result = event_query_summary(
            {
                "events": events,
                "count": len(events),
            },
            _nested_summary,
        )

        assert len(result) <= _EVENT_QUERY_MAX_TOTAL_CHARS
        for line in result.splitlines()[1:]:
            assert len(line) <= 240

    def test_preserves_join_marker_for_status_snapshot_rows(self):
        result = event_query_summary(
            {
                "events": [
                    {
                        "event": "status.snapshot",
                        "timestamp": "2026-03-29T12:00:00Z",
                        "payload": {
                            "source": {"method": "join"},
                            "detail": "at sector 825",
                        },
                    }
                ],
                "count": 1,
            },
            _nested_summary,
        )

        assert "status.snapshot: join marker:" in result
