"""Game server API client for Gradient Bang."""

from typing import List, Optional, Dict, Any, Callable, Awaitable, Tuple
import logging
import asyncio
import json
import uuid
import inspect
import websockets
from copy import deepcopy
from .port_helpers import (
    sells_commodity,
    buys_commodity,
    list_sells,
    list_buys,
    last_seen_price,
)


logger = logging.getLogger(__name__)


class LLMResult(dict):
    """Dictionary-like result enriched with LLM-specific metadata."""

    def __init__(
        self,
        data: Dict[str, Any],
        summary: Optional[str] = None,
        delta: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(data)
        self.llm_summary: str = summary or ""
        self.llm_delta: Dict[str, Any] = deepcopy(delta) if delta is not None else {}


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
    ):
        """Initialize the async game client.

        Args:
            base_url: Base URL of the game server
            character_id: Character ID this client will operate on
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
        self._subscriptions: set[str] = set()
        self._auto_subscribe_my_status_on_join: bool = False

        # Map cache: character_id -> {map_data, last_fetched}
        self._map_cache: Dict[str, Dict[str, Any]] = {}
        self._character_id: str = character_id
        self._current_character: Optional[str] = character_id
        self._current_sector: Optional[int] = None
        self._ship_status: Optional[Dict[str, Any]] = None
        self._status_cache: Dict[str, Dict[str, Any]] = {}

        # Locks for thread-safe operations
        self._cache_lock = asyncio.Lock()
        self._status_lock = asyncio.Lock()

    def _resolve_character_id(self, character_id: Optional[str]) -> str:
        """Return the bound character ID, validating overrides."""
        if character_id is None:
            return self._character_id
        if character_id != self._character_id:
            raise ValueError(
                "AsyncGameClient is bound to character_id "
                f"{self._character_id!r}; received {character_id!r}"
            )
        return character_id

    @property
    def current_sector(self) -> Optional[int]:
        """Get the current sector of the tracked character."""
        return self._current_sector

    @property
    def current_character(self) -> Optional[str]:
        """Get the currently tracked character ID."""
        return self._current_character

    @property
    def ship_status(self) -> Optional[Dict[str, Any]]:
        """Get the current ship status."""
        return self._ship_status

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

    def _auto_subscribe_for_event(self, event_name: str) -> None:
        """Ensure required subscriptions are active for certain events."""

        if event_name != "status.update":
            return

        # Server now auto-filters events; no client-side subscribe needed.
        return

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
        self._auto_subscribe_for_event(event_name)
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
        """Wait for an event matching an optional predicate and return its payload."""

        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        token: Optional[Tuple[str, Callable[[Dict[str, Any]], Awaitable[None]]]] = None

        async def _handler(payload: Dict[str, Any]) -> None:
            nonlocal token
            try:
                if predicate and not predicate(payload):
                    return
                if not future.done():
                    future.set_result(payload)
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
                frame_type = msg.get("frame_type")
                if frame_type == "event":
                    event_name = msg.get("event")
                    payload = msg.get("payload", {})
                    if event_name:
                        asyncio.create_task(self._dispatch_event(event_name, payload))
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

    async def _dispatch_event(self, event_name: str, payload: Dict[str, Any]) -> None:
        if event_name == "status.update":
            await self._handle_status_event(payload)
        handlers = self._event_handlers.get(event_name, [])
        for handler in handlers:
            asyncio.create_task(handler(payload))

    async def _handle_status_event(self, payload: Dict[str, Any]) -> None:
        character_id = payload.get("character_id")
        if not character_id:
            return
        async with self._status_lock:
            if self._current_character == character_id:
                if "sector" in payload:
                    self._current_sector = payload.get("sector")
                if "ship" in payload:
                    self._ship_status = payload.get("ship")
            self._status_cache[character_id] = payload
        try:
            await self._update_map_cache_from_status(character_id, payload)
        except Exception:
            logger.exception("Failed to update map cache from status event")

    # ------------------------------------------------------------------
    # Diff / summarization helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _deep_diff(before: Any, after: Any) -> Any:
        if before is None:
            return after
        if after is None:
            return None if before is None else after
        if isinstance(before, dict) and isinstance(after, dict):
            diff: Dict[str, Any] = {}
            for key, after_value in after.items():
                before_value = before.get(key)
                if isinstance(after_value, dict) and isinstance(before_value, dict):
                    sub = AsyncGameClient._deep_diff(before_value, after_value)
                    if sub:
                        diff[key] = sub
                elif isinstance(after_value, list) and isinstance(before_value, list):
                    if after_value != before_value:
                        diff[key] = after_value
                else:
                    if after_value != before_value:
                        diff[key] = after_value
            for key in set(after.keys()) - set(before.keys()):
                diff[key] = after[key]
            return diff
        if isinstance(before, list) and isinstance(after, list):
            return after if after != before else []
        return after if before != after else None

    def _summarize_status(
        self,
        endpoint: str,
        character_id: str,
        before: Optional[Dict[str, Any]],
        after: Dict[str, Any],
        delta: Dict[str, Any],
    ) -> str:
        lines: List[str] = []
        after_sector = after.get("sector")
        before_sector = before.get("sector") if before else None

        if before_sector is None:
            if after_sector is not None:
                lines.append(f"Status initialized in sector {after_sector}.")
        else:
            if after_sector is not None and after_sector != before_sector:
                lines.append(f"Moved from sector {before_sector} to {after_sector}.")
            elif after_sector is not None:
                lines.append(f"Status refreshed in sector {after_sector}.")

        ship_before = before.get("ship") if before else None
        ship_after = after.get("ship")
        if ship_before and ship_after:
            wp_before = ship_before.get("warp_power")
            wp_after = ship_after.get("warp_power")
            if wp_before != wp_after:
                lines.append(f"Warp power {wp_before} → {wp_after}.")
            credits_before = ship_before.get("credits")
            credits_after = ship_after.get("credits")
            if credits_before != credits_after:
                lines.append(f"Credits {credits_before} → {credits_after}.")

        if "sector_contents" in delta:
            adjacent_sectors = delta.get("sector_contents").get("adjacent_sectors")
            if adjacent_sectors:
                lines.append(
                    f"Adjacent sectors: {', '.join(map(str, adjacent_sectors))}."
                )
            port = delta.get("sector_contents").get("port")
            if port:
                lines.append(f"Port {port.get('code')}.")

        return " ".join(lines)

    def _wrap_status_result(
        self,
        endpoint: str,
        character_id: str,
        result: Dict[str, Any],
        *,
        previous: Optional[Dict[str, Any]] = None,
    ) -> LLMResult:
        before = (
            deepcopy(previous)
            if previous is not None
            else deepcopy(self._status_cache.get(character_id))
        )
        delta = self._deep_diff(before or {}, result) if before else result
        if isinstance(delta, dict):
            delta = {k: v for k, v in delta.items() if v not in (None, {}, [])}
        summary = self._summarize_status(
            endpoint,
            character_id,
            before,
            result,
            delta if isinstance(delta, dict) else {},
        )
        self._status_cache[character_id] = deepcopy(result)
        if self._current_character == character_id:
            self._current_sector = result.get("sector")
            self._ship_status = result.get("ship")
        return LLMResult(result, summary, delta if isinstance(delta, dict) else result)

    def _wrap_map_result(
        self,
        character_id: str,
        result: Dict[str, Any],
        *,
        previous: Optional[Dict[str, Any]] = None,
    ) -> LLMResult:
        before = previous or self._map_cache.get(character_id)
        after_sectors = result.get("sectors_visited", {})
        added: List[str] = []
        updated: List[str] = []
        if before:
            before_sectors = before.get("sectors_visited", {})
            added = sorted(set(after_sectors.keys()) - set(before_sectors.keys()))
            updated = sorted(
                sid
                for sid in set(after_sectors.keys()) & set(before_sectors.keys())
                if before_sectors[sid] != after_sectors[sid]
            )
        total_known = len(after_sectors)
        delta = {
            "sector": result.get("sector"),
            "total_known": total_known,
        }
        if added:
            delta["added_sectors"] = added
        if updated:
            delta["updated_sectors"] = updated
        port_highlights = []
        for sid, info in sorted(after_sectors.items()):
            if not isinstance(info, dict):
                continue
            port_info = info.get("port_info") or info.get("port")
            if isinstance(port_info, dict) and port_info.get("code"):
                port_highlights.append(f"{port_info['code']}@{sid}")

        if not before:
            summary = ""
            result_llm = LLMResult(result)
        else:
            summary_bits = [
                f"Map centers on sector {result.get('sector')}.",
                f"Known sectors: {total_known}.",
            ]
            if added:
                summary_bits.append(
                    f"Added {len(added)} sector(s): {', '.join(added[:8])}{'…' if len(added) > 8 else ''}."
                )
            if updated:
                summary_bits.append(f"Updated intel for {len(updated)} sector(s).")
            if port_highlights:
                summary_bits.append(
                    "Known ports: "
                    + ", ".join(port_highlights[:5])
                    + ("…" if len(port_highlights) > 5 else ".")
                )
            if not added and not updated:
                summary_bits.append("No new map intel.")
            summary = " ".join(summary_bits)
            result_llm = LLMResult(result, summary, delta)

        self._map_cache[character_id] = deepcopy(result)
        return result_llm

    @staticmethod
    def _format_list(items: List[Any]) -> str:
        return ", ".join(str(item) for item in items)

    def _wrap_trade_result(
        self,
        character_id: str,
        result: Dict[str, Any],
    ) -> LLMResult:
        before_status = deepcopy(self._status_cache.get(character_id))
        ship_before = before_status.get("ship") if before_status else None
        credits_before = ship_before.get("credits") if ship_before else None
        cargo_before = ship_before.get("cargo") if ship_before else {}
        credits_after = result.get("new_credits")
        cargo_after = result.get("new_cargo", {})
        cargo_delta: Dict[str, Dict[str, Any]] = {}
        for commodity, new_qty in cargo_after.items():
            old_qty = cargo_before.get(commodity) if cargo_before else None
            if old_qty != new_qty:
                cargo_delta[commodity] = {"old": old_qty, "new": new_qty}
        delta = {
            "success": result.get("success", False),
            "trade_type": result.get("trade_type"),
            "commodity": result.get("commodity"),
            "units": result.get("units"),
            "price_per_unit": result.get("price_per_unit"),
            "total_price": result.get("total_price"),
        }
        if credits_before is not None and credits_after is not None:
            delta["credits"] = {"old": credits_before, "new": credits_after}
        if cargo_delta:
            delta["cargo"] = cargo_delta
        summary_bits = []
        action = result.get("trade_type", "trade")
        commodity = result.get("commodity")
        units = result.get("units")
        total_price = result.get("total_price")
        if result.get("success"):
            summary_bits.append(
                f"{action.title()}ed {units} {commodity} for {total_price} credits."
            )
        else:
            summary_bits.append(
                f"Trade failed: {result.get('message', 'unspecified reason')}."
            )
        if credits_before is not None and credits_after is not None:
            summary_bits.append(f"Credits {credits_before} → {credits_after}.")
        if cargo_delta:
            cargo_changes = [
                f"{k}: {v['old']} → {v['new']}" for k, v in cargo_delta.items()
            ]
            summary_bits.append("Cargo " + self._format_list(cargo_changes) + ".")
        summary = " ".join(summary_bits)

        if before_status and ship_before:
            updated_status = deepcopy(before_status)
            updated_status.setdefault("ship", {})
            updated_status["ship"]["credits"] = credits_after
            updated_status["ship"]["cargo"] = cargo_after
            self._status_cache[character_id] = updated_status
            if self._current_character == character_id:
                self._ship_status = updated_status.get("ship")

        return LLMResult(result, summary, delta)

    def _wrap_recharge_result(
        self,
        character_id: str,
        result: Dict[str, Any],
    ) -> LLMResult:
        before_status = deepcopy(self._status_cache.get(character_id))
        ship_before = before_status.get("ship") if before_status else None
        warp_before = ship_before.get("warp_power") if ship_before else None
        credits_before = ship_before.get("credits") if ship_before else None
        warp_after = result.get("new_warp_power")
        credits_after = result.get("new_credits")
        delta = {
            "success": result.get("success", False),
            "units_bought": result.get("units_bought"),
            "price_per_unit": result.get("price_per_unit"),
            "total_cost": result.get("total_cost"),
        }
        if warp_before is not None and warp_after is not None:
            delta["warp_power"] = {"old": warp_before, "new": warp_after}
        if credits_before is not None and credits_after is not None:
            delta["credits"] = {"old": credits_before, "new": credits_after}
        if result.get("success"):
            summary_parts = [
                f"Purchased {result.get('units_bought')} warp power for {result.get('total_cost')} credits."
            ]
        else:
            summary_parts = [
                f"Failed to recharge warp power: {result.get('message', 'unknown reason')}"
            ]
        if warp_before is not None and warp_after is not None:
            summary_parts.append(f"Warp {warp_before} → {warp_after}.")
        if credits_before is not None and credits_after is not None:
            summary_parts.append(f"Credits {credits_before} → {credits_after}.")
        summary = " ".join(summary_parts)

        if before_status and ship_before:
            updated_status = deepcopy(before_status)
            updated_status.setdefault("ship", {})
            if warp_after is not None:
                updated_status["ship"]["warp_power"] = warp_after
            if credits_after is not None:
                updated_status["ship"]["credits"] = credits_after
            self._status_cache[character_id] = updated_status
            if self._current_character == character_id:
                self._ship_status = updated_status.get("ship")

        return LLMResult(result, summary, delta)

    def _wrap_transfer_result(self, result: Dict[str, Any]) -> LLMResult:
        from_id = result.get("from_character") or result.get("from_character_id")
        to_id = result.get("to_character") or result.get("to_character_id")
        units = result.get("units_transferred") or result.get("units")
        delta = {
            "units_transferred": units,
            "sector": result.get("sector"),
            "from_warp_power_remaining": result.get("from_warp_power_remaining"),
            "to_warp_power_current": result.get("to_warp_power_current"),
        }
        summary_parts = [f"Transferred {units} warp power from {from_id} to {to_id}."]
        if result.get("from_warp_power_remaining") is not None:
            summary_parts.append(
                f"Sender now has {result['from_warp_power_remaining']} warp power."
            )
        if result.get("to_warp_power_current") is not None:
            summary_parts.append(
                f"Recipient now has {result['to_warp_power_current']} warp power."
            )
        summary = " ".join(summary_parts)

        return LLMResult(result, summary, delta)

    async def join(
        self, character_id: str, ship_type: Optional[str] = None
    ) -> Dict[str, Any]:
        """Join the game with a character.

        Args:
            character_id: Unique identifier for the character
            ship_type: Optional ship type to start with (defaults to Kestrel Courier)

        Returns:
            Character status after joining

        Raises:
            RPCError: If the request fails
        """
        character_id = self._resolve_character_id(character_id)
        payload = {"character_id": character_id}
        if ship_type:
            payload["ship_type"] = ship_type

        before = deepcopy(self._status_cache.get(character_id))
        status = await self._request("join", payload)
        wrapped = self._wrap_status_result(
            "join", character_id, status, previous=before
        )

        async with self._status_lock:
            self._current_character = character_id
            self._current_sector = status.get("sector")
            self._ship_status = status.get("ship")

        self._auto_subscribe_my_status_on_join = False

        return wrapped

    async def move(
        self, to_sector: int, character_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Move a character to an adjacent sector.

        Args:
            to_sector: Destination sector (must be adjacent)
            character_id: Character to move (defaults to current character)

        Returns:
            Character status after move

        Raises:
            RPCError: If the request fails (e.g., non-adjacent sector)
        """
        character_id = self._resolve_character_id(character_id)

        # Ensure we have map data before moving
        await self._ensure_map_cached(character_id)

        before = deepcopy(self._status_cache.get(character_id))
        status = await self._request(
            "move", {"character_id": character_id, "to_sector": to_sector}
        )
        wrapped = self._wrap_status_result(
            "move", character_id, status, previous=before
        )

        async with self._status_lock:
            if character_id == self._current_character:
                self._current_sector = status.get("sector")
            self._ship_status = status.get("ship")

        await self._update_map_cache_from_status(character_id, status)

        return wrapped

    async def my_status(
        self, character_id: Optional[str] = None, force_refresh: bool = False
    ) -> Dict[str, Any]:
        """Get current status of a character.

        Args:
            character_id: Character to query (defaults to current character)
            force_refresh: If True, bypass cache and fetch fresh data

        Returns:
            Current character status

        Raises:
            RPCError: If the request fails
        """
        character_id = self._resolve_character_id(character_id)

        # Ensure we have map data
        if not force_refresh:
            await self._ensure_map_cached(character_id)

        before = deepcopy(self._status_cache.get(character_id))
        status = await self._request("my_status", {"character_id": character_id})
        wrapped = self._wrap_status_result(
            "my_status", character_id, status, previous=before
        )

        await self._update_map_cache_from_status(character_id, status)

        return wrapped

    async def plot_course(self, from_sector: int, to_sector: int) -> Dict[str, Any]:
        """Plot a course between two sectors.

        Args:
            from_sector: Starting sector
            to_sector: Destination sector

        Returns:
            Course information including path and distance

        Raises:
            RPCError: If the request fails
        """
        result = await self._request(
            "plot_course", {"from_sector": from_sector, "to_sector": to_sector}
        )
        path = result.get("path", []) or []
        distance = result.get("distance")
        summary_parts = [f"Course {from_sector} → {to_sector}"]
        if distance is not None:
            summary_parts.append(f"({distance} hop{'s' if distance != 1 else ''})")
        if path:
            summary_parts.append(
                "Path: " + " → ".join(str(node) for node in path) + "."
            )
        summary = " ".join(summary_parts)
        delta = {
            "from_sector": from_sector,
            "to_sector": to_sector,
            "distance": distance,
            "path": path,
        }
        return LLMResult(result, summary, delta)

    async def server_status(self) -> Dict[str, Any]:
        """Get server status information.

        Returns:
            Server status including name, version, and sector count

        Raises:
            RPCError: If the request fails
        """
        result = await self._request("server_status", {})
        summary = (
            f"Server {result.get('name')} {result.get('status')} (v{result.get('version')}, "
            f"sectors: {result.get('sectors')})."
        )
        return LLMResult(result, summary, result)

    async def my_map(
        self, character_id: Optional[str] = None, force_refresh: bool = False
    ) -> Dict[str, Any]:
        """Get the map knowledge for a character.

        Args:
            character_id: Character to query (defaults to current character)
            force_refresh: If True, force a fresh fetch from the server

        Returns:
            Map knowledge including visited sectors and discovered ports

        Raises:
            RPCError: If the request fails
        """
        character_id = self._resolve_character_id(character_id)

        async with self._cache_lock:
            previous_map = deepcopy(self._map_cache.get(character_id))

            if force_refresh or character_id not in self._map_cache:
                fetched = await self._request("my_map", {"character_id": character_id})
                map_data = deepcopy(fetched)
            else:
                map_data = deepcopy(self._map_cache.get(character_id, {}))
            if (
                self._current_character == character_id
                and self._current_sector is not None
            ):
                map_data["sector"] = self._current_sector
            wrapped = self._wrap_map_result(
                character_id, map_data, previous=previous_map
            )
            self._map_cache[character_id] = deepcopy(map_data)
            return wrapped

    async def local_map(
        self,
        max_hops: Optional[int] = None,
        current_sector: Optional[int] = None,
        character_id: Optional[str] = None,
        max_sectors: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Get a local view of the player's known graph.

        Args:
            max_hops: Number of rings to include around the center (legacy mode)
            current_sector: Optional explicit center; defaults to tracked sector
            character_id: Character to query (defaults to current character)
            max_sectors: Optional node cap (takes precedence over `max_hops`)
        """
        character_id = self._resolve_character_id(character_id)

        if current_sector is None:
            current_sector = self._current_sector

        payload: Dict[str, Any] = {
            "character_id": character_id,
        }
        if current_sector is not None:
            payload["current_sector"] = int(current_sector)

        limit_summary: str
        if max_sectors is not None:
            payload["max_sectors"] = int(max_sectors)
            limit_summary = f"max {int(max_sectors)} sector(s)"
        else:
            hops_value = 3 if max_hops is None else int(max_hops)
            payload["max_hops"] = hops_value
            limit_summary = f"{hops_value} hop(s)"

        result = await self._request("local_map", payload)
        node_list = result.get("node_list", [])
        summary = (
            f"Local map around sector {payload.get('current_sector', current_sector)} "
            f"with {len(node_list)} node(s) ({limit_summary})."
        )
        delta = {
            "nodes": len(node_list),
            "max_sectors": payload.get("max_sectors"),
            "max_hops": payload.get("max_hops"),
        }
        if node_list:
            delta["sample_nodes"] = node_list[: min(3, len(node_list))]
        return LLMResult(result, summary, delta)

    async def _ensure_map_cached(self, character_id: str):
        """Ensure map data is cached for a character.

        Args:
            character_id: Character to ensure map data for
        """
        if character_id not in self._map_cache:
            await self._fetch_and_cache_map(character_id)

    async def _fetch_and_cache_map(self, character_id: str):
        """Fetch and cache map data from the server.

        Args:
            character_id: Character to fetch map data for
        """
        result = await self._request("my_map", {"character_id": character_id})
        self._map_cache[character_id] = deepcopy(result)

    async def _update_map_cache_from_status(
        self, character_id: str, status: Dict[str, Any]
    ):
        """Update the map cache with information from a status response.

        Args:
            character_id: Character whose map to update
            status: Status response containing sector information
        """
        async with self._cache_lock:
            # If we haven't fetched the map yet, defer until a tool explicitly
            # requests it so we don't leak map intel ahead of time.
            if character_id not in self._map_cache:
                return

            # Update the cached map with new sector information
            map_data = self._map_cache[character_id]
            # Keep top-level sector in sync with status
            try:
                map_data["sector"] = status.get("sector", map_data.get("sector"))
            except Exception:
                pass
            sectors_visited = map_data.setdefault("sectors_visited", {})

            # Prefer numeric string keys to match server shape (e.g., "15")
            numeric_key = str(status["sector"])  # e.g., "15"
            legacy_key = f"sector_{status['sector']}"  # old client-side key

            # Migrate legacy key to numeric if present
            if legacy_key in sectors_visited and numeric_key not in sectors_visited:
                sectors_visited[numeric_key] = sectors_visited.pop(legacy_key)

            sector_info = sectors_visited.setdefault(numeric_key, {})

            # Update sector information
            sector_info["sector_id"] = status["sector"]
            sector_info["last_visited"] = status["last_active"]
            sector_contents = status.get("sector_contents", {})
            sector_info["adjacent_sectors"] = sector_contents.get(
                "adjacent_sectors", []
            )

            # Update port information if present
            # Pass through the server's minimal snapshot unchanged
            port = sector_contents.get("port")
            if port:
                sector_info["port_info"] = port

            # Update planet information if present
            planets = sector_contents.get("planets", [])
            if planets:
                sector_info["planets"] = [
                    {
                        "id": planet.get("id"),
                        "class_code": planet.get("class_code"),
                        "class_name": planet.get("class_name"),
                    }
                    for planet in planets
                ]

    async def find_nearest_known_port(
        self, from_sector: int
    ) -> Optional[Dict[str, Any]]:
        """Find the nearest known port of any type from a given sector.

        This is CLIENT-SIDE logic that analyzes the character's map knowledge.

        Args:
            from_sector: Sector to search from

        Returns:
            Port information with distance and path, or None if not found

        Raises:
            ValueError: If from_sector has not been visited
        """
        # Ensure we have map data for current character
        if not self._current_character:
            raise ValueError("No character currently tracked")

        await self._ensure_map_cached(self._current_character)
        map_knowledge = self._map_cache.get(self._current_character, {})
        sectors_visited = map_knowledge.get("sectors_visited", {})

        # Check if from_sector has been visited (support numeric and legacy keys)
        if (
            str(from_sector) not in sectors_visited
            and f"sector_{from_sector}" not in sectors_visited
        ):
            raise ValueError(f"Sector {from_sector} has not been visited")

        # Find all ports
        all_ports = []
        for sector_key, sector_info in sectors_visited.items():
            port_info = sector_info.get("port_info")
            if port_info:
                all_ports.append(
                    {
                        "sector": sector_info["sector_id"],
                        "port": port_info,
                        "last_visited": sector_info.get("last_visited"),
                    }
                )

        if not all_ports:
            return None

        # Find the nearest port using pathfinding
        nearest = None
        min_distance = float("inf")

        for port_data in all_ports:
            try:
                course = await self.plot_course(from_sector, port_data["sector"])
                distance = course.get("distance")
                if distance is None:
                    continue
                if distance < min_distance:
                    min_distance = distance
                    nearest = {
                        "sector": port_data["sector"],
                        "distance": distance,
                        "path": course.get("path"),
                        "port": port_data["port"],
                        "last_visited": port_data["last_visited"],
                    }
            except RPCError as e:
                logger.warning(
                    "RPC error while plotting course from %s to %s: %s",
                    from_sector,
                    port_data["sector"],
                    e,
                )
                continue
            except ValueError as e:
                logger.warning(
                    "Value error while plotting course from %s to %s: %s",
                    from_sector,
                    port_data["sector"],
                    e,
                )
                continue
            except Exception:
                logger.exception(
                    "Unexpected error while plotting course from %s to %s",
                    from_sector,
                    port_data["sector"],
                )
                raise

        return nearest

    async def find_nearest_known_port_with_commodity(
        self, from_sector: int, commodity: str, buy_or_sell: str
    ) -> Optional[Dict[str, Any]]:
        """Find the nearest known port that buys or sells a specific commodity.

        This is CLIENT-SIDE logic that analyzes the character's map knowledge.

        Args:
            from_sector: Sector to search from
            commodity: Commodity to search for (must be exact: 'fuel_ore', 'organics', or 'equipment')
            buy_or_sell: Whether to find a port that 'buy's or 'sell's the commodity

        Returns:
            Port information with distance and path, or None if not found

        Raises:
            ValueError: If from_sector has not been visited
        """
        # Ensure we have map data for current character
        if not self._current_character:
            raise ValueError("No character currently tracked")

        await self._ensure_map_cached(self._current_character)
        map_knowledge = self._map_cache.get(self._current_character, {})
        sectors_visited = map_knowledge.get("sectors_visited", {})

        # Check if from_sector has been visited (support numeric and legacy keys)
        if (
            str(from_sector) not in sectors_visited
            and f"sector_{from_sector}" not in sectors_visited
        ):
            raise ValueError(f"Sector {from_sector} has not been visited")

        # Find all ports that match the criteria
        matching_ports = []
        for sector_key, sector_info in sectors_visited.items():
            port_info = sector_info.get("port_info")
            if port_info:
                # Check if port has the commodity using code-derived helpers
                if buy_or_sell == "sell" and sells_commodity(port_info, commodity):
                    matching_ports.append(
                        {
                            "sector": sector_info["sector_id"],
                            "port": port_info,
                            "last_visited": sector_info.get("last_visited"),
                        }
                    )
                elif buy_or_sell == "buy" and buys_commodity(port_info, commodity):
                    matching_ports.append(
                        {
                            "sector": sector_info["sector_id"],
                            "port": port_info,
                            "last_visited": sector_info.get("last_visited"),
                        }
                    )

        if not matching_ports:
            return None

        # Find the closest port using plot_course
        closest = None
        min_distance = float("inf")

        for port_data in matching_ports:
            try:
                course = await self.plot_course(from_sector, port_data["sector"])
                distance = course.get("distance")
                if distance is None:
                    continue
                if distance < min_distance:
                    min_distance = distance
                    closest = {
                        **port_data,
                        "distance": distance,
                        "path": course.get("path"),
                    }
            except RPCError as e:
                logger.warning(
                    "RPC error while plotting course from %s to %s: %s",
                    from_sector,
                    port_data["sector"],
                    e,
                )
                continue
            except ValueError as e:
                logger.warning(
                    "Value error while plotting course from %s to %s: %s",
                    from_sector,
                    port_data["sector"],
                    e,
                )
                continue
            except Exception:
                logger.exception(
                    "Unexpected error while plotting course from %s to %s",
                    from_sector,
                    port_data["sector"],
                )
                raise

        return closest

    async def get_adjacent_port_pairs(self, character_id: str) -> List[Dict[str, Any]]:
        """Find all known pairs of ports in adjacent sectors.

        This is CLIENT-SIDE logic that analyzes the character's map knowledge.

        Args:
            character_id: Character making the query

        Returns:
            List of adjacent port pairs
        """
        character_id = self._resolve_character_id(character_id)
        # Ensure we have map data
        await self._ensure_map_cached(character_id)

        map_knowledge = self._map_cache.get(character_id, {})
        sectors_visited = map_knowledge.get("sectors_visited", {})

        port_pairs = []

        # Get all sectors with ports
        port_sectors = {}
        for sector_key, sector_info in sectors_visited.items():
            if sector_info.get("port_info"):
                sector_id = sector_info["sector_id"]
                port_sectors[sector_id] = sector_info

        # Check for adjacent pairs
        for sector_id, sector_info in port_sectors.items():
            adjacent = sector_info.get("adjacent_sectors", [])
            for adj_sector in adjacent:
                if (
                    adj_sector in port_sectors and adj_sector > sector_id
                ):  # Avoid duplicates
                    pair = {
                        "sector1": sector_id,
                        "port1": sector_info["port_info"],
                        "sector2": adj_sector,
                        "port2": port_sectors[adj_sector]["port_info"],
                    }
                    port_pairs.append(pair)

        return port_pairs

    async def check_trade(
        self,
        commodity: str,
        quantity: int,
        trade_type: str,
        character_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Preview a trade transaction without executing it.

        Args:
            commodity: Commodity to trade (fuel_ore, organics, equipment)
            quantity: Amount to trade
            trade_type: "buy" or "sell"
            character_id: Character making the trade (defaults to current character)

        Returns:
            Trade preview including prices and validation

        Raises:
            RPCError: If the request fails
        """
        character_id = self._resolve_character_id(character_id)

        result = await self._request(
            "check_trade",
            {
                "character_id": character_id,
                "commodity": commodity,
                "quantity": quantity,
                "trade_type": trade_type,
            },
        )
        can_trade = result.get("can_trade")
        if can_trade:
            summary = (
                f"Can {trade_type} {quantity} {commodity} "
                f"for {result.get('total_price')} credits (unit {result.get('price_per_unit')})."
            )
        else:
            summary = (
                f"Cannot {trade_type} {quantity} {commodity}: "
                f"{result.get('error', 'unknown reason')}."
            )
        delta = {
            "can_trade": can_trade,
            "price_per_unit": result.get("price_per_unit"),
            "total_price": result.get("total_price"),
            "error": result.get("error"),
        }
        return LLMResult(result, summary, delta)

    async def trade(
        self,
        commodity: str,
        quantity: int,
        trade_type: str,
        character_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Execute a trade transaction.

        Args:
            commodity: Commodity to trade (fuel_ore, organics, equipment)
            quantity: Amount to trade
            trade_type: "buy" or "sell"
            character_id: Character making the trade (defaults to current character)

        Returns:
            Trade result including new credits and cargo

        Raises:
            RPCError: If the request fails
        """
        character_id = self._resolve_character_id(character_id)

        result = await self._request(
            "trade",
            {
                "character_id": character_id,
                "commodity": commodity,
                "quantity": quantity,
                "trade_type": trade_type,
            },
        )

        return self._wrap_trade_result(character_id, result)

    async def recharge_warp_power(
        self, units: int, character_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Recharge warp power at the special depot in sector 0.

        Args:
            units: Number of warp power units to recharge
            character_id: Character recharging warp power (defaults to current character)

        Returns:
            Transaction result

        Raises:
            RPCError: If the request fails
        """
        character_id = self._resolve_character_id(character_id)

        result = await self._request(
            "recharge_warp_power", {"character_id": character_id, "units": units}
        )
        return self._wrap_recharge_result(character_id, result)

    async def transfer_warp_power(
        self, to_character_id: str, units: int, character_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Transfer warp power to another character in the same sector.

        Args:
            to_character_id: Character ID to transfer warp power to
            units: Number of warp power units to transfer
            character_id: Character transferring warp power (defaults to current character)

        Returns:
            Transfer result

        Raises:
            RPCError: If the request fails
        """
        character_id = self._resolve_character_id(character_id)

        result = await self._request(
            "transfer_warp_power",
            {
                "from_character_id": character_id,
                "to_character_id": to_character_id,
                "units": units,
            },
        )
        wrapped = self._wrap_transfer_result(result)

        from_id = (
            result.get("from_character")
            or result.get("from_character_id")
            or character_id
        )
        to_id = (
            result.get("to_character")
            or result.get("to_character_id")
            or to_character_id
        )
        from_remaining = result.get("from_warp_power_remaining")
        to_current = result.get("to_warp_power_current")

        if from_id and from_id in self._status_cache and from_remaining is not None:
            updated = deepcopy(self._status_cache[from_id])
            updated.setdefault("ship", {})
            updated["ship"]["warp_power"] = from_remaining
            self._status_cache[from_id] = updated
            if self._current_character == from_id:
                self._ship_status = updated.get("ship")

        if to_id and to_id in self._status_cache and to_current is not None:
            updated = deepcopy(self._status_cache[to_id])
            updated.setdefault("ship", {})
            updated["ship"]["warp_power"] = to_current
            self._status_cache[to_id] = updated
            if self._current_character == to_id:
                self._ship_status = updated.get("ship")

        return wrapped

    async def combat_initiate(
        self,
        *,
        character_id: str,
        target_id: Optional[str] = None,
        target_type: str = "character",
    ) -> Dict[str, Any]:
        character_id = self._resolve_character_id(character_id)
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
        character_id: Optional[str] = None,
        round_number: Optional[int] = None,
    ) -> Dict[str, Any]:
        actor = self._resolve_character_id(character_id)
        payload: Dict[str, Any] = {
            "combat_id": combat_id,
            "character_id": actor,
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

    async def combat_status(
        self,
        *,
        combat_id: Optional[str] = None,
        character_id: Optional[str] = None,
        include_logs: bool = False,
    ) -> Dict[str, Any]:
        if not combat_id and not character_id:
            character_id = self._resolve_character_id(character_id)
        payload: Dict[str, Any] = {}
        if combat_id:
            payload["combat_id"] = combat_id
        if character_id:
            payload["character_id"] = self._resolve_character_id(character_id)
        if include_logs:
            payload["include_logs"] = True
        return await self._request("combat.status", payload)

    async def combat_leave_fighters(
        self,
        *,
        sector: int,
        quantity: int,
        mode: str = "offensive",
        toll_amount: int = 0,
        character_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        actor = self._resolve_character_id(character_id)
        payload = {
            "character_id": actor,
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
        character_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        actor = self._resolve_character_id(character_id)
        payload = {
            "character_id": actor,
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
        character_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        actor = self._resolve_character_id(character_id)
        payload = {
            "character_id": actor,
            "sector": sector,
            "mode": mode,
            "toll_amount": toll_amount,
        }
        return await self._request("combat.set_garrison_mode", payload)

    async def salvage_collect(
        self,
        *,
        salvage_id: str,
        character_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        actor = self._resolve_character_id(character_id)
        payload = {
            "character_id": actor,
            "salvage_id": salvage_id,
        }
        return await self._request("salvage.collect", payload)

    async def send_message(
        self,
        content: str,
        msg_type: str = "broadcast",
        to_name: Optional[str] = None,
        character_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send a chat message via WebSocket server.

        Args:
            content: Message text (<=512 chars)
            msg_type: "broadcast" or "direct"
            to_name: Required if msg_type == "direct"
            character_id: Sender (defaults to current character)
        """
        character_id = self._resolve_character_id(character_id)
        payload = {"character_id": character_id, "type": msg_type, "content": content}
        if msg_type == "direct":
            if not to_name:
                raise ValueError("to_name is required for direct messages")
            payload["to_name"] = to_name
        result = await self._request("send_message", payload)
        summary = f"Sent {msg_type} message (id {result.get('id')})."
        delta = {"id": result.get("id"), "type": msg_type, "to_name": to_name}
        return LLMResult(result, summary, delta)

    async def subscribe_chat(self):
        logger.debug("subscribe_chat is deprecated; skipping explicit subscribe")

    async def subscribe_my_messages(
        self,
        handler: Optional[Callable[[Dict[str, Any]], Awaitable[None] | None]] = None,
    ) -> None:
        """Ensure chat.message events are subscribed and optionally register a handler."""

        if handler is not None:
            if asyncio.iscoroutinefunction(handler):
                self.on("chat.message")(handler)
            else:
                async def _wrapper(payload: Dict[str, Any]) -> None:
                    handler(payload)

                self.on("chat.message")(_wrapper)

        await self.subscribe_chat()

    async def _request(self, endpoint: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        await self._ensure_ws()
        req_id = str(uuid.uuid4())
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        frame = {
            "id": req_id,
            "type": "rpc",
            "endpoint": endpoint,
            "payload": payload,
        }
        await self._ws.send(json.dumps(frame))
        msg = await fut
        if not msg.get("ok"):
            err = msg.get("error", {})
            raise RPCError(
                endpoint,
                int(err.get("status", 500)),
                str(err.get("detail", "Unknown error")),
                err.get("code"),
            )
        return msg.get("result", {})

    async def _send_command(self, frame: Dict[str, Any]) -> Dict[str, Any]:
        await self._ensure_ws()
        req_id = frame.setdefault("id", str(uuid.uuid4()))
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        await self._ws.send(json.dumps(frame))
        msg = await fut
        if not msg.get("ok"):
            err = msg.get("error", {})
            raise RPCError(
                frame.get("type", "command"),
                int(err.get("status", 500)),
                str(err.get("detail", "Unknown error")),
                err.get("code"),
            )
        return msg.get("result", {})

    async def subscribe_my_status(self, character_id: str):
        logger.debug("subscribe_my_status is deprecated; skipping explicit subscribe")

    async def identify(
        self, *, name: Optional[str] = None, character_id: Optional[str] = None
    ):
        """Register identity for receiving direct messages without my_status subscribe.

        One of name or character_id must be provided. If neither is provided,
        attempts to use the currently joined character.
        """
        if character_id is None and name is None:
            character_id = self._resolve_character_id(None)
        elif character_id is not None:
            character_id = self._resolve_character_id(character_id)
        if name is None and character_id is None:
            raise ValueError("No name or character specified for identify()")
        frame: Dict[str, Any] = {"type": "identify"}
        if name is not None:
            frame["name"] = name
        if character_id is not None:
            frame["character_id"] = character_id
        await self._send_command(frame)

    async def start_task(
        self, task_description: str, context: Optional[str] = None
    ) -> Dict[str, Any]:
        """Start a complex multi-step task.

        Args:
            task_description: Natural language description of the task
            context: Optional context or clarifications

        Returns:
            Task status
        """
        # This would typically interact with an NPC/agent system
        return {"status": "started", "task": task_description, "context": context}

    async def stop_task(self) -> Dict[str, Any]:
        """Cancel the currently running task.

        Returns:
            Cancellation status
        """
        # This would typically interact with an NPC/agent system
        return {"status": "cancelled"}

    async def find_profitable_route(
        self, character_id: Optional[str] = None, max_distance: int = 10
    ) -> Optional[Dict[str, Any]]:
        """Find a profitable trade route from known ports.

        Args:
            character_id: Character to analyze for (defaults to current character)
            max_distance: Maximum distance to consider for routes

        Returns:
            Profitable route information or None if no profitable route found
        """
        character_id = self._resolve_character_id(character_id)

        # Get current status to know where we are
        status = await self.my_status(character_id)
        current_sector = status["sector"]
        current_cargo = status["ship"]["cargo"]

        # Get known ports
        ports = await self.find_port(character_id=character_id)
        if not ports:
            return None

        best_route = None
        best_profit = 0

        # Analyze each known port
        for port_info in ports:
            port_sector = port_info["sector"]
            port = port_info["port"]

            # Skip if too far
            distance = port_info.get("distance", float("inf"))
            if distance > max_distance:
                continue

            # Check what we can buy here (from port sells list)
            sells = list_sells(port)
            for commodity in sells:
                buy_price = last_seen_price(port, commodity)
                if buy_price is None:
                    continue

                # Find ports that buy this commodity
                for other_port_info in ports:
                    if other_port_info["sector"] == port_sector:
                        continue

                    other_port = other_port_info["port"]
                    if buys_commodity(other_port, commodity):
                        sell_price = last_seen_price(other_port, commodity)
                        if sell_price is None:
                            continue

                        # Calculate profit
                        profit_per_unit = sell_price - buy_price
                        if profit_per_unit > 0:
                            # Consider distance
                            total_distance = distance + other_port_info.get(
                                "distance", float("inf")
                            )
                            if total_distance <= max_distance * 2:
                                profit_efficiency = profit_per_unit / max(
                                    1, total_distance
                                )

                                if profit_efficiency > best_profit:
                                    best_profit = profit_efficiency
                                    best_route = {
                                        "buy_sector": port_sector,
                                        "buy_port": port,
                                        "sell_sector": other_port_info["sector"],
                                        "sell_port": other_port,
                                        "commodity": commodity,
                                        "buy_price": buy_price,
                                        "sell_price": sell_price,
                                        "profit_per_unit": profit_per_unit,
                                        "total_distance": total_distance,
                                        "profit_efficiency": profit_efficiency,
                                    }

        return best_route
