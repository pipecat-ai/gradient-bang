"""Focused tests for ``PubsubEventAdapter``."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from gradientbang.adapters.events import pubsub as pubsub_module
from gradientbang.adapters.events.pubsub import DEFAULT_QTY, PubsubEventAdapter
from gradientbang.utils.supabase_client import AsyncGameClient


PLAYER_ID = "11111111-1111-1111-1111-111111111111"
CORP_SHIP_ID = "22222222-2222-2222-2222-222222222222"
OTHER_SHIP_ID = "33333333-3333-3333-3333-333333333333"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> AsyncGameClient:
    monkeypatch.setenv("EDGE_API_TOKEN", "test-token")
    monkeypatch.setenv("SUPABASE_URL", "http://localhost:54321")
    return AsyncGameClient(
        character_id=PLAYER_ID,
        enable_event_polling=False,
    )


@pytest.fixture
def adapter(client: AsyncGameClient) -> PubsubEventAdapter:
    return PubsubEventAdapter(client)


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


class _FakeCursor:
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
    async def fake_connect(*_args, **_kwargs):
        return _FakeConnection(cursor)

    monkeypatch.setattr(
        pubsub_module.psycopg.AsyncConnection,
        "connect",
        staticmethod(fake_connect),
    )


def _envelope(
    queue_character_id: str,
    msg_id: int,
    read_ct: int,
    *,
    event_id: int | None = None,
    event_type: str = "task.progress",
) -> tuple:
    return (
        queue_character_id,
        msg_id,
        read_ct,
        {
            "event_type": event_type,
            "payload": {"step": msg_id},
            "event_context": {
                "event_id": event_id,
                "character_id": queue_character_id,
                "reason": "direct",
                "scope": "direct",
                "recipient_ids": [queue_character_id],
                "recipient_reasons": ["direct"],
            },
        },
    )


def _archive_call(cursor: _FakeCursor) -> tuple[list[str], list[int]]:
    archive_calls = [
        params for sql, params in cursor.executions if "archive_my_events_scope" in sql
    ]
    if not archive_calls:
        return [], []
    params = archive_calls[-1]
    return list(params[-2]), list(params[-1])


def _subscribe_calls(cursor: _FakeCursor) -> list[tuple]:
    return [
        params for sql, params in cursor.executions if "subscribe_my_events_scope" in sql
    ]


@pytest.mark.asyncio
class TestScopedPolling:
    async def test_set_scope_actor_first_sorted_and_wakes_loop(
        self, adapter: PubsubEventAdapter
    ) -> None:
        adapter._started = True
        adapter._scope_changed_event.clear()

        adapter.set_scope(
            character_ids=[PLAYER_ID],
            ship_ids=[OTHER_SHIP_ID, CORP_SHIP_ID],
        )

        assert adapter._character_ids == [PLAYER_ID, CORP_SHIP_ID, OTHER_SHIP_ID]
        assert adapter._scope_changed_event.is_set()
        assert not hasattr(adapter, "_char_tasks")

    async def test_empty_read_returns_false_without_archive(
        self, adapter: PubsubEventAdapter
    ) -> None:
        cursor = _FakeCursor(fetch_results=[[]])
        adapter._dispatch = AsyncMock()  # type: ignore[assignment]

        had_rows = await adapter._poll_scope_once(cursor)

        assert had_rows is False
        assert _archive_call(cursor) == ([], [])
        adapter._dispatch.assert_not_called()

    async def test_scoped_poll_uses_one_read_for_player_and_ships(
        self, adapter: PubsubEventAdapter
    ) -> None:
        adapter.set_scope(character_ids=[PLAYER_ID], ship_ids=[CORP_SHIP_ID])
        cursor = _FakeCursor(fetch_results=[[]])

        await adapter._poll_scope_once(cursor)

        assert _subscribe_calls(cursor) == [
            (PLAYER_ID, "test-token", [PLAYER_ID, CORP_SHIP_ID], DEFAULT_QTY)
        ]

    async def test_successful_dispatch_archives_queue_message_pairs(
        self, adapter: PubsubEventAdapter
    ) -> None:
        adapter.set_scope(character_ids=[PLAYER_ID], ship_ids=[CORP_SHIP_ID])
        cursor = _FakeCursor(
            fetch_results=[
                [
                    _envelope(CORP_SHIP_ID, 201, read_ct=1, event_id=20),
                    _envelope(PLAYER_ID, 101, read_ct=1, event_id=10),
                ]
            ]
        )
        dispatched: list[int] = []

        async def capture(message):
            dispatched.append(message["payload"]["step"])

        adapter._dispatch = capture  # type: ignore[assignment]

        had_rows = await adapter._poll_scope_once(cursor)

        assert had_rows is True
        assert dispatched == [101, 201]
        assert _archive_call(cursor) == (
            [PLAYER_ID, CORP_SHIP_ID],
            [101, 201],
        )

    async def test_rows_without_event_id_dispatch_after_global_event_ids(
        self, adapter: PubsubEventAdapter
    ) -> None:
        cursor = _FakeCursor(
            fetch_results=[
                [
                    _envelope(PLAYER_ID, 3, read_ct=1, event_id=3),
                    _envelope(PLAYER_ID, 99, read_ct=1, event_id=None),
                    _envelope(PLAYER_ID, 2, read_ct=1, event_id=2),
                ]
            ]
        )
        dispatched: list[int] = []

        async def capture(message):
            dispatched.append(message["payload"]["step"])

        adapter._dispatch = capture  # type: ignore[assignment]

        await adapter._poll_scope_once(cursor)

        assert dispatched == [2, 3, 99]

    async def test_dispatch_failure_below_max_defers_archive(
        self, adapter: PubsubEventAdapter
    ) -> None:
        cursor = _FakeCursor(
            fetch_results=[[_envelope(PLAYER_ID, 202, read_ct=1, event_id=202)]]
        )
        adapter._dispatch = AsyncMock(side_effect=RuntimeError("bus hiccup"))  # type: ignore[assignment]

        await adapter._poll_scope_once(cursor)

        assert _archive_call(cursor) == ([], [])
        assert all("archive_my_events_scope" not in sql for sql, _ in cursor.executions)

    async def test_poison_message_archived_after_max_attempts(
        self, adapter: PubsubEventAdapter
    ) -> None:
        cursor = _FakeCursor(
            fetch_results=[[_envelope(PLAYER_ID, 303, read_ct=3, event_id=303)]]
        )
        adapter._dispatch = AsyncMock(side_effect=RuntimeError("always raises"))  # type: ignore[assignment]

        await adapter._poll_scope_once(cursor)

        assert _archive_call(cursor) == ([PLAYER_ID], [303])

    async def test_malformed_message_archived_immediately(
        self, adapter: PubsubEventAdapter
    ) -> None:
        cursor = _FakeCursor(fetch_results=[[(PLAYER_ID, 404, 1, "not-a-dict")]])
        adapter._dispatch = AsyncMock()  # type: ignore[assignment]

        await adapter._poll_scope_once(cursor)

        assert _archive_call(cursor) == ([PLAYER_ID], [404])


@pytest.mark.asyncio
class TestPurgeBacklog:
    async def test_purge_ensures_and_clears_each_character_queue(
        self,
        adapter: PubsubEventAdapter,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("PGMQ_URL", "postgresql://fake")
        adapter.set_scope(character_ids=[PLAYER_ID], ship_ids=[CORP_SHIP_ID])
        cursor = _FakeCursor(fetch_results=[])
        _install_fake_psycopg(monkeypatch, cursor)

        await adapter.purge_backlog()

        ensure_calls = [
            params for sql, params in cursor.executions if "ensure_character_queue" in sql
        ]
        purge_calls = [
            params for sql, params in cursor.executions if "purge_queue" in sql
        ]
        assert ensure_calls == [(PLAYER_ID,), (CORP_SHIP_ID,)]
        assert purge_calls == [(f"chr_{PLAYER_ID}",), (f"chr_{CORP_SHIP_ID}",)]

    async def test_purge_errors_are_fatal(
        self,
        adapter: PubsubEventAdapter,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("PGMQ_URL", "postgresql://fake")
        cursor = _FakeCursor(
            fetch_results=[], raise_on_execute=RuntimeError("queue not found")
        )
        _install_fake_psycopg(monkeypatch, cursor)

        with pytest.raises(RuntimeError, match="queue not found"):
            await adapter.purge_backlog()
