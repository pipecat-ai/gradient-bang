"""Game server API client for Gradient Bang."""

from typing import List, Optional, Dict, Any, Callable, Awaitable, Tuple, Mapping
from datetime import datetime, timezone
import logging
import asyncio
import json
import uuid
import inspect
import websockets

from gradientbang.utils.summary_formatters import (
    chat_message_summary,
    combat_action_accepted_summary,
    combat_ended_summary,
    combat_round_waiting_summary,
    combat_round_resolved_summary,
    character_moved_summary,
    garrison_character_moved_summary,
    join_summary,
    list_known_ports_summary,
    map_local_summary,
    movement_start_summary,
    move_summary,
    plot_course_summary,
    port_update_summary,
    salvage_collected_summary,
    salvage_created_summary,
    garrison_combat_alert_summary,
    sector_update_summary,
    status_update_summary,
    trade_executed_summary,
    transfer_summary,
)


logger = logging.getLogger(__name__)


class RPCError(RuntimeError):
    """Raised when the server responds with an RPC error frame."""

    def __init__(
        self, endpoint: str, status: int, detail: str, code: Optional[str] = None
    ) -> None:
        super().__init__(f"{endpoint} failed with status {status}: {detail}")
        self.endpoint = endpoint
        self.status = status
        self.detail = detail
        self.code = code


