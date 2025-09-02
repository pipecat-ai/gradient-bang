#!/usr/bin/env python3
"""
Gradient Bang game server - FastAPI backend for a TradeWars-inspired space game.
"""

import json
import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Set, Optional, Any
from collections import deque

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect

from character_knowledge import CharacterKnowledgeManager
from ships import ShipType, get_ship_stats, validate_ship_type
from port_manager import PortManager
from trading import get_port_prices


class UniverseGraph:
    """Graph representation of the game universe for efficient pathfinding."""

    def __init__(self, universe_data: dict):
        self.sector_count = universe_data["meta"]["sector_count"]
        self.adjacency: Dict[int, List[int]] = {}

        # Build adjacency list from universe structure
        for sector in universe_data["sectors"]:
            sector_id = sector["id"]
            self.adjacency[sector_id] = []

            for warp in sector["warps"]:
                self.adjacency[sector_id].append(warp["to"])

    def find_path(self, start: int, end: int) -> Optional[List[int]]:
        """Find shortest path using BFS."""
        if start == end:
            return [start]

        if start not in self.adjacency or end not in self.adjacency:
            return None

        visited: Set[int] = {start}
        queue = deque([(start, [start])])

        while queue:
            current, path = queue.popleft()

            for neighbor in self.adjacency.get(current, []):
                if neighbor == end:
                    return path + [neighbor]

                if neighbor not in visited:
                    visited.add(neighbor)
                    queue.append((neighbor, path + [neighbor]))

        return None


# Pydantic Models for API


# Removed Pydantic models - using plain dictionaries instead for all data structures


class Character:
    """Represents a player character in the game."""

    def __init__(self, character_id: str, sector: int = 0):
        self.id = character_id
        self.sector = sector
        self.last_active = datetime.now(timezone.utc)

    def update_activity(self):
        """Update the last active timestamp."""
        self.last_active = datetime.now(timezone.utc)

    def to_dict(self) -> dict:
        """Convert character to dictionary for API responses."""
        return {"id": self.id, "sector": self.sector, "last_active": self.last_active.isoformat()}


class ConnectionManager:
    """Manages WebSocket connections for the firehose."""

    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.event_queue: asyncio.Queue = asyncio.Queue()
        self.broadcast_task = None

    async def connect(self, websocket: WebSocket):
        """Accept and track a new WebSocket connection."""
        await websocket.accept()
        self.active_connections.append(websocket)
        # Send welcome message
        await websocket.send_json(
            {
                "type": "connected",
                "message": "Connected to Gradient Bang firehose",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        )

    def disconnect(self, websocket: WebSocket):
        """Remove a WebSocket connection."""
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast_event(self, event: dict):
        """Add an event to the queue for broadcasting."""
        await self.event_queue.put(event)

    async def _broadcast_worker(self):
        """Background task to broadcast events from the queue."""
        while True:
            try:
                event = await self.event_queue.get()
                # Send to all connected clients
                disconnected = []
                for connection in self.active_connections:
                    try:
                        await connection.send_json(event)
                    except:
                        disconnected.append(connection)

                # Remove disconnected clients
                for conn in disconnected:
                    self.disconnect(conn)

            except Exception as e:
                print(f"Broadcast error: {e}")
                await asyncio.sleep(0.1)

    def start_broadcast_task(self):
        """Start the background broadcast task."""
        if self.broadcast_task is None:
            self.broadcast_task = asyncio.create_task(self._broadcast_worker())


def log_trade(
    character_id: str,
    sector: int,
    trade_type: str,
    commodity: str,
    quantity: int,
    price_per_unit: int,
    total_price: int,
    credits_after: int
):
    """Log a trade transaction to the history file.
    
    Args:
        character_id: Character making the trade
        sector: Sector where trade occurred
        trade_type: "buy" or "sell"
        commodity: Commodity traded
        quantity: Amount traded
        price_per_unit: Price per unit
        total_price: Total transaction value
        credits_after: Credits after transaction
    """
    trade_log_path = Path(__file__).parent.parent / "world-data" / "trade_history.jsonl"
    
    trade_record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "character_id": character_id,
        "sector": sector,
        "trade_type": trade_type,
        "commodity": commodity,
        "quantity": quantity,
        "price_per_unit": price_per_unit,
        "total_price": total_price,
        "credits_after": credits_after
    }
    
    try:
        # Append to JSONL file (create if doesn't exist)
        with open(trade_log_path, "a") as f:
            f.write(json.dumps(trade_record) + "\n")
    except Exception as e:
        print(f"Failed to log trade: {e}")


