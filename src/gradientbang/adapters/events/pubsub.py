"""pgmq-backed pubsub implementation of :class:`EventAdapter`.

Connects directly to Postgres as ``pubsub_client`` and long-polls per-character
queues via the auth-gated SECURITY DEFINER functions:

- ``public.subscribe_my_events(character_id, access_token, max_seconds, qty)``
- ``public.archive_my_events(character_id, access_token, msg_ids[])``

Per-character authorization (direct ownership or corp membership) is enforced
inside those functions; this adapter trusts what they return. The adapter
runs one long-poll task per character in the active scope; ``set_scope`` adds
and removes tasks as the bound voice agent expands subscription (e.g. when a
corp ship joins the session).

Required env: ``PGMQ_URL`` — direct (NOT pooled) postgres URL with the
``pubsub_client`` role's credentials. Required client state: ``access_token``
on the ``AsyncGameClient`` (set at construction time by the bot, originating
from the proxy ``start`` edge function or the BOT_TEST_ACCESS_TOKEN dev env).

Failure modes:
- Missing ``PGMQ_URL`` or ``access_token`` → raise at ``start()``.
- Auth raises (``forbidden`` / ``token_expired`` / ``invalid_token``) inside
  ``subscribe_my_events`` → adapter re-raises so the bot can disconnect (per
  the auth design: no token-refresh path; expired sessions terminate).

No client-side dedup ring: per the design, a fresh pubsub session does not
replay history. Messages already in queues at connect time are still consumed
(at-least-once via pgmq vt+archive); duplicates within a session would only
arise from a crash between dispatch and archive, which is acceptable.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import suppress
from typing import TYPE_CHECKING, Any, Mapping, Optional

import psycopg
from psycopg.errors import RaiseException
from psycopg.rows import tuple_row

from gradientbang.utils.legacy_ids import canonicalize_character_id

if TYPE_CHECKING:
    from gradientbang.utils.supabase_client import AsyncGameClient


logger = logging.getLogger(__name__)
logger.addHandler(logging.NullHandler())


# Long-poll window per subscribe_my_events call. Connection stays in
# `read_with_poll` server-side until either a message arrives or this elapses.
DEFAULT_MAX_POLL_SECONDS = int(os.getenv("PGMQ_MAX_POLL_SECONDS", "30"))
# Max messages drained per call. Above this, the next iteration picks them up.
DEFAULT_QTY = int(os.getenv("PGMQ_BATCH_QTY", "100"))
# Backoff cap on transient connection errors.
RECONNECT_BACKOFF_MAX = float(os.getenv("PGMQ_RECONNECT_BACKOFF_MAX", "10.0"))


class PubsubEventAdapter:
    """Long-polls pgmq queues via SECURITY DEFINER functions and dispatches.

    One asyncio task per character in scope, each with its own connection to
    the database. Coordinated through ``set_scope`` (typically from the voice
    agent updating subscriptions for corp ships).
    """

    def __init__(self, client: "AsyncGameClient") -> None:
        self._client = client

        # Initial scope mirrors the polling adapter: just the bound character.
        # Voice agent expands this via set_scope when corp ships join.
        self._character_ids: list[str] = [client._canonical_character_id]
        # corp_id and ship_ids are accepted by set_scope for API parity with
        # the polling adapter, but pubsub mode treats every subscription as
        # per-character (corp ships are characters with their own queues).
        self._corp_id: Optional[str] = None

        self._char_tasks: dict[str, asyncio.Task] = {}
        self._stop_event = asyncio.Event()
        self._scope_lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # EventAdapter Protocol
    # ------------------------------------------------------------------

    async def start(self) -> None:
        if self._char_tasks:
            return  # Already running.

        if not os.getenv("PGMQ_URL"):
            raise RuntimeError(
                "PGMQ_URL is required when EVENT_TRANSPORT=pubsub. "
                "Set it to a direct (NOT pooled) postgres URL with the "
                "pubsub_client role's credentials."
            )
        if not getattr(self._client, "_access_token", None):
            raise RuntimeError(
                "access_token is required on AsyncGameClient when "
                "EVENT_TRANSPORT=pubsub. Production: comes from the proxy "
                "`start` edge function. Dev: pass via /start body or "
                "BOT_TEST_ACCESS_TOKEN."
            )

        if self._stop_event.is_set():
            self._stop_event = asyncio.Event()

        await self._sync_tasks()

    async def stop(self) -> None:
        self._stop_event.set()
        async with self._scope_lock:
            tasks = list(self._char_tasks.values())
            self._char_tasks.clear()
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError, Exception):
                await task

    def set_scope(
        self,
        *,
        character_ids: Optional[list[str]] = None,
        corp_id: Optional[str] = None,
        ship_ids: Optional[list[str]] = None,
    ) -> None:
        # Pubsub treats every subscription as per-character. corp_id is a
        # recipient-fanout concern handled server-side; ship_ids are corp
        # ship pseudo-characters that simply join the per-character list.
        merged: list[str] = []
        if character_ids is not None:
            for cid in character_ids:
                if isinstance(cid, str) and cid.strip():
                    merged.append(canonicalize_character_id(cid.strip()))
        else:
            merged.extend(self._character_ids)
        if ship_ids is not None:
            for sid in ship_ids:
                if isinstance(sid, str) and sid.strip():
                    merged.append(sid.strip())
        self._character_ids = sorted(set(merged))

        if corp_id is None:
            self._corp_id = None
        elif isinstance(corp_id, str):
            cleaned = corp_id.strip()
            self._corp_id = cleaned or None

        # Reconcile tasks if we're already running. Schedule the sync as a
        # background task — set_scope is sync and we shouldn't block the
        # caller waiting for asyncio cleanup.
        if self._char_tasks or not self._stop_event.is_set():
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                # No running loop; sync will happen at next start().
                return
            loop.create_task(self._sync_tasks())

    # ------------------------------------------------------------------
    # Per-character long-poll loop
    # ------------------------------------------------------------------

    async def _sync_tasks(self) -> None:
        """Add tasks for newly-in-scope characters; cancel removed ones."""
        async with self._scope_lock:
            wanted = set(self._character_ids)
            current = set(self._char_tasks.keys())

            to_add = wanted - current
            to_remove = current - wanted

            for cid in to_remove:
                task = self._char_tasks.pop(cid, None)
                if task is not None:
                    task.cancel()

            for cid in to_add:
                if self._stop_event.is_set():
                    break
                self._char_tasks[cid] = asyncio.create_task(
                    self._character_loop(cid),
                    name=f"pubsub-loop-{cid}",
                )

    async def _character_loop(self, character_id: str) -> None:
        """Long-poll one character's queue forever (until stop)."""
        backoff = 1.0
        while not self._stop_event.is_set():
            try:
                await self._poll_once(character_id)
                backoff = 1.0
            except asyncio.CancelledError:
                raise
            except (RaiseException, psycopg.errors.InsufficientPrivilege) as exc:
                # Auth failure — token expired/invalid or character ownership
                # was revoked. Per design: no refresh, surface to disconnect.
                logger.error(
                    "pubsub.auth_failed character=%s error=%s",
                    character_id,
                    exc,
                )
                self._stop_event.set()
                raise
            except Exception:
                logger.warning(
                    "pubsub.poll_error character=%s; reconnecting after %.1fs",
                    character_id,
                    backoff,
                    exc_info=True,
                )
                with suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self._stop_event.wait(), timeout=backoff)
                backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX)

    async def _poll_once(self, character_id: str) -> None:
        """One long-poll + dispatch + archive cycle."""
        pgmq_url = os.environ["PGMQ_URL"]
        access_token = self._client._access_token

        async with await psycopg.AsyncConnection.connect(
            pgmq_url, autocommit=True, row_factory=tuple_row
        ) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT msg_id, message FROM public.subscribe_my_events(%s, %s, %s, %s)",
                    (character_id, access_token, DEFAULT_MAX_POLL_SECONDS, DEFAULT_QTY),
                )
                rows = await cur.fetchall()

                if not rows:
                    return

                delivered_msg_ids: list[int] = []
                for msg_id, message in rows:
                    if not isinstance(message, Mapping):
                        logger.debug(
                            "pubsub.skip_malformed msg_id=%s character=%s",
                            msg_id,
                            character_id,
                        )
                        delivered_msg_ids.append(msg_id)
                        continue
                    try:
                        await self._dispatch(message)
                    except Exception:
                        logger.exception(
                            "pubsub.dispatch_error msg_id=%s character=%s",
                            msg_id,
                            character_id,
                        )
                    delivered_msg_ids.append(msg_id)

                if delivered_msg_ids:
                    await cur.execute(
                        "SELECT public.archive_my_events(%s, %s, %s)",
                        (character_id, access_token, delivered_msg_ids),
                    )

    async def _dispatch(self, message: Mapping[str, Any]) -> None:
        """Dispatch one pgmq message into the client's existing event sinks.

        Mirrors `PollingEventAdapter._deliver_polled_event` so pubsub and
        polling deliver to the same downstream code paths.
        """
        event_name = message.get("event_type")
        if not isinstance(event_name, str) or not event_name:
            return

        raw_payload = message.get("payload")
        payload: dict[str, Any]
        if isinstance(raw_payload, Mapping):
            payload = dict(raw_payload)
        else:
            payload = {"value": raw_payload}

        meta = message.get("meta")
        if isinstance(meta, Mapping) and "meta" not in payload:
            payload["meta"] = dict(meta)

        request_id = message.get("request_id")
        request_id_str = (
            request_id if isinstance(request_id, str) else None
        )

        await self._client._maybe_update_sector_from_event(event_name, payload)
        await self._client._process_event(
            event_name, payload, request_id=request_id_str
        )
        self._client._append_event_log(event_name, payload)


__all__ = [
    "DEFAULT_MAX_POLL_SECONDS",
    "DEFAULT_QTY",
    "PubsubEventAdapter",
    "RECONNECT_BACKOFF_MAX",
]
