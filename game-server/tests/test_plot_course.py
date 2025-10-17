from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from api import plot_course


class DummyCharacter:
    def __init__(self, sector: int) -> None:
        self.sector = sector


class DummyGraph:
    def __init__(self, sector_count: int = 10, path=None) -> None:
        self.sector_count = sector_count
        self._path = path or []

    def find_path(self, from_sector: int, to_sector: int):
        return list(self._path)


@pytest.mark.asyncio
async def test_plot_course_emits_event_and_returns_success(monkeypatch):
    graph = DummyGraph(path=[0, 1, 2])
    world = SimpleNamespace(
        universe_graph=graph,
        characters={"char-1": DummyCharacter(sector=0)},
    )

    mock_emit = AsyncMock()
    monkeypatch.setattr(
        plot_course, "event_dispatcher", SimpleNamespace(emit=mock_emit)
    )

    result = await plot_course.handle(
        {
            "character_id": "char-1",
            "to_sector": 2,
            "request_id": "req-plot",
        },
        world,
    )

    assert result == {"success": True}
    mock_emit.assert_awaited_once()

    event_name, payload = mock_emit.await_args.args[:2]
    assert event_name == "course.plot"
    assert payload["path"] == [0, 1, 2]
    assert payload["distance"] == 2
    assert payload["source"]["method"] == "plot_course"
    assert payload["source"]["request_id"] == "req-plot"
    assert mock_emit.await_args.kwargs["character_filter"] == ["char-1"]


@pytest.mark.asyncio
async def test_plot_course_missing_character_returns_failure(monkeypatch):
    world = SimpleNamespace(
        universe_graph=DummyGraph(path=[0, 1]),
        characters={},
    )
    mock_emit = AsyncMock()
    monkeypatch.setattr(
        plot_course, "event_dispatcher", SimpleNamespace(emit=mock_emit)
    )

    with pytest.raises(HTTPException) as exc:
        await plot_course.handle(
            {"character_id": "ghost", "to_sector": 1, "request_id": "req-fail"},
            world,
        )

    assert exc.value.status_code == 404
    assert exc.value.detail == "Character not found: ghost"
    mock_emit.assert_awaited_once()
    event_name, payload = mock_emit.await_args.args[:2]
    assert event_name == "error"
    assert payload["endpoint"] == "plot_course"
    assert payload["error"] == "Character not found: ghost"
