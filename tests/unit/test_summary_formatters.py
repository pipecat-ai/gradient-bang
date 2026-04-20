"""Tests for bounded summary formatter behavior."""

import pytest

from gradientbang.utils.summary_formatters import (
    _EVENT_QUERY_MAX_EVENTS,
    _EVENT_QUERY_MAX_TOTAL_CHARS,
    _format_port_prices_compact,
    event_query_summary,
    list_known_ports_summary,
    map_local_summary,
    port_update_summary,
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

    def test_omits_recursive_event_query_rows_by_default(self):
        result = event_query_summary(
            {
                "events": [
                    {
                        "event": "event.query",
                        "timestamp": "2026-03-29T12:00:00Z",
                        "payload": {"count": 30, "has_more": True},
                    },
                    {
                        "event": "task.finish",
                        "timestamp": "2026-03-29T12:00:01Z",
                        "payload": {"detail": "found the useful answer"},
                    },
                ],
                "count": 2,
                "filters": {"filter_string_match": "Aegis Cruiser"},
            },
            _nested_summary,
        )

        assert "event.query row omitted" in result
        assert "nested query returned" not in result
        assert "task.finish" in result

    def test_keeps_event_query_rows_when_explicitly_requested(self):
        result = event_query_summary(
            {
                "events": [
                    {
                        "event": "event.query",
                        "timestamp": "2026-03-29T12:00:00Z",
                        "payload": {"count": 30, "has_more": True},
                    }
                ],
                "count": 1,
                "filters": {"filter_event_type": "event.query"},
            },
            lambda event_name, payload: (
                "nested query returned "
                f"{payload.get('count', 0)} events"
                f"{' (more available)' if payload.get('has_more') else ''}"
            ),
        )

        assert "nested query returned 30 events (more available)" in result
        assert "event.query row omitted" not in result


@pytest.mark.unit
class TestPortMegaMarker:
    """Every rendered port string must carry an affirmative MEGA/STD marker.

    Non-mega had previously been encoded as absence of the "MEGA" prefix —
    the LLM missed non-mega ports because it looked for a presence signal.
    Both states now carry an explicit token so there is no negative-space
    inference.
    """

    def _port(self, *, mega: bool, code: str = "BBS") -> dict:
        return {
            "code": code,
            "mega": mega,
            "prices": {"quantum_foam": 33, "retro_organics": 13, "neuro_symbolics": 52},
        }

    def test_compact_formatter_marks_mega(self):
        rendered = _format_port_prices_compact(self._port(mega=True))
        assert rendered.startswith("MEGA "), rendered

    def test_compact_formatter_marks_standard(self):
        rendered = _format_port_prices_compact(self._port(mega=False))
        assert rendered.startswith("STD "), rendered
        assert "MEGA" not in rendered

    def test_list_known_ports_summary_marks_each_port(self):
        result = {
            "from_sector": 100,
            "total_ports_found": 2,
            "ports": [
                {
                    "sector": {"id": 305, "port": self._port(mega=True, code="SSS")},
                    "hops_from_start": 3,
                },
                {
                    "sector": {"id": 3344, "port": self._port(mega=False, code="BSB")},
                    "hops_from_start": 0,
                },
            ],
        }
        summary = list_known_ports_summary(result)
        assert "MEGA SSS" in summary
        assert "STD BSB" in summary

    def test_port_update_summary_marks_mega(self):
        event = {
            "sector": {"id": 42, "port": self._port(mega=True, code="SSS")},
        }
        summary = port_update_summary(event)
        assert "MEGA SSS" in summary

    def test_port_update_summary_marks_standard(self):
        event = {
            "sector": {"id": 42, "port": self._port(mega=False, code="BSB")},
        }
        summary = port_update_summary(event)
        assert "STD BSB" in summary


@pytest.mark.unit
class TestMapLocalSummary:
    """Regression tests for the removed 'We are currently in sector X' line.

    The shared AsyncGameClient's _current_sector cache can represent only one
    entity, but map.local / map.region / map.update events flow through the
    client for multiple entities (player + corp ships). Embedding _current_sector
    into these summaries leaked one entity's sector into another's context. The
    line was removed; this test guards against reintroduction. See
    planning-docs/shared-client-sector-pollution-2026-04-18.md.
    """

    @staticmethod
    def _realistic_result() -> dict:
        return {
            "center_sector": 3815,
            "total_visited": 14,
            "total_sectors": 19,
            "total_unvisited": 5,
            "sectors": [
                {
                    "id": 3815,
                    "visited": True,
                    "hops_from_center": 0,
                    "region": "Neutral",
                    "adjacent_sectors": {
                        "4074": {"region": "Neutral"},
                        "4149": {"region": "Neutral"},
                    },
                },
                {"id": 4074, "visited": False, "hops_from_center": 1, "region": "Neutral"},
                {"id": 4149, "visited": False, "hops_from_center": 1, "region": "Neutral"},
                {"id": 2495, "visited": False, "hops_from_center": 3, "region": "Neutral"},
            ],
        }

    def test_omits_we_are_currently_line(self):
        summary = map_local_summary(self._realistic_result())
        assert "We are currently" not in summary

    def test_retains_core_content(self):
        summary = map_local_summary(self._realistic_result())
        assert "Local map around sector 3815" in summary
        assert "14/19 visited" in summary
        assert "5 unvisited" in summary
        assert "Nearest unvisited" in summary
