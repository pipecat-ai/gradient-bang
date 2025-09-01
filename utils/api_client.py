"""Game server API client for Gradient Bang."""

from typing import List, Optional, Dict, Any
import httpx
import logging
import asyncio


logger = logging.getLogger(__name__)


class AsyncGameClient:
    """Async client for interacting with the Gradient Bang game server."""
    
    def __init__(self, base_url: str = "http://localhost:8000", character_id: Optional[str] = None):
        """Initialize the async game client.
        
        Args:
            base_url: Base URL of the game server
            character_id: Optional character ID to associate with this client
        """
        self.base_url = base_url.rstrip("/")
        self.client = httpx.AsyncClient(timeout=10.0)
        
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
        """Close the HTTP client."""
        await self.client.aclose()
    
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
        
        response = await self.client.post(
            f"{self.base_url}/api/join",
            json=payload
        )
        response.raise_for_status()
        status = response.json()
        
        async with self._status_lock:
            # Set current character and sector, fetch initial map data
            self._current_character = character_id
            self._current_sector = status["sector"]
            self._ship_status = status["ship"]
        
        await self._fetch_and_cache_map(character_id)
        
        # Update cache with new sector information
        await self._update_map_cache_from_status(character_id, status)
        
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
        
        response = await self.client.post(
            f"{self.base_url}/api/move",
            json={"character_id": character_id, "to_sector": to_sector}
        )
        
        # Check for errors and include response body in exception
        if response.status_code >= 400:
            try:
                error_detail = response.json()
                error_msg = error_detail.get("detail", str(error_detail))
            except:
                error_msg = response.text or f"HTTP {response.status_code}"
            raise Exception(f"Move failed (HTTP {response.status_code}): {error_msg}")
        
        status = response.json()
        
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
        
        response = await self.client.post(
            f"{self.base_url}/api/my-status",
            json={"character_id": character_id}
        )
        response.raise_for_status()
        status = response.json()
        
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
        response = await self.client.post(
            f"{self.base_url}/api/plot-course",
            json={"from_sector": from_sector, "to_sector": to_sector}
        )
        response.raise_for_status()
        return response.json()
    
    async def server_status(self) -> Dict[str, Any]:
        """Get server status information.
        
        Returns:
            Server status including name, version, and sector count
            
        Raises:
            httpx.HTTPStatusError: If the request fails
        """
        response = await self.client.get(f"{self.base_url}/")
        response.raise_for_status()
        return response.json()
    
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
        response = await self.client.post(
            f"{self.base_url}/api/my-map",
            json={"character_id": character_id}
        )
        response.raise_for_status()
        
        # Lock is already held by caller if needed
        self._map_cache[character_id] = response.json()
    
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
        
        response = await self.client.post(
            f"{self.base_url}/api/check_trade",
            json={
                "character_id": character_id,
                "commodity": commodity,
                "quantity": quantity,
                "trade_type": trade_type
            }
        )
        response.raise_for_status()
        return response.json()
    
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
        
        response = await self.client.post(
            f"{self.base_url}/api/trade",
            json={
                "character_id": character_id,
                "commodity": commodity,
                "quantity": quantity,
                "trade_type": trade_type
            }
        )
        response.raise_for_status()
        result = response.json()
        
        # Update cache if successful
        if result.get("success"):
            # The trade changes our credits and cargo, so we should invalidate status cache
            # (In a real implementation, we might update the cache instead of invalidating)
            pass
        
        return result
    
    async def buy_warp_power(self, units: int, character_id: Optional[str] = None) -> Dict[str, Any]:
        """Buy warp power at the special depot in sector 0.
        
        Args:
            units: Number of warp power units to buy
            character_id: Character buying warp power (defaults to current character)
            
        Returns:
            Transaction result
            
        Raises:
            httpx.HTTPStatusError: If the request fails
        """
        if character_id is None:
            character_id = self._current_character
        if character_id is None:
            raise ValueError("No character specified or tracked")
        
        response = await self.client.post(
            f"{self.base_url}/api/buy-warp-power",
            json={
                "character_id": character_id,
                "units": units
            }
        )
        response.raise_for_status()
        return response.json()
    
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
        
        response = await self.client.post(
            f"{self.base_url}/api/transfer-warp-power",
            json={
                "from_character_id": character_id,
                "to_character_id": to_character_id,
                "units": units
            }
        )
        response.raise_for_status()
        return response.json()
    
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
