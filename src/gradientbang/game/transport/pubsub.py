"""Session-scoped pgmq implementation of :class:`EventAdapter`.

``EVENT_TRANSPORT=pubsub`` means one temporary queue per live bot session. The
queue is registered before bootstrap RPCs run, kept alive by heartbeat, and
removed by best-effort unregister plus database-owned expiry cleanup.
"""

from __future__ import annotations

import asyncio
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

from gradientbang.config import Settings, settings
from gradientbang.utils.event_ordering import (
    extract_event_id_from_context,
    sort_by_event_id_id_first,
)
from gradientbang.utils.legacy_ids import canonicalize_character_id

if TYPE_CHECKING:
    from gradientbang.game.client import AsyncGameClient


HEARTBEAT_SECONDS = max(1.0, settings.EVENT_SESSION_HEARTBEAT_SECONDS)
TTL_SECONDS = max(5, settings.EVENT_SESSION_TTL_SECONDS)
HARD_TTL_SECONDS = max(TTL_SECONDS, settings.EVENT_SESSION_HARD_TTL_SECONDS)
VISIBILITY_TIMEOUT_SECONDS = max(1, settings.EVENT_SESSION_VISIBILITY_TIMEOUT_SECONDS)
EMPTY_POLL_INTERVAL_SECONDS = max(0.05, settings.EVENT_SESSION_EMPTY_POLL_INTERVAL_SECONDS)
DEFAULT_QTY = max(1, settings.EVENT_SESSION_BATCH_QTY)
BOOTSTRAP_DRAIN_TIMEOUT_SECONDS = max(
    0.0, settings.EVENT_SESSION_BOOTSTRAP_DRAIN_TIMEOUT_SECONDS
)
RECONNECT_BACKOFF_MAX = settings.PGMQ_RECONNECT_BACKOFF_MAX
NO_EVENTS_WARNING_SECONDS = settings.PGMQ_NO_EVENTS_WARNING_SECONDS
MAX_DISPATCH_ATTEMPTS = settings.PGMQ_MAX_DISPATCH_ATTEMPTS


def _resolve_pgmq_url() -> str:
    """Return the admin Postgres URL for pgmq, falling back to LOCAL_API_POSTGRES_URL."""
    current = Settings()
    url = current.PGMQ_URL or current.LOCAL_API_POSTGRES_URL
    if not url:
        raise RuntimeError(
            "PGMQ_URL (or LOCAL_API_POSTGRES_URL) is required when "
            "EVENT_TRANSPORT=pubsub. Set it to a direct (session-mode, NOT "
            "transaction-pooled) postgres URL with admin credentials."
        )
    return url


