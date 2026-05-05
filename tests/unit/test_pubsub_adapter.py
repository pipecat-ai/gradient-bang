"""Focused tests for ``PubsubEventAdapter`` dispatch parity with polling.

Connection/loop lifecycle is out of scope here — those rely on a live
postgres + populated pgmq queues and are exercised by the integration
suite. These tests verify the in-process bit that is most likely to
diverge from the polling adapter: how a single pgmq message gets
dispatched into the client's event sinks.
"""

from __future__ import annotations

import pytest

from gradientbang.adapters.events.pubsub import PubsubEventAdapter
from gradientbang.utils.supabase_client import AsyncGameClient


PLAYER_ID = "11111111-1111-1111-1111-111111111111"
CORP_SHIP_ID = "22222222-2222-2222-2222-222222222222"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> AsyncGameClient:
    """A real AsyncGameClient with polling disabled; we drive the pubsub
    adapter directly.
    """
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
class TestDispatchParity:
    """Pubsub `_dispatch` should drive the same client sinks as polling."""

    async def test_player_movement_updates_sector_cache(
        self, client: AsyncGameClient, adapter: PubsubEventAdapter
    ) -> None:
        """Parity with polling: a player-owned event updates _current_sector."""
        assert client._current_sector is None
        await adapter._dispatch(
            {
                "event_type": "movement.complete",
                "payload": {"player": {"id": PLAYER_ID}, "sector": {"id": 4242}},
            }
        )
        assert client._current_sector == 4242

    async def test_corp_ship_event_does_not_pollute_sector_cache(
        self, client: AsyncGameClient, adapter: PubsubEventAdapter
    ) -> None:
        """Ownership guard: corp-ship events must not clobber the bound
        character's sector. Same invariant as ``test_supabase_client``.
        """
        await adapter._dispatch(
            {
                "event_type": "movement.complete",
                "payload": {"player": {"id": CORP_SHIP_ID}, "sector": {"id": 9999}},
            }
        )
        assert client._current_sector is None

    async def test_skips_messages_without_event_type(
        self, adapter: PubsubEventAdapter
    ) -> None:
        """Defensive: malformed messages should no-op rather than raise."""
        await adapter._dispatch({"payload": {"foo": "bar"}})  # missing event_type
        await adapter._dispatch({"event_type": "", "payload": {}})  # empty event_type
        # No assertion needed — we just want no exception.

    async def test_dispatch_rehydrates_event_context_and_task_id(
        self, client: AsyncGameClient, adapter: PubsubEventAdapter
    ) -> None:
        """Pubsub consumer must mirror polling's __event_context / __task_id
        rehydration. EventRelay drops non-combat events when __event_context
        is missing (event_relay.py:1784) and routes tasks via
        payload['__task_id'] (event_relay.py:1953)."""
        seen: list[tuple[str, dict]] = []

        async def capture(name, payload, **_):
            seen.append((name, dict(payload)))

        client._process_event = capture  # type: ignore[assignment]

        msg = {
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
        await adapter._dispatch(msg)

        assert len(seen) == 1
        _, payload = seen[0]
        assert payload["__event_context"]["character_id"] == PLAYER_ID
        assert payload["__event_context"]["reason"] == "direct"
        assert payload["__task_id"] == "task-abc"

    async def test_dispatch_preserves_payload_injected_task_id(
        self, client: AsyncGameClient, adapter: PubsubEventAdapter
    ) -> None:
        """When the producer already injected __task_id into the payload
        (the default path now), the consumer must not overwrite it."""
        seen: list[tuple[str, dict]] = []

        async def capture(name, payload, **_):
            seen.append((name, dict(payload)))

        client._process_event = capture  # type: ignore[assignment]

        msg = {
            "event_type": "task.progress",
            "payload": {"__task_id": "from-payload"},
            "task_id": "from-toplevel",
        }
        await adapter._dispatch(msg)
        assert seen[0][1]["__task_id"] == "from-payload"


class TestSetScope:
    """``set_scope`` mirrors the public API of the polling adapter."""

    def test_initial_scope_is_bound_character(
        self, client: AsyncGameClient, adapter: PubsubEventAdapter
    ) -> None:
        assert adapter._character_ids == [client._canonical_character_id]

    def test_ship_ids_join_character_scope(
        self, adapter: PubsubEventAdapter
    ) -> None:
        """Corp-ship pseudo-character ids merge into the per-character list —
        unlike polling (which keeps them separate to drive a different filter
        in `events_since`), pubsub treats every queue identically.
        """
        adapter.set_scope(ship_ids=[CORP_SHIP_ID])
        assert CORP_SHIP_ID in adapter._character_ids

    def test_corp_id_stored_for_parity(
        self, adapter: PubsubEventAdapter
    ) -> None:
        adapter.set_scope(corp_id="33333333-3333-3333-3333-333333333333")
        assert adapter._corp_id == "33333333-3333-3333-3333-333333333333"
        adapter.set_scope(corp_id=None)
        assert adapter._corp_id is None

    def test_set_scope_before_start_does_not_spawn_tasks(
        self, adapter: PubsubEventAdapter
    ) -> None:
        """A pre-start scope update must absorb into self._character_ids only.

        The previous gate fired before start() validated PGMQ_URL/access_token,
        relying on the missing event loop to no-op. The explicit _started
        flag makes that contract precise.
        """
        assert adapter._started is False
        adapter.set_scope(ship_ids=[CORP_SHIP_ID])
        assert CORP_SHIP_ID in adapter._character_ids
        assert adapter._char_tasks == {}
        assert adapter._started is False
