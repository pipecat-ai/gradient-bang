"""Ownership-filter regression tests for AsyncGameClient.

The voice agent's AsyncGameClient is shared with the player-ship TaskAgent
and is the sole poller for the entire session (including corp-ship events
fanned out via the bus). Per-instance scalar caches (_current_sector,
_corporation_id) must only be updated from events about the bound character.

See planning-docs/shared-client-sector-pollution-2026-04-18.md.
"""

from __future__ import annotations

from typing import Any, Dict

import pytest

from gradientbang.utils.supabase_client import AsyncGameClient


PLAYER_ID = "11111111-1111-1111-1111-111111111111"
CORP_SHIP_ID = "22222222-2222-2222-2222-222222222222"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> AsyncGameClient:
    """Construct a real AsyncGameClient without starting the poller.

    enable_event_polling=False keeps the polling task dormant; polling would
    otherwise kick in on _request / _ensure_event_delivery. Test drives
    _deliver_polled_event directly with crafted rows.
    """
    monkeypatch.setenv("SUPABASE_URL", "http://test-supabase.local")
    monkeypatch.setenv("EDGE_API_TOKEN", "test-token")
    return AsyncGameClient(character_id=PLAYER_ID, enable_event_polling=False)


def _row(event_type: str, payload: Dict[str, Any], *, event_id: int = 1) -> Dict[str, Any]:
    """Shape matches the rows produced by events_since/index.ts:317-345."""
    return {
        "id": event_id,
        "event_type": event_type,
        "timestamp": "2026-04-18T21:00:00Z",
        "payload": payload,
        "scope": "direct",
        "meta": None,
        "request_id": f"req-{event_id}",
        "event_context": {
            "event_id": event_id,
            "character_id": payload.get("player", {}).get("id"),
            "reason": "direct",
            "scope": "direct",
        },
    }


@pytest.mark.asyncio
class TestOwnershipFilterSector:
    """_current_sector must only update from player-own events."""

    async def test_corp_ship_movement_does_not_pollute(self, client: AsyncGameClient) -> None:
        assert client._current_sector is None
        row = _row(
            "movement.complete",
            {"player": {"id": CORP_SHIP_ID}, "sector": {"id": 4894}},
        )
        await client._deliver_polled_event(row)
        assert client._current_sector is None, (
            "Corp-ship movement.complete must not update the bound player's sector cache"
        )

    async def test_player_movement_updates(self, client: AsyncGameClient) -> None:
        row = _row(
            "movement.complete",
            {"player": {"id": PLAYER_ID}, "sector": {"id": 3194}},
        )
        await client._deliver_polled_event(row)
        assert client._current_sector == 3194

    async def test_corp_ship_map_local_does_not_pollute(self, client: AsyncGameClient) -> None:
        """Corp-ship ``map.local`` with a ``center_sector`` payload must not
        leak into the bound player's cache.

        Exercises the base-class ``_maybe_update_current_sector`` center_sector
        branch (api_client.py ``map.local``/``local_map_region`` extraction).
        The Supabase ``_maybe_update_sector_from_event`` reads
        ``payload.sector``, not ``center_sector``; that path is covered by the
        ``movement.complete`` test above (which has the same ``payload.sector``
        shape for ``map.local``) and by the ownership guard at the top of the
        Supabase function.
        """
        assert client._current_sector is None
        row = _row(
            "map.local",
            {"player": {"id": CORP_SHIP_ID}, "center_sector": 4894, "sectors": []},
            event_id=2,
        )
        await client._deliver_polled_event(row)
        assert client._current_sector is None

    async def test_player_map_local_updates(self, client: AsyncGameClient) -> None:
        """Player ``map.local`` with ``center_sector`` updates via the base-class
        extraction path."""
        row = _row(
            "map.local",
            {"player": {"id": PLAYER_ID}, "center_sector": 3194, "sectors": []},
        )
        await client._deliver_polled_event(row)
        assert client._current_sector == 3194

    async def test_corp_ship_map_local_with_sector_payload_does_not_pollute(
        self, client: AsyncGameClient
    ) -> None:
        """Covers the Supabase ``_maybe_update_sector_from_event`` path
        specifically: ``_extract_sector_id_from_event`` reads ``payload.sector``
        for ``map.local`` events. Even if the emitter produces that shape, the
        ownership guard must reject corp-ship events."""
        assert client._current_sector is None
        row = _row(
            "map.local",
            {"player": {"id": CORP_SHIP_ID}, "sector": {"id": 4894}, "sectors": []},
            event_id=3,
        )
        await client._deliver_polled_event(row)
        assert client._current_sector is None

    async def test_status_snapshot_without_player_block_is_skipped(
        self, client: AsyncGameClient
    ) -> None:
        """Defensive: events lacking a player block should not mutate the cache."""
        row = _row("status.snapshot", {"sector": {"id": 9999}})
        await client._deliver_polled_event(row)
        assert client._current_sector is None

    async def test_non_self_state_event_does_not_update(self, client: AsyncGameClient) -> None:
        """Events outside the self-state whitelist (movement.complete,
        status.snapshot, status.update, map.local) must not update the sector
        cache, even when the event is owned by the player and contains
        sector-shaped fields. This guards against the previously-dead
        top-level ``payload["current_sector"]`` branch that was removed from
        ``_maybe_update_current_sector``.
        """
        row = _row(
            "trade.executed",
            {"player": {"id": PLAYER_ID}, "current_sector": 9999, "sector": {"id": 9999}},
            event_id=4,
        )
        await client._deliver_polled_event(row)
        assert client._current_sector is None

    async def test_map_region_does_not_update_sector(self, client: AsyncGameClient) -> None:
        """``map.region`` is a query response about arbitrary sectors, not a
        statement about the player's current position. It must not mutate the
        cache — that's why only ``map.local`` is in the whitelist."""
        row = _row(
            "map.region",
            {"player": {"id": PLAYER_ID}, "center_sector": 9999, "sectors": []},
            event_id=5,
        )
        await client._deliver_polled_event(row)
        assert client._current_sector is None

    async def test_corp_ship_my_status_does_not_pollute(self, client: AsyncGameClient) -> None:
        """Specific case: corp-ship my_status emits status.snapshot addressed
        to the actor (player) but the payload's player.id is the corp ship
        (see deployment/supabase/functions/my_status/index.ts and
        deployment/supabase/functions/_shared/pg_queries.ts buildPlayerSnapshot).
        The recipient-based event_context would name the player; only
        payload.player.id correctly identifies the subject.
        """
        row = _row(
            "status.snapshot",
            {
                "player": {"id": CORP_SHIP_ID},
                "sector": {"id": 4894},
                "corporation": {"corp_id": "corp_X"},
            },
        )
        # Override context.character_id to simulate the recipient being the
        # player (actor), not the corp ship (subject).
        row["event_context"]["character_id"] = PLAYER_ID
        await client._deliver_polled_event(row)
        assert client._current_sector is None


