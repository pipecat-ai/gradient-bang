"""Focused tests for session-scoped ``PubsubEventAdapter``."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from gradientbang.game.transport import pubsub as pubsub_module
from gradientbang.game.transport.pubsub import DEFAULT_QTY, PubsubEventAdapter
from gradientbang.game.client import AsyncGameClient


PLAYER_ID = "11111111-1111-1111-1111-111111111111"
CORP_SHIP_ID = "22222222-2222-2222-2222-222222222222"
OTHER_SHIP_ID = "33333333-3333-3333-3333-333333333333"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> AsyncGameClient:
    monkeypatch.setenv("EDGE_API_TOKEN", "test-token")
    monkeypatch.setenv("SUPABASE_URL", "http://localhost:54321")
    return AsyncGameClient(
        base_url="http://localhost:54321",
        character_id=PLAYER_ID,
        enable_event_polling=False,
    )


@pytest.fixture
def adapter(client: AsyncGameClient) -> PubsubEventAdapter:
    return PubsubEventAdapter(client)


class _FakeCursor:
    def __init__(
        self,
        fetch_results: list[list[tuple]] | None = None,
        *,
        fetchone_results: list[tuple | None] | None = None,
        raise_on_execute: Exception | None = None,
    ) -> None:
        self._fetch_results = fetch_results or []
        self._fetchone_results = fetchone_results or []
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

    async def fetchone(self) -> tuple | None:
        return self._fetchone_results.pop(0) if self._fetchone_results else None


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
    async def fake_connect(*_args, **_kwargs):
        return _FakeConnection(cursor)

    monkeypatch.setattr(
        pubsub_module.psycopg.AsyncConnection,
        "connect",
        staticmethod(fake_connect),
    )


def _envelope(
    msg_id: int,
    read_ct: int,
    *,
    event_id: int | None = None,
    event_type: str = "task.progress",
    request_id: str | None = None,
) -> tuple:
    return (
        msg_id,
        read_ct,
        {
            "event_type": event_type,
            "payload": {"step": msg_id},
            "request_id": request_id,
            "event_context": {
                "event_id": event_id,
                "character_id": PLAYER_ID,
                "reason": "direct",
                "scope": "direct",
                "recipient_ids": [PLAYER_ID],
                "recipient_reasons": ["direct"],
            },
        },
    )


def _archive_call(cursor: _FakeCursor) -> list[int]:
    archive_calls = [
        params for sql, params in cursor.executions if "event_session_archive" in sql
    ]
    if not archive_calls:
        return []
    return list(archive_calls[-1][-1])


def _subscribe_calls(cursor: _FakeCursor) -> list[tuple]:
    return [
        params for sql, params in cursor.executions if "event_session_subscribe" in sql
    ]


@pytest.mark.asyncio
async def test_dispatch_rehydrates_event_context_and_task_id(
    client: AsyncGameClient, adapter: PubsubEventAdapter
) -> None:
    seen: list[tuple[str, dict]] = []

    async def capture(name, payload, **_):
        seen.append((name, dict(payload)))

    client._process_event = capture  # type: ignore[assignment]

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
async def test_prepare_bootstrap_registers_session_and_starts_heartbeat(
    adapter: PubsubEventAdapter,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PGMQ_URL", "postgresql://fake")
    cursor = _FakeCursor(
        fetchone_results=[
            ("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "evs_queue"),
            (True,),
        ]
    )
    _install_fake_psycopg(monkeypatch, cursor)

    await adapter.prepare_bootstrap()

    register_calls = [
        params for sql, params in cursor.executions if "event_session_register" in sql
    ]
    assert register_calls == [
        (
            PLAYER_ID,
            "test-token",
            [PLAYER_ID],
            None,
            pubsub_module.TTL_SECONDS,
            pubsub_module.HARD_TTL_SECONDS,
        )
    ]
    assert adapter._session_id == "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    assert adapter._queue_name == "evs_queue"
    queue_exists_calls = [
        params for sql, params in cursor.executions if "pg_class" in sql
    ]
    assert queue_exists_calls == [("q_evs_queue",)]
    assert adapter._heartbeat_task is not None
    await adapter.stop()


@pytest.mark.asyncio
async def test_prepare_bootstrap_bails_if_registered_queue_is_missing(
    adapter: PubsubEventAdapter,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PGMQ_URL", "postgresql://fake")
    cursor = _FakeCursor(
        fetchone_results=[
            ("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "evs_queue"),
            (False,),
        ]
    )
    _install_fake_psycopg(monkeypatch, cursor)

    with pytest.raises(RuntimeError, match="physical pgmq queue is missing"):
        await adapter.prepare_bootstrap()

    assert adapter._session_id is None
    assert adapter._queue_name is None
    assert adapter._heartbeat_task is None


@pytest.mark.asyncio
class TestSessionPolling:
    async def test_set_scope_actor_first_sorted_and_marks_pending(
        self, adapter: PubsubEventAdapter
    ) -> None:
        adapter._started = True
        adapter._scope_changed_event.clear()

        adapter.set_scope(
            character_ids=[PLAYER_ID],
            ship_ids=[OTHER_SHIP_ID, CORP_SHIP_ID],
        )

        assert adapter._character_ids == [PLAYER_ID, CORP_SHIP_ID, OTHER_SHIP_ID]
        assert adapter._pending_scope_sync is True
        assert adapter._scope_changed_event.is_set()
        assert not hasattr(adapter, "_char_tasks")

    async def test_empty_read_returns_false_without_archive(
        self, adapter: PubsubEventAdapter
    ) -> None:
        adapter._session_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        cursor = _FakeCursor(fetch_results=[[]])
        adapter._dispatch = AsyncMock()  # type: ignore[assignment]

        had_rows = await adapter._poll_session_once(cursor)

        assert had_rows is False
        assert _archive_call(cursor) == []
        adapter._dispatch.assert_not_called()

    async def test_session_poll_uses_one_session_read(
        self, adapter: PubsubEventAdapter
    ) -> None:
        adapter._session_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        cursor = _FakeCursor(fetch_results=[[]])

        await adapter._poll_session_once(cursor)

        assert _subscribe_calls(cursor) == [
            (
                "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                "test-token",
                pubsub_module.VISIBILITY_TIMEOUT_SECONDS,
                DEFAULT_QTY,
            )
        ]

    async def test_successful_dispatch_archives_session_messages_in_event_order(
        self, adapter: PubsubEventAdapter
    ) -> None:
        adapter._session_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        cursor = _FakeCursor(
            fetch_results=[
                [
                    _envelope(201, read_ct=1, event_id=20),
                    _envelope(101, read_ct=1, event_id=10),
                ]
            ]
        )
        dispatched: list[int] = []

        async def capture(message):
            dispatched.append(message["payload"]["step"])

        adapter._dispatch = capture  # type: ignore[assignment]

        had_rows = await adapter._poll_session_once(cursor)

        assert had_rows is True
        assert dispatched == [101, 201]
        assert _archive_call(cursor) == [101, 201]

    async def test_dispatch_failure_below_max_defers_archive(
        self, adapter: PubsubEventAdapter
    ) -> None:
        adapter._session_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        cursor = _FakeCursor(fetch_results=[[_envelope(202, read_ct=1, event_id=202)]])
        adapter._dispatch = AsyncMock(side_effect=RuntimeError("bus hiccup"))  # type: ignore[assignment]

        await adapter._poll_session_once(cursor)

        assert _archive_call(cursor) == []

    async def test_poison_message_archived_after_max_attempts(
        self, adapter: PubsubEventAdapter
    ) -> None:
        adapter._session_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        cursor = _FakeCursor(fetch_results=[[_envelope(303, read_ct=3, event_id=303)]])
        adapter._dispatch = AsyncMock(side_effect=RuntimeError("always raises"))  # type: ignore[assignment]

        await adapter._poll_session_once(cursor)

        assert _archive_call(cursor) == [303]

    async def test_malformed_message_archived_immediately(
        self, adapter: PubsubEventAdapter
    ) -> None:
        adapter._session_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        cursor = _FakeCursor(fetch_results=[[(404, 1, "not-a-dict")]])
        adapter._dispatch = AsyncMock()  # type: ignore[assignment]

        await adapter._poll_session_once(cursor)

        assert _archive_call(cursor) == [404]


@pytest.mark.asyncio
async def test_complete_bootstrap_discards_echoes_and_buffers_unrelated(
    adapter: PubsubEventAdapter,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PGMQ_URL", "postgresql://fake")
    adapter._session_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    cursor = _FakeCursor(
        fetch_results=[
            [
                _envelope(10, read_ct=1, event_id=10, request_id="bootstrap-req"),
                _envelope(20, read_ct=1, event_id=20, request_id="combat-req"),
            ],
            [],
        ]
    )
    _install_fake_psycopg(monkeypatch, cursor)

    await adapter.complete_bootstrap({"bootstrap-req"})

    assert _archive_call(cursor) == [10, 20]
    assert [msg["request_id"] for msg in adapter._catchup_buffer] == ["combat-req"]


@pytest.mark.asyncio
async def test_replay_catchup_dispatches_buffered_events_after_activation(
    adapter: PubsubEventAdapter,
) -> None:
    adapter._catchup_buffer = [
        _envelope(2, read_ct=1, event_id=2)[2],
        _envelope(1, read_ct=1, event_id=1)[2],
    ]
    dispatched: list[int] = []

    async def capture(message):
        dispatched.append(message["payload"]["step"])

    adapter._dispatch = capture  # type: ignore[assignment]

    await adapter.replay_catchup()

    assert dispatched == [1, 2]
    assert adapter._catchup_buffer == []


@pytest.mark.asyncio
async def test_stop_unregisters_session_best_effort(
    adapter: PubsubEventAdapter,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PGMQ_URL", "postgresql://fake")
    adapter._session_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    cursor = _FakeCursor()
    _install_fake_psycopg(monkeypatch, cursor)

    await adapter.stop()

    unregister_calls = [
        params for sql, params in cursor.executions if "event_session_unregister" in sql
    ]
    assert unregister_calls == [
        ("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "test-token")
    ]
    assert adapter._session_id is None
