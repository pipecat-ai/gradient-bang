import json
import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Set, Optional, Any
from collections import deque

from contextlib import asynccontextmanager

from fastapi import FastAPI

from character_knowledge import CharacterKnowledgeManager
from port_manager import PortManager
from .config import get_world_data_path


class UniverseGraph:
    def __init__(self, universe_data: dict):
        self.sector_count = universe_data["meta"]["sector_count"]
        self.adjacency: Dict[int, List[int]] = {}
        for sector in universe_data["sectors"]:
            sector_id = sector["id"]
            self.adjacency[sector_id] = [warp["to"] for warp in sector["warps"]]

    def find_path(self, start: int, end: int) -> Optional[List[int]]:
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


class Character:
    def __init__(self, character_id: str, sector: int = 0):
        self.id = character_id
        self.sector = sector
        self.last_active = datetime.now(timezone.utc)

    def update_activity(self):
        self.last_active = datetime.now(timezone.utc)

    def to_response(self) -> dict:
        # Do not leak character_id beyond name
        return {
            "name": self.id,
            "sector": self.sector,
            "last_active": self.last_active.isoformat(),
        }


class ConnectionManager:
    def __init__(self):
        self.active_connections: List[Any] = []  # WebSocket objects
        self.event_queue: asyncio.Queue = asyncio.Queue()
        self.broadcast_task: Optional[asyncio.Task] = None

    async def connect(self, websocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast_event(self, event: dict):
        await self.event_queue.put({"type": "event", **event})

    async def _broadcast_worker(self):
        while True:
            event = await self.event_queue.get()
            disconnected = []
            for connection in self.active_connections:
                try:
                    await connection.send_json(event)
                except Exception:
                    disconnected.append(connection)
            for conn in disconnected:
                self.disconnect(conn)

    def start_broadcast_task(self):
        if self.broadcast_task is None:
            self.broadcast_task = asyncio.create_task(self._broadcast_worker())


class GameWorld:
    def __init__(self):
        self.universe_graph: Optional[UniverseGraph] = None
        self.sector_contents: Optional[dict] = None
        self.characters: Dict[str, Character] = {}
        self.connection_manager = ConnectionManager()
        self.knowledge_manager = CharacterKnowledgeManager()
        self.port_manager: Optional[PortManager] = None

    def load_data(self):
        world_data_path = get_world_data_path()

        universe_path = world_data_path / "universe_structure.json"
        if not universe_path.exists():
            raise FileNotFoundError(f"Universe structure file not found: {universe_path}")
        with open(universe_path, "r") as f:
            universe_data = json.load(f)
        self.universe_graph = UniverseGraph(universe_data)

        contents_path = world_data_path / "sector_contents.json"
        if not contents_path.exists():
            raise FileNotFoundError(f"Sector contents file not found: {contents_path}")
        with open(contents_path, "r") as f:
            self.sector_contents = json.load(f)

        self.port_manager = PortManager(universe_contents=self.sector_contents)


world = GameWorld()


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        world.load_data()
        world.connection_manager.start_broadcast_task()
    except Exception as e:
        print(f"Failed to load game world: {e}")
        raise
    yield
