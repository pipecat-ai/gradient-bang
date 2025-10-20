from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from api import list_known_ports


class DummySectorKnowledge:
    def __init__(self, port=None, adjacent=None, adjacent_sectors=None, last_visited=None) -> None:
        self.port = port
        if adjacent_sectors is not None:
            self.adjacent_sectors = adjacent_sectors
        else:
            self.adjacent_sectors = adjacent or []
        self.last_visited = last_visited


class DummyKnowledge:
    def __init__(self, sectors) -> None:
        self.sectors_visited = sectors
        self.current_sector = next(iter(int(k) for k in sectors.keys()))


class DummyKnowledgeManager:
    def __init__(self, knowledge) -> None:
        self._knowledge = knowledge

    def load_knowledge(self, character_id: str):
        return self._knowledge


@pytest.mark.asyncio
async def test_list_known_ports_emits_event(monkeypatch):
    sectors = {
        "0": DummySectorKnowledge(
            port={"code": "BSS"},
            adjacent_sectors=[1],
            last_visited="2025-10-16T15:00:00Z",
        )
    }
    knowledge = DummyKnowledge(sectors)
    world = SimpleNamespace(
        universe_graph=object(),
        knowledge_manager=DummyKnowledgeManager(knowledge),
        characters={"char-1": SimpleNamespace(sector=0)},
    )

    mock_contents = AsyncMock(return_value={"position": (0, 0)})
    monkeypatch.setattr(list_known_ports, "sector_contents", mock_contents)

    mock_emit = AsyncMock()
    monkeypatch.setattr(
        list_known_ports, "event_dispatcher", SimpleNamespace(emit=mock_emit)
    )

    result = await list_known_ports.handle(
        {"character_id": "char-1", "request_id": "req-ports"},
        world,
    )

    assert result == {"success": True}

    event_name, payload = mock_emit.await_args.args[:2]
    assert event_name == "ports.list"
    assert payload["from_sector"] == 0
    assert payload["total_ports_found"] == 1
    assert payload["ports"][0]["sector_id"] == 0
    assert payload["source"]["method"] == "list_known_ports"
    assert payload["source"]["request_id"] == "req-ports"
    assert mock_emit.await_args.kwargs["character_filter"] == ["char-1"]


@pytest.mark.asyncio
async def test_list_known_ports_unknown_commodity(monkeypatch):
    sectors = {"0": DummySectorKnowledge(port={"code": "BSS"})}
    knowledge = DummyKnowledge(sectors)
    world = SimpleNamespace(
        universe_graph=object(),
        knowledge_manager=DummyKnowledgeManager(knowledge),
        characters={"char-1": SimpleNamespace(sector=0)},
    )

    mock_emit = AsyncMock()
    monkeypatch.setattr(
        list_known_ports, "event_dispatcher", SimpleNamespace(emit=mock_emit)
    )

    with pytest.raises(HTTPException) as exc:
        await list_known_ports.handle(
            {
                "character_id": "char-1",
                "commodity": "dark_matter",
                "trade_type": "buy",
                "request_id": "req-fail",
            },
            world,
        )

    assert exc.value.status_code == 400
    assert exc.value.detail == "Unknown commodity: dark_matter"

    mock_emit.assert_awaited_once()
    event_name, payload = mock_emit.await_args.args[:2]
    assert event_name == "error"
    assert payload["endpoint"] == "list_known_ports"
    assert payload["error"] == "Unknown commodity: dark_matter"
