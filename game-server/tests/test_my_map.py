from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from api import my_map


class DummyKnowledge:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def model_dump(self) -> dict:
        return dict(self._payload)


class DummyKnowledgeManager:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def load_knowledge(self, character_id: str) -> DummyKnowledge:
        data = dict(self._payload)
        data.setdefault("character_id", character_id)
        return DummyKnowledge(data)


@pytest.mark.asyncio
async def test_my_map_emits_map_knowledge(monkeypatch):
    knowledge_payload = {
        "sectors_visited": {"1": {"sector_id": 1}},
        "current_sector": 5,
    }
    world = SimpleNamespace(
        knowledge_manager=DummyKnowledgeManager(knowledge_payload),
        characters={"char-1": SimpleNamespace(sector=9)},
    )

    mock_emit = AsyncMock()
    monkeypatch.setattr(my_map, "event_dispatcher", SimpleNamespace(emit=mock_emit))

    result = await my_map.handle(
        {"character_id": "char-1", "request_id": "req-map"},
        world,
    )

    assert result == {"success": True}
    mock_emit.assert_awaited_once()
    event_name, payload = mock_emit.await_args.args[:2]
    assert event_name == "map.knowledge"
    assert payload["character_id"] == "char-1"
    assert payload["sector"] == 9
    assert "current_sector" not in payload
    assert payload["source"]["method"] == "my_map"
    assert payload["source"]["request_id"] == "req-map"
    assert mock_emit.await_args.kwargs["character_filter"] == ["char-1"]


@pytest.mark.asyncio
async def test_my_map_missing_character(monkeypatch):
    world = SimpleNamespace(knowledge_manager=DummyKnowledgeManager({}))

    mock_emit = AsyncMock()
    monkeypatch.setattr(my_map, "event_dispatcher", SimpleNamespace(emit=mock_emit))

    result = await my_map.handle({}, world)

    assert result == {
        "success": False,
        "error": "Missing character_id",
    }
    mock_emit.assert_not_awaited()