class AsyncGameClient:
    """Async client for interacting with the Gradient Bang game server."""

    def __init__(
        self,
        base_url: str = "http://localhost:8000",
        *,
        character_id: str,
        transport: str = "websocket",
        actor_character_id: Optional[str] = None,
        entity_type: str = "character",
        allow_corp_actorless_control: bool = False,
        websocket_frame_callback: Optional[
            Callable[[str, Mapping[str, Any]], Any]
        ] = None,
    ):
        """Initialize the async game client.

        Args:
            base_url: Base URL of the game server
            character_id: Character ID this client will operate on (immutable)
            actor_character_id: Optional corporation member ID issuing commands when
                controlling autonomous ships
            entity_type: "character" (default) or "corporation_ship" for corp vessels
            allow_corp_actorless_control: Set True to bypass the actor requirement for
                corporation ships (admin/ops tools only)
            websocket_frame_callback: Optional callback for WebSocket frame logging/debugging
        """
        if not character_id:
            raise ValueError("AsyncGameClient requires a non-empty character_id")

        self.base_url = base_url.rstrip("/")
        if transport != "websocket":
            raise ValueError("AsyncGameClient now supports only websocket transport")
        self.transport = "websocket"
        self._ws = None
        self._ws_reader_task: Optional[asyncio.Task] = None
        self._pending: Dict[str, asyncio.Future] = {}
        self._event_handlers: Dict[
            str, List[Callable[[Dict[str, Any]], Awaitable[None]]]
        ] = {}
        self._event_handler_wrappers: Dict[
            Tuple[str, Callable[[Dict[str, Any]], Any]],
            Callable[[Dict[str, Any]], Awaitable[None]],
        ] = {}
        self._event_delivery_enabled: bool = True
        self._pending_events: List[Tuple[str, Dict[str, Any]]] = []
        self._event_queues: Dict[str, asyncio.Queue] = {}
        self._subscriptions: set[str] = set()
        self._seen_error_request_ids: set[str] = set()

        # Immutable character ID
        self._character_id: str = character_id
        self._actor_character_id: Optional[str] = actor_character_id
        self._entity_type = entity_type
        self._allow_corp_actorless_control = allow_corp_actorless_control

        if self._entity_type not in {"character", "corporation_ship"}:
            raise ValueError(f"Unknown entity_type {entity_type!r}")

        if (
            self._entity_type == "corporation_ship"
            and not self._allow_corp_actorless_control
            and self._actor_character_id is None
        ):
            raise ValueError(
                "actor_character_id is required when controlling a corporation ship. "
                "Pass allow_corp_actorless_control=True to override."
            )

        # Track the player's latest known sector for contextual summaries
        self._current_sector: Optional[int] = None

        # Optional summary formatters: endpoint/event name -> formatter function
        self._summary_formatters: Dict[str, Callable[[Dict[str, Any]], str]] = (
            self._build_default_summaries()
        )

        # Optional WebSocket frame callback for logging/debugging
        self._websocket_frame_callback = websocket_frame_callback

    @property
    def character_id(self) -> str:
        """Get the character ID this client is bound to."""
        return self._character_id

    @property
    def actor_character_id(self) -> Optional[str]:
        """Return the actor character ID (None when acting as self)."""
        return self._actor_character_id

    def set_actor_character_id(self, actor_character_id: Optional[str]) -> None:
        """Update the actor character ID for subsequent requests."""

        if (
            actor_character_id is None
            and self._entity_type == "corporation_ship"
            and not self._allow_corp_actorless_control
        ):
            raise ValueError(
                "actor_character_id cannot be cleared while controlling a corporation ship "
                "unless allow_corp_actorless_control=True"
            )
        self._actor_character_id = actor_character_id

    def set_summary_formatter(
        self, endpoint: str, formatter: Callable[[Dict[str, Any]], str]
    ) -> None:
        """Attach a summary formatter to an endpoint.

        Args:
            endpoint: Endpoint name (e.g., "move", "trade")
            formatter: Function that takes server response and returns summary string
        """
        self._summary_formatters[endpoint] = formatter
        logger.info(f"Registered summary formatter for endpoint: {endpoint}")

    def _build_default_summaries(self) -> Dict[str, Callable[[Dict[str, Any]], str]]:
        def map_local_wrapper(
            data: Dict[str, Any], client: "AsyncGameClient" = self
        ) -> str:
            current = client._current_sector
            if current is None and isinstance(data, Mapping):
                current_candidate = data.get("center_sector")
                if isinstance(current_candidate, int):
                    current = current_candidate
            return map_local_summary(data, current)

        return {
            "join": join_summary,
            "my_status": join_summary,
            "status.snapshot": join_summary,
            "status.update": status_update_summary,
            "move": move_summary,
            "movement.complete": move_summary,
            "movement.start": movement_start_summary,
            "plot_course": plot_course_summary,
            "course.plot": plot_course_summary,
            "list_known_ports": list_known_ports_summary,
            "local_map_region": map_local_wrapper,
            "map.local": map_local_wrapper,
            "trade.executed": trade_executed_summary,
            "credits.transfer": transfer_summary,
            "warp.transfer": transfer_summary,
            "chat.message": chat_message_summary,
            "port.update": port_update_summary,
            "character.moved": character_moved_summary,
            "combat.round_waiting": combat_round_waiting_summary,
            "combat.action_accepted": combat_action_accepted_summary,
            "combat.round_resolved": combat_round_resolved_summary,
            "combat.ended": combat_ended_summary,
            "salvage.created": salvage_created_summary,
            "salvage.collected": salvage_collected_summary,
            "garrison.combat_alert": garrison_combat_alert_summary,
            "garrison.character_moved": garrison_character_moved_summary,
            "sector.update": sector_update_summary,
        }

    def _set_current_sector(self, candidate: Any) -> None:
        """Update cached sector ID if candidate is a valid integer."""

        if candidate is None or isinstance(candidate, bool):
            return

        try:
            value = int(candidate)
        except (TypeError, ValueError):
            return

        self._current_sector = value

    def _maybe_update_current_sector(
        self, event_name: str, payload: Mapping[str, Any]
    ) -> None:
        """Extract and cache the player's current sector from incoming data."""

        sector_id: Optional[Any] = None

        if event_name in {"movement.complete", "status.snapshot", "status.update"}:
            sector = payload.get("sector")
            if isinstance(sector, Mapping):
                sector_id = sector.get("id")

        if sector_id is None and "current_sector" in payload:
            sector_id = payload.get("current_sector")

        if sector_id is None and event_name in {"map.local", "local_map_region"}:
            sector_id = payload.get("center_sector")

        if sector_id is not None:
            self._set_current_sector(sector_id)

    def _get_summary(self, name: str, data: Dict[str, Any]) -> Optional[str]:
        """Run a registered summary formatter and return the summary string."""

        logger.info(
            f"_get_summary called for name: {name}, has formatter: {name in self._summary_formatters}"
        )

        formatter = self._summary_formatters.get(name)
        if not formatter:
            logger.debug(f"No formatter registered for {name}")
            return None

        try:
            logger.info(f"Calling formatter for {name}")
            summary = formatter(data)
        except Exception:
            logger.exception(f"Summary formatter for {name} failed")
            return None

        if summary is None:
            logger.warning(f"Formatter for {name} returned empty summary")
            return None

        if not isinstance(summary, str):
            summary = str(summary)

        summary = summary.strip()
        if not summary:
            logger.warning(f"Formatter for {name} returned empty summary")
            return None

        logger.info(f"Summary formatter for {name} produced: {summary}")
        return summary

    def _format_event(self, event_name: str, payload: Any) -> Dict[str, Any]:
        """Normalize an event payload and attach summary metadata when available."""

        if isinstance(payload, Mapping):
            self._maybe_update_current_sector(event_name, payload)

        event_message: Dict[str, Any] = {
            "event_name": event_name,
            "payload": payload,
        }

        if isinstance(payload, dict):
            summary = self._get_summary(event_name, payload)
            if summary:
                event_message["summary"] = summary

        return event_message

    async def __aenter__(self):
        """Enter async context manager."""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Exit async context manager and close client."""
        await self.close()

    async def close(self):
        """Close network clients."""
        if self._ws_reader_task:
            self._ws_reader_task.cancel()
            self._ws_reader_task = None
        if self._ws:
            try:
                await self._ws.aclose()
            except Exception:
                pass
            self._ws = None

    def _register_event_handler(
        self,
        event_name: str,
        handler: Callable[[Dict[str, Any]], Awaitable[None] | None],
    ) -> Tuple[str, Callable[[Dict[str, Any]], Awaitable[None]]]:
        """Register an event handler and return a removable token."""

        if not callable(handler):
            raise TypeError("Event handler must be callable")

        if asyncio.iscoroutinefunction(handler):
            async_handler = handler  # type: ignore[assignment]
        else:

            async def async_handler(payload: Dict[str, Any]) -> None:
                try:
                    result = handler(payload)
                    if inspect.isawaitable(result):
                        await result
                except Exception:  # noqa: BLE001
                    logger.exception("Unhandled error in %s handler", event_name)

        bucket = self._event_handlers.setdefault(event_name, [])
        bucket.append(async_handler)
        self._event_handler_wrappers[(event_name, handler)] = async_handler
        return event_name, async_handler

    # Event subscription decorator (WS only)
    def on(self, event_name: str):
        def decorator(fn: Callable[[Dict[str, Any]], Awaitable[None] | None]):
            self._register_event_handler(event_name, fn)
            return fn

        return decorator

    def add_event_handler(
        self,
        event_name: str,
        handler: Callable[[Dict[str, Any]], Awaitable[None] | None],
    ) -> Tuple[str, Callable[[Dict[str, Any]], Awaitable[None]]]:
        """Register a handler programmatically and return a token for removal."""

        return self._register_event_handler(event_name, handler)

    def remove_event_handler(
        self,
        token: Tuple[str, Callable[[Dict[str, Any]], Awaitable[None]]],
    ) -> bool:
        """Remove a previously registered handler using its token."""

        event_name, async_handler = token
        handlers = self._event_handlers.get(event_name)
        if not handlers:
            return False

        removed = False
        try:
            handlers.remove(async_handler)
            removed = True
        except ValueError:
            removed = False

        if not handlers:
            self._event_handlers.pop(event_name, None)

        if removed:
            for key, value in list(self._event_handler_wrappers.items()):
                if value is async_handler:
                    self._event_handler_wrappers.pop(key, None)

        return removed

    def remove_event_handler_by_callable(
        self,
        event_name: str,
        handler: Callable[[Dict[str, Any]], Awaitable[None] | None],
    ) -> bool:
        """Remove a handler by the original callable reference."""

        wrapper = self._event_handler_wrappers.get((event_name, handler))
        if not wrapper:
            return False
        return self.remove_event_handler((event_name, wrapper))

    async def wait_for_event(
        self,
        event_name: str,
        *,
        predicate: Optional[Callable[[Dict[str, Any]], bool]] = None,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Wait for an event matching an optional predicate and return the event message."""

        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        token: Optional[Tuple[str, Callable[[Dict[str, Any]], Awaitable[None]]]] = None

        async def _handler(event: Dict[str, Any]) -> None:
            nonlocal token
            try:
                if predicate and not predicate(event):
                    return
                if not future.done():
                    future.set_result(event)
            finally:
                if token is not None:
                    self.remove_event_handler(token)

        token = self.add_event_handler(event_name, _handler)

        try:
            if timeout is not None:
                return await asyncio.wait_for(future, timeout)
            return await future
        finally:
            if not future.done() and token is not None:
                self.remove_event_handler(token)

    async def _emit_frame(self, direction: str, frame: Mapping[str, Any]) -> None:
        """Emit a WebSocket frame to the registered callback if present.

        Args:
            direction: "send" or "recv"
            frame: The WebSocket frame dict
        """
        if self._websocket_frame_callback is None:
            return
        try:
            result = self._websocket_frame_callback(direction, frame)
            if inspect.isawaitable(result):
                await result
        except Exception:  # pragma: no cover - logging must never crash the client
            pass

    async def _ensure_ws(self):
        if self._ws is not None:
            return
        ws_url = self.base_url.replace("http://", "ws://").replace("https://", "wss://")
        ws_url = ws_url.rstrip("/") + "/ws"
        self._ws = await websockets.connect(ws_url)
        self._ws_reader_task = asyncio.create_task(self._ws_reader())

    async def _ws_reader(self):
        try:
            async for raw in self._ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                await self._emit_frame("recv", msg)
                frame_type = msg.get("frame_type")
                if frame_type == "event":
                    event_name = msg.get("event")
                    payload = msg.get("payload", {})
                    if event_name:
                        if (
                            event_name == "character.moved"
                            and self._character_id is not None
                        ):
                            player = payload.get("player") or {}
                            mover_id = player.get("id") or payload.get("character_id")
                            mover_name = player.get("name") or payload.get("name")
                            if (
                                mover_id == self._character_id
                                or mover_name == self._character_id
                            ):
                                continue
                        await self._process_event(event_name, payload)
                    continue
                if frame_type == "rpc":
                    req_id = msg.get("id")
                else:
                    req_id = msg.get("id")
                fut = self._pending.pop(req_id, None)
                if fut and not fut.done():
                    fut.set_result(msg)
        except asyncio.CancelledError:
            pass
        except Exception:
            # Terminate all pending
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(RuntimeError("WebSocket connection lost"))
            self._pending.clear()

    async def _process_event(self, event_name: str, payload: Dict[str, Any]) -> None:
        if event_name == "error" and isinstance(payload, Mapping):
            source = payload.get("source")
            if isinstance(source, Mapping):
                request_id = source.get("request_id")
                if request_id is not None:
                    self._seen_error_request_ids.add(str(request_id))
        event_message = self._format_event(event_name, payload)
        if not self._event_delivery_enabled:
            self._pending_events.append((event_name, event_message))
            return
        self._deliver_event(event_name, event_message)

    def _deliver_event(self, event_name: str, event_message: Dict[str, Any]) -> None:
        queue = self._event_queues.setdefault(event_name, asyncio.Queue())
        queue.put_nowait(event_message)
        handlers = self._event_handlers.get(event_name, [])
        for handler in handlers:
            asyncio.create_task(handler(event_message))

    def get_event_queue(self, event_name: str) -> asyncio.Queue:
        """Return a per-event queue for consumers that prefer awaiting messages.

        The queue receives event message dictionaries matching the structure
        delivered to registered handlers (keys: ``event_name``, ``payload``,
        and optional ``summary``).
        """

        return self._event_queues.setdefault(event_name, asyncio.Queue())

    async def pause_event_delivery(self) -> None:
        """Temporarily buffer incoming events instead of delivering them."""

        self._event_delivery_enabled = False

    async def resume_event_delivery(self) -> None:
        """Enable event delivery and flush any buffered events."""

        if self._event_delivery_enabled:
            return
        self._event_delivery_enabled = True
        pending = self._pending_events
        self._pending_events = []
        for event_name, event_message in pending:
            self._deliver_event(event_name, event_message)

    async def _request(self, endpoint: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        await self._ensure_ws()
        req_id = str(uuid.uuid4())
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        enriched_payload = dict(payload)
        if self._actor_character_id and "actor_character_id" not in enriched_payload:
            enriched_payload["actor_character_id"] = self._actor_character_id
        frame = {
            "id": req_id,
            "type": "rpc",
            "endpoint": endpoint,
            "payload": enriched_payload,
        }
        await self._emit_frame("send", frame)
        await self._ws.send(json.dumps(frame))
        msg = await fut
        if not msg.get("ok"):
            err = msg.get("error", {})
            await self._synthesize_error_event(
                endpoint=endpoint,
                request_id=req_id,
                error_payload=err,
            )
            raise RPCError(
                endpoint,
                int(err.get("status", 500)),
                str(err.get("detail", "Unknown error")),
                err.get("code"),
            )

        result = msg.get("result", {})
        await self._maybe_synthesize_error_from_result(
            endpoint=endpoint,
            request_id=req_id,
            result=result,
        )
        return result

    async def _send_command(self, frame: Dict[str, Any]) -> Dict[str, Any]:
        await self._ensure_ws()
        enriched = dict(frame)
        payload = enriched.get("payload")
        if self._actor_character_id:
            if isinstance(payload, dict):
                payload.setdefault("actor_character_id", self._actor_character_id)
            else:
                enriched.setdefault("actor_character_id", self._actor_character_id)
        req_id = enriched.setdefault("id", str(uuid.uuid4()))
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        await self._emit_frame("send", enriched)
        await self._ws.send(json.dumps(enriched))
        msg = await fut
        if not msg.get("ok"):
            err = msg.get("error", {})
            endpoint = enriched.get("endpoint") or enriched.get("type", "command")
            await self._synthesize_error_event(
                endpoint=endpoint,
                request_id=req_id,
                error_payload=err,
            )
            raise RPCError(
                enriched.get("type", "command"),
                int(err.get("status", 500)),
                str(err.get("detail", "Unknown error")),
                err.get("code"),
            )

        result = msg.get("result", {})
        await self._maybe_synthesize_error_from_result(
            endpoint=enriched.get("endpoint") or enriched.get("type", "command"),
            request_id=req_id,
            result=result,
        )
        return result

    async def _synthesize_error_event(
        self,
        *,
        endpoint: Optional[str],
        request_id: Optional[str],
        error_payload: Mapping[str, Any],
    ) -> None:
        if request_id is not None and request_id in self._seen_error_request_ids:
            return

        detail = str(error_payload.get("detail", "Unknown error"))
        source_request_id = request_id or str(uuid.uuid4())
        source_endpoint = endpoint or "unknown"
        payload: Dict[str, Any] = {
            "endpoint": source_endpoint,
            "error": detail,
            "source": {
                "type": "rpc",
                "method": source_endpoint,
                "request_id": source_request_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
            "synthesized": True,
        }

        status = error_payload.get("status")
        if status is not None:
            payload["status"] = status

        code = error_payload.get("code")
        if code is not None:
            payload["code"] = code

        self._seen_error_request_ids.add(source_request_id)
        await self._process_event("error", payload)

    async def _maybe_synthesize_error_from_result(
        self,
        *,
        endpoint: Optional[str],
        request_id: Optional[str],
        result: Any,
    ) -> None:
        if not isinstance(result, Mapping):
            return

        success = result.get("success")
        error_text = result.get("error")

        if success is not False or not isinstance(error_text, str) or not error_text:
            return

        error_payload: Dict[str, Any] = {"detail": error_text}

        status = result.get("status")
        if status is not None:
            error_payload["status"] = status

        code = result.get("code")
        if code is not None:
            error_payload["code"] = code

        await self._synthesize_error_event(
            endpoint=endpoint,
            request_id=request_id,
            error_payload=error_payload,
        )

    # ------------------------------------------------------------------
    # API Methods
    # ------------------------------------------------------------------

    async def join(
        self,
        character_id: str,
        ship_type: Optional[str] = None,
        credits: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Join the game with a character.

        Args:
            character_id: Unique identifier for the character (must match bound ID)
            ship_type: Optional ship type to start with (defaults to Kestrel Courier)
            credits: Optional starting credit balance to seed for tests/admin flows

        Returns:
            Minimal RPC acknowledgment (e.g., ``{\"success\": True}``)

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload = {"character_id": character_id}
        if ship_type:
            payload["ship_type"] = ship_type
        if credits is not None:
            payload["credits"] = int(credits)

        ack = await self._request("join", payload)
        return ack

    async def test_reset(
        self,
        *,
        clear_files: bool = True,
        file_prefixes: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Reset server state (testing utility).

        Returns:
            Minimal RPC acknowledgment describing the reset operation
        """

        payload: Dict[str, Any] = {"clear_files": clear_files}
        if file_prefixes is not None:
            payload["file_prefixes"] = list(file_prefixes)
        return await self._request("test.reset", payload)

    async def move(self, to_sector: int, character_id: str) -> Dict[str, Any]:
        """Move a character to an adjacent sector.

        Args:
            to_sector: Destination sector (must be adjacent)
            character_id: Character to move (must match bound ID)

        Returns:
            Minimal RPC acknowledgment (e.g., ``{\"success\": True}``)

        Raises:
            RPCError: If the request fails (e.g., non-adjacent sector)
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        ack = await self._request(
            "move", {"character_id": character_id, "to_sector": to_sector}
        )
        return ack

    async def my_status(self, character_id: str) -> Dict[str, Any]:
        """Request a current status snapshot.

        Args:
            character_id: Character to query (must match bound ID)

        Returns:
            Minimal RPC acknowledgment (status data arrives via ``status.snapshot``)

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        ack = await self._request("my_status", {"character_id": character_id})
        return ack

    async def plot_course(self, to_sector: int, character_id: str) -> Dict[str, Any]:
        """Plot a course from the current sector to a destination.

        Args:
            to_sector: Destination sector
            character_id: Character to plot course for (must match bound ID)

        Returns:
            Minimal RPC acknowledgment (course details arrive via ``course.plot``)

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        ack = await self._request(
            "plot_course", {"character_id": character_id, "to_sector": to_sector}
        )
        return ack

    async def server_status(self) -> Dict[str, Any]:
        """Get server status information.

        Returns:
            Server status including name, version, and sector count

        Raises:
            RPCError: If the request fails
        """
        return await self._request("server_status", {})

    async def leaderboard_resources(
        self,
        *,
        character_id: Optional[str] = None,
        force_refresh: bool = False,
    ) -> Dict[str, Any]:
        """Fetch the latest leaderboard snapshot (players + corporations)."""

        payload: Dict[str, Any] = {}
        target_character = character_id or self._character_id
        if target_character:
            payload["character_id"] = target_character
        if force_refresh:
            payload["force_refresh"] = True
        return await self._request("leaderboard.resources", payload)

    async def character_create(
        self,
        *,
        name: str,
        admin_password: Optional[str] = None,
        player: Optional[Dict[str, Any]] = None,
        ship: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Create a character via admin RPC."""

        payload: Dict[str, Any] = {"name": name}
        if admin_password is not None:
            payload["admin_password"] = admin_password
        if player:
            payload["player"] = player
        if ship:
            payload["ship"] = ship
        return await self._request("character.create", payload)

    async def character_modify(
        self,
        *,
        character_id: str,
        admin_password: Optional[str] = None,
        name: Optional[str] = None,
        player: Optional[Dict[str, Any]] = None,
        ship: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Modify an existing character's metadata."""

        payload: Dict[str, Any] = {"character_id": character_id}
        if admin_password is not None:
            payload["admin_password"] = admin_password
        if name is not None:
            payload["name"] = name
        if player:
            payload["player"] = player
        if ship:
            payload["ship"] = ship
        return await self._request("character.modify", payload)

    async def character_delete(
        self,
        *,
        character_id: str,
        admin_password: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Delete a character via admin RPC."""

        payload: Dict[str, Any] = {"character_id": character_id}
        if admin_password is not None:
            payload["admin_password"] = admin_password
        return await self._request("character.delete", payload)

    async def event_query(
        self,
        *,
        start: str,
        end: str,
        admin_password: Optional[str] = None,
        character_id: Optional[str] = None,
        sector: Optional[int] = None,
        corporation_id: Optional[str] = None,
        string_match: Optional[str] = None,
        max_rows: Optional[int] = None,
        sort_direction: Optional[str] = None,
        actor_character_id: Optional[str] = None,
        event_scope: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Query event logs within a time range."""

        payload: Dict[str, Any] = {
            "start": start,
            "end": end,
        }
        if admin_password is not None:
            payload["admin_password"] = admin_password
        if character_id:
            payload["character_id"] = character_id
        if sector is not None:
            payload["sector"] = sector
        if corporation_id:
            payload["corporation_id"] = corporation_id
        if string_match:
            payload["string_match"] = string_match
        if max_rows is not None:
            payload["max_rows"] = max_rows
        if sort_direction:
            payload["sort_direction"] = sort_direction
        if event_scope:
            payload["event_scope"] = event_scope

        actor_value = (
            actor_character_id
            or self._actor_character_id
            or self._character_id
        )
        if actor_value:
            payload.setdefault("actor_character_id", actor_value)

        return await self._request("event.query", payload)

    async def create_corporation(
        self,
        *,
        name: str,
        character_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create a new corporation for the bound character."""

        if not isinstance(name, str) or not name.strip():
            raise ValueError("name must be a non-empty string")

        if character_id is None:
            character_id = self._character_id
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload: Dict[str, Any] = {
            "character_id": character_id,
            "name": name,
        }
        return await self._request("corporation.create", payload)

    async def join_corporation(
        self,
        *,
        corp_id: str,
        invite_code: str,
        character_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Join an existing corporation using an invite code."""

        if not isinstance(corp_id, str) or not corp_id.strip():
            raise ValueError("corp_id must be a non-empty string")
        if not isinstance(invite_code, str) or not invite_code.strip():
            raise ValueError("invite_code must be a non-empty string")

        if character_id is None:
            character_id = self._character_id
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload: Dict[str, Any] = {
            "character_id": character_id,
            "corp_id": corp_id,
            "invite_code": invite_code,
        }
        return await self._request("corporation.join", payload)

    async def leave_corporation(
        self,
        *,
        character_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Leave the current corporation."""

        if character_id is None:
            character_id = self._character_id
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload: Dict[str, Any] = {"character_id": character_id}
        return await self._request("corporation.leave", payload)

    async def kick_corporation_member(
        self,
        *,
        target_id: str,
        character_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Remove another member from the corporation."""

        if not isinstance(target_id, str) or not target_id.strip():
            raise ValueError("target_id must be a non-empty string")

        if character_id is None:
            character_id = self._character_id
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload: Dict[str, Any] = {
            "character_id": character_id,
            "target_id": target_id,
        }
        return await self._request("corporation.kick", payload)

    async def list_corporations(self) -> List[Dict[str, Any]]:
        """Return summaries of all corporations."""

        result = await self._request("corporation.list", {})
        corps = result.get("corporations")
        if isinstance(corps, list):
            return corps
        return []

    async def purchase_ship(
        self,
        *,
        ship_type: str,
        character_id: Optional[str] = None,
        purchase_type: Optional[str] = None,
        ship_name: Optional[str] = None,
        trade_in_ship_id: Optional[str] = None,
        corp_id: Optional[str] = None,
        initial_ship_credits: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Purchase a ship for personal use or on behalf of a corporation."""

        if not isinstance(ship_type, str) or not ship_type:
            raise ValueError("ship_type must be a non-empty string")

        if character_id is None:
            character_id = self._character_id
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload: Dict[str, Any] = {
            "character_id": character_id,
            "ship_type": ship_type,
        }

        if purchase_type is not None:
            payload["purchase_type"] = purchase_type
        if ship_name is not None:
            payload["ship_name"] = ship_name
        if trade_in_ship_id is not None:
            payload["trade_in_ship_id"] = trade_in_ship_id
        if corp_id is not None:
            payload["corp_id"] = corp_id
        if initial_ship_credits is not None:
            payload["initial_ship_credits"] = int(initial_ship_credits)

        return await self._request("ship.purchase", payload)

    # DEPRECATED
    async def my_map(self, character_id: str) -> Dict[str, Any]:
        """Request cached map knowledge for the character.

        Args:
            character_id: Character to query (must match bound ID)

        Returns:
            Minimal RPC acknowledgment (map data arrives via ``map.knowledge``)

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        ack = await self._request("my_map", {"character_id": character_id})
        return ack

    async def local_map_region(
        self,
        character_id: str,
        center_sector: Optional[int] = None,
        max_hops: int = 3,
        max_sectors: int = 100,
        source: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Get all known sectors around current location for local navigation.

        Args:
            character_id: Character to query (must match bound ID)
            center_sector: Optional center sector; defaults to current sector
            max_hops: Maximum BFS depth (default 3, max 10)
            max_sectors: Maximum sectors to return (default 100)

        Returns:
            Minimal RPC acknowledgment (map data arrives via ``map.region``)

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload: Dict[str, Any] = {"character_id": character_id}
        if center_sector is not None:
            payload["center_sector"] = int(center_sector)
        payload["max_hops"] = int(max_hops)
        payload["max_sectors"] = int(max_sectors)
        if source is not None:
            payload["source"] = source

        ack = await self._request("local_map_region", payload)
        return ack

    async def list_known_ports(
        self,
        character_id: str,
        from_sector: Optional[int] = None,
        max_hops: int = 5,
        port_type: Optional[str] = None,
        commodity: Optional[str] = None,
        trade_type: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Find all known ports within travel range for trading/planning.

        Args:
            character_id: Character to query (must match bound ID)
            from_sector: Optional starting sector; defaults to current sector
            max_hops: Maximum distance (default 5, max 10)
            port_type: Optional filter by port code (e.g., "BBB")
            commodity: Optional filter ports that trade this commodity
            trade_type: Optional "buy" or "sell" (requires commodity)

        Returns:
            Minimal RPC acknowledgment (port data arrives via ``ports.list``)

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload: Dict[str, Any] = {"character_id": character_id}
        if from_sector is not None:
            payload["from_sector"] = int(from_sector)
        payload["max_hops"] = int(max_hops)
        if port_type is not None:
            payload["port_type"] = port_type
        if commodity is not None:
            payload["commodity"] = commodity
        if trade_type is not None:
            payload["trade_type"] = trade_type

        ack = await self._request("list_known_ports", payload)
        return ack

    async def path_with_region(
        self,
        to_sector: int,
        character_id: str,
        region_hops: int = 1,
        max_sectors: int = 200,
    ) -> Dict[str, Any]:
        """Get path plus local context around each node for route visualization.

        Args:
            to_sector: Destination sector
            character_id: Character to plot route for (must match bound ID)
            region_hops: How many hops around each path node (default 1)
            max_sectors: Total sector limit (default 200)

        Returns:
            Minimal RPC acknowledgment (region data arrives via ``path.region``)

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload: Dict[str, Any] = {
            "character_id": character_id,
            "to_sector": int(to_sector),
            "region_hops": int(region_hops),
            "max_sectors": int(max_sectors),
        }

        ack = await self._request("path_with_region", payload)
        return ack

    async def trade(
        self,
        commodity: str,
        quantity: int,
        trade_type: str,
        character_id: str,
    ) -> Dict[str, Any]:
        """Execute a trade transaction.

        Args:
            commodity: Commodity to trade (quantum_foam, retro_organics, neuro_symbolics)
            quantity: Amount to trade
            trade_type: "buy" or "sell"
            character_id: Character making the trade (must match bound ID)

        Returns:
            Minimal RPC acknowledgment (trade data arrives via ``trade.executed``)

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        ack = await self._request(
            "trade",
            {
                "character_id": character_id,
                "commodity": commodity,
                "quantity": quantity,
                "trade_type": trade_type,
            },
        )
        return ack

    async def purchase_fighters(
        self,
        *,
        units: int,
        character_id: str,
    ) -> Dict[str, Any]:
        """Purchase fighters at the sector 0 armory (50 credits each)."""

        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        if not isinstance(units, int) or units <= 0:
            raise ValueError("units must be a positive integer")

        payload = {"character_id": character_id, "units": units}
        return await self._request("purchase_fighters", payload)

    async def recharge_warp_power(
        self, units: int, character_id: str
    ) -> Dict[str, Any]:
        """Recharge warp power at the special depot in sector 0.

        Args:
            units: Number of warp power units to recharge
            character_id: Character recharging warp power (must match bound ID)

        Returns:
            Minimal RPC acknowledgment (warp updates arrive via ``warp.purchase``)

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        ack = await self._request(
            "recharge_warp_power", {"character_id": character_id, "units": units}
        )
        return ack

    async def transfer_warp_power(
        self,
        *,
        to_player_name: str,
        units: int,
        character_id: str,
    ) -> Dict[str, Any]:
        """Transfer warp power to another character in the same sector.

        Args:
            to_player_name: Display name of the recipient in the same sector
            units: Number of warp power units to transfer
            character_id: Character transferring warp power (must match bound ID)

        Returns:
            Minimal RPC acknowledgment (transfer data arrives via ``warp.transfer``)

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID or name missing
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        if not isinstance(to_player_name, str) or not to_player_name.strip():
            raise ValueError("to_player_name must be a non-empty string")

        payload = {
            "from_character_id": character_id,
            "units": units,
            "to_player_name": to_player_name,
        }

        ack = await self._request("transfer_warp_power", payload)
        return ack

    async def transfer_credits(
        self,
        *,
        to_player_name: str,
        amount: int,
        character_id: str,
    ) -> Dict[str, Any]:
        """Transfer on-hand credits to another character in the same sector.

        Args:
            to_player_name: Display name of the recipient in the same sector
            amount: Credits to transfer (must be positive)
            character_id: Sender's character ID

        Returns:
            Success response dict

        Raises:
            ValueError: If character_id doesn't match bound character
            HTTPException: If validation fails or characters not in same sector
        """

        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload = {
            "from_character_id": character_id,
            "to_player_name": to_player_name,
            "amount": amount,
        }
        return await self._request("transfer_credits", payload)

    async def deposit_to_bank(
        self,
        *,
        amount: int,
        target_player_name: str,
        ship_id: Optional[str] = None,
        character_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Deposit credits from a player's or corporation's ship into a bank account."""

        if not isinstance(target_player_name, str) or not target_player_name.strip():
            raise ValueError("target_player_name must be a non-empty string")

        payload: Dict[str, Any] = {
            "direction": "deposit",
            "amount": amount,
            "target_player_name": target_player_name,
        }

        if character_id is not None:
            if character_id != self._character_id:
                raise ValueError(
                    f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                    f"received {character_id!r}"
                )
            payload["character_id"] = character_id
        elif ship_id is None:
            # Default to the bound character when no ship is provided.
            payload["character_id"] = self._character_id

        if ship_id is not None:
            payload["ship_id"] = ship_id

        if ship_id is not None and "actor_character_id" not in payload:
            payload["actor_character_id"] = (
                self._actor_character_id or self._character_id
            )

        return await self._request("bank_transfer", payload)

    async def withdraw_from_bank(
        self,
        *,
        amount: int,
        character_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Withdraw credits from the bound character's bank account back onto their ship."""

        if character_id is None:
            character_id = self._character_id
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload = {
            "direction": "withdraw",
            "amount": amount,
            "character_id": character_id,
        }
        return await self._request("bank_transfer", payload)

    async def combat_initiate(
        self,
        *,
        character_id: str,
        target_id: Optional[str] = None,
        target_type: str = "character",
    ) -> Dict[str, Any]:
        """Initiate combat with a target.

        Args:
            character_id: Attacking character (must match bound ID)
            target_id: Target ID
            target_type: Type of target ("character", etc.)

        Returns:
            Combat session data

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload = {
            "character_id": character_id,
        }
        if target_id is not None:
            payload["target_id"] = target_id
            payload["target_type"] = target_type
        return await self._request("combat.initiate", payload)

    async def combat_action(
        self,
        *,
        combat_id: str,
        action: str,
        commit: int = 0,
        target_id: Optional[str] = None,
        to_sector: Optional[int] = None,
        character_id: str,
        round_number: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Submit a combat action.

        Args:
            combat_id: Combat session ID
            action: Action type
            commit: Commitment value
            target_id: Target ID for action
            to_sector: Destination sector for flee
            character_id: Acting character (must match bound ID)
            round_number: Round number

        Returns:
            Action result

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload: Dict[str, Any] = {
            "combat_id": combat_id,
            "character_id": character_id,
            "action": action,
        }
        if commit:
            payload["commit"] = commit
        if target_id is not None:
            payload["target_id"] = target_id
        if to_sector is not None:
            payload["to_sector"] = to_sector
        if round_number is not None:
            payload["round"] = round_number
        return await self._request("combat.action", payload)

    async def combat_leave_fighters(
        self,
        *,
        sector: int,
        quantity: int,
        mode: str = "offensive",
        toll_amount: int = 0,
        character_id: str,
    ) -> Dict[str, Any]:
        """Deploy fighters to a sector.

        Args:
            sector: Sector to leave fighters in
            quantity: Number of fighters
            mode: "offensive", "defensive", or "toll"
            toll_amount: Credits for toll mode
            character_id: Character leaving fighters (must match bound ID)

        Returns:
            Deployment confirmation

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload = {
            "character_id": character_id,
            "sector": sector,
            "quantity": quantity,
            "mode": mode,
            "toll_amount": toll_amount,
        }
        return await self._request("combat.leave_fighters", payload)

    async def combat_collect_fighters(
        self,
        *,
        sector: int,
        quantity: int,
        character_id: str,
    ) -> Dict[str, Any]:
        """Retrieve deployed fighters.

        Args:
            sector: Sector to collect fighters from
            quantity: Number of fighters to collect
            character_id: Character collecting fighters (must match bound ID)

        Returns:
            Collection result

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload = {
            "character_id": character_id,
            "sector": sector,
            "quantity": quantity,
        }
        return await self._request("combat.collect_fighters", payload)

    async def combat_set_garrison_mode(
        self,
        *,
        sector: int,
        mode: str,
        toll_amount: int = 0,
        character_id: str,
    ) -> Dict[str, Any]:
        """Change garrison behavior mode.

        Args:
            sector: Sector with garrison
            mode: "offensive", "defensive", or "toll"
            toll_amount: Credits for toll mode
            character_id: Garrison owner (must match bound ID)

        Returns:
            Updated garrison state

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload = {
            "character_id": character_id,
            "sector": sector,
            "mode": mode,
            "toll_amount": toll_amount,
        }
        return await self._request("combat.set_garrison_mode", payload)

    async def salvage_collect(
        self,
        *,
        salvage_id: str,
        character_id: str,
    ) -> Dict[str, Any]:
        """Collect salvage from destroyed ships.

        Args:
            salvage_id: Salvage item ID
            character_id: Character collecting (must match bound ID)

        Returns:
            Collected items

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload = {
            "character_id": character_id,
            "salvage_id": salvage_id,
        }
        return await self._request("salvage.collect", payload)

    async def dump_cargo(
        self,
        *,
        items: list[dict],
        character_id: str,
    ) -> Dict[str, Any]:
        """Dump cargo from the ship, creating a salvage container."""

        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload = {
            "character_id": character_id,
            "items": items,
        }
        return await self._request("dump_cargo", payload)

    async def send_message(
        self,
        content: str,
        msg_type: str = "broadcast",
        to_name: Optional[str] = None,
        character_id: str = None,
    ) -> Dict[str, Any]:
        """Send a chat message via WebSocket server.

        Args:
            content: Message text (<=512 chars)
            msg_type: "broadcast" or "direct"
            to_name: Required if msg_type == "direct"
            character_id: Sender (must match bound ID)

        Returns:
            Minimal RPC acknowledgment (chat payloads arrive via ``chat.message``)

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id is None:
            character_id = self._character_id
        elif character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload = {"character_id": character_id, "type": msg_type, "content": content}
        if msg_type == "direct":
            if not to_name:
                raise ValueError("to_name is required for direct messages")
            payload["to_name"] = to_name
        ack = await self._request("send_message", payload)
        return ack

    async def subscribe_chat(self):
        """Deprecated: Server auto-subscribes to chat."""
        logger.debug("subscribe_chat is deprecated; skipping explicit subscribe")

    async def subscribe_my_messages(
        self,
        handler: Optional[Callable[[Dict[str, Any]], Awaitable[None] | None]] = None,
    ) -> None:
        """Ensure chat.message events are subscribed and optionally register a handler."""

        if handler is not None:

            async def _dispatch(event: Dict[str, Any]) -> None:
                payload = (
                    event.get("payload")
                    if isinstance(event, dict) and "payload" in event
                    else event
                )
                try:
                    result = handler(payload)
                    if inspect.isawaitable(result):
                        await result
                except Exception:  # noqa: BLE001
                    logger.exception("Unhandled error in chat.message handler")

            self.on("chat.message")(_dispatch)

        await self.subscribe_chat()

    async def subscribe_my_status(self, character_id: str):
        """Deprecated: Server auto-subscribes to status updates."""
        logger.debug("subscribe_my_status is deprecated; skipping explicit subscribe")

    async def identify(
        self, *, name: Optional[str] = None, character_id: Optional[str] = None
    ):
        """Register identity for receiving direct messages.

        One of name or character_id must be provided.

        Args:
            name: Character name
            character_id: Character ID (must match bound ID if provided)

        Raises:
            ValueError: If neither name nor character_id provided, or if ID doesn't match
        """
        if character_id is not None and character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        if character_id is None and name is None:
            # Default to bound character
            character_id = self._character_id

        if name is None and character_id is None:
            raise ValueError("No name or character specified for identify()")

        frame: Dict[str, Any] = {"type": "identify"}
        if name is not None:
            frame["name"] = name
        if character_id is not None:
            frame["character_id"] = character_id
        await self._send_command(frame)
