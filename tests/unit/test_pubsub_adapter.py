"""Focused tests for ``PubsubEventAdapter``.

Tests target the bits unique to pubsub — envelope rehydration into the
payload (so EventRelay accepts the message), the cached internal-token
exchange, and the dispatch-failure / poison-message archival policy in
``_poll_once``. Ownership filtering and downstream sinks are exercised
in ``test_supabase_client.py`` since they run via the shared
``client._process_event`` path. Connection/loop lifecycle is covered by
the integration suite.
"""

from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from gradientbang.adapters.events import pubsub as pubsub_module
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

    async def test_sends_edge_auth_header(
        self,
        adapter: PubsubEventAdapter,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """verify_token is a bot-internal bridge; the call must carry
        X-Edge-Auth (the EDGE_API_TOKEN) alongside the user JWT in
        Authorization. Without it, the edge function returns 401 because
        the trusted-backend gate fails.
        """
        future_exp = int(time.time()) + 600
        mock_resp = MagicMock(status_code=200, text="ok")
        mock_resp.json.return_value = {
            "success": True, "token": "tok-X", "expires_at": future_exp,
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

        await adapter._ensure_internal_token(PLAYER_ID)
        assert post_mock.await_count == 1
        _, kwargs = post_mock.await_args
        headers = kwargs["headers"]
        assert headers["X-Edge-Auth"] == "test-token"
        assert headers["Authorization"] == "Bearer test-access-token"


# ---------------------------------------------------------------------------
# Helpers + tests for `_poll_once` archival policy.
# A failed dispatch must NOT archive on the first few attempts (so pgmq's
# visibility-timeout redelivery can retry transient faults), but must archive
# eventually so a genuinely poison message can't loop forever.
# ---------------------------------------------------------------------------


class _FakeCursor:
    """Async cursor stub. Records every execute() call and serves a queue
    of fetchall() results. Tests inspect ``executions`` to verify which
    msg_ids were passed to archive_my_events."""

    def __init__(
        self,
        fetch_results: list[list[tuple]],
        *,
        raise_on_execute: Exception | None = None,
    ) -> None:
        self._fetch_results = fetch_results
        self._raise_on_execute = raise_on_execute
        self.executions: list[tuple[str, tuple]] = []

    async def __aenter__(self) -> "_FakeCursor":
        return self

    async def __aexit__(self, *_args) -> bool:
        return False

    async def execute(self, sql: str, params: tuple) -> None:
        self.executions.append((sql, params))
        if self._raise_on_execute is not None:
            raise self._raise_on_execute

    async def fetchall(self) -> list[tuple]:
        return self._fetch_results.pop(0) if self._fetch_results else []


class _FakeConnection:
    def __init__(self, cursor: _FakeCursor) -> None:
        self._cursor = cursor

    async def __aenter__(self) -> "_FakeConnection":
        return self

    async def __aexit__(self, *_args) -> bool:
        return False

    def cursor(self) -> _FakeCursor:
        return self._cursor


def _install_fake_psycopg(
    monkeypatch: pytest.MonkeyPatch, cursor: _FakeCursor
) -> None:
    """Patch psycopg.AsyncConnection.connect to yield a fake connection."""

    async def fake_connect(*_args, **_kwargs):
        return _FakeConnection(cursor)

    monkeypatch.setattr(
        pubsub_module.psycopg.AsyncConnection,
        "connect",
        staticmethod(fake_connect),
    )


def _stub_internal_token(adapter: PubsubEventAdapter) -> None:
    """Skip verify_token round-trip; tests aren't exercising token caching."""

    async def _stub(_character_id: str) -> str:
        return "fake-internal-token"

    adapter._ensure_internal_token = _stub  # type: ignore[assignment]


def _envelope(msg_id: int, read_ct: int, *, event_type: str = "task.progress") -> tuple:
    """A row shaped like the new SELECT msg_id, read_ct, message."""
    return (
        msg_id,
        read_ct,
        {
            "event_type": event_type,
            "payload": {"step": msg_id},
            "event_context": {
                "event_id": None,
                "character_id": PLAYER_ID,
                "reason": "direct",
                "scope": "direct",
                "recipient_ids": [PLAYER_ID],
                "recipient_reasons": ["direct"],
            },
        },
    )


def _archived_msg_ids(cursor: _FakeCursor) -> list[int]:
    """Pull the msg_ids passed to archive_my_events out of the recorded SQL."""
    archive_calls = [
        params for sql, params in cursor.executions if "archive_my_events" in sql
    ]
    if not archive_calls:
        return []
    # Last param to archive_my_events is the msg_ids list.
    return list(archive_calls[-1][-1])


@pytest.mark.asyncio
class TestPollOnceArchival:
    async def test_successful_dispatch_archives(
        self,
        adapter: PubsubEventAdapter,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("PGMQ_URL", "postgresql://fake")
        cursor = _FakeCursor(fetch_results=[[_envelope(101, read_ct=1)]])
        _install_fake_psycopg(monkeypatch, cursor)
        _stub_internal_token(adapter)
        adapter._dispatch = AsyncMock()  # type: ignore[assignment]

        await adapter._poll_once(PLAYER_ID)

        assert _archived_msg_ids(cursor) == [101]

    async def test_dispatch_failure_below_max_defers_archive(
        self,
        adapter: PubsubEventAdapter,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Transient failures: pgmq must redeliver via visibility timeout."""
        monkeypatch.setenv("PGMQ_URL", "postgresql://fake")
        # read_ct=1 is the first delivery — well below MAX_DISPATCH_ATTEMPTS=3.
        cursor = _FakeCursor(fetch_results=[[_envelope(202, read_ct=1)]])
        _install_fake_psycopg(monkeypatch, cursor)
        _stub_internal_token(adapter)
        adapter._dispatch = AsyncMock(side_effect=RuntimeError("bus hiccup"))  # type: ignore[assignment]

        await adapter._poll_once(PLAYER_ID)

        # The msg_id must NOT be archived. Since it's the only message,
        # archive_my_events should not be called at all.
        assert _archived_msg_ids(cursor) == []
        assert all(
            "archive_my_events" not in sql for sql, _ in cursor.executions
        )

    async def test_poison_message_archived_after_max_attempts(
        self,
        adapter: PubsubEventAdapter,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Permanent failures must not loop forever — archive at MAX."""
        monkeypatch.setenv("PGMQ_URL", "postgresql://fake")
        cursor = _FakeCursor(fetch_results=[[_envelope(303, read_ct=3)]])
        _install_fake_psycopg(monkeypatch, cursor)
        _stub_internal_token(adapter)
        adapter._dispatch = AsyncMock(side_effect=RuntimeError("always raises"))  # type: ignore[assignment]

        await adapter._poll_once(PLAYER_ID)

        assert _archived_msg_ids(cursor) == [303]

    async def test_mixed_batch_archives_only_successes_and_poison(
        self,
        adapter: PubsubEventAdapter,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """In a mixed batch, success and poison are archived, transient
        failures are left for redelivery."""
        monkeypatch.setenv("PGMQ_URL", "postgresql://fake")
        cursor = _FakeCursor(
            fetch_results=[
                [
                    _envelope(1, read_ct=1),  # will succeed → archive
                    _envelope(2, read_ct=1),  # will raise, transient → defer
                    _envelope(3, read_ct=3),  # will raise, poison → archive
                ]
            ]
        )
        _install_fake_psycopg(monkeypatch, cursor)
        _stub_internal_token(adapter)

        async def selective_dispatch(message):
            if message["payload"]["step"] in (2, 3):
                raise RuntimeError("handler bug")

        adapter._dispatch = selective_dispatch  # type: ignore[assignment]

        await adapter._poll_once(PLAYER_ID)

        assert _archived_msg_ids(cursor) == [1, 3]

    async def test_malformed_message_archived_immediately(
        self,
        adapter: PubsubEventAdapter,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Non-Mapping messages are unparseable garbage — archive on first
        sight, do not retry."""
        monkeypatch.setenv("PGMQ_URL", "postgresql://fake")
        cursor = _FakeCursor(fetch_results=[[(404, 1, "not-a-dict")]])
        _install_fake_psycopg(monkeypatch, cursor)
        _stub_internal_token(adapter)
        adapter._dispatch = AsyncMock()  # type: ignore[assignment]

        await adapter._poll_once(PLAYER_ID)

        assert _archived_msg_ids(cursor) == [404]


@pytest.mark.asyncio
class TestPurgeBacklog:
    """`purge_backlog` ensures the per-character queue exists and is empty
    so bootstrap-RPC publishes during session_init land successfully and
    reach the client, while still discarding any backlog from a prior
    session. Previously dropped the queue, but that lost bootstrap-window
    events to ``undefined_table`` silent no-ops."""

    async def test_purge_ensures_and_clears_each_character_queue(
        self,
        adapter: PubsubEventAdapter,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("PGMQ_URL", "postgresql://fake")
        cursor = _FakeCursor(fetch_results=[])
        _install_fake_psycopg(monkeypatch, cursor)

        await adapter.purge_backlog()

        ensure_calls = [
            params for sql, params in cursor.executions if "ensure_character_queue" in sql
        ]
        purge_calls = [
            params for sql, params in cursor.executions if "purge_queue" in sql
        ]
        assert ensure_calls == [(PLAYER_ID,)]
        assert purge_calls == [(f"chr_{PLAYER_ID}",)]

    async def test_purge_swallows_errors(
        self,
        adapter: PubsubEventAdapter,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A pgmq error must not bubble up — the whole point of purge is
        to leave a clean slate, and ``start`` will surface real problems
        if any."""
        monkeypatch.setenv("PGMQ_URL", "postgresql://fake")
        cursor = _FakeCursor(fetch_results=[], raise_on_execute=RuntimeError("queue not found"))
        _install_fake_psycopg(monkeypatch, cursor)

        await adapter.purge_backlog()  # must not raise


@pytest.mark.asyncio
class TestDynamicScopePreflight:
    async def test_dynamic_preflight_retries_before_poll_loop(
        self,
        adapter: PubsubEventAdapter,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A transient preflight failure must not permanently drop an
        in-scope dynamic subscription."""

        adapter._character_ids = [PLAYER_ID, CORP_SHIP_ID]
        self_test = AsyncMock(side_effect=[RuntimeError("db hiccup"), None])
        adapter._run_startup_self_test = self_test  # type: ignore[assignment]
        entered_loop = asyncio.Event()

        async def fake_character_loop(_character_id: str) -> None:
            entered_loop.set()

        adapter._character_loop = fake_character_loop  # type: ignore[assignment]

        async def immediate_wait_for(awaitable, *, timeout):
            awaitable.close()
            await asyncio.sleep(0)

        monkeypatch.setattr(pubsub_module.asyncio, "wait_for", immediate_wait_for)

        await adapter._dynamic_character_loop(CORP_SHIP_ID)

        assert self_test.await_count == 2
        assert entered_loop.is_set()

    async def test_dynamic_preflight_removed_scope_does_not_start_stale_loop(
        self,
        adapter: PubsubEventAdapter,
    ) -> None:
        """If scope changes while preflight is awaiting, recheck membership
        before starting the long-poll task."""

        adapter._character_ids = [PLAYER_ID, CORP_SHIP_ID]
        entered_loop = asyncio.Event()

        async def fake_self_test(_character_id: str) -> None:
            adapter._character_ids = [PLAYER_ID]

        async def fake_character_loop(_character_id: str) -> None:
            entered_loop.set()

        adapter._run_startup_self_test = fake_self_test  # type: ignore[assignment]
        adapter._character_loop = fake_character_loop  # type: ignore[assignment]

        await adapter._dynamic_character_loop(CORP_SHIP_ID)

        assert not entered_loop.is_set()