@pytest.mark.asyncio
class TestOwnershipFilterCorp:
    """_corporation_id must only update from player-own events."""

    async def test_corp_ship_my_status_does_not_set_corp_id(
        self, client: AsyncGameClient
    ) -> None:
        assert client._corporation_id is None
        row = _row(
            "status.snapshot",
            {
                "player": {"id": CORP_SHIP_ID},
                "corporation": {"corp_id": "corp_X"},
            },
        )
        row["event_context"]["character_id"] = PLAYER_ID
        await client._deliver_polled_event(row)
        assert client._corporation_id is None

    async def test_player_status_sets_corp_id(self, client: AsyncGameClient) -> None:
        row = _row(
            "status.snapshot",
            {
                "player": {"id": PLAYER_ID},
                "corporation": {"corp_id": "corp_X"},
            },
        )
        await client._deliver_polled_event(row)
        assert client._corporation_id == "corp_X"

    async def test_player_leave_clears_corp_id(self, client: AsyncGameClient) -> None:
        # First, join corp
        row_join = _row(
            "status.snapshot",
            {
                "player": {"id": PLAYER_ID},
                "corporation": {"corp_id": "corp_X"},
            },
        )
        await client._deliver_polled_event(row_join)
        assert client._corporation_id == "corp_X"

        # Then, a subsequent status with corp_id=None clears the cache
        row_leave = _row(
            "status.update",
            {
                "player": {"id": PLAYER_ID},
                "corporation": {"corp_id": None},
            },
            event_id=2,
        )
        await client._deliver_polled_event(row_leave)
        assert client._corporation_id is None


@pytest.mark.asyncio
class TestDeadFieldRemoval:
    """_current_sector_id used to be a shadow field on the Supabase subclass.

    It has been removed; ensure nothing depends on it.
    """

    async def test_no_current_sector_id_attribute(self, client: AsyncGameClient) -> None:
        assert not hasattr(client, "_current_sector_id"), (
            "_current_sector_id was removed; any reintroduction would resurrect "
            "the dead-duplicate cache documented in the pollution fix plan."
        )
