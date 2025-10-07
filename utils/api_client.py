"""Game server API client for Gradient Bang."""

from typing import List, Optional, Dict, Any, Callable, Awaitable, Tuple, Mapping
import logging
import asyncio
import json
import uuid
import inspect
import websockets


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
        websocket_frame_callback: Optional[
            Callable[[str, Mapping[str, Any]], Any]
        ] = None,
    ):
        """Initialize the async game client.

        Args:
            base_url: Base URL of the game server
            character_id: Character ID this client will operate on (immutable)
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
        self._subscriptions: set[str] = set()

        # Immutable character ID
        self._character_id: str = character_id

        # Optional summary formatters: endpoint_name -> formatter_function
        self._summary_formatters: Dict[str, Callable[[Dict[str, Any]], str]] = {}

        # Optional WebSocket frame callback for logging/debugging
        self._websocket_frame_callback = websocket_frame_callback

    @property
    def character_id(self) -> str:
        """Get the character ID this client is bound to."""
        return self._character_id

    def set_summary_formatter(
        self, endpoint: str, formatter: Callable[[Dict[str, Any]], str]
    ) -> None:
        """Attach a summary formatter to an endpoint.

        Args:
            endpoint: Endpoint name (e.g., "move", "trade")
            formatter: Function that takes server response and returns summary string
        """
        self._summary_formatters[endpoint] = formatter

    def _apply_summary(self, endpoint: str, result: Dict[str, Any]) -> Dict[str, Any]:
        """Apply summary formatter if one is registered for this endpoint.

        Args:
            endpoint: Endpoint name
            result: Server response dict

        Returns:
            Result dict, optionally with "summary" key added
        """
        formatter = self._summary_formatters.get(endpoint)
        if formatter:
            try:
                summary = formatter(result)
                if summary:
                    result["summary"] = summary
            except Exception:
                logger.exception(f"Summary formatter for {endpoint} failed")
        return result

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
        handlers = self._event_handlers.get(event_name, [])
        for handler in handlers:
            asyncio.create_task(handler(payload))

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
        await self._emit_frame("send", frame)
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
        await self._emit_frame("send", frame)
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

    # ------------------------------------------------------------------
    # API Methods
    # ------------------------------------------------------------------

    async def join(
        self, character_id: str, ship_type: Optional[str] = None
    ) -> Dict[str, Any]:
        """Join the game with a character.

        Args:
            character_id: Unique identifier for the character (must match bound ID)
            ship_type: Optional ship type to start with (defaults to Kestrel Courier)

        Returns:
            Character status after joining

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

        result = await self._request("join", payload)
        return self._apply_summary("join", result)

    async def move(self, to_sector: int, character_id: str) -> Dict[str, Any]:
        """Move a character to an adjacent sector.

        Args:
            to_sector: Destination sector (must be adjacent)
            character_id: Character to move (must match bound ID)

        Returns:
            Character status after move

        Raises:
            RPCError: If the request fails (e.g., non-adjacent sector)
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        result = await self._request(
            "move", {"character_id": character_id, "to_sector": to_sector}
        )
        return self._apply_summary("move", result)

    async def my_status(self, character_id: str) -> Dict[str, Any]:
        """Get current status of a character.

        Args:
            character_id: Character to query (must match bound ID)

        Returns:
            Current character status

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        result = await self._request("my_status", {"character_id": character_id})
        return self._apply_summary("my_status", result)

    async def plot_course(self, to_sector: int, character_id: str) -> Dict[str, Any]:
        """Plot a course from character's current sector to destination.

        Args:
            to_sector: Destination sector
            character_id: Character to plot course for (must match bound ID)

        Returns:
            Course information including path and distance

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        result = await self._request(
            "plot_course", {"character_id": character_id, "to_sector": to_sector}
        )
        return self._apply_summary("plot_course", result)

    async def server_status(self) -> Dict[str, Any]:
        """Get server status information.

        Returns:
            Server status including name, version, and sector count

        Raises:
            RPCError: If the request fails
        """
        result = await self._request("server_status", {})
        return self._apply_summary("server_status", result)

    async def my_map(self, character_id: str) -> Dict[str, Any]:
        """Get the map knowledge for a character.

        Args:
            character_id: Character to query (must match bound ID)

        Returns:
            Map knowledge including visited sectors and discovered ports

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        result = await self._request("my_map", {"character_id": character_id})
        return self._apply_summary("my_map", result)

    async def local_map_region(
        self,
        character_id: str,
        center_sector: Optional[int] = None,
        max_hops: int = 3,
        max_sectors: int = 100,
    ) -> Dict[str, Any]:
        """Get all known sectors around current location for local navigation.

        Args:
            character_id: Character to query (must match bound ID)
            center_sector: Optional center sector; defaults to current sector
            max_hops: Maximum BFS depth (default 3, max 10)
            max_sectors: Maximum sectors to return (default 100)

        Returns:
            Dict with center_sector, sectors list, totals

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

        result = await self._request("local_map_region", payload)
        return self._apply_summary("local_map_region", result)

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
            Dict with from_sector, ports list, totals

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

        result = await self._request("list_known_ports", payload)
        return self._apply_summary("list_known_ports", result)

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
            Dict with path, distance, sectors list, totals

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

        result = await self._request("path_with_region", payload)
        return self._apply_summary("path_with_region", result)

    async def check_trade(
        self,
        commodity: str,
        quantity: int,
        trade_type: str,
        character_id: str,
    ) -> Dict[str, Any]:
        """Preview a trade transaction without executing it.

        Args:
            commodity: Commodity to trade (fuel_ore, organics, equipment)
            quantity: Amount to trade
            trade_type: "buy" or "sell"
            character_id: Character making the trade (must match bound ID)

        Returns:
            Trade preview including prices and validation

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        result = await self._request(
            "check_trade",
            {
                "character_id": character_id,
                "commodity": commodity,
                "quantity": quantity,
                "trade_type": trade_type,
            },
        )
        return self._apply_summary("check_trade", result)

    async def trade(
        self,
        commodity: str,
        quantity: int,
        trade_type: str,
        character_id: str,
    ) -> Dict[str, Any]:
        """Execute a trade transaction.

        Args:
            commodity: Commodity to trade (fuel_ore, organics, equipment)
            quantity: Amount to trade
            trade_type: "buy" or "sell"
            character_id: Character making the trade (must match bound ID)

        Returns:
            Trade result including new credits and cargo

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        result = await self._request(
            "trade",
            {
                "character_id": character_id,
                "commodity": commodity,
                "quantity": quantity,
                "trade_type": trade_type,
            },
        )
        return self._apply_summary("trade", result)

    async def recharge_warp_power(
        self, units: int, character_id: str
    ) -> Dict[str, Any]:
        """Recharge warp power at the special depot in sector 0.

        Args:
            units: Number of warp power units to recharge
            character_id: Character recharging warp power (must match bound ID)

        Returns:
            Transaction result

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        result = await self._request(
            "recharge_warp_power", {"character_id": character_id, "units": units}
        )
        return self._apply_summary("recharge_warp_power", result)

    async def transfer_warp_power(
        self, to_character_id: str, units: int, character_id: str
    ) -> Dict[str, Any]:
        """Transfer warp power to another character in the same sector.

        Args:
            to_character_id: Character ID to transfer warp power to
            units: Number of warp power units to transfer
            character_id: Character transferring warp power (must match bound ID)

        Returns:
            Transfer result

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        result = await self._request(
            "transfer_warp_power",
            {
                "from_character_id": character_id,
                "to_character_id": to_character_id,
                "units": units,
            },
        )
        return self._apply_summary("transfer_warp_power", result)

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

    async def combat_status(
        self,
        *,
        combat_id: Optional[str] = None,
        character_id: Optional[str] = None,
        include_logs: bool = False,
    ) -> Dict[str, Any]:
        """Query combat session state.

        Args:
            combat_id: Combat session ID
            character_id: Character to query (must match bound ID if provided)
            include_logs: Include combat logs in response

        Returns:
            Combat session state

        Raises:
            RPCError: If the request fails
            ValueError: If character_id doesn't match bound ID
        """
        if character_id is not None and character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )

        payload: Dict[str, Any] = {}
        if combat_id:
            payload["combat_id"] = combat_id
        if character_id:
            payload["character_id"] = character_id
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
            Message confirmation

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
        result = await self._request("send_message", payload)
        return self._apply_summary("send_message", result)

    async def subscribe_chat(self):
        """Deprecated: Server auto-subscribes to chat."""
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

    async def subscribe_my_status(self, character_id: str):
        """Deprecated: Server auto-subscribes to status updates."""
        logger.debug("subscribe_my_status is deprecated; skipping explicit subscribe")

    async def test_reset(
        self,
        *,
        clear_files: bool = True,
        file_prefixes: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Reset server state for test isolation.

        WARNING: This clears all game state and should only be used in test environments.

        Args:
            clear_files: If True, delete test character files from disk
            file_prefixes: List of prefixes to match for file deletion (default: common test prefixes)

        Returns:
            dict: Statistics about what was cleared

        Raises:
            RPCError: If the request fails
        """
        payload = {"clear_files": clear_files}
        if file_prefixes is not None:
            payload["file_prefixes"] = file_prefixes

        result = await self._request("test.reset", payload)
        return self._apply_summary("test.reset", result)

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
