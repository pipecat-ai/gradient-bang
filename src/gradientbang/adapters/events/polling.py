"""HTTP-polling implementation of :class:`EventAdapter`.

Extracted from ``gradientbang.utils.supabase_client.AsyncGameClient``. Behavior
is intentionally byte-identical to the pre-refactor inline implementation —
this module exists so a future pubsub adapter can plug in via the same
Protocol without altering the polling code path.

Tuning env vars:
- ``SUPABASE_POLL_INTERVAL_SECONDS`` — sleep between poll batches (default 1.0).
- ``SUPABASE_POLL_LIMIT`` — page size (default 100 local, 50 cloud).
- ``SUPABASE_POLL_BACKOFF_MAX`` — max backoff after errors (default 5.0).
"""

from __future__ import annotations

import asyncio
import os
from collections import deque
from contextlib import suppress
from typing import TYPE_CHECKING, Any, Deque, Dict, Mapping, Optional

from loguru import logger

from gradientbang.utils.api_client import RPCError
from gradientbang.utils.legacy_ids import canonicalize_character_id

if TYPE_CHECKING:
    from gradientbang.utils.supabase_client import AsyncGameClient


POLL_INTERVAL_SECONDS = max(0.25, float(os.getenv("SUPABASE_POLL_INTERVAL_SECONDS", "1.0")))
_POLL_LIMIT_ENV = os.getenv("SUPABASE_POLL_LIMIT")
if _POLL_LIMIT_ENV is not None:
    try:
        POLL_LIMIT_DEFAULT = max(1, min(250, int(_POLL_LIMIT_ENV)))
    except ValueError:
        POLL_LIMIT_DEFAULT = 100
else:
    # Cloud: lower default to reduce payload size; local stays at 100
    POLL_LIMIT_DEFAULT = 50 if "supabase.co" in (os.getenv("SUPABASE_URL") or "") else 100
POLL_BACKOFF_MAX = max(1.0, float(os.getenv("SUPABASE_POLL_BACKOFF_MAX", "5.0")))


