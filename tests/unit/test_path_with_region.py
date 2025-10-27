from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from api import path_with_region


class DummySectorKnowledge:
    def __init__(self, adjacent=None, last_visited=None) -> None:
        self.adjacent_sectors = adjacent or []
        self.last_visited = last_visited


class DummyKnowledge:
    def __init__(self, sectors) -> None:
        self.sectors_visited = sectors
        self.current_sector = 0


class DummyKnowledgeManager:
    def __init__(self, knowledge) -> None:
        self._knowledge = knowledge

    def load_knowledge(self, character_id: str):
        return self._knowledge


class DummyGraph:
    def __init__(self, path) -> None:
        self._path = path
        self.sector_count = 50

    def find_path(self, from_sector: int, to_sector: int):
        return list(self._path)


@pytest.mark.asyncio
async def test_path_with_region_emits_event(monkeypatch):
    sectors = {
        "0": DummySectorKnowledge(adjacent=[1]),
        "1": DummySectorKnowledge(adjacent=[0], last_visited="2025-10-16T16:00:00Z"),
    }
    knowledge = DummyKnowledge(sectors)
    world = SimpleNamespace(
        universe_graph=DummyGraph(path=[0, 1]),
        knowledge_manager=DummyKnowledgeManager(knowledge),
        characters={"char-1": SimpleNamespace(sector=0)},
    )

    mock_contents = AsyncMock(return_value={"position": (0, 0)})
    monkeypatch.setattr(path_with_region, "sector_contents", mock_contents)

    mock_emit = AsyncMock()
    monkeypatch.setattr(
        path_with_region, "event_dispatcher", SimpleNamespace(emit=mock_emit)
    )

    result = await path_with_region.handle(
        {"character_id": "char-1", "to_sector": 1, "request_id": "req-path"},
        world,
    )

    assert result == {"success": True}

    event_name, payload = mock_emit.await_args.args[:2]
    assert event_name == "path.region"
    assert payload["path"] == [0, 1]
    assert payload["distance"] == 1
    assert payload["source"]["request_id"] == "req-path"
    assert payload["source"]["method"] == "path_with_region"
    assert mock_emit.await_args.kwargs["character_filter"] == ["char-1"]


@pytest.mark.asyncio
async def test_path_with_region_missing_character(monkeypatch):
    world = SimpleNamespace(
        universe_graph=DummyGraph(path=[0, 1]),
        knowledge_manager=DummyKnowledgeManager(DummyKnowledge({})),
        characters={},
    )

    mock_emit = AsyncMock()
    monkeypatch.setattr(
        path_with_region, "event_dispatcher", SimpleNamespace(emit=mock_emit)
    )

    with pytest.raises(HTTPException) as exc:
        await path_with_region.handle({"to_sector": 1}, world)

    assert exc.value.status_code == 400
    assert exc.value.detail == "Missing character_id"
    mock_emit.assert_not_awaited()