def _edge_token() -> str:
    current = Settings()
    token = current.EDGE_API_TOKEN or current.SUPABASE_API_TOKEN
    if not token:
        raise RuntimeError(
            "EDGE_API_TOKEN (or SUPABASE_API_TOKEN) is required when "
            "EVENT_TRANSPORT=pubsub. SQL verifies this token before reading "
            "session event queues."
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
    """Polls one temporary session queue via direct Postgres reads."""

    def __init__(self, client: "AsyncGameClient") -> None:
        self._client = client
        self._actor_character_id = client._canonical_character_id
        self._character_ids: list[str] = [self._actor_character_id]
        self._corp_id: Optional[str] = None

        self._session_id: Optional[str] = None
        self._queue_name: Optional[str] = None

        self._poll_task: Optional[asyncio.Task] = None
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._watchdog_task: Optional[asyncio.Task] = None

        self._stop_event = asyncio.Event()
        self._scope_changed_event = asyncio.Event()
        self._scope_lock = asyncio.Lock()
        self._started = False
        self._first_event_at: Optional[float] = None
        self._catchup_buffer: list[Mapping[str, Any]] = []
        self._pending_scope_sync = False

    # ------------------------------------------------------------------
    # EventAdapter Protocol
    # ------------------------------------------------------------------

    async def purge_backlog(self) -> None:
        """Reset pending delivery for callers without explicit bootstrap hooks."""
        if self._session_id is None:
            await self.prepare_bootstrap()
            return
        await self.complete_bootstrap(discard_request_ids=set())

    async def prepare_bootstrap(self) -> None:
        """Register a live event session before any bootstrap RPCs run."""
        if self._session_id is not None:
            return

        _resolve_pgmq_url()
        _edge_token()
        await self._register_session()
        self._ensure_heartbeat_task()
        logger.info(
            "pubsub.session_queue_created session_id={} queue={} physical_queue=pgmq.{} "
            "ttl={}s hard_ttl={}s heartbeat={}s",
            self._session_id,
            self._queue_name,
            f"q_{self._queue_name}",
            TTL_SECONDS,
            HARD_TTL_SECONDS,
            HEARTBEAT_SECONDS,
        )

    async def complete_bootstrap(self, discard_request_ids: set[str]) -> None:
        """Drain startup-window messages without interrupting initial context.

        Messages with bootstrap request ids are archived and discarded. Other
        messages are archived and held in memory for explicit catch-up replay
        after the agent activates.
        """
        if self._session_id is None:
            return
        await self._drain_bootstrap_queue(discard_request_ids)

    async def replay_catchup(self) -> None:
        """Dispatch messages buffered during bootstrap."""
        if not self._catchup_buffer:
            return
        buffered = self._sort_messages(self._catchup_buffer)
        self._catchup_buffer = []
        logger.info("pubsub.catchup_replay count={}", len(buffered))
        for message in buffered:
            await self._dispatch(message)

    async def start(self) -> None:
        if self._poll_task and not self._poll_task.done():
            return

        if self._session_id is None:
            await self.prepare_bootstrap()

        if self._stop_event.is_set():
            self._stop_event = asyncio.Event()
        if self._scope_changed_event.is_set():
            self._scope_changed_event.clear()

        self._ensure_heartbeat_task()
        self._started = True
        self._poll_task = asyncio.create_task(
            self._session_poll_loop(), name="pubsub-session-loop"
        )
        self._watchdog_task = asyncio.create_task(
            self._no_events_watchdog(), name="pubsub-no-events-watchdog"
        )

        logger.info(
            "pubsub.start session_id={} queue={} character_ids={} empty_poll_interval={}s",
            self._session_id,
            self._queue_name,
            self._character_ids,
            EMPTY_POLL_INTERVAL_SECONDS,
        )

    async def stop(self) -> None:
        self._started = False
        self._stop_event.set()
        self._scope_changed_event.set()

        tasks = [
            task
            for task in (self._poll_task, self._heartbeat_task, self._watchdog_task)
            if task is not None
        ]
        self._poll_task = None
        self._heartbeat_task = None
        self._watchdog_task = None

        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError, Exception):
                await task

        if self._session_id is not None:
            with suppress(Exception):
                await self._unregister_session()
        self._session_id = None
        self._queue_name = None

    def set_scope(
        self,
        *,
        character_ids: Optional[list[str]] = None,
        corp_id: Optional[str] = None,
        ship_ids: Optional[list[str]] = None,
    ) -> None:
        """Update desired session fanout scope.

        The database row is synchronized before the next read/heartbeat. Code
        that needs a hard ordering before event-emitting scoped work should use
        ``sync_scope`` on the adapter/client.
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

        self._pending_scope_sync = True
        if self._started or self._session_id is not None:
            self._scope_changed_event.set()

    async def sync_scope(self) -> None:
        if self._session_id is None or not self._pending_scope_sync:
            return
        await self._update_session_scope()

    # ------------------------------------------------------------------
    # Session lifecycle
    # ------------------------------------------------------------------

    async def _register_session(self) -> None:
        pgmq_url = _resolve_pgmq_url()
        async with await psycopg.AsyncConnection.connect(
            pgmq_url, autocommit=True, row_factory=tuple_row
        ) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT session_id, queue_name
                    FROM public.event_session_register(
                        %s::uuid,
                        %s::text,
                        %s::uuid[],
                        %s::uuid,
                        %s::integer,
                        %s::integer
                    )
                    """,
                    (
                        self._actor_character_id,
                        _edge_token(),
                        await self._current_scope(),
                        self._corp_id,
                        TTL_SECONDS,
                        HARD_TTL_SECONDS,
                    ),
                )
                row = await cur.fetchone()
                if not row:
                    raise RuntimeError("event_session_register returned no row")
                session_id = str(row[0])
                queue_name = str(row[1])
                await self._assert_session_queue_exists(cur, queue_name)
        self._session_id = session_id
        self._queue_name = queue_name
        self._pending_scope_sync = False

    async def _assert_session_queue_exists(self, cur: Any, queue_name: str) -> None:
        physical_queue = f"q_{queue_name}"
        await cur.execute(
            """
            SELECT EXISTS (
                SELECT 1
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'pgmq'
                  AND c.relname = %s
            )
            """,
            (physical_queue,),
        )
        row = await cur.fetchone()
        exists = bool(row and row[0])
        if not exists:
            raise RuntimeError(
                "event_session_register returned queue_name but physical pgmq "
                f"queue is missing: queue={queue_name} physical_queue=pgmq.{physical_queue}"
            )

    async def _heartbeat_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                await self._heartbeat_once()
                await self.sync_scope()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if _is_fatal_pubsub_error(exc):
                    logger.error("pubsub.heartbeat_fatal_error error={}", exc)
                    self._stop_event.set()
                    raise
                logger.warning("pubsub.heartbeat_error", exc_info=True)
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=HEARTBEAT_SECONDS)
                return
            except asyncio.TimeoutError:
                continue

    async def _heartbeat_once(self) -> None:
        if self._session_id is None:
            return
        pgmq_url = _resolve_pgmq_url()
        async with await psycopg.AsyncConnection.connect(
            pgmq_url, autocommit=True, row_factory=tuple_row
        ) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT public.event_session_heartbeat(
                        %s::uuid,
                        %s::text,
                        %s::integer
                    )
                    """,
                    (self._session_id, _edge_token(), TTL_SECONDS),
                )

    def _ensure_heartbeat_task(self) -> None:
        if self._heartbeat_task and not self._heartbeat_task.done():
            return
        if self._stop_event.is_set():
            self._stop_event = asyncio.Event()
        self._heartbeat_task = asyncio.create_task(
            self._heartbeat_loop(), name="pubsub-session-heartbeat"
        )

    async def _update_session_scope(self) -> None:
        if self._session_id is None:
            return
        pgmq_url = _resolve_pgmq_url()
        async with await psycopg.AsyncConnection.connect(
            pgmq_url, autocommit=True, row_factory=tuple_row
        ) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT public.event_session_update_scope(
                        %s::uuid,
                        %s::text,
                        %s::uuid[],
                        %s::uuid
                    )
                    """,
                    (
                        self._session_id,
                        _edge_token(),
                        await self._current_scope(),
                        self._corp_id,
                    ),
                )
        self._pending_scope_sync = False
        self._scope_changed_event.clear()

    async def _unregister_session(self) -> None:
        if self._session_id is None:
            return
        pgmq_url = _resolve_pgmq_url()
        async with await psycopg.AsyncConnection.connect(
            pgmq_url, autocommit=True, row_factory=tuple_row
        ) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT public.event_session_unregister(%s::uuid, %s::text)",
                    (self._session_id, _edge_token()),
                )
        logger.info("pubsub.session_unregistered session_id={}", self._session_id)

    # ------------------------------------------------------------------
    # Session pgmq reader
    # ------------------------------------------------------------------

    async def _current_scope(self) -> list[str]:
        async with self._scope_lock:
            return list(self._character_ids)

    async def _session_poll_loop(self) -> None:
        logger.info("pubsub.session_loop_started session_id={}", self._session_id)
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
                            await self.sync_scope()
                            had_rows = await self._poll_session_once(cur)
                            if not had_rows:
                                await self._wait_for_stop_or_scope_change(
                                    EMPTY_POLL_INTERVAL_SECONDS
                                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if _is_fatal_pubsub_error(exc):
                    logger.error("pubsub.fatal_error error={}", exc)
                    self._stop_event.set()
                    raise
                logger.warning(
                    "pubsub.poll_error; reconnecting after {:.1f}s",
                    backoff,
                    exc_info=True,
                )
                with suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self._stop_event.wait(), timeout=backoff)
                backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX)

    async def _wait_for_stop_or_scope_change(self, timeout: float) -> None:
        if self._scope_changed_event.is_set():
            await self.sync_scope()
            return

        stop_wait = asyncio.create_task(self._stop_event.wait())
        scope_wait = asyncio.create_task(self._scope_changed_event.wait())
        try:
            done, _pending = await asyncio.wait(
                {stop_wait, scope_wait},
                timeout=timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if scope_wait in done:
                await self.sync_scope()
        finally:
            stop_wait.cancel()
            scope_wait.cancel()
            with suppress(asyncio.CancelledError):
                await stop_wait
            with suppress(asyncio.CancelledError):
                await scope_wait

    async def _poll_session_once(self, cur: Any) -> bool:
        rows = await self._read_session_rows(cur)
        if not rows:
            return False

        msg_ids_to_archive: list[int] = []
        for msg_id, read_ct, message in self._sort_rows(rows):
            if not isinstance(message, Mapping):
                logger.debug("pubsub.skip_malformed msg_id={}", msg_id)
                msg_ids_to_archive.append(int(msg_id))
                continue
            try:
                await self._dispatch(message)
                msg_ids_to_archive.append(int(msg_id))
            except Exception:
                if read_ct >= MAX_DISPATCH_ATTEMPTS:
                    logger.exception(
                        "pubsub.poison_msg msg_id={} read_ct={} "
                        "(archiving after {} attempts)",
                        msg_id,
                        read_ct,
                        MAX_DISPATCH_ATTEMPTS,
                    )
                    msg_ids_to_archive.append(int(msg_id))
                else:
                    logger.exception(
                        "pubsub.dispatch_error msg_id={} read_ct={} (will redeliver)",
                        msg_id,
                        read_ct,
                    )

        if msg_ids_to_archive:
            await self._archive_session_messages(cur, msg_ids_to_archive)
        return True

    async def _read_session_rows(self, cur: Any) -> list[tuple]:
        if self._session_id is None:
            return []
        await cur.execute(
            """
            SELECT msg_id, read_ct, message
            FROM public.event_session_subscribe(
                %s::uuid,
                %s::text,
                %s::integer,
                %s::integer
            )
            """,
            (
                self._session_id,
                _edge_token(),
                VISIBILITY_TIMEOUT_SECONDS,
                DEFAULT_QTY,
            ),
        )
        return await cur.fetchall()

    async def _archive_session_messages(self, cur: Any, msg_ids: list[int]) -> None:
        if self._session_id is None or not msg_ids:
            return
        await cur.execute(
            """
            SELECT public.event_session_archive(
                %s::uuid,
                %s::text,
                %s::bigint[]
            )
            """,
            (self._session_id, _edge_token(), msg_ids),
        )

    async def _drain_bootstrap_queue(self, discard_request_ids: set[str]) -> None:
        logger.info(
            "Flushing pubsub message queue after bootstrap; bootstrap_request_ids={}",
            len(discard_request_ids),
        )
        deadline = time.monotonic() + BOOTSTRAP_DRAIN_TIMEOUT_SECONDS
        pgmq_url = _resolve_pgmq_url()
        async with await psycopg.AsyncConnection.connect(
            pgmq_url, autocommit=True, row_factory=tuple_row
        ) as conn:
            async with conn.cursor() as cur:
                while True:
                    rows = await self._read_session_rows(cur)
                    if not rows:
                        break
                    archive_ids: list[int] = []
                    for msg_id, _read_ct, message in self._sort_rows(rows):
                        archive_ids.append(int(msg_id))
                        if not isinstance(message, Mapping):
                            continue
                        request_id = message.get("request_id")
                        if isinstance(request_id, str) and request_id in discard_request_ids:
                            continue
                        self._catchup_buffer.append(message)
                    await self._archive_session_messages(cur, archive_ids)
                    if BOOTSTRAP_DRAIN_TIMEOUT_SECONDS == 0:
                        break
                    if time.monotonic() >= deadline:
                        break

    def _sort_rows(self, rows: list[tuple]) -> list[tuple]:
        return sort_by_event_id_id_first(rows, event_id_of=self._event_id_for_row)

    def _sort_messages(self, messages: list[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
        return sort_by_event_id_id_first(messages, event_id_of=self._event_id_for_message)

    def _event_id_for_row(self, row: tuple) -> Optional[int]:
        message = row[2] if len(row) >= 3 else None
        if not isinstance(message, Mapping):
            return None
        return self._event_id_for_message(message)

    def _event_id_for_message(self, message: Mapping[str, Any]) -> Optional[int]:
        return extract_event_id_from_context(message.get("event_context"))

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
                    "session_id={} - adapter is connected but no events "
                    "have been received. Check active event_sessions fanout.",
                    NO_EVENTS_WARNING_SECONDS,
                    self._session_id,
                )

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

        logger.debug("pubsub.dispatch event={} request_id={}", event_name, request_id_str)

        await self._client._maybe_update_sector_from_event(event_name, payload)
        await self._client._process_event(event_name, payload, request_id=request_id_str)
        self._client._append_event_log(event_name, payload)


__all__ = [
    "DEFAULT_QTY",
    "EMPTY_POLL_INTERVAL_SECONDS",
    "HEARTBEAT_SECONDS",
    "PubsubEventAdapter",
    "RECONNECT_BACKOFF_MAX",
]
