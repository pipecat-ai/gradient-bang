"""Game server API client for Gradient Bang."""

from typing import List, Optional, Dict, Any, Callable, Awaitable
import httpx
import logging
import asyncio
import json
import uuid


logger = logging.getLogger(__name__)


class AsyncGameClient:
    """Async client for interacting with the Gradient Bang game server."""
    
    def __init__(self, base_url: str = "http://localhost:8000", character_id: Optional[str] = None, transport: str = "http"):
        """Initialize the async game client.
        
        Args:
            base_url: Base URL of the game server
            character_id: Optional character ID to associate with this client
        """
        self.base_url = base_url.rstrip("/")
        self.client = httpx.AsyncClient(timeout=10.0)
        self.transport = transport  # "http" or "websocket"
        self._ws = None
        self._ws_reader_task: Optional[asyncio.Task] = None
        self._pending: Dict[str, asyncio.Future] = {}
        self._event_handlers: Dict[str, List[Callable[[Dict[str, Any]], Awaitable[None]]]] = {}
        self._subscriptions: set[str] = set()
        self._auto_subscribe_my_status_on_join: bool = False
        
        # Map cache: character_id -> {map_data, last_fetched}
        self._map_cache: Dict[str, Dict[str, Any]] = {}
        self._current_character: Optional[str] = character_id
        self._current_sector: Optional[int] = None
        self._ship_status: Optional[Dict[str, Any]] = None
        
        # Locks for thread-safe operations
        self._cache_lock = asyncio.Lock()
        self._status_lock = asyncio.Lock()
    
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
        await self.client.aclose()
        if self._ws_reader_task:
            self._ws_reader_task.cancel()
            self._ws_reader_task = None
        if self._ws:
            try:
                await self._ws.aclose()
            except Exception:
                pass
            self._ws = None

    # Event subscription decorator (WS only)
    def on(self, event_name: str):
        def decorator(fn: Callable[[Dict[str, Any]], Awaitable[None]]):
            self._event_handlers.setdefault(event_name, []).append(fn)
            # Auto-subscribe behavior for WS events
            if self.transport == "websocket":
                if event_name == "my_status":
                    # If we already know the character, subscribe immediately; otherwise, defer until join()
                    if self._current_character:
                        try:
                            loop = asyncio.get_running_loop()
                            loop.create_task(self.subscribe_my_status(self._current_character))
                        except RuntimeError:
                            # No running loop yet; defer
                            self._auto_subscribe_my_status_on_join = True
                    else:
                        self._auto_subscribe_my_status_on_join = True
            return fn
        return decorator

    async def _ensure_ws(self):
        if self._ws is not None:
            return
        import websockets
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
                if msg.get("type") == "event":
                    handlers = self._event_handlers.get(msg.get("event"), [])
                    for h in handlers:
                        asyncio.create_task(h(msg.get("data", {})))
                    continue
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
    
    async def join(self, character_id: str, ship_type: Optional[str] = None) -> Dict[str, Any]:
        """Join the game with a character.
        
        Args:
            character_id: Unique identifier for the character
            ship_type: Optional ship type to start with (defaults to Kestrel Courier)
            
        Returns:
            Character status after joining
            
        Raises:
            httpx.HTTPStatusError: If the request fails
        """
        payload = {"character_id": character_id}
        if ship_type:
            payload["ship_type"] = ship_type
        
        status = await self._request("join", payload)
        
        async with self._status_lock:
            # Set current character and sector, fetch initial map data
            self._current_character = character_id
            self._current_sector = status["sector"]
            self._ship_status = status["ship"]
        
        await self._fetch_and_cache_map(character_id)

        # Update cache with new sector information
        await self._update_map_cache_from_status(character_id, status)

        # If using websockets and a my_status handler is registered, auto-subscribe
        if self.transport == "websocket":
            if self._auto_subscribe_my_status_on_join or ("my_status" in self._event_handlers and self._event_handlers["my_status"]):
                if "my_status" not in self._subscriptions:
                    try:
                        await self.subscribe_my_status(character_id)
                    except Exception:
                        # Non-fatal; caller can subscribe explicitly if needed
                        pass
                # Reset the flag once attempted
                self._auto_subscribe_my_status_on_join = False

        return status
    
    async def move(self, to_sector: int, character_id: Optional[str] = None) -> Dict[str, Any]:
        """Move a character to an adjacent sector.
        
        Args:
            to_sector: Destination sector (must be adjacent)
            character_id: Character to move (defaults to current character)
            
        Returns:
            Character status after move
            
        Raises:
            httpx.HTTPStatusError: If the request fails (e.g., non-adjacent sector)
        """
        if character_id is None:
            character_id = self._current_character
        if character_id is None:
            raise ValueError("No character specified or tracked")
        
        # Ensure we have map data before moving
        await self._ensure_map_cached(character_id)
        
        status = await self._request("move", {"character_id": character_id, "to_sector": to_sector})
        
        # Update current sector if this is the tracked character
        async with self._status_lock:
            if character_id == self._current_character:
                self._current_sector = status["sector"]
            self._ship_status = status["ship"]
        
        # Update map cache with new sector information
        await self._update_map_cache_from_status(character_id, status)
        
        return status
    
    async def my_status(self, character_id: Optional[str] = None, force_refresh: bool = False) -> Dict[str, Any]:
        """Get current status of a character.
        
        Args:
            character_id: Character to query (defaults to current character)
            force_refresh: If True, bypass cache and fetch fresh data
            
        Returns:
            Current character status
            
        Raises:
            httpx.HTTPStatusError: If the request fails
        """
        # Use current character if not specified
        if character_id is None:
            character_id = self._current_character
        if character_id is None:
            raise ValueError("No character specified or tracked")
        
        # Ensure we have map data
        if not force_refresh:
            await self._ensure_map_cached(character_id)
        
        status = await self._request("my_status", {"character_id": character_id})
        
        # Update map cache with current sector information
        await self._update_map_cache_from_status(character_id, status)
        
        return status
    
    async def plot_course(self, from_sector: int, to_sector: int) -> Dict[str, Any]:
        """Plot a course between two sectors.
        
        Args:
            from_sector: Starting sector
            to_sector: Destination sector
            
        Returns:
            Course information including path and distance
            
        Raises:
            httpx.HTTPStatusError: If the request fails
        """
        return await self._request("plot_course", {"from_sector": from_sector, "to_sector": to_sector})
    
    async def server_status(self) -> Dict[str, Any]:
        """Get server status information.
        
        Returns:
            Server status including name, version, and sector count
            
        Raises:
            httpx.HTTPStatusError: If the request fails
        """
        if self.transport == "http":
            response = await self.client.get(f"{self.base_url}/")
            response.raise_for_status()
            return response.json()
        else:
            # WS server has different name, but compatible shape
            return await self._request("noop", {})  # Not implemented; keep HTTP for status
    
    async def my_map(self, character_id: Optional[str] = None, force_refresh: bool = False) -> Dict[str, Any]:
        """Get the map knowledge for a character.
        
        Args:
            character_id: Character to query (defaults to current character)
            force_refresh: If True, force a fresh fetch from the server
            
        Returns:
            Map knowledge including visited sectors and discovered ports
            
        Raises:
            httpx.HTTPStatusError: If the request fails
        """
        # Use current character if not specified
        if character_id is None:
            character_id = self._current_character
        if character_id is None:
            raise ValueError("No character specified or tracked")
        
        async with self._cache_lock:
            if force_refresh or character_id not in self._map_cache:
                await self._fetch_and_cache_map(character_id)
            
            return self._map_cache.get(character_id, {})
    
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
        self._map_cache[character_id] = result
    
    async def _update_map_cache_from_status(self, character_id: str, status: Dict[str, Any]):
        """Update the map cache with information from a status response.
        
        Args:
            character_id: Character whose map to update
            status: Status response containing sector information
        """
        async with self._cache_lock:
            # Ensure we have a cache entry
            if character_id not in self._map_cache:
                await self._fetch_and_cache_map(character_id)
                return
            
            # Update the cached map with new sector information
            map_data = self._map_cache[character_id]
            sectors_visited = map_data.setdefault("sectors_visited", {})
        
            sector_key = f"sector_{status['sector']}"
            sector_info = sectors_visited.setdefault(sector_key, {})
        
            # Update sector information
            sector_info["sector_id"] = status["sector"]
            sector_info["last_visited"] = status["last_active"]
            sector_contents = status.get("sector_contents", {})
            sector_info["adjacent_sectors"] = sector_contents.get("adjacent_sectors", [])
            
            # Update port information if present
            port = sector_contents.get("port")
            if port:
                sector_info["port_info"] = {
                    "class_num": port.get("class"),  # Use same field name as server
                    "code": port.get("code"),
                    "buys": port.get("buys", []),
                    "sells": port.get("sells", []),
                    "stock": port.get("stock", {}),
                    "max_capacity": port.get("max_capacity", {}),
                    "prices": port.get("prices")
                }
            
            # Update planet information if present
            planets = sector_contents.get("planets", [])
            if planets:
                sector_info["planets"] = [
                    {
                        "id": planet.get("id"),
                        "class_code": planet.get("class_code"),
                        "class_name": planet.get("class_name")
                    }
                    for planet in planets
                ]
    
    async def find_nearest_known_port(self, from_sector: int) -> Optional[Dict[str, Any]]:
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
        
        # Check if from_sector has been visited
        from_sector_key = f"sector_{from_sector}"
        if from_sector_key not in sectors_visited:
            raise ValueError(f"Sector {from_sector} has not been visited")
        
        # Find all ports
        all_ports = []
        for sector_key, sector_info in sectors_visited.items():
            port_info = sector_info.get("port_info")
            if port_info:
                all_ports.append({
                    "sector": sector_info["sector_id"],
                    "port": port_info,
                    "last_visited": sector_info.get("last_visited")
                })
        
        if not all_ports:
            return None
        
        # Find the nearest port using pathfinding
        nearest = None
        min_distance = float('inf')
        
        for port_data in all_ports:
            try:
                course = await self.plot_course(from_sector, port_data["sector"])
                if course["distance"] < min_distance:
                    min_distance = course["distance"]
                    nearest = {
                        "sector": port_data["sector"],
                        "distance": course["distance"],
                        "path": course["path"],
                        "port": port_data["port"],
                        "last_visited": port_data["last_visited"]
                    }
            except httpx.HTTPError as e:
                logger.warning(
                    "HTTP error while plotting course from %s to %s: %s",
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
        self, 
        from_sector: int, 
        commodity: str, 
        buy_or_sell: str
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
        
        # Check if from_sector has been visited
        from_sector_key = f"sector_{from_sector}"
        if from_sector_key not in sectors_visited:
            raise ValueError(f"Sector {from_sector} has not been visited")
        
        # Find all ports that match the criteria
        matching_ports = []
        for sector_key, sector_info in sectors_visited.items():
            port_info = sector_info.get("port_info")
            if port_info:
                # Check if port has the commodity
                if buy_or_sell == "sell" and commodity in port_info.get("sells", []):
                    matching_ports.append({
                        "sector": sector_info["sector_id"],
                        "port": port_info,
                        "last_visited": sector_info.get("last_visited")
                    })
                elif buy_or_sell == "buy" and commodity in port_info.get("buys", []):
                    matching_ports.append({
                        "sector": sector_info["sector_id"],
                        "port": port_info,
                        "last_visited": sector_info.get("last_visited")
                    })
        
        if not matching_ports:
            return None
        
        # Find the closest port using plot_course
        closest = None
        min_distance = float('inf')
        
        for port_data in matching_ports:
            try:
                course = await self.plot_course(from_sector, port_data["sector"])
                distance = course.distance
                if distance < min_distance:
                    min_distance = distance
                    closest = {
                        **port_data,
                        "distance": distance,
                        "path": course.path
                    }
            except httpx.HTTPError as e:
                logger.warning(
                    "HTTP error while plotting course from %s to %s: %s",
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
                if adj_sector in port_sectors and adj_sector > sector_id:  # Avoid duplicates
                    pair = {
                        "sector1": sector_id,
                        "port1": sector_info["port_info"],
                        "sector2": adj_sector,
                        "port2": port_sectors[adj_sector]["port_info"]
                    }
                    port_pairs.append(pair)
        
        return port_pairs
    
    async def check_trade(
        self,
        commodity: str,
        quantity: int,
        trade_type: str,
        character_id: Optional[str] = None
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
            httpx.HTTPStatusError: If the request fails
        """
        if character_id is None:
            character_id = self._current_character
        if character_id is None:
            raise ValueError("No character specified or tracked")
        
        return await self._request(
            "check_trade",
            {
                "character_id": character_id,
                "commodity": commodity,
                "quantity": quantity,
                "trade_type": trade_type,
            },
        )
    
    async def trade(
        self,
        commodity: str,
        quantity: int,
        trade_type: str,
        character_id: Optional[str] = None
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
            httpx.HTTPStatusError: If the request fails
        """
        if character_id is None:
            character_id = self._current_character
        if character_id is None:
            raise ValueError("No character specified or tracked")
        
        result = await self._request(
            "trade",
            {
                "character_id": character_id,
                "commodity": commodity,
                "quantity": quantity,
                "trade_type": trade_type,
            },
        )
        
        # Update cache if successful
        if result.get("success"):
            # The trade changes our credits and cargo, so we should invalidate status cache
            # (In a real implementation, we might update the cache instead of invalidating)
            pass
        
        return result
    
    async def recharge_warp_power(self, units: int, character_id: Optional[str] = None) -> Dict[str, Any]:
        """Recharge warp power at the special depot in sector 0.
        
        Args:
            units: Number of warp power units to recharge
            character_id: Character recharging warp power (defaults to current character)
            
        Returns:
            Transaction result
            
        Raises:
            httpx.HTTPStatusError: If the request fails
        """
        if character_id is None:
            character_id = self._current_character
        if character_id is None:
            raise ValueError("No character specified or tracked")
        
        return await self._request("recharge_warp_power", {"character_id": character_id, "units": units})
    
    async def transfer_warp_power(self, to_character_id: str, units: int, character_id: Optional[str] = None) -> Dict[str, Any]:
        """Transfer warp power to another character in the same sector.
        
        Args:
            to_character_id: Character ID to transfer warp power to
            units: Number of warp power units to transfer
            character_id: Character transferring warp power (defaults to current character)
            
        Returns:
            Transfer result
            
        Raises:
            httpx.HTTPStatusError: If the request fails
        """
        if character_id is None:
            character_id = self._current_character
        if character_id is None:
            raise ValueError("No character specified or tracked")
        
        return await self._request(
            "transfer_warp_power",
            {"from_character_id": character_id, "to_character_id": to_character_id, "units": units},
        )

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
        if self.transport != "websocket":
            raise RuntimeError("send_message requires websocket transport")
        if character_id is None:
            character_id = self._current_character
        if character_id is None:
            raise ValueError("No character specified or tracked")
        payload = {"character_id": character_id, "type": msg_type, "content": content}
        if msg_type == "direct":
            if not to_name:
                raise ValueError("to_name is required for direct messages")
            payload["to_name"] = to_name
        return await self._request("send_message", payload)

    async def subscribe_chat(self):
        if self.transport != "websocket":
            raise RuntimeError("subscribe_chat requires websocket transport")
        await self._ensure_ws()
        frame = {"id": str(uuid.uuid4()), "action": "subscribe", "event": "chat"}
        await self._ws.send(json.dumps(frame))
        self._subscriptions.add("chat")

    async def _request(self, endpoint: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self.transport == "http":
            # Map endpoint to HTTP
            if endpoint == "plot_course":
                resp = await self.client.post(f"{self.base_url}/api/plot_course", json=payload)
            elif endpoint == "join":
                resp = await self.client.post(f"{self.base_url}/api/join", json=payload)
            elif endpoint == "move":
                resp = await self.client.post(f"{self.base_url}/api/move", json=payload)
            elif endpoint == "my_status":
                resp = await self.client.post(f"{self.base_url}/api/my_status", json=payload)
            elif endpoint == "my_map":
                resp = await self.client.post(f"{self.base_url}/api/my_map", json=payload)
            elif endpoint == "check_trade":
                resp = await self.client.post(f"{self.base_url}/api/check_trade", json=payload)
            elif endpoint == "trade":
                resp = await self.client.post(f"{self.base_url}/api/trade", json=payload)
            elif endpoint == "recharge_warp_power":
                resp = await self.client.post(f"{self.base_url}/api/recharge_warp_power", json=payload)
            elif endpoint == "transfer_warp_power":
                resp = await self.client.post(f"{self.base_url}/api/transfer_warp_power", json=payload)
            elif endpoint == "reset_ports":
                resp = await self.client.post(f"{self.base_url}/api/reset_ports")
            elif endpoint == "regenerate_ports":
                resp = await self.client.post(f"{self.base_url}/api/regenerate_ports", json=payload)
            else:
                raise ValueError(f"Unknown endpoint {endpoint}")
            resp.raise_for_status()
            return resp.json()
        else:
            await self._ensure_ws()
            req_id = str(uuid.uuid4())
            frame = {"id": req_id, "endpoint": endpoint, "payload": payload}
            fut: asyncio.Future = asyncio.get_running_loop().create_future()
            self._pending[req_id] = fut
            await self._ws.send(json.dumps(frame))
            msg = await fut
            if not msg.get("ok"):
                err = msg.get("error", {})
                raise httpx.HTTPStatusError(f"WS error: {err}", request=None, response=None)
            return msg.get("data", {})

    async def subscribe_my_status(self, character_id: str):
        if self.transport != "websocket":
            raise RuntimeError("Subscriptions require websocket transport")
        await self._ensure_ws()
        frame = {"id": str(uuid.uuid4()), "action": "subscribe", "event": "my_status", "character_id": character_id}
        await self._ws.send(json.dumps(frame))
        self._subscriptions.add("my_status")
        # Do not await response for simplicity in this client; events will stream via on('my_status') handlers

    async def identify(self, *, name: Optional[str] = None, character_id: Optional[str] = None):
        """Register identity for receiving direct messages without my_status subscribe.

        One of name or character_id must be provided. If neither is provided,
        attempts to use the currently joined character.
        """
        if self.transport != "websocket":
            raise RuntimeError("identify requires websocket transport")
        await self._ensure_ws()
        if name is None and character_id is None:
            character_id = self._current_character
        if name is None and character_id is None:
            raise ValueError("No name or character specified for identify()")
        frame: Dict[str, Any] = {"id": str(uuid.uuid4()), "action": "identify"}
        if name is not None:
            frame["name"] = name
        if character_id is not None:
            frame["character_id"] = character_id
        await self._ws.send(json.dumps(frame))
    
    async def start_task(self, task_description: str, context: Optional[str] = None) -> Dict[str, Any]:
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
        self,
        character_id: Optional[str] = None,
        max_distance: int = 10
    ) -> Optional[Dict[str, Any]]:
        """Find a profitable trade route from known ports.
        
        Args:
            character_id: Character to analyze for (defaults to current character)
            max_distance: Maximum distance to consider for routes
            
        Returns:
            Profitable route information or None if no profitable route found
        """
        if character_id is None:
            character_id = self._current_character
        if character_id is None:
            raise ValueError("No character specified or tracked")
        
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
            distance = port_info.get("distance", float('inf'))
            if distance > max_distance:
                continue
            
            # Check what we can buy here
            if port.get("sells") and "prices" in port:
                for commodity in port["sells"]:
                    if commodity not in port["prices"]:
                        continue
                    
                    buy_price = port["prices"][commodity].get("sell")
                    if buy_price is None:
                        continue
                    
                    # Find ports that buy this commodity
                    for other_port_info in ports:
                        if other_port_info["sector"] == port_sector:
                            continue
                        
                        other_port = other_port_info["port"]
                        if commodity in other_port.get("buys", []) and "prices" in other_port:
                            sell_price = other_port["prices"][commodity].get("buy")
                            if sell_price is None:
                                continue
                            
                            # Calculate profit
                            profit_per_unit = sell_price - buy_price
                            if profit_per_unit > 0:
                                # Consider distance
                                total_distance = distance + other_port_info.get("distance", float('inf'))
                                if total_distance <= max_distance * 2:
                                    profit_efficiency = profit_per_unit / max(1, total_distance)
                                    
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
                                            "profit_efficiency": profit_efficiency
                                        }
        
        return best_route
