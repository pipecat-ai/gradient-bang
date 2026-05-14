"""pgmq-backed pubsub implementation of :class:`EventAdapter`.

One bot session owns one scoped PGMQ reader connection and, when enabled, one
``LISTEN gb_broadcasts`` connection. SQL verifies ``EDGE_API_TOKEN`` and actor
scope before reading any queue.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import suppress
from typing import TYPE_CHECKING, Any, Mapping, Optional

import psycopg
from loguru import logger
from psycopg.errors import (
    InsufficientPrivilege,
    InvalidAuthorizationSpecification,
    InvalidCatalogName,
    InvalidPassword,
    RaiseException,
)
from psycopg.rows import tuple_row

from gradientbang.utils.legacy_ids import canonicalize_character_id

if TYPE_CHECKING:
    from gradientbang.utils.supabase_client import AsyncGameClient


# LISTEN timeout and legacy SQL signature value. Scoped reads return immediately.
DEFAULT_MAX_POLL_SECONDS = int(os.getenv("PGMQ_MAX_POLL_SECONDS", "1"))
EMPTY_POLL_INTERVAL_SECONDS = float(
    os.getenv("PGMQ_EMPTY_POLL_INTERVAL_SECONDS", "1.0")
)
DEFAULT_QTY = int(os.getenv("PGMQ_BATCH_QTY", "100"))
RECONNECT_BACKOFF_MAX = float(os.getenv("PGMQ_RECONNECT_BACKOFF_MAX", "10.0"))
NO_EVENTS_WARNING_SECONDS = float(os.getenv("PGMQ_NO_EVENTS_WARNING_SECONDS", "30.0"))
MAX_DISPATCH_ATTEMPTS = int(os.getenv("PGMQ_MAX_DISPATCH_ATTEMPTS", "3"))


def _resolve_pgmq_url() -> str:
    """Return the admin Postgres URL for pgmq, falling back to LOCAL_API_POSTGRES_URL."""
    url = os.getenv("PGMQ_URL") or os.getenv("LOCAL_API_POSTGRES_URL")
    if not url:
        raise RuntimeError(
            "PGMQ_URL (or LOCAL_API_POSTGRES_URL) is required when "
            "EVENT_TRANSPORT=pubsub. Set it to a direct (session-mode, NOT "
            "transaction-pooled) postgres URL with admin credentials."
        )
    return url


def _edge_token() -> str:
    token = os.getenv("EDGE_API_TOKEN") or os.getenv("SUPABASE_API_TOKEN")
    if not token:
        raise RuntimeError(
            "EDGE_API_TOKEN (or SUPABASE_API_TOKEN) is required when "
            "EVENT_TRANSPORT=pubsub. SQL verifies this token before reading "
            "scoped pgmq queues."
        )
    return token


def _is_fatal_pubsub_error(exc: BaseException) -> bool:
    """Connection/auth errors that indicate misconfiguration, not transient state."""
    if isinstance(exc, (RaiseException, InsufficientPrivilege)):
        return True
    if isinstance(
        exc, (InvalidPassword, InvalidAuthorizationSpecification, InvalidCatalogName)
    ):
        return True
    if isinstance(exc, psycopg.OperationalError):
        msg = str(exc).lower()
        if "authentication failed" in msg:
            return True
        if "does not exist" in msg and ("role " in msg or "database " in msg):
            return True
    return False


class PubsubEventAdapter:
    """Polls scoped pgmq queues via one session-wide reader loop."""

    def __init__(self, client: "AsyncGameClient") -> None:
        self._client = client
        self._actor_character_id = client._canonical_character_id
        self._character_ids: list[str] = [self._actor_character_id]
        self._corp_id: Optional[str] = None

        self._poll_task: Optional[asyncio.Task] = None
        self._broadcast_task: Optional[asyncio.Task] = None
        self._watchdog_task: Optional[asyncio.Task] = None

        self._stop_event = asyncio.Event()
        self._scope_changed_event = asyncio.Event()
        self._scope_lock = asyncio.Lock()
        self._started = False
        self._first_event_at: Optional[float] = None

    # ------------------------------------------------------------------
    # EventAdapter Protocol
    # ------------------------------------------------------------------

    async def purge_backlog(self) -> None:
        """Ensure each scoped pgmq queue exists, then empty it."""
        pgmq_url = _resolve_pgmq_url()
        async with await psycopg.AsyncConnection.connect(
            pgmq_url, autocommit=True, row_factory=tuple_row
        ) as conn:
            async with conn.cursor() as cur:
                for character_id in await self._current_scope():
                    queue_name = f"chr_{character_id}"
                    await cur.execute(
                        "SELECT public.ensure_character_queue(%s::uuid)",
                        (character_id,),
                    )
                    await cur.execute("SELECT pgmq.purge_queue(%s)", (queue_name,))
                    logger.info(f"pubsub.backlog_purged character={character_id}")

    async def start(self) -> None:
        if self._poll_task and not self._poll_task.done():
            return

        _resolve_pgmq_url()
        _edge_token()

        if self._stop_event.is_set():
            self._stop_event = asyncio.Event()
        if self._scope_changed_event.is_set():
            self._scope_changed_event = asyncio.Event()

        logger.info(
            "pubsub.start character_ids={} empty_poll_interval={}s",
            self._character_ids,
            EMPTY_POLL_INTERVAL_SECONDS,
        )

        self._started = True
        self._poll_task = asyncio.create_task(
            self._scoped_poll_loop(), name="pubsub-scoped-loop"
        )

        if os.getenv("PGMQ_SUBSCRIBE_BROADCASTS", "1") != "0":
            self._broadcast_task = asyncio.create_task(
                self._listen_broadcasts_loop(),
                name="pubsub-listen-broadcasts",
            )

        self._watchdog_task = asyncio.create_task(
            self._no_events_watchdog(), name="pubsub-no-events-watchdog"
        )

    async def stop(self) -> None:
        self._started = False
        self._stop_event.set()
        self._scope_changed_event.set()

        tasks = [
            task
            for task in (self._poll_task, self._broadcast_task, self._watchdog_task)
            if task is not None
        ]
        self._poll_task = None
        self._broadcast_task = None
        self._watchdog_task = None

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
        """Update the scoped queue list.

        The bound actor character is always first. Additional character ids and
        corp ship pseudo-character ids are appended in sorted order.
        """
        extras: set[str] = set()
        if character_ids is not None:
            for cid in character_ids:
                if isinstance(cid, str) and cid.strip():
                    normalized = canonicalize_character_id(cid.strip())
                    if normalized != self._actor_character_id:
                        extras.add(normalized)
        elif self._character_ids:
            extras.update(cid for cid in self._character_ids if cid != self._actor_character_id)

        if ship_ids is not None:
            for sid in ship_ids:
                if isinstance(sid, str) and sid.strip():
                    cleaned = sid.strip()
                    if cleaned != self._actor_character_id:
                        extras.add(cleaned)

        self._character_ids = [self._actor_character_id, *sorted(extras)]

        if corp_id is None:
            self._corp_id = None
        elif isinstance(corp_id, str):
            cleaned = corp_id.strip()
            self._corp_id = cleaned or None

        if self._started:
            self._scope_changed_event.set()

    # ------------------------------------------------------------------
    # Scoped pgmq reader
    # ------------------------------------------------------------------

    async def _current_scope(self) -> list[str]:
        async with self._scope_lock:
            return list(self._character_ids)

    async def _scoped_poll_loop(self) -> None:
        logger.info("pubsub.scoped_loop_started")
        backoff = 1.0
        while not self._stop_event.is_set():
            try:
                pgmq_url = _resolve_pgmq_url()
                async with await psycopg.AsyncConnection.connect(
                    pgmq_url, autocommit=True, row_factory=tuple_row
                ) as conn:
                    async with conn.cursor() as cur:
                        backoff = 1.0
                        while not self._stop_event.is_set():
                            had_rows = await self._poll_scope_once(cur)
                            if not had_rows:
                                await self._wait_for_stop_or_scope_change(
                                    EMPTY_POLL_INTERVAL_SECONDS
                                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if _is_fatal_pubsub_error(exc):
                    logger.error(f"pubsub.fatal_error error={exc}")
                    self._stop_event.set()
                    raise
                logger.warning(
                    f"pubsub.poll_error; reconnecting after {backoff:.1f}s",
                    exc_info=True,
                )
                with suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self._stop_event.wait(), timeout=backoff)
                backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX)

    async def _wait_for_stop_or_scope_change(self, timeout: float) -> None:
        if self._scope_changed_event.is_set():
            self._scope_changed_event.clear()
            return

        stop_wait = asyncio.create_task(self._stop_event.wait())
        scope_wait = asyncio.create_task(self._scope_changed_event.wait())
        try:
            done, _pending = await asyncio.wait(
                {stop_wait, scope_wait},
                timeout=timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                return
            if scope_wait in done:
                self._scope_changed_event.clear()
        finally:
            stop_wait.cancel()
            scope_wait.cancel()
            with suppress(asyncio.CancelledError):
                await stop_wait
            with suppress(asyncio.CancelledError):
                await scope_wait

    async def _poll_scope_once(self, cur: Any) -> bool:
        """Read all scoped queues once, dispatch messages, and archive handled rows."""
        character_ids = await self._current_scope()
        if not character_ids:
            return False

        await cur.execute(
            """
            SELECT queue_character_id, msg_id, read_ct, message
            FROM public.subscribe_my_events_scope(
                %s::uuid,
                %s::text,
                %s::uuid[],
                %s::integer
            )
            """,
            (self._actor_character_id, _edge_token(), character_ids, DEFAULT_QTY),
        )
        rows = await cur.fetchall()
        if not rows:
            return False

        msg_ids_to_archive: list[int] = []
        queue_ids_to_archive: list[str] = []
        for queue_character_id, msg_id, read_ct, message in self._sort_rows(rows):
            if not isinstance(message, Mapping):
                logger.debug(
                    "pubsub.skip_malformed msg_id={} character={}",
                    msg_id,
                    queue_character_id,
                )
                queue_ids_to_archive.append(str(queue_character_id))
                msg_ids_to_archive.append(int(msg_id))
                continue
            try:
                await self._dispatch(message)
                queue_ids_to_archive.append(str(queue_character_id))
                msg_ids_to_archive.append(int(msg_id))
            except Exception:
                if read_ct >= MAX_DISPATCH_ATTEMPTS:
                    logger.exception(
                        "pubsub.poison_msg msg_id={} character={} read_ct={} "
                        "(archiving after {} attempts)",
                        msg_id,
                        queue_character_id,
                        read_ct,
                        MAX_DISPATCH_ATTEMPTS,
                    )
                    queue_ids_to_archive.append(str(queue_character_id))
                    msg_ids_to_archive.append(int(msg_id))
                else:
                    logger.exception(
                        "pubsub.dispatch_error msg_id={} character={} read_ct={} "
                        "(will redeliver)",
                        msg_id,
                        queue_character_id,
                        read_ct,
                    )

        if msg_ids_to_archive:
            await cur.execute(
                """
                SELECT public.archive_my_events_scope(
                    %s::uuid,
                    %s::text,
                    %s::uuid[],
                    %s::bigint[]
                )
                """,
                (
                    self._actor_character_id,
                    _edge_token(),
                    queue_ids_to_archive,
                    msg_ids_to_archive,
                ),
            )
        return True

    def _sort_rows(self, rows: list[tuple]) -> list[tuple]:
        """Sort a scoped batch by global event id, matching old events_since ordering."""

        def event_id_for(row: tuple) -> Optional[int]:
            message = row[3] if len(row) >= 4 else None
            if not isinstance(message, Mapping):
                return None
            event_context = message.get("event_context")
            if not isinstance(event_context, Mapping):
                return None
            event_id = event_context.get("event_id")
            if isinstance(event_id, int):
                return event_id
            if isinstance(event_id, str) and event_id.isdigit():
                return int(event_id)
            return None

        indexed = list(enumerate(rows))
        indexed.sort(
            key=lambda item: (
                1 if event_id_for(item[1]) is None else 0,
                event_id_for(item[1]) or 0,
                item[0],
            )
        )
        return [row for _idx, row in indexed]

    async def _no_events_watchdog(self) -> None:
        try:
            await asyncio.wait_for(
                self._stop_event.wait(),
                timeout=NO_EVENTS_WARNING_SECONDS,
            )
        except asyncio.TimeoutError:
            if self._first_event_at is None:
                logger.warning(
                    "pubsub.no_events_after_start_warning window_seconds={} "
                    "character_ids={} - adapter is connected but no events "
                    "have been received. Check that edge functions are "
                    "publishing to pgmq.",
                    NO_EVENTS_WARNING_SECONDS,
                    self._character_ids,
                )

    # ------------------------------------------------------------------
    # Broadcast LISTEN/NOTIFY
    # ------------------------------------------------------------------

    async def _listen_broadcasts_loop(self) -> None:
        logger.info("pubsub.broadcast_listener_started channel=gb_broadcasts")
        backoff = 1.0
        while not self._stop_event.is_set():
            try:
                await self._listen_broadcasts_once()
                backoff = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if _is_fatal_pubsub_error(exc):
                    logger.error(f"pubsub.broadcast_fatal_error error={exc}")
                    self._stop_event.set()
                    raise
                logger.warning(
                    f"pubsub.broadcast_listen_error; reconnecting after {backoff:.1f}s",
                    exc_info=True,
                )
                with suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self._stop_event.wait(), timeout=backoff)
                backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX)

    async def _listen_broadcasts_once(self) -> None:
        pgmq_url = _resolve_pgmq_url()

        async with await psycopg.AsyncConnection.connect(
            pgmq_url, autocommit=True
        ) as conn:
            await conn.execute("LISTEN gb_broadcasts")
            while not self._stop_event.is_set():
                async for notify in conn.notifies(timeout=DEFAULT_MAX_POLL_SECONDS):
                    if self._stop_event.is_set():
                        return
                    await self._handle_broadcast_notify(notify)

    async def _handle_broadcast_notify(self, notify: psycopg.Notify) -> None:
        try:
            message = json.loads(notify.payload)
        except json.JSONDecodeError:
            logger.debug("pubsub.broadcast_skip_invalid_json")
            return
        if not isinstance(message, Mapping):
            return
        try:
            await self._dispatch(message)
        except Exception:
            logger.exception("pubsub.broadcast_dispatch_error")

    async def _dispatch(self, message: Mapping[str, Any]) -> None:
        """Dispatch one pgmq message into the client's existing event sinks."""
        event_name = message.get("event_type")
        if not isinstance(event_name, str) or not event_name:
            return

        if self._first_event_at is None:
            self._first_event_at = time.time()

        raw_payload = message.get("payload")
        payload: dict[str, Any]
        if isinstance(raw_payload, Mapping):
            payload = dict(raw_payload)
        else:
            payload = {"value": raw_payload}

        meta = message.get("meta")
        if isinstance(meta, Mapping) and "meta" not in payload:
            payload["meta"] = dict(meta)

        event_context = message.get("event_context")
        if isinstance(event_context, Mapping) and "__event_context" not in payload:
            payload["__event_context"] = dict(event_context)

        if "__task_id" not in payload:
            top_task_id = message.get("task_id")
            if isinstance(top_task_id, str) and top_task_id.strip():
                payload["__task_id"] = top_task_id.strip()

        request_id = message.get("request_id")
        request_id_str = request_id if isinstance(request_id, str) else None

        logger.debug(f"pubsub.dispatch event={event_name} request_id={request_id_str}")

        await self._client._maybe_update_sector_from_event(event_name, payload)
        await self._client._process_event(event_name, payload, request_id=request_id_str)
        self._client._append_event_log(event_name, payload)


__all__ = [
    "DEFAULT_MAX_POLL_SECONDS",
    "DEFAULT_QTY",
    "EMPTY_POLL_INTERVAL_SECONDS",
    "PubsubEventAdapter",
    "RECONNECT_BACKOFF_MAX",
]
