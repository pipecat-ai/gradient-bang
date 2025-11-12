"""Reusable Supabase Realtime subscription core."""

from __future__ import annotations

import asyncio
import inspect
import logging
from collections import deque
from collections.abc import Awaitable, Callable
from contextlib import suppress
import os
from typing import Any, Deque, Dict, List, Optional, Tuple

from realtime import AsyncRealtimeChannel, AsyncRealtimeClient, RealtimeSubscribeStates


logger = logging.getLogger(__name__)
logger.addHandler(logging.NullHandler())
SUPABASE_REALTIME_DEBUG = os.getenv("SUPABASE_REALTIME_DEBUG", "").lower() in {
    "1",
    "true",
    "on",
}
logger.setLevel(logging.DEBUG if SUPABASE_REALTIME_DEBUG else logging.WARNING)

EventHandler = Callable[[str, Dict[str, Any]], Awaitable[None] | None]
StatusHandler = Callable[[RealtimeSubscribeStates, Optional[BaseException]], Awaitable[None] | None]
HandlerToken = Tuple[Optional[str], EventHandler]


class SupabaseRealtimeListener:
    """Manages a single-topic Supabase realtime subscription."""

    def __init__(
        self,
        *,
        supabase_url: str,
        anon_key: str,
        topic: str,
        subscribe_timeout: float = 5.0,
        schema: str = "public",
        table: Optional[str] = None,
        access_token: Optional[str] = None,
        postgres_filter: Optional[str] = None,
    ) -> None:
        trimmed_topic = topic.strip()
        if not trimmed_topic:
            raise ValueError("SupabaseRealtimeListener requires a topic")
        if trimmed_topic.startswith("realtime:"):
            trimmed_topic = trimmed_topic[len("realtime:") :]

        self._supabase_url = supabase_url.rstrip("/")
        self._anon_key = anon_key
        self._topic = trimmed_topic
        self._subscribe_timeout = subscribe_timeout
        self._schema = schema or "public"
        self._table = table
        self._access_token = access_token
        self._postgres_filter = postgres_filter

        self._client: Optional[AsyncRealtimeClient] = None
        self._channel: Optional[AsyncRealtimeChannel] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._start_lock = asyncio.Lock()
        self._ready = asyncio.Event()

        self._event_handlers: Dict[str, List[EventHandler]] = {}
        self._any_handlers: List[EventHandler] = []
        self._status_handlers: List[StatusHandler] = []
        self._recent_event_ids: Deque[int] = deque(maxlen=2048)

    @property
    def topic(self) -> str:
        return self._topic

    def on(self, event_name: str, handler: EventHandler) -> HandlerToken:
        bucket = self._event_handlers.setdefault(event_name, [])
        bucket.append(handler)
        return (event_name, handler)

    def on_any(self, handler: EventHandler) -> HandlerToken:
        self._any_handlers.append(handler)
        return (None, handler)

    def remove_handler(self, token: HandlerToken) -> None:
        name, handler = token
        if name is None:
            with suppress(ValueError):
                self._any_handlers.remove(handler)
            return
        handlers = self._event_handlers.get(name)
        if not handlers:
            return
        with suppress(ValueError):
            handlers.remove(handler)
        if not handlers:
            self._event_handlers.pop(name, None)

    def add_status_handler(self, handler: StatusHandler) -> StatusHandler:
        self._status_handlers.append(handler)
        return handler

    def remove_status_handler(self, handler: StatusHandler) -> None:
        with suppress(ValueError):
            self._status_handlers.remove(handler)

    async def start(self) -> None:
        if self._channel is not None:
            await self._ready.wait()
            return

        async with self._start_lock:
            if self._channel is not None:
                await self._ready.wait()
                return

            self._ready.clear()
            loop = asyncio.get_running_loop()
            self._loop = loop

            client = AsyncRealtimeClient(
                url=f"{self._supabase_url}/realtime/v1",
                token=self._anon_key,
                auto_reconnect=True,
            )
            if self._access_token:
                await client.set_auth(self._access_token)

            channel = client.channel(self._topic)
            channel.on_postgres_changes(
                event="INSERT",
                schema=self._schema,
                table=self._table,
                filter=self._postgres_filter,
                callback=self._handle_postgres_change,
            )
            logger.info(
                "supabase realtime postgres handler registered",
                extra={
                    "topic": self._topic,
                    "schema": self._schema,
                    "table": self._table,
                },
            )

            subscribe_future: asyncio.Future[None] = loop.create_future()

            def _state_callback(state, error):
                self._emit_status(state, error)
                if subscribe_future.done():
                    return
                if state == RealtimeSubscribeStates.SUBSCRIBED:
                    subscribe_future.set_result(None)
                elif state in {
                    RealtimeSubscribeStates.CHANNEL_ERROR,
                    RealtimeSubscribeStates.CLOSED,
                    RealtimeSubscribeStates.TIMED_OUT,
                }:
                    subscribe_future.set_exception(
                        error or RuntimeError(f"Supabase realtime subscribe failed: {state}")
                    )

            await channel.subscribe(callback=_state_callback)

            try:
                await asyncio.wait_for(subscribe_future, timeout=self._subscribe_timeout)
            except Exception:  # noqa: BLE001
                await self._cleanup(channel, client)
                raise

            self._client = client
            self._channel = channel
            self._ready.set()
            logger.info(
                "supabase realtime subscribed",
                extra={"topic": self._topic},
            )

    async def stop(self) -> None:
        async with self._start_lock:
            await self._cleanup(self._channel, self._client)
            self._client = None
            self._channel = None
            self._ready.clear()

    async def _cleanup(
        self,
        channel: Optional[AsyncRealtimeChannel],
        client: Optional[AsyncRealtimeClient],
    ) -> None:
        if channel is not None:
            try:
                await channel.unsubscribe()
            except Exception:  # noqa: BLE001
                logger.debug("channel unsubscribe failed", exc_info=True)
        if client is not None:
            try:
                await client.close()
            except Exception:  # noqa: BLE001
                logger.debug("realtime client close failed", exc_info=True)

    def _handle_postgres_change(self, change: Dict[str, Any]) -> None:
        logger.info(
            "supabase realtime postgres raw",
            extra={"topic": self._topic, "schema": self._schema, "table": self._table},
        )
        # Extract record from postgres_changes payload structure
        data = change.get("data", {})
        record = data.get("new") or data.get("record") or {}
        if not isinstance(record, dict):
            return

        event_name = record.get("event_type")
        if not isinstance(event_name, str) or not event_name:
            return

        payload = record.get("payload") or {}
        if not isinstance(payload, dict):
            payload = {"value": payload}

        meta = record.get("meta")
        if isinstance(meta, dict) and "meta" not in payload:
            payload["meta"] = meta

        request_id = record.get("request_id")
        if isinstance(request_id, str) and request_id and "request_id" not in payload:
            payload["request_id"] = request_id

        inserted_id = record.get("id")
        event_id: Optional[int]
        try:
            event_id = int(inserted_id) if inserted_id is not None else None
        except (TypeError, ValueError):
            event_id = None

        context: Dict[str, Any] = {}
        for key in ("scope", "sector_id", "corp_id", "actor_character_id", "character_id", "direction"):
            value = record.get(key)
            if value is not None:
                context[key] = value
        if event_id is not None:
            context["event_id"] = event_id
        if context:
            payload.setdefault("__event_context", context)

        self._dispatch_event(event_name, payload, event_id)

    def _dispatch_event(self, event_name: str, payload: Dict[str, Any], event_id: Optional[int]) -> None:
        if event_id is not None:
            if event_id in self._recent_event_ids:
                logger.debug(
                    "supabase realtime dropping duplicate",
                    extra={"topic": self._topic, "event": event_name, "event_id": event_id},
                )
                return
            self._recent_event_ids.append(event_id)

        loop = self._loop
        if loop is None:
            return

        handlers = list(self._event_handlers.get(event_name, []))
        any_handlers = list(self._any_handlers)
        if not handlers and not any_handlers:
            return

        payload_for_handlers = payload.copy()

        for handler in handlers:
            loop.call_soon_threadsafe(self._dispatch_event_handler, handler, event_name, payload_for_handlers.copy())
        for handler in any_handlers:
            loop.call_soon_threadsafe(self._dispatch_event_handler, handler, event_name, payload_for_handlers.copy())

    def _dispatch_event_handler(
        self,
        handler: EventHandler,
        event_name: str,
        payload: Dict[str, Any],
    ) -> None:
        if self._loop is None:
            return
        try:
            result = handler(event_name, payload)
            if inspect.isawaitable(result):
                self._loop.create_task(self._await_handler(result, handler, event_name))
        except Exception:  # noqa: BLE001
            logger.exception("supabase realtime handler failed", extra={"event": event_name})

    async def _await_handler(
        self,
        awaitable: Awaitable[Any],
        handler: EventHandler,
        event_name: str,
    ) -> None:
        try:
            await awaitable
        except Exception:  # noqa: BLE001
            logger.exception("supabase realtime handler coroutine failed", extra={"event": event_name})

    def _emit_status(
        self,
        state: RealtimeSubscribeStates,
        error: Optional[BaseException],
    ) -> None:
        if not self._status_handlers or self._loop is None:
            return
        for handler in list(self._status_handlers):
            self._loop.call_soon_threadsafe(self._dispatch_status_handler, handler, state, error)

    def _dispatch_status_handler(
        self,
        handler: StatusHandler,
        state: RealtimeSubscribeStates,
        error: Optional[BaseException],
    ) -> None:
        if self._loop is None:
            return
        try:
            result = handler(state, error)
            if inspect.isawaitable(result):
                self._loop.create_task(self._await_status_handler(result, state))
        except Exception:  # noqa: BLE001
            logger.exception("supabase realtime status handler failed", extra={"state": state})

    async def _await_status_handler(
        self,
        awaitable: Awaitable[Any],
        state: RealtimeSubscribeStates,
    ) -> None:
        try:
            await awaitable
        except Exception:  # noqa: BLE001
            logger.exception("supabase realtime status coroutine failed", extra={"state": state})
