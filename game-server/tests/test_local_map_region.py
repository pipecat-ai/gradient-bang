from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from api import local_map_region


class DummyKnowledge:
    def __init__(self, center: int) -> None:
        sector = SimpleNamespace(adjacent_sectors=[], last_visited=None)
        self.sectors_visited = {str(center): sector}
        self.current_sector = center


class DummyKnowledgeManager:
    def __init__(self, knowledge: DummyKnowledge) -> None:
        self._knowledge = knowledge

    def load_knowledge(self, character_id: str) -> DummyKnowledge:
        return self._knowledge


@pytest.mark.asyncio
async def test_local_map_region_emits_event(monkeypatch):
    knowledge = DummyKnowledge(center=5)
    world = SimpleNamespace(
        universe_graph=object(),
        knowledge_manager=DummyKnowledgeManager(knowledge),
        characters={"char-1": SimpleNamespace(sector=5)},
    )

    mock_region = AsyncMock(
        return_value={
            "center_sector": 5,
            "sectors": [{"sector_id": 5}],
            "total_sectors": 1,
        }
    )
    monkeypatch.setattr(local_map_region, "build_local_map_region", mock_region)

    mock_emit = AsyncMock()
    monkeypatch.setattr(
        local_map_region, "event_dispatcher", SimpleNamespace(emit=mock_emit)
    )

    result = await local_map_region.handle(
        {"character_id": "char-1", "request_id": "req-region"},
        world,
    )

    assert result == {"success": True}
    mock_region.assert_awaited_once()

    event_name, payload = mock_emit.await_args.args[:2]
    assert event_name == "map.region"
    assert payload["center_sector"] == 5
    assert payload["source"]["method"] == "local_map_region"
    assert payload["source"]["request_id"] == "req-region"
    assert mock_emit.await_args.kwargs["character_filter"] == ["char-1"]


@pytest.mark.asyncio
async def test_local_map_region_missing_character(monkeypatch):
    knowledge = DummyKnowledge(center=0)
    world = SimpleNamespace(
        universe_graph=object(),
        knowledge_manager=DummyKnowledgeManager(knowledge),
        characters={},
    )

    mock_emit = AsyncMock()
    monkeypatch.setattr(
        local_map_region, "event_dispatcher", SimpleNamespace(emit=mock_emit)
    )

    result = await local_map_region.handle({}, world)

    assert result == {"success": False, "error": "Missing character_id"}
    mock_emit.assert_not_awaited()
