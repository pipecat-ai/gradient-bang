from __future__ import annotations

from typing import Any, Dict

import pytest

from gradientbang.game.base_client import RPCError
from gradientbang.game.client import AsyncGameClient


PLAYER_ID = "11111111-1111-1111-1111-111111111111"


class _FakeHttpResponse:
    def __init__(self, body: Dict[str, Any], status_code: int) -> None:
        self._body = body
        self.status_code = status_code
        self.text = str(body)
        self.is_success = 200 <= status_code < 300

    def json(self) -> Dict[str, Any]:
        return self._body


class _FakeHttpClient:
    def __init__(self, response: _FakeHttpResponse) -> None:
        self.response = response

    async def post(self, *_args: Any, **_kwargs: Any) -> _FakeHttpResponse:
        return self.response


@pytest.mark.asyncio
async def test_failed_supabase_request_raises_and_synthesizes_local_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SUPABASE_URL", "http://test-supabase.local")
    monkeypatch.setenv("EDGE_API_TOKEN", "test-token")
    client = AsyncGameClient(
        base_url="http://test-supabase.local",
        character_id=PLAYER_ID,
        enable_event_polling=False,
    )
    seen: list[tuple[str, Dict[str, Any]]] = []

    async def capture(event_name: str, payload: Dict[str, Any], **_kwargs: Any) -> None:
        seen.append((event_name, payload))

    client._http = _FakeHttpClient(  # type: ignore[assignment]
        _FakeHttpResponse(
            {"success": False, "error": "Center sector must be visited", "status": 400},
            400,
        )
    )
    client._process_event = capture  # type: ignore[assignment]

    with pytest.raises(RPCError) as exc_info:
        await client._request("local_map_region", {"character_id": PLAYER_ID})

    assert exc_info.value.status == 400
    assert exc_info.value.detail == "Center sector must be visited"
    assert len(seen) == 1
    event_name, payload = seen[0]
    assert event_name == "error"
    assert payload["endpoint"] == "local_map_region"
    assert payload["error"] == "Center sector must be visited"
    assert payload["synthesized"] is True
    assert payload["status"] == 400
    assert payload["source"]["method"] == "local_map_region"
    assert payload["source"]["request_id"] == client.last_request_id
