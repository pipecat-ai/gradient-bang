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