class PollingEventAdapter:
    """Polls the ``events_since`` edge function and dispatches into the client.

    The adapter owns its own scope / cursor / dedup state. It calls back into
    the client only via the documented surface area in
    :mod:`gradientbang.adapters.events.base`.
    """

    def __init__(self, client: "AsyncGameClient") -> None:
        self._client = client

        # Subscription scope — initialized to the bound character; mutated via
        # set_scope() (typically by the voice agent when corp ships join).
        self._poll_character_ids: list[str] = [client._canonical_character_id]
        self._poll_corp_id: Optional[str] = None
        self._poll_ship_ids: list[str] = []

        # Tuning
        self._poll_interval = POLL_INTERVAL_SECONDS
        self._poll_limit = POLL_LIMIT_DEFAULT

        # Lifecycle
        self._polling_task: Optional[asyncio.Task] = None
        self._polling_stop_event = asyncio.Event()
        self._polling_last_event_id: Optional[int] = None
        self._polling_lock = asyncio.Lock()
        self._polling_backoff = 0.0

        # Per-adapter dedup ring — same ring size as the pre-refactor inline impl.
        self._recent_event_ids: Deque[int] = deque()
        self._recent_event_ids_max = 512

    # ------------------------------------------------------------------
    # EventAdapter Protocol
    # ------------------------------------------------------------------

    async def start(self) -> None:
        async with self._polling_lock:
            if self._polling_task and not self._polling_task.done():
                return
            if self._polling_task and self._polling_task.done():
                with suppress(Exception):
                    await self._polling_task
                self._polling_task = None
            if self._polling_stop_event.is_set():
                self._polling_stop_event = asyncio.Event()
            if self._polling_last_event_id is None:
                await self._initialize_polling_cursor()
            self._polling_task = asyncio.create_task(self._poll_events_loop())

    async def stop(self) -> None:
        # Do one final poll to capture any pending events before stopping
        # This ensures events from the last RPC are delivered before client closes
        try:
            await self._poll_events_once()
        except Exception:
            pass  # Ignore errors during final poll

        self._polling_stop_event.set()
        if self._polling_task is not None:
            self._polling_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._polling_task
            self._polling_task = None

    def set_scope(
        self,
        *,
        character_ids: Optional[list[str]] = None,
        corp_id: Optional[str] = None,
        ship_ids: Optional[list[str]] = None,
    ) -> None:
        if character_ids is not None:
            normalized: list[str] = []
            for cid in character_ids:
                if not isinstance(cid, str):
                    continue
                cleaned = cid.strip()
                if cleaned:
                    normalized.append(canonicalize_character_id(cleaned))
            if normalized:
                self._poll_character_ids = sorted(set(normalized))
        if ship_ids is not None:
            normalized_ship_ids: list[str] = []
            for sid in ship_ids:
                if not isinstance(sid, str):
                    continue
                cleaned = sid.strip()
                if cleaned:
                    normalized_ship_ids.append(cleaned)
            self._poll_ship_ids = sorted(set(normalized_ship_ids))
        if corp_id is None:
            self._poll_corp_id = None
        else:
            cleaned = corp_id.strip() if isinstance(corp_id, str) else ""
            self._poll_corp_id = cleaned or None

    # ------------------------------------------------------------------
    # Polling internals
    # ------------------------------------------------------------------

    def _build_events_since_payload(
        self,
        *,
        since_event_id: Optional[int] = None,
        initial_only: bool = False,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "character_ids": self._poll_character_ids,
        }
        # `ship_ids` holds corp-ship pseudo-character ids (corp ships are
        # registered in `characters` with character_id == ship_id). They live
        # in the same namespace as `character_ids` and the events_since edge
        # function unions them into the recipient_character_id filter.
        if self._poll_ship_ids:
            payload["ship_ids"] = self._poll_ship_ids
        if self._poll_corp_id:
            payload["corp_id"] = self._poll_corp_id
        if initial_only:
            payload["initial_only"] = True
            return payload
        if since_event_id is not None:
            payload["since_event_id"] = since_event_id
        payload["limit"] = self._poll_limit
        return payload

    async def _initialize_polling_cursor(self) -> None:
        payload = self._build_events_since_payload(initial_only=True)
        response = await self._client._request("events_since", payload, skip_event_delivery=True)
        last_id = response.get("last_event_id")
        if isinstance(last_id, int):
            self._polling_last_event_id = last_id
        else:
            self._polling_last_event_id = 0

    async def _poll_events_loop(self) -> None:
        while not self._polling_stop_event.is_set():
            try:
                has_more = await self._poll_events_once()
                self._polling_backoff = 0.0

                # If there are more events available, poll immediately without delay
                if has_more:
                    continue
            except asyncio.CancelledError:
                break
            except Exception:  # noqa: BLE001
                logger.warning("supabase.poller.error", exc_info=True)
                backoff = self._polling_backoff or self._poll_interval
                backoff = min(backoff * 2 if self._polling_backoff else backoff, POLL_BACKOFF_MAX)
                self._polling_backoff = backoff
                try:
                    await asyncio.wait_for(self._polling_stop_event.wait(), timeout=backoff)
                    break
                except asyncio.TimeoutError:
                    continue
            try:
                await asyncio.wait_for(self._polling_stop_event.wait(), timeout=self._poll_interval)
                break
            except asyncio.TimeoutError:
                continue

    async def _poll_events_once(self) -> bool:
        """Poll for events once. Returns True if more events are available."""
        if self._polling_last_event_id is None:
            await self._initialize_polling_cursor()
            return False

        payload = self._build_events_since_payload(
            since_event_id=self._polling_last_event_id,
            initial_only=False,
        )
        # Basic retry on transient 5xx to avoid stalling long-running tests
        attempts = 3
        backoff = 0.5
        for attempt in range(1, attempts + 1):
            try:
                response = await self._client._request(
                    "events_since", payload, skip_event_delivery=True
                )
                break
            except RPCError as exc:  # type: ignore
                if exc.status >= 500 and attempt < attempts:
                    await asyncio.sleep(backoff)
                    backoff *= 2
                    continue
                raise
        events = response.get("events")
        if not isinstance(events, list):
            events = []
        for row in events:
            await self._deliver_polled_event(row)
        last_id = response.get("last_event_id")
        if isinstance(last_id, int):
            self._polling_last_event_id = last_id
        elif events:
            maybe = events[-1]
            if isinstance(maybe, Mapping):
                candidate = maybe.get("id")
                if isinstance(candidate, int):
                    self._polling_last_event_id = candidate

        # Return True if there are more events waiting (hit the limit)
        has_more = response.get("has_more")
        return bool(has_more)

    async def _deliver_polled_event(self, row: Mapping[str, Any]) -> None:
        if not isinstance(row, Mapping):
            return
        event_name = row.get("event_type")
        if not isinstance(event_name, str) or not event_name:
            return
        payload = self._build_polled_event_payload(row)

        # Deduplicate events (same as realtime path)
        if not self._record_event_id(payload):
            return

        # Extract request_id from row for event correlation
        request_id = row.get("request_id")

        await self._client._maybe_update_sector_from_event(event_name, payload)
        await self._client._process_event(event_name, payload, request_id=request_id)

        # Log events to JSONL audit log (same as realtime path)
        self._client._append_event_log(event_name, payload)

    def _build_polled_event_payload(self, row: Mapping[str, Any]) -> Dict[str, Any]:
        raw_payload = row.get("payload")
        if isinstance(raw_payload, Mapping):
            payload = dict(raw_payload)
        else:
            payload = {"value": raw_payload}

        meta = row.get("meta")
        if isinstance(meta, Mapping) and "meta" not in payload:
            payload["meta"] = dict(meta)

        event_context = row.get("event_context")
        if isinstance(event_context, Mapping) and "__event_context" not in payload:
            payload["__event_context"] = dict(event_context)

        # Note: request_id and __event_context are internal metadata fields.
        # They should not be surfaced directly to end-user clients.
        return payload

    def _record_event_id(self, payload: Mapping[str, Any]) -> bool:
        ctx = payload.get("__event_context") if isinstance(payload, Mapping) else None
        if not isinstance(ctx, Mapping):
            return True
        event_id = ctx.get("event_id")
        if not isinstance(event_id, int):
            return True
        if event_id in self._recent_event_ids:
            return False
        self._recent_event_ids.append(event_id)
        if len(self._recent_event_ids) > self._recent_event_ids_max:
            self._recent_event_ids.popleft()
        return True


__all__ = [
    "POLL_BACKOFF_MAX",
    "POLL_INTERVAL_SECONDS",
    "POLL_LIMIT_DEFAULT",
    "PollingEventAdapter",
]
