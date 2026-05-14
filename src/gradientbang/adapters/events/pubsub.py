"""pgmq-backed pubsub implementation of :class:`EventAdapter`.

Connects directly to Postgres (admin URL — same as the rest of the system)
and long-polls per-character queues via the auth-gated SECURITY DEFINER
functions:

- ``public.subscribe_my_events(character_id, internal_token, max_seconds, qty)``
- ``public.archive_my_events(character_id, internal_token, msg_ids[])``

Per-character authorization (direct ownership or corp membership) is enforced
inside those functions; this adapter trusts what they return. The adapter
runs one long-poll task per character in the active scope; ``set_scope`` adds
and removes tasks as the bound voice agent expands subscription (e.g. when a
corp ship joins the session).

Auth model: each SQL call carries a short-lived **internal HS256 token**
minted by the ``verify_token`` edge function in exchange for the user's
Supabase Auth JWT. The internal token is signed with a stable secret we
control end-to-end (``PUBSUB_INTERNAL_SECRET``), decoupling SQL verification
from Supabase Auth's signing-key rotation. We cache one internal token per
character and refresh before expiry.

Required env: ``PGMQ_URL`` — direct (NOT pooled) postgres URL with admin
credentials (same value as ``POSTGRES_POOLER_URL`` in ``.env.supabase``).
Falls back to ``LOCAL_API_POSTGRES_URL`` when unset, since both point at
the same admin connection in cloud deploys.
Required client state: ``access_token`` on the ``AsyncGameClient`` (set at
construction time by the bot, originating from the proxy ``start`` edge
function or the BOT_TEST_ACCESS_TOKEN dev env). Required also:
``SUPABASE_URL`` so we can reach the ``verify_token`` edge function.

Failure modes:
- Missing ``PGMQ_URL`` / ``SUPABASE_URL`` / ``access_token`` → raise at ``start()``.
- ``verify_token`` non-2xx → raise (bot session terminates).
- Auth raises (``forbidden`` / ``token_expired`` / ``invalid_token``) inside
  ``subscribe_my_events`` → adapter re-raises so the bot can disconnect (per
  the auth design: no token-refresh path; expired sessions terminate).

No client-side dedup ring: callers that build their LLM context inline from
RPC responses call ``purge_backlog`` before issuing those RPCs. It ensures
the per-character pgmq queue exists and purges stale messages from prior
sessions. The queue remains present throughout bootstrap because pubsub
delivery is required; publish failures surface synchronously to the RPC
caller.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import suppress
from typing import TYPE_CHECKING, Any, Mapping, Optional

import httpx
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


# Long-poll window per subscribe_my_events call. Connection stays in
# `read_with_poll` server-side until either a message arrives or this elapses.
DEFAULT_MAX_POLL_SECONDS = int(os.getenv("PGMQ_MAX_POLL_SECONDS", "30"))
# Max messages dispatched per long-poll iteration.
DEFAULT_QTY = int(os.getenv("PGMQ_BATCH_QTY", "100"))
# Backoff cap on transient connection errors.
RECONNECT_BACKOFF_MAX = float(os.getenv("PGMQ_RECONNECT_BACKOFF_MAX", "10.0"))
# Warn if no events have been dispatched within this many seconds of start.
# Doesn't disconnect — there are legitimate quiet windows — but makes silent
# mis-wiring (the symptom this guard exists for) visible.
NO_EVENTS_WARNING_SECONDS = float(os.getenv("PGMQ_NO_EVENTS_WARNING_SECONDS", "30.0"))
# Max number of times a single message will be dispatched before we give up
# and archive it as poison. pgmq's read_with_poll increments read_ct on each
# read; with a 10s VT (see subscribe_my_events SQL) this gives a transient
# fault ~MAX_DISPATCH_ATTEMPTS * 10s of redelivery before we drop the message.
MAX_DISPATCH_ATTEMPTS = int(os.getenv("PGMQ_MAX_DISPATCH_ATTEMPTS", "3"))


def _resolve_pgmq_url() -> str:
    """Return the admin Postgres URL for pgmq, falling back to LOCAL_API_POSTGRES_URL.

    In cloud deploys both vars point at the same admin connection, so a
    single value satisfies both the pgmq adapter and the in-process edge
    function server. Raises if neither is set.
    """
    url = os.getenv("PGMQ_URL") or os.getenv("LOCAL_API_POSTGRES_URL")
    if not url:
        raise RuntimeError(
            "PGMQ_URL (or LOCAL_API_POSTGRES_URL) is required when "
            "EVENT_TRANSPORT=pubsub. Set it to a direct (session-mode, NOT "
            "transaction-pooled) postgres URL with admin credentials."
        )
    return url


def _is_fatal_pubsub_error(exc: BaseException) -> bool:
    """Connection/auth errors that indicate misconfiguration, not transient state.

    Retrying these forever just hides the real problem (wrong PGMQ_URL, expired
    token, revoked ownership). Surface them as fatal so the session disconnects
    with a clear error instead of silently spinning in a backoff loop.
    """
    if isinstance(exc, (RaiseException, InsufficientPrivilege)):
        return True
    if isinstance(
        exc, (InvalidPassword, InvalidAuthorizationSpecification, InvalidCatalogName)
    ):
        return True
    if isinstance(exc, psycopg.OperationalError):
        # libpq FATAL errors (auth failed, role/database missing) arrive as
        # bare OperationalError without a SQLSTATE — match on the message.
        msg = str(exc).lower()
        if "authentication failed" in msg:
            return True
        if "does not exist" in msg and ("role " in msg or "database " in msg):
            return True
    return False


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
        # Single session-wide task that LISTENs on `gb_broadcasts` to receive
        # chat broadcasts and gm/system messages. Postgres NOTIFY is the
        # correct fan-out primitive (every listener gets every notification).
        # pgmq is competing-consumer and would drop broadcasts to peers.
        self._broadcast_task: Optional[asyncio.Task] = None
        self._stop_event = asyncio.Event()
        self._scope_lock = asyncio.Lock()
        # Per-character internal token cache. Keyed by character_id; values
        # are (token, expires_at_unix). Tokens are minted by the verify_token
        # edge function. Refreshed in _ensure_internal_token before expiry.
        self._internal_tokens: dict[str, tuple[str, float]] = {}
        # Set True at the end of start() once env validations and the initial
        # task sync have completed. set_scope() consults this before scheduling
        # any reconcile work, so a pre-start scope update can't spawn polling
        # tasks before start() has had a chance to validate PGMQ_URL/access_token.
        self._started: bool = False
        # Watchdog: warn loudly if no events arrive within N seconds of start.
        # Set on first _dispatch; the watchdog short-circuits when this is set.
        self._first_event_at: Optional[float] = None
        self._watchdog_task: Optional[asyncio.Task] = None

    # ------------------------------------------------------------------
    # EventAdapter Protocol
    # ------------------------------------------------------------------

    async def purge_backlog(self) -> None:
        """Ensure each per-character pgmq queue exists, then empty it.

        Sessions call this before bootstrap RPCs so stale messages from a
        prior session cannot replay. The queue must remain present because
        pubsub delivery is required: if a bootstrap or steady-state event
        cannot publish to pgmq, the request should fail synchronously.
        """
        pgmq_url = _resolve_pgmq_url()
        async with await psycopg.AsyncConnection.connect(
            pgmq_url, autocommit=True, row_factory=tuple_row
        ) as conn:
            async with conn.cursor() as cur:
                for character_id in self._character_ids:
                    queue_name = f"chr_{character_id}"
                    await cur.execute(
                        "SELECT public.ensure_character_queue(%s)",
                        (character_id,),
                    )
                    await cur.execute(
                        "SELECT pgmq.purge_queue(%s)", (queue_name,)
                    )
                    logger.info(
                        f"pubsub.backlog_purged character={character_id}"
                    )

    async def start(self) -> None:
        if self._char_tasks:
            return  # Already running.

        _resolve_pgmq_url()  # Validate early so start() raises before launching tasks.
        if not os.getenv("SUPABASE_URL"):
            raise RuntimeError(
                "SUPABASE_URL is required when EVENT_TRANSPORT=pubsub "
                "(used to reach the verify_token edge function)."
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

        logger.info(
            f"pubsub.start character_ids={self._character_ids} "
            f"poll_window={DEFAULT_MAX_POLL_SECONDS}s"
        )

        # Pre-fetch the internal token for the bound character so misconfig
        # (bad access_token, verify_token edge function down, etc.) surfaces
        # at session start instead of first poll. Other characters added via
        # set_scope mint on demand.
        for character_id in self._character_ids:
            await self._ensure_internal_token(character_id)

        # Self-test: verify the SQL roundtrip works end-to-end before we
        # silently accept the session. Also creates the per-character queue
        # defensively if it never existed.
        for character_id in self._character_ids:
            await self._run_startup_self_test(character_id)

        await self._sync_tasks()

        # Spawn the LISTEN/NOTIFY broadcast subscriber. Disable via
        # PGMQ_SUBSCRIBE_BROADCASTS=0 if a deploy goes sideways; default on.
        if os.getenv("PGMQ_SUBSCRIBE_BROADCASTS", "1") != "0":
            self._broadcast_task = asyncio.create_task(
                self._listen_broadcasts_loop(),
                name="pubsub-listen-broadcasts",
            )

        # Watchdog: if no event has been dispatched within N seconds, warn
        # loudly. Catches the "connected, no errors, but pgmq is empty"
        # silent-failure mode that prompted these guards.
        self._watchdog_task = asyncio.create_task(
            self._no_events_watchdog(), name="pubsub-no-events-watchdog"
        )

        self._started = True

    async def _ensure_internal_token(self, character_id: str) -> str:
        """Return a valid internal token for ``character_id``, refreshing if needed.

        Tokens are minted by the ``verify_token`` edge function in exchange
        for the AsyncGameClient's Supabase Auth access_token. We cache one per
        character and refresh when within 60s of expiry.
        """
        cached = self._internal_tokens.get(character_id)
        if cached:
            token, expires_at = cached
            if time.time() < expires_at - 60:
                return token

        supabase_url = os.environ["SUPABASE_URL"].rstrip("/")
        access_token = self._client._access_token
        if not access_token:
            raise RuntimeError(
                "access_token missing on AsyncGameClient; cannot mint internal token"
            )
        # X-Edge-Auth proves the request came from a trusted backend. The
        # bot must set EDGE_API_TOKEN in production — verify_token requires
        # X-Edge-Auth and will 401 without it. Tests/local-dev rely on the
        # server bypass (ALLOW_AUTH_BYPASS_FOR_LOCAL_DEV=1), so we omit the
        # header when no token is configured.
        edge_auth = os.environ.get("EDGE_API_TOKEN")

        url = f"{supabase_url}/functions/v1/verify_token"
        headers = {"Authorization": f"Bearer {access_token}"}
        if edge_auth:
            headers["X-Edge-Auth"] = edge_auth
        async with httpx.AsyncClient(timeout=10.0) as http:
            resp = await http.post(
                url,
                headers=headers,
                json={"character_id": character_id},
            )
        if resp.status_code != 200:
            logger.error(
                f"pubsub.verify_token_failed character={character_id} "
                f"status={resp.status_code} body={resp.text}"
            )
            raise RuntimeError(
                f"verify_token returned {resp.status_code}: {resp.text}"
            )
        data = resp.json()
        if not data.get("success") or not data.get("token"):
            raise RuntimeError(f"verify_token returned malformed response: {data}")

        token = str(data["token"])
        expires_at = float(data.get("expires_at") or 0)
        self._internal_tokens[character_id] = (token, expires_at)
        return token

    async def _run_startup_self_test(self, character_id: str) -> None:
        """One-shot subscribe_my_events to prove the SQL auth path works.

        Calls with max_seconds=0 so pgmq.read_with_poll exits after a single
        non-blocking read. The assertion is "no exception raised"; we discard
        any rows. Catches verify_token/secret mismatch, queue-missing, or
        ownership-revoked failures at session start instead of letting them
        manifest minutes later as a silent stalled poll.
        """
        pgmq_url = _resolve_pgmq_url()
        internal_token = await self._ensure_internal_token(character_id)
        try:
            async with await psycopg.AsyncConnection.connect(
                pgmq_url, autocommit=True, row_factory=tuple_row
            ) as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "SELECT msg_id, message FROM public.subscribe_my_events(%s, %s, %s, %s)",
                        (character_id, internal_token, 0, 1),
                    )
                    await cur.fetchall()
        except Exception as exc:
            logger.error(
                f"pubsub.startup_self_test_failed character={character_id} "
                f"error={exc}"
            )
            raise

    async def _no_events_watchdog(self) -> None:
        """Wait NO_EVENTS_WARNING_SECONDS; warn if no event has been dispatched.

        Doesn't disconnect — there are legitimate reasons for silence (player
        idle in a quiet sector, bot started before any state change). Just
        logs a single visible warning to surface the "connected but receiving
        nothing" failure mode that misconfig used to hide.
        """
        try:
            await asyncio.wait_for(
                self._stop_event.wait(),
                timeout=NO_EVENTS_WARNING_SECONDS,
            )
        except asyncio.TimeoutError:
            if self._first_event_at is None:
                logger.warning(
                    f"pubsub.no_events_after_start_warning "
                    f"window_seconds={NO_EVENTS_WARNING_SECONDS} "
                    f"character_ids={self._character_ids} — adapter is "
                    f"connected but no events have been received. Check "
                    f"that edge functions are publishing to pgmq."
                )

    async def stop(self) -> None:
        self._started = False
        self._stop_event.set()
        async with self._scope_lock:
            tasks = list(self._char_tasks.values())
            self._char_tasks.clear()
        broadcast_task = self._broadcast_task
        self._broadcast_task = None
        if broadcast_task is not None:
            tasks.append(broadcast_task)
        watchdog_task = self._watchdog_task
        self._watchdog_task = None
        if watchdog_task is not None:
            tasks.append(watchdog_task)
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

        # Reconcile tasks only after start() has succeeded. Schedule the sync
        # as a background task — set_scope is sync and we shouldn't block the
        # caller waiting for asyncio cleanup. Pre-start scope updates are
        # absorbed into self._character_ids and applied by start()'s initial
        # _sync_tasks() call.
        if self._started:
            loop = asyncio.get_running_loop()
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

            if self._stop_event.is_set():
                return

            for cid in to_add:
                loop_coro = (
                    self._dynamic_character_loop(cid)
                    if self._started
                    else self._character_loop(cid)
                )
                self._char_tasks[cid] = asyncio.create_task(
                    loop_coro,
                    name=f"pubsub-loop-{cid}",
                )

    async def _dynamic_character_loop(self, character_id: str) -> None:
        """Preflight a post-start scope add, then enter the normal poll loop."""
        logger.info(f"pubsub.dynamic_preflight_started character={character_id}")
        backoff = 1.0
        while not self._stop_event.is_set():
            async with self._scope_lock:
                if character_id not in self._character_ids:
                    return
            try:
                await self._run_startup_self_test(character_id)
                break
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if _is_fatal_pubsub_error(exc):
                    logger.error(
                        f"pubsub.dynamic_preflight_fatal character={character_id} "
                        f"error={exc}"
                    )
                    self._stop_event.set()
                    raise
                logger.warning(
                    f"pubsub.dynamic_preflight_failed character={character_id}; "
                    f"retrying after {backoff:.1f}s",
                    exc_info=True,
                )
                with suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self._stop_event.wait(), timeout=backoff)
                backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX)

        async with self._scope_lock:
            if character_id not in self._character_ids:
                return
        await self._character_loop(character_id)

    async def _character_loop(self, character_id: str) -> None:
        """Long-poll one character's queue forever (until stop)."""
        logger.info(f"pubsub.character_loop_started character={character_id}")
        backoff = 1.0
        while not self._stop_event.is_set():
            try:
                await self._poll_once(character_id)
                backoff = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if _is_fatal_pubsub_error(exc):
                    logger.error(
                        f"pubsub.fatal_error character={character_id} error={exc}"
                    )
                    self._stop_event.set()
                    raise
                logger.warning(
                    f"pubsub.poll_error character={character_id}; "
                    f"reconnecting after {backoff:.1f}s",
                    exc_info=True,
                )
                with suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self._stop_event.wait(), timeout=backoff)
                backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX)

    async def _listen_broadcasts_loop(self) -> None:
        """LISTEN on `gb_broadcasts` for the lifetime of the session.

        One connection, one LISTEN, one async loop pulling notifications and
        dispatching them through the same `_dispatch` path as per-character
        messages. Reconnects with backoff on connection error.
        """
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

    async def _poll_once(self, character_id: str) -> None:
        """One long-poll + dispatch + archive cycle."""
        pgmq_url = _resolve_pgmq_url()
        internal_token = await self._ensure_internal_token(character_id)

        async with await psycopg.AsyncConnection.connect(
            pgmq_url, autocommit=True, row_factory=tuple_row
        ) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT msg_id, read_ct, message FROM public.subscribe_my_events(%s, %s, %s, %s)",
                    (character_id, internal_token, DEFAULT_MAX_POLL_SECONDS, DEFAULT_QTY),
                )
                rows = await cur.fetchall()

                if not rows:
                    return

                # Archive on success or when we give up (poison/malformed).
                # Transient dispatch failures are deliberately left un-archived
                # so pgmq's visibility-timeout redelivery can retry them.
                msg_ids_to_archive: list[int] = []
                for msg_id, read_ct, message in rows:
                    if not isinstance(message, Mapping):
                        logger.debug(
                            f"pubsub.skip_malformed msg_id={msg_id} "
                            f"character={character_id}"
                        )
                        msg_ids_to_archive.append(msg_id)
                        continue
                    try:
                        await self._dispatch(message)
                        msg_ids_to_archive.append(msg_id)
                    except Exception:
                        if read_ct >= MAX_DISPATCH_ATTEMPTS:
                            logger.exception(
                                f"pubsub.poison_msg msg_id={msg_id} "
                                f"character={character_id} read_ct={read_ct} "
                                f"(archiving after {MAX_DISPATCH_ATTEMPTS} attempts)"
                            )
                            msg_ids_to_archive.append(msg_id)
                        else:
                            logger.exception(
                                f"pubsub.dispatch_error msg_id={msg_id} "
                                f"character={character_id} read_ct={read_ct} "
                                f"(will redeliver)"
                            )

                if msg_ids_to_archive:
                    # Re-fetch in case the cached token expired during the
                    # poll window (rare — typical poll window is 30s, refresh
                    # margin is 60s — but cheap to be safe).
                    archive_token = await self._ensure_internal_token(character_id)
                    await cur.execute(
                        "SELECT public.archive_my_events(%s, %s, %s)",
                        (character_id, archive_token, msg_ids_to_archive),
                    )

    async def _listen_broadcasts_once(self) -> None:
        """One LISTEN session: hold a connection, dispatch notifications.

        Returns when the connection drops or the stop_event fires. The outer
        loop reconnects on error with backoff.
        """
        pgmq_url = _resolve_pgmq_url()

        async with await psycopg.AsyncConnection.connect(
            pgmq_url, autocommit=True
        ) as conn:
            await conn.execute("LISTEN gb_broadcasts")
            # `notifies(timeout=...)` yields received notifications and ends
            # after the idle timeout — we wrap it in an outer loop so we can
            # bail when stop_event fires without a notification.
            while not self._stop_event.is_set():
                # Use the same long-poll window as per-character queues so the
                # generator periodically returns and we can re-check stop_event.
                async for notify in conn.notifies(
                    timeout=DEFAULT_MAX_POLL_SECONDS
                ):
                    if self._stop_event.is_set():
                        return
                    await self._handle_broadcast_notify(notify)

    async def _handle_broadcast_notify(
        self, notify: psycopg.Notify
    ) -> None:
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
        """Dispatch one pgmq message into the client's existing event sinks.

        Mirrors `PollingEventAdapter._deliver_polled_event` so pubsub and
        polling deliver to the same downstream code paths. In particular:
        lift top-level ``event_context`` into ``payload["__event_context"]``
        and (defensively) inject ``__task_id`` if the producer didn't already.
        Without these, EventRelay drops non-combat events and loses task
        routing (event_relay.py:1784, 1953).
        """
        event_name = message.get("event_type")
        if not isinstance(event_name, str) or not event_name:
            return

        # First-event signal for the no-events watchdog. Set it once; the
        # watchdog short-circuits on this and stops warning.
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

        # Mirror polling.py:_build_polled_event_payload — lift event_context
        # into __event_context so EventRelay's gate at event_relay.py:1784
        # accepts the message.
        event_context = message.get("event_context")
        if isinstance(event_context, Mapping) and "__event_context" not in payload:
            payload["__event_context"] = dict(event_context)

        # Defensive: if the producer didn't already inject __task_id into the
        # payload, fall back to the top-level task_id field.
        if "__task_id" not in payload:
            top_task_id = message.get("task_id")
            if isinstance(top_task_id, str) and top_task_id.strip():
                payload["__task_id"] = top_task_id.strip()

        request_id = message.get("request_id")
        request_id_str = (
            request_id if isinstance(request_id, str) else None
        )

        logger.debug(
            f"pubsub.dispatch event={event_name} request_id={request_id_str}"
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
