"""Focused tests for ``PubsubEventAdapter``.

Tests target the bits unique to pubsub — envelope rehydration into the
payload (so EventRelay accepts the message) and the cached internal-token
exchange. Ownership filtering and downstream sinks are exercised in
``test_supabase_client.py`` since they run via the shared
``client._process_event`` path. Connection/loop lifecycle is covered by
the integration suite.
"""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from gradientbang.adapters.events.pubsub import PubsubEventAdapter
from gradientbang.utils.supabase_client import AsyncGameClient


PLAYER_ID = "11111111-1111-1111-1111-111111111111"
CORP_SHIP_ID = "22222222-2222-2222-2222-222222222222"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> AsyncGameClient:
    monkeypatch.setenv("SUPABASE_URL", "http://test-supabase.local")
    monkeypatch.setenv("EDGE_API_TOKEN", "test-token")
    return AsyncGameClient(
        character_id=PLAYER_ID,
        enable_event_polling=False,
        access_token="test-access-token",
    )


@pytest.fixture
def adapter(client: AsyncGameClient) -> PubsubEventAdapter:
    return PubsubEventAdapter(client)


@pytest.mark.asyncio
async def test_dispatch_rehydrates_event_context_and_task_id(
    client: AsyncGameClient, adapter: PubsubEventAdapter
) -> None:
    """Pubsub consumer must mirror polling's __event_context / __task_id
    rehydration. EventRelay drops non-combat events when __event_context
    is missing (event_relay.py:1784) and routes tasks via
    payload['__task_id'] (event_relay.py:1953). Also verifies that an
    already-injected payload __task_id takes precedence over the envelope.
    """
    seen: list[tuple[str, dict]] = []

    async def capture(name, payload, **_):
        seen.append((name, dict(payload)))

    client._process_event = capture  # type: ignore[assignment]

    # Envelope-only task_id → flows into payload as __task_id.
    await adapter._dispatch(
        {
            "event_type": "task.progress",
            "payload": {"step": 1},
            "task_id": "task-abc",
            "event_context": {
                "event_id": None,
                "character_id": PLAYER_ID,
                "reason": "direct",
                "scope": "direct",
                "recipient_ids": [PLAYER_ID],
                "recipient_reasons": ["direct"],
            },
        }
    )

    # Payload-injected __task_id wins over envelope task_id.
    await adapter._dispatch(
        {
            "event_type": "task.progress",
            "payload": {"__task_id": "from-payload"},
            "task_id": "from-toplevel",
        }
    )

    assert len(seen) == 2
    _, first = seen[0]
    assert first["__event_context"]["character_id"] == PLAYER_ID
    assert first["__event_context"]["reason"] == "direct"
    assert first["__task_id"] == "task-abc"
    assert seen[1][1]["__task_id"] == "from-payload"


@pytest.mark.asyncio
class TestEnsureInternalToken:
    """``_ensure_internal_token`` calls verify_token, caches per-character,
    and refreshes on near-expiry.
    """

    async def test_caches_per_character_within_ttl(
        self,
        adapter: PubsubEventAdapter,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        future_exp = int(time.time()) + 600
        responses = [
            MagicMock(status_code=200, text="ok"),
            MagicMock(status_code=200, text="ok"),
        ]
        responses[0].json.return_value = {
            "success": True, "token": "tok-A", "expires_at": future_exp,
        }
        responses[1].json.return_value = {
            "success": True, "token": "tok-B", "expires_at": future_exp,
        }
        post_mock = AsyncMock(side_effect=responses)

        class FakeAsyncClient:
            def __init__(self, *_args, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            post = post_mock

        monkeypatch.setattr(
            "gradientbang.adapters.events.pubsub.httpx.AsyncClient",
            FakeAsyncClient,
        )

        # First call for each character mints; repeats hit the cache.
        assert await adapter._ensure_internal_token(PLAYER_ID) == "tok-A"
        assert await adapter._ensure_internal_token(CORP_SHIP_ID) == "tok-B"
        assert await adapter._ensure_internal_token(PLAYER_ID) == "tok-A"
        assert await adapter._ensure_internal_token(CORP_SHIP_ID) == "tok-B"
        assert post_mock.await_count == 2

    async def test_refresh_when_near_expiry(
        self,
        adapter: PubsubEventAdapter,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Seed cache with a token expiring within the 60s safety margin
        adapter._internal_tokens[PLAYER_ID] = ("stale-token", time.time() + 30)

        future_exp = int(time.time()) + 3600
        mock_resp = MagicMock(status_code=200, text="ok")
        mock_resp.json.return_value = {
            "success": True,
            "token": "fresh-token",
            "expires_at": future_exp,
        }
        post_mock = AsyncMock(return_value=mock_resp)

        class FakeAsyncClient:
            def __init__(self, *_args, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            post = post_mock

        monkeypatch.setattr(
            "gradientbang.adapters.events.pubsub.httpx.AsyncClient",
            FakeAsyncClient,
        )

        token = await adapter._ensure_internal_token(PLAYER_ID)
        assert token == "fresh-token"
        assert post_mock.await_count == 1