class GameWorld:
    """Container for all game world data."""

    def __init__(self):
        self.universe_graph: Optional[UniverseGraph] = None
        self.sector_contents: Optional[dict] = None
        self.characters: Dict[str, Character] = {}
        self.connection_manager = ConnectionManager()
        self.knowledge_manager = CharacterKnowledgeManager()
        self.port_manager: Optional[PortManager] = None

    def get_sector_contents(
        self, sector_id: int, current_character_id: str = None
    ) -> Dict[str, Any]:
        """Get the contents of a sector visible to a player.

        Args:
            sector_id: The sector to examine
            current_character_id: The character making the query (to exclude from other_players)

        Returns:
            SectorContents object with all visible information
        """
        # Get port information if present
        port_info = None
        if self.port_manager:
            # Load current port state (with live inventory)
            port_state = self.port_manager.load_port_state(sector_id)
            if port_state:
                # Build port info from current state
                port_data = {
                    "class": port_state.port_class,
                    "code": port_state.code,
                    "stock": port_state.stock,
                    "max_capacity": port_state.max_capacity,
                    # Determine buys/sells from code
                    "buys": [],
                    "sells": []
                }
                
                # Map code to buys/sells
                commodities = [("FO", "fuel_ore"), ("OG", "organics"), ("EQ", "equipment")]
                for i, (key, name) in enumerate(commodities):
                    if port_state.code[i] == "B":
                        port_data["buys"].append(name)
                    else:  # "S"
                        port_data["sells"].append(name)
                
                # Calculate current prices
                prices = get_port_prices(port_data)
                
                # Add warp power depot info for sector 0
                if sector_id == 0:
                    prices["warp_power_depot"] = {"price_per_unit": 2, "note": "Special warp power depot - recharge your ship"}
                
                port_info = {**port_data, "prices": prices}

        # Get planets if present
        planets = []
        if self.sector_contents and sector_id < len(self.sector_contents["sectors"]):
            sector_data = self.sector_contents["sectors"][sector_id]
            for planet_data in sector_data.get("planets", []):
                planets.append({
                    "id": planet_data["id"],
                    "class_code": planet_data["class_code"],
                    "class_name": planet_data["class_name"],
                })

        # Get other players in this sector with their ship info
        other_players = []
        for char_id, character in self.characters.items():
            if character.sector == sector_id and char_id != current_character_id:
                # Load the character's knowledge to get ship info
                knowledge = self.knowledge_manager.load_knowledge(char_id)
                ship_stats = get_ship_stats(ShipType(knowledge.ship_config.ship_type))
                
                other_players.append({
                    "character_id": char_id,
                    "ship_type": knowledge.ship_config.ship_type,
                    "ship_name": ship_stats.name
                })

        # Get adjacent sectors
        adjacent_sectors = []
        if self.universe_graph and sector_id in self.universe_graph.adjacency:
            adjacent_sectors = sorted(self.universe_graph.adjacency[sector_id])

        return {
            "port": port_info,
            "planets": planets,
            "other_players": other_players,
            "adjacent_sectors": adjacent_sectors,
        }

    def load_data(self):
        """Load universe data from JSON files."""
        # Find world-data directory relative to server file
        server_dir = Path(__file__).parent
        world_data_path = server_dir.parent / "world-data"

        # Load universe structure
        universe_path = world_data_path / "universe_structure.json"
        if not universe_path.exists():
            raise FileNotFoundError(f"Universe structure file not found: {universe_path}")

        with open(universe_path, "r") as f:
            universe_data = json.load(f)

        self.universe_graph = UniverseGraph(universe_data)

        # Load sector contents
        contents_path = world_data_path / "sector_contents.json"
        if not contents_path.exists():
            raise FileNotFoundError(f"Sector contents file not found: {contents_path}")

        with open(contents_path, "r") as f:
            self.sector_contents = json.load(f)
        
        # Initialize port manager with universe data
        self.port_manager = PortManager(universe_contents=self.sector_contents)

        print(f"Loaded universe with {self.universe_graph.sector_count} sectors")


