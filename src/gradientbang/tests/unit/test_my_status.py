from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from gradientbang.game_server.api import my_status


class DummyCharacter:
    def __init__(self, *, in_hyperspace: bool = False) -> None:
        self.in_hyperspace = in_hyperspace


@pytest.mark.asyncio
async def test_my_status_emits_status_snapshot(monkeypatch):
    world = SimpleNamespace(characters={"char-1": DummyCharacter()})

    mock_payload = {"player": {"name": "char-1"}, "ship": {}, "sector": {}}
    mock_build_status = AsyncMock(return_value=mock_payload)
    monkeypatch.setattr(my_status, "build_status_payload", mock_build_status)

    mock_emit = AsyncMock()
    monkeypatch.setattr(
        my_status, "event_dispatcher", SimpleNamespace(emit=mock_emit)
    )

    result = await my_status.handle(
        {"character_id": "char-1", "request_id": "req-1"},
        world,
    )

    assert result == {"success": True}
    mock_build_status.assert_awaited_once_with(world, "char-1")

    mock_emit.assert_awaited_once()
    event_args = mock_emit.await_args
    event_name, payload = event_args.args[:2]
    assert event_name == "status.snapshot"
    assert payload["player"]["name"] == "char-1"
    assert payload["source"]["method"] == "my_status"
    assert payload["source"]["request_id"] == "req-1"
    assert event_args.kwargs["character_filter"] == ["char-1"]


@pytest.mark.asyncio
async def test_my_status_missing_character(monkeypatch):
    world = SimpleNamespace(characters={})
    mock_emit = AsyncMock()
    monkeypatch.setattr(
        my_status, "event_dispatcher", SimpleNamespace(emit=mock_emit)
    )

    with pytest.raises(HTTPException) as exc:
        await my_status.handle({"character_id": "ghost", "request_id": "req-fail"}, world)

    assert exc.value.status_code == 404
    assert exc.value.detail == "Character 'ghost' not found"

    mock_emit.assert_awaited_once()
    event_name, payload = mock_emit.await_args.args[:2]
    assert event_name == "error"
    assert payload["endpoint"] == "my_status"
    assert payload["error"] == "Character 'ghost' not found"
