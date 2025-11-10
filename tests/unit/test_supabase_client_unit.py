import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from utils.supabase_client import AsyncGameClient


class DummyResponse:
    status_code = 200

    @property
    def is_success(self) -> bool:
        return True

    def json(self):
        return {"success": True}


@pytest.mark.asyncio
async def test_supabase_client_translates_dotted_endpoints(monkeypatch):
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-key")
    monkeypatch.setenv("EDGE_API_TOKEN", "edge-token")
    monkeypatch.setenv("EDGE_FUNCTIONS_URL", "http://127.0.0.1:54321/functions/v1")

    client = AsyncGameClient(base_url="http://127.0.0.1:54321", character_id="char-id")

    called = {}

    async def fake_post(url, headers, json):
        called["url"] = url
        called["json"] = json
        return DummyResponse()

    client._http = SimpleNamespace(post=fake_post)  # type: ignore[attr-defined]
    client._ensure_realtime_listener = AsyncMock()  # type: ignore[attr-defined]

    await client._request("my.corporation", {"character_id": "char-id"})

    assert called["url"].endswith("/my_corporation")
    assert called["json"].get("character_id")