# Initialize game world
game_world = GameWorld()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifespan."""
    # Startup
    try:
        game_world.load_data()
        game_world.connection_manager.start_broadcast_task()
        print("Game world loaded successfully")
        print("Firehose broadcast task started")
    except Exception as e:
        print(f"Failed to load game world: {e}")
        raise

    yield

    # Shutdown (nothing to do yet)
    pass


app = FastAPI(title="Gradient Bang", version="0.1.0", lifespan=lifespan)


# Removed Pydantic models for plot-course - using plain dictionaries


@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "name": "Gradient Bang",
        "version": "0.1.0",
        "status": "running",
        "sectors": game_world.universe_graph.sector_count if game_world.universe_graph else 0,
    }


@app.post("/api/plot_course")
async def plot_course(request: dict):
    """Calculate shortest path between two sectors."""
    if not game_world.universe_graph:
        raise HTTPException(status_code=503, detail="Game world not loaded")

    # Extract and validate parameters
    from_sector = request.get("from_sector")
    to_sector = request.get("to_sector")
    
    if from_sector is None or to_sector is None:
        raise HTTPException(status_code=400, detail="Missing from_sector or to_sector")
    
    # Validate sector IDs
    if from_sector >= game_world.universe_graph.sector_count:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid from_sector: {from_sector}. Must be < {game_world.universe_graph.sector_count}",
        )

    if to_sector >= game_world.universe_graph.sector_count:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid to_sector: {to_sector}. Must be < {game_world.universe_graph.sector_count}",
        )

    # Find path
    path = game_world.universe_graph.find_path(from_sector, to_sector)

    if path is None:
        raise HTTPException(
            status_code=404,
            detail=f"No path found from sector {from_sector} to sector {to_sector}",
        )

    return {
        "from_sector": from_sector,
        "to_sector": to_sector,
        "path": path,
        "distance": len(path) - 1,
    }


# Removed Pydantic models for JoinRequest, ShipStatus, and CharacterStatus - using plain dictionaries


def build_ship_status(character_id: str) -> dict:
    """Build ship status for a character."""
    knowledge = game_world.knowledge_manager.load_knowledge(character_id)
    ship_config = knowledge.ship_config
    ship_stats = get_ship_stats(ShipType(ship_config.ship_type))
    
    return {
        "ship_type": ship_config.ship_type,
        "ship_name": ship_stats.name,
        "cargo": ship_config.cargo,
        "cargo_capacity": ship_stats.cargo_holds,
        "cargo_used": sum(ship_config.cargo.values()),
        "warp_power": ship_config.current_warp_power,
        "warp_power_capacity": ship_stats.warp_power_capacity,
        "shields": ship_config.current_shields,
        "max_shields": ship_stats.shields,
        "fighters": ship_config.current_fighters,
        "max_fighters": ship_stats.fighters,
        "credits": knowledge.credits
    }


@app.post("/api/join")
async def join(request: dict):
    """Add a new character to the game or update an existing character's position.
    
    For new characters: Creates them at sector 0 (or specified sector if provided).
    For existing characters: Can optionally move them to a specified sector.
    """
    # Extract parameters
    character_id = request.get("character_id")
    if not character_id:
        raise HTTPException(status_code=400, detail="Missing character_id")
    
    ship_type = request.get("ship_type")
    credits = request.get("credits")
    sector = request.get("sector")
    
    is_new = character_id not in game_world.characters

    if is_new:
        # Create new character at sector 0 (or specified sector)
        start_sector = sector if sector is not None else 0
        
        # Validate sector exists
        if start_sector < 0 or start_sector >= game_world.universe_graph.sector_count:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid sector: {start_sector}. Must be between 0 and {game_world.universe_graph.sector_count - 1}"
            )
        
        character = Character(character_id, sector=start_sector)
        game_world.characters[character_id] = character
        
        # Initialize ship configuration
        validated_ship_type = None
        if ship_type:
            validated_ship_type = validate_ship_type(ship_type)
            if not validated_ship_type:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid ship type: {ship_type}"
                )
        
        # Initialize ship in character knowledge
        game_world.knowledge_manager.initialize_ship(character_id, validated_ship_type)
        
        # Set credits if provided (for new characters)
        if credits is not None:
            game_world.knowledge_manager.update_credits(character_id, credits)

        # Broadcast join event
        join_event = {
            "type": "join",
            "character_id": character_id,
            "sector": start_sector,
            "timestamp": character.last_active.isoformat(),
        }
        asyncio.create_task(game_world.connection_manager.broadcast_event(join_event))
    else:
        # Character already exists
        character = game_world.characters[character_id]
        character.update_activity()
        
        # Move to specified sector if provided
        if sector is not None:
            # Validate sector exists
            if sector < 0 or sector >= game_world.universe_graph.sector_count:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid sector: {sector}. Must be between 0 and {game_world.universe_graph.sector_count - 1}"
                )
            
            old_sector = character.sector
            character.sector = sector
            
            # Broadcast move event
            move_event = {
                "type": "admin_move",
                "character_id": character_id,
                "from_sector": old_sector,
                "to_sector": sector,
                "timestamp": character.last_active.isoformat(),
                "note": "Character moved via join endpoint"
            }
            asyncio.create_task(game_world.connection_manager.broadcast_event(move_event))
        
        # Update credits if provided (override for existing characters)
        if credits is not None:
            game_world.knowledge_manager.update_credits(character_id, credits)

    # Get sector contents for the character's current position
    sector_contents = game_world.get_sector_contents(character.sector, character_id)

    # Update character's map knowledge
    port_info = sector_contents.get("port")
    planets = sector_contents.get("planets", [])
    adjacent_sectors = sector_contents.get("adjacent_sectors", [])

    game_world.knowledge_manager.update_sector_visit(
        character_id=character_id,
        sector_id=character.sector,
        port_info=port_info,
        planets=planets,
        adjacent_sectors=adjacent_sectors,
    )

    return {
        **character.to_dict(),
        "sector_contents": sector_contents,
        "ship": build_ship_status(character.id)
    }


# Removed Pydantic model for move - using plain dictionary


@app.post("/api/move")
async def move(request: dict):
    """Move a character to an adjacent sector."""
    if not game_world.universe_graph:
        raise HTTPException(status_code=503, detail="Game world not loaded")

    # Extract parameters
    character_id = request.get("character_id")
    to_sector = request.get("to_sector")
    
    if not character_id or to_sector is None:
        raise HTTPException(status_code=400, detail="Missing character_id or to_sector")
    
    # Check if character exists
    if character_id not in game_world.characters:
        raise HTTPException(
            status_code=404,
            detail=f"Character '{character_id}' not found. Join the game first.",
        )

    character = game_world.characters[character_id]
    current_sector = character.sector

    # Validate destination sector
    if to_sector >= game_world.universe_graph.sector_count:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid sector: {to_sector}. Must be < {game_world.universe_graph.sector_count}",
        )

    # Check if destination is adjacent
    adjacent_sectors = game_world.universe_graph.adjacency.get(current_sector, [])
    if to_sector not in adjacent_sectors:
        raise HTTPException(
            status_code=400,
            detail=f"Sector {to_sector} is not adjacent to current sector {current_sector}",
        )

    # Check warp power and consume it
    knowledge = game_world.knowledge_manager.load_knowledge(character_id)
    ship_stats = get_ship_stats(ShipType(knowledge.ship_config.ship_type))
    warp_cost = ship_stats.turns_per_warp  # Each move costs turns_per_warp warp power
    
    if knowledge.ship_config.current_warp_power < warp_cost:
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient warp power. Need {warp_cost} units but only have {knowledge.ship_config.current_warp_power}",
        )
    
    # Deduct warp power
    knowledge.ship_config.current_warp_power -= warp_cost
    game_world.knowledge_manager.save_knowledge(knowledge)

    # Move the character
    old_sector = character.sector
    character.sector = to_sector
    character.update_activity()

    # Broadcast movement event to firehose
    movement_event = {
        "type": "movement",
        "character_id": character_id,
        "from_sector": old_sector,
        "to_sector": to_sector,
        "timestamp": character.last_active.isoformat(),
    }
    # Use create_task to avoid blocking the response
    asyncio.create_task(game_world.connection_manager.broadcast_event(movement_event))

    # Get sector contents for the new position
    sector_contents = game_world.get_sector_contents(character.sector, character_id)

    # Update character's map knowledge for the new sector
    port_info = sector_contents.get("port")
    planets = sector_contents.get("planets", [])
    adjacent_sectors = sector_contents.get("adjacent_sectors", [])

    game_world.knowledge_manager.update_sector_visit(
        character_id=character_id,
        sector_id=character.sector,
        port_info=port_info,
        planets=planets,
        adjacent_sectors=adjacent_sectors,
    )

    # Build the response
    return {
        **character.to_dict(),
        "sector_contents": sector_contents,
        "ship": build_ship_status(character_id)
    }


# Removed Pydantic model for StatusRequest - using plain dictionary

@app.post("/api/my_status")
async def my_status(request: dict):
    """Get the current status of a character."""
    character_id = request.get("character_id")
    if not character_id:
        raise HTTPException(status_code=400, detail="Missing character_id")
    
    if character_id not in game_world.characters:
        raise HTTPException(status_code=404, detail=f"Character '{character_id}' not found")

    character = game_world.characters[character_id]
    character.update_activity()

    # Get sector contents for the character's current position
    sector_contents = game_world.get_sector_contents(character.sector, character_id)

    return {
        **character.to_dict(),
        "sector_contents": sector_contents,
        "ship": build_ship_status(character.id)
    }


# Removed Pydantic model for MapRequest - using plain dictionary

@app.post("/api/my_map")
async def my_map(request: dict):
    """Get the map knowledge for a character."""
    character_id = request.get("character_id")
    if not character_id:
        raise HTTPException(status_code=400, detail="Missing character_id")
    
    knowledge = game_world.knowledge_manager.load_knowledge(character_id)
    return knowledge.model_dump()


# Removed Pydantic models for CheckTradeRequest and CheckTradeResponse - using plain dictionaries


@app.post("/api/check_trade")
async def check_trade(request: dict):
    """Preview a trade transaction without executing it."""
    # Extract parameters
    character_id = request.get("character_id")
    commodity = request.get("commodity")
    quantity = request.get("quantity")
    trade_type = request.get("trade_type")
    
    if not all([character_id, commodity, quantity, trade_type]):
        raise HTTPException(status_code=400, detail="Missing required parameters")
    
    # Verify character exists
    if character_id not in game_world.characters:
        raise HTTPException(status_code=404, detail="Character not found")
    
    character = game_world.characters[character_id]
    
    # Load character's current state
    knowledge = game_world.knowledge_manager.load_knowledge(character_id)
    ship_config = knowledge.ship_config
    ship_stats = get_ship_stats(ShipType(ship_config.ship_type))
    
    # Check if character is at a port
    port_state = game_world.port_manager.load_port_state(character.sector)
    if not port_state:
        return {
            "can_trade": False,
            "error": "No port at current location",
            "current_credits": knowledge.credits,
            "current_cargo": ship_config.cargo,
            "cargo_capacity": ship_stats.cargo_holds,
            "cargo_used": sum(ship_config.cargo.values())
        }
    
    # Validate commodity
    if commodity not in ["fuel_ore", "organics", "equipment"]:
        return {
            "can_trade": False,
            "error": f"Invalid commodity: {commodity}",
            "current_credits": knowledge.credits,
            "current_cargo": ship_config.cargo,
            "cargo_capacity": ship_stats.cargo_holds,
            "cargo_used": sum(ship_config.cargo.values())
        }
    
    # Get commodity key for port data
    commodity_key = {"fuel_ore": "FO", "organics": "OG", "equipment": "EQ"}[commodity]
    
    # Calculate price and validate trade
    from trading import (
        calculate_price_sell_to_player,
        calculate_price_buy_from_player,
        validate_buy_transaction,
        validate_sell_transaction,
        TradingError
    )
    
    try:
        if trade_type == "buy":
            # Check if port sells this commodity
            idx = {"FO": 0, "OG": 1, "EQ": 2}[commodity_key]
            if port_state.code[idx] != "S":
                return {
                    "can_trade": False,
                    "error": f"Port does not sell {commodity}",
                    "current_credits": knowledge.credits,
                    "current_cargo": ship_config.cargo,
                    "cargo_capacity": ship_stats.cargo_holds,
                    "cargo_used": sum(ship_config.cargo.values())
                }
            
            price_per_unit = calculate_price_sell_to_player(
                commodity,
                port_state.stock[commodity_key],
                port_state.max_capacity[commodity_key]
            )
            
            validate_buy_transaction(
                knowledge.credits,
                sum(ship_config.cargo.values()),
                ship_stats.cargo_holds,
                commodity,
                quantity,
                port_state.stock[commodity_key],
                price_per_unit
            )
            
        else:  # sell
            # Check if port buys this commodity
            idx = {"FO": 0, "OG": 1, "EQ": 2}[commodity_key]
            if port_state.code[idx] != "B":
                return {
                    "can_trade": False,
                    "error": f"Port does not buy {commodity}",
                    "current_credits": knowledge.credits,
                    "current_cargo": ship_config.cargo,
                    "cargo_capacity": ship_stats.cargo_holds,
                    "cargo_used": sum(ship_config.cargo.values())
                }
            
            price_per_unit = calculate_price_buy_from_player(
                commodity,
                port_state.stock[commodity_key],
                port_state.max_capacity[commodity_key]
            )
            
            validate_sell_transaction(
                ship_config.cargo,
                commodity,
                quantity,
                port_state.stock[commodity_key],
                port_state.max_capacity[commodity_key]
            )
        
        total_price = price_per_unit * quantity
        
        return {
            "can_trade": True,
            "price_per_unit": price_per_unit,
            "total_price": total_price,
            "current_credits": knowledge.credits,
            "current_cargo": ship_config.cargo,
            "cargo_capacity": ship_stats.cargo_holds,
            "cargo_used": sum(ship_config.cargo.values())
        }
        
    except TradingError as e:
        return {
            "can_trade": False,
            "error": str(e),
            "current_credits": knowledge.credits,
            "current_cargo": ship_config.cargo,
            "cargo_capacity": ship_stats.cargo_holds,
            "cargo_used": sum(ship_config.cargo.values())
        }


# Removed Pydantic models for TradeRequest and TradeResponse - using plain dictionaries


@app.post("/api/trade")
async def trade(request: dict):
    """Execute a trade transaction (buy only for Stage 3)."""
    # Extract parameters
    character_id = request.get("character_id")
    commodity = request.get("commodity")
    quantity = request.get("quantity")
    trade_type = request.get("trade_type")

    if not all([character_id, commodity, quantity, trade_type]):
        raise HTTPException(status_code=400, detail="Missing required parameters")

    # Verify character exists
    if character_id not in game_world.characters:
        raise HTTPException(status_code=404, detail="Character not found")
    
    character = game_world.characters[character_id]
    
    # Load character's current state
    knowledge = game_world.knowledge_manager.load_knowledge(character_id)
    ship_config = knowledge.ship_config
    ship_stats = get_ship_stats(ShipType(ship_config.ship_type))
    
    # Check if character is at a port
    port_state = game_world.port_manager.load_port_state(character.sector)
    if not port_state:
        raise HTTPException(status_code=400, detail="No port at current location")
    
    # Validate commodity
    if commodity not in ["fuel_ore", "organics", "equipment"]:
        raise HTTPException(status_code=400, detail=f"Invalid commodity: {commodity}")
    
    # Get commodity key for port data
    commodity_key = {"fuel_ore": "FO", "organics": "OG", "equipment": "EQ"}[commodity]
    
    # Import trading functions
    from trading import (
        calculate_price_sell_to_player,
        calculate_price_buy_from_player,
        validate_buy_transaction,
        validate_sell_transaction,
        TradingError,
        get_port_prices
    )
    
    try:
        if trade_type == "buy":
            # Check if port sells this commodity
            idx = {"FO": 0, "OG": 1, "EQ": 2}[commodity_key]
            if port_state.code[idx] != "S":
                raise HTTPException(status_code=400, detail=f"Port does not sell {commodity}")
            
            # Calculate price
            price_per_unit = calculate_price_sell_to_player(
                commodity,
                port_state.stock[commodity_key],
                port_state.max_capacity[commodity_key]
            )
            
            # Validate transaction
            validate_buy_transaction(
                knowledge.credits,
                sum(ship_config.cargo.values()),
                ship_stats.cargo_holds,
                commodity,
                quantity,
                port_state.stock[commodity_key],
                price_per_unit
            )
            
            total_price = price_per_unit * quantity
            
            # Execute transaction atomically
            # 1. Deduct credits
            new_credits = knowledge.credits - total_price
            game_world.knowledge_manager.update_credits(character_id, new_credits)
            
            # 2. Add cargo
            game_world.knowledge_manager.update_cargo(character_id, commodity, quantity)
            
            # 3. Update port stock
            game_world.port_manager.update_port_inventory(
                character.sector,
                commodity_key,
                quantity,
                "buy"  # Player is buying from port
            )
            
            # Reload updated states
            updated_port_state = game_world.port_manager.load_port_state(character.sector)
            updated_cargo = game_world.knowledge_manager.get_cargo(character_id)
            
            # Build port data for price calculation
            port_data = {
                "class": updated_port_state.port_class,
                "code": updated_port_state.code,
                "stock": updated_port_state.stock,
                "max_capacity": updated_port_state.max_capacity,
                "buys": [],
                "sells": []
            }
            
            # Map code to buys/sells
            commodities = [("FO", "fuel_ore"), ("OG", "organics"), ("EQ", "equipment")]
            for i, (key, name) in enumerate(commodities):
                if updated_port_state.code[i] == "B":
                    port_data["buys"].append(name)
                else:
                    port_data["sells"].append(name)
            
            # Get new prices after trade
            new_prices = get_port_prices(port_data)
            
            # Log the trade
            log_trade(
                character_id=character_id,
                sector=character.sector,
                trade_type="buy",
                commodity=commodity,
                quantity=quantity,
                price_per_unit=price_per_unit,
                total_price=total_price,
                credits_after=new_credits
            )
            
            # Broadcast trade event
            trade_event = {
                "type": "trade",
                "character_id": character_id,
                "sector": character.sector,
                "trade_type": "buy",
                "commodity": commodity,
                "quantity": quantity,
                "price_per_unit": price_per_unit,
                "total_price": total_price,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
            asyncio.create_task(game_world.connection_manager.broadcast_event(trade_event))
            
            return {
                "success": True,
                "trade_type": "buy",
                "commodity": commodity,
                "quantity": quantity,
                "price_per_unit": price_per_unit,
                "total_price": total_price,
                "new_credits": new_credits,
                "new_cargo": updated_cargo,
                "port_stock": updated_port_state.stock,
                "port_max_capacity": updated_port_state.max_capacity,
                "new_prices": new_prices
            }
            
        else:  # sell
            # Check if port buys this commodity
            idx = {"FO": 0, "OG": 1, "EQ": 2}[commodity_key]
            if port_state.code[idx] != "B":
                raise HTTPException(status_code=400, detail=f"Port does not buy {commodity}")
            
            # Calculate price
            price_per_unit = calculate_price_buy_from_player(
                commodity,
                port_state.stock[commodity_key],
                port_state.max_capacity[commodity_key]
            )
            
            # Validate transaction
            validate_sell_transaction(
                ship_config.cargo,
                commodity,
                quantity,
                port_state.stock[commodity_key],
                port_state.max_capacity[commodity_key]
            )
            
            total_price = price_per_unit * quantity
            
            # Execute transaction atomically
            # 1. Add credits
            new_credits = knowledge.credits + total_price
            game_world.knowledge_manager.update_credits(character_id, new_credits)
            
            # 2. Remove cargo
            game_world.knowledge_manager.update_cargo(character_id, commodity, -quantity)
            
            # 3. Update port stock
            game_world.port_manager.update_port_inventory(
                character.sector,
                commodity_key,
                quantity,
                "sell"  # Player is selling to port
            )
            
            # Reload updated states
            updated_port_state = game_world.port_manager.load_port_state(character.sector)
            updated_cargo = game_world.knowledge_manager.get_cargo(character_id)
            
            # Build port data for price calculation
            port_data = {
                "class": updated_port_state.port_class,
                "code": updated_port_state.code,
                "stock": updated_port_state.stock,
                "max_capacity": updated_port_state.max_capacity,
                "buys": [],
                "sells": []
            }
            
            # Map code to buys/sells
            commodities = [("FO", "fuel_ore"), ("OG", "organics"), ("EQ", "equipment")]
            for i, (key, name) in enumerate(commodities):
                if updated_port_state.code[i] == "B":
                    port_data["buys"].append(name)
                else:
                    port_data["sells"].append(name)
            
            # Get new prices after trade
            new_prices = get_port_prices(port_data)
            
            # Log the trade
            log_trade(
                character_id=character_id,
                sector=character.sector,
                trade_type="sell",
                commodity=commodity,
                quantity=quantity,
                price_per_unit=price_per_unit,
                total_price=total_price,
                credits_after=new_credits
            )
            
            # Broadcast trade event
            trade_event = {
                "type": "trade",
                "character_id": character_id,
                "sector": character.sector,
                "trade_type": "sell",
                "commodity": commodity,
                "quantity": quantity,
                "price_per_unit": price_per_unit,
                "total_price": total_price,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
            asyncio.create_task(game_world.connection_manager.broadcast_event(trade_event))
            
            return {
                "success": True,
                "trade_type": "sell",
                "commodity": commodity,
                "quantity": quantity,
                "price_per_unit": price_per_unit,
                "total_price": total_price,
                "new_credits": new_credits,
                "new_cargo": updated_cargo,
                "port_stock": updated_port_state.stock,
                "port_max_capacity": updated_port_state.max_capacity,
                "new_prices": new_prices
            }
            
    except TradingError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # Roll back changes if something went wrong
        # This is simplified - in production you'd want proper transaction handling
        raise HTTPException(status_code=500, detail=f"Transaction failed: {str(e)}")


# Removed Pydantic models for RechargeWarpPowerRequest and RechargeWarpPowerResponse - using plain dictionaries


@app.post("/api/recharge_warp_power")
async def recharge_warp_power(request: dict):
    """Recharge warp power at the special depot in sector 0.
    
    Sector 0 has a special warp power depot that sells warp power at 2 credits per unit.
    This provides a reliable way for players to recharge their ships.
    """
    # Extract parameters
    character_id = request.get("character_id")
    units = request.get("units")
    
    if not character_id or units is None:
        raise HTTPException(status_code=400, detail="Missing character_id or units")
    
    # Validate character exists
    if character_id not in game_world.characters:
        raise HTTPException(status_code=404, detail=f"Character not found: {character_id}")
    
    character = game_world.characters[character_id]
    
    # Check if character is in sector 0
    if character.sector != 0:
        raise HTTPException(
            status_code=400,
            detail=f"Warp power depot is only available in sector 0. You are in sector {character.sector}"
        )
    
    # Load character knowledge and ship stats
    knowledge = game_world.knowledge_manager.load_knowledge(character_id)
    ship_stats = get_ship_stats(ShipType(knowledge.ship_config.ship_type))
    
    # Calculate how much warp power can be recharged
    current_warp_power = knowledge.ship_config.current_warp_power
    warp_power_capacity = ship_stats.warp_power_capacity
    max_units = warp_power_capacity - current_warp_power
    
    if max_units <= 0:
        return {
            "success": False,
            "units_bought": 0,
            "price_per_unit": 2,
            "total_cost": 0,
            "new_warp_power": current_warp_power,
            "warp_power_capacity": warp_power_capacity,
            "new_credits": knowledge.credits,
            "message": "Warp power is already at maximum"
        }
    
    # Determine actual units to recharge
    units_to_buy = min(units, max_units)
    
    # Fixed price: 2 credits per warp power unit at sector 0 depot
    price_per_unit = 2
    total_cost = units_to_buy * price_per_unit
    
    # Check if character has enough credits
    if knowledge.credits < total_cost:
        return {
            "success": False,
            "units_bought": 0,
            "price_per_unit": price_per_unit,
            "total_cost": total_cost,
            "new_warp_power": current_warp_power,
            "warp_power_capacity": warp_power_capacity,
            "new_credits": knowledge.credits,
            "message": f"Insufficient credits. Need {total_cost} but only have {knowledge.credits}"
        }
    
    # Execute transaction
    new_credits = knowledge.credits - total_cost
    new_warp_power = current_warp_power + units_to_buy
    
    # Update character state
    knowledge.credits = new_credits
    knowledge.ship_config.current_warp_power = new_warp_power
    game_world.knowledge_manager.save_knowledge(knowledge)
    
    # Log the warp power purchase
    log_trade(
        character_id=character_id,
        sector=character.sector,
        trade_type="buy",
        commodity="warp_power",
        quantity=units_to_buy,
        price_per_unit=price_per_unit,
        total_price=total_cost,
        credits_after=new_credits
    )
    
    # Broadcast warp power purchase event
    warp_event = {
        "type": "warp_power_purchase",
        "character_id": character_id,
        "sector": character.sector,
        "units": units_to_buy,
        "price_per_unit": price_per_unit,
        "total_cost": total_cost,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    asyncio.create_task(game_world.connection_manager.broadcast_event(warp_event))
    
    return {
        "success": True,
        "units_bought": units_to_buy,
        "price_per_unit": price_per_unit,
        "total_cost": total_cost,
        "new_warp_power": new_warp_power,
        "warp_power_capacity": warp_power_capacity,
        "new_credits": new_credits,
        "message": f"Successfully bought {units_to_buy} warp power units for {total_cost} credits at sector 0 depot"
    }


# Removed Pydantic models for TransferWarpPowerRequest and TransferWarpPowerResponse - using plain dictionaries


@app.post("/api/transfer_warp_power")
async def transfer_warp_power(request: dict):
    """Transfer warp power from one player to another in the same sector.
    
    This allows players to help stranded players by giving them warp power.
    Both players must be in the same sector for the transfer to work.
    """
    # Extract parameters
    from_character_id = request.get("from_character_id")
    to_character_id = request.get("to_character_id")
    units = request.get("units")
    
    if not all([from_character_id, to_character_id, units]):
        raise HTTPException(status_code=400, detail="Missing required parameters")
    
    # Validate both characters exist
    if from_character_id not in game_world.characters:
        raise HTTPException(status_code=404, detail=f"Source character not found: {from_character_id}")
    
    from_character = game_world.characters[from_character_id]
    
    if to_character_id not in game_world.characters:
        raise HTTPException(status_code=404, detail=f"Target character not found: {to_character_id}")
    
    to_character = game_world.characters[to_character_id]
    
    # Check if both characters are in the same sector
    if from_character.sector != to_character.sector:
        raise HTTPException(
            status_code=400,
            detail=f"Characters must be in the same sector. {from_character_id} is in sector {from_character.sector}, "
                   f"{to_character_id} is in sector {to_character.sector}"
        )
    
    # Load knowledge for both characters
    from_knowledge = game_world.knowledge_manager.load_knowledge(from_character_id)
    to_knowledge = game_world.knowledge_manager.load_knowledge(to_character_id)
    
    # Get ship stats for both
    from_ship_stats = get_ship_stats(ShipType(from_knowledge.ship_config.ship_type))
    to_ship_stats = get_ship_stats(ShipType(to_knowledge.ship_config.ship_type))
    
    # Check if sender has enough warp power
    if from_knowledge.ship_config.current_warp_power < units:
        return {
            "success": False,
            "units_transferred": 0,
            "from_warp_power_remaining": from_knowledge.ship_config.current_warp_power,
            "to_warp_power_current": to_knowledge.ship_config.current_warp_power,
            "message": f"Insufficient warp power. {from_character_id} only has {from_knowledge.ship_config.current_warp_power} units"
        }
    
    # Calculate how much warp power can be transferred (limited by receiver's capacity)
    receiver_capacity = to_ship_stats.warp_power_capacity - to_knowledge.ship_config.current_warp_power
    units_to_transfer = min(units, receiver_capacity)
    
    if units_to_transfer <= 0:
        return {
            "success": False,
            "units_transferred": 0,
            "from_warp_power_remaining": from_knowledge.ship_config.current_warp_power,
            "to_warp_power_current": to_knowledge.ship_config.current_warp_power,
            "message": f"{to_character_id}'s warp power is already at maximum"
        }
    
    # Execute the transfer
    from_knowledge.ship_config.current_warp_power -= units_to_transfer
    to_knowledge.ship_config.current_warp_power += units_to_transfer
    
    # Save both characters
    game_world.knowledge_manager.save_knowledge(from_knowledge)
    game_world.knowledge_manager.save_knowledge(to_knowledge)
    
    # Log the transfer
    log_trade(
        character_id=from_character_id,
        sector=from_character.sector,
        trade_type="transfer",
        commodity="warp_power",
        quantity=units_to_transfer,
        price_per_unit=0,
        total_price=0,
        credits_after=from_knowledge.credits
    )
    
    # Broadcast warp power transfer event
    transfer_event = {
        "type": "warp_power_transfer",
        "from_character_id": from_character_id,
        "to_character_id": to_character_id,
        "sector": from_character.sector,
        "units": units_to_transfer,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    asyncio.create_task(game_world.connection_manager.broadcast_event(transfer_event))
    
    return {
        "success": True,
        "units_transferred": units_to_transfer,
        "from_warp_power_remaining": from_knowledge.ship_config.current_warp_power,
        "to_warp_power_current": to_knowledge.ship_config.current_warp_power,
        "message": f"Successfully transferred {units_to_transfer} warp power units from {from_character_id} to {to_character_id}"
    }


@app.post("/api/reset_ports")
async def reset_ports():
    """Reset all ports to their initial state from universe data.
    
    WARNING: This will delete all port state files and recreate them from
    the original universe data, losing all trade history effects on inventory.
    """
    try:
        count = game_world.port_manager.reset_all_ports()
        
        # Broadcast reset event
        reset_event = {
            "type": "port_reset",
            "ports_reset": count,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
        asyncio.create_task(game_world.connection_manager.broadcast_event(reset_event))
        
        return {
            "success": True,
            "message": f"Reset {count} ports to initial state",
            "ports_reset": count
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to reset ports: {str(e)}")


# Removed Pydantic model for RegeneratePortsRequest - using plain dictionary


@app.post("/api/regenerate_ports")
async def regenerate_ports(request: dict):
    """Partially regenerate all port inventories.
    
    This simulates daily trade/restocking:
    - Ports that sell commodities get more stock
    - Ports that buy commodities get more demand capacity
    
    Args:
        fraction: Fraction of max capacity to regenerate (0.0 to 1.0)
                 Default 0.25 means 25% of max capacity is added
    """
    # Extract parameters with default
    fraction = request.get("fraction", 0.25)
    if not (0.0 <= fraction <= 1.0):
        raise HTTPException(status_code=400, detail="Fraction must be between 0.0 and 1.0")
    
    try:
        count = game_world.port_manager.regenerate_ports(fraction)
        
        # Broadcast regeneration event
        regen_event = {
            "type": "port_regeneration",
            "ports_regenerated": count,
            "fraction": fraction,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
        asyncio.create_task(game_world.connection_manager.broadcast_event(regen_event))
        
        return {
            "success": True,
            "message": f"Regenerated {count} ports with {fraction:.1%} of max capacity",
            "ports_regenerated": count,
            "fraction": fraction
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to regenerate ports: {str(e)}")


@app.websocket("/api/firehose")
async def websocket_firehose(websocket: WebSocket):
    """WebSocket endpoint for real-time game events."""
    await game_world.connection_manager.connect(websocket)
    try:
        # Keep the connection alive
        while True:
            # Wait for any message from client (like ping/pong)
            await websocket.receive_text()
    except WebSocketDisconnect:
        game_world.connection_manager.disconnect(websocket)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
