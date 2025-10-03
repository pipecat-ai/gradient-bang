import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Set, Optional, Tuple
from collections import deque, defaultdict

from contextlib import asynccontextmanager

from fastapi import FastAPI

from character_knowledge import CharacterKnowledgeManager
from port_manager import PortManager
from config import get_world_data_path


class UniverseGraph:
    def __init__(self, universe_data: dict):
        self.sector_count = universe_data["meta"]["sector_count"]
        self.adjacency: Dict[int, List[int]] = {}
        self.positions: Dict[int, Tuple[int, int]] = {}

        undirected: Dict[int, set[int]] = defaultdict(set)

        for sector in universe_data["sectors"]:
            sector_id = sector["id"]
            self.positions[sector_id] = [sector["position"].get("x"), sector["position"].get("y")]
            targets = [warp["to"] for warp in sector["warps"]]
            self.adjacency[sector_id] = targets
            for target in targets:
                undirected[sector_id].add(target)
                undirected[target].add(sector_id)

        # Freeze undirected adjacency into regular dicts for easier access
        self.undirected_adjacency: Dict[int, List[int]] = {
            sector_id: sorted(neighbors)
            for sector_id, neighbors in undirected.items()
        }

    def neighbors(self, sector_id: int) -> set[int]:
        """Return the undirected neighbor set for a sector."""
        return set(self.undirected_adjacency.get(sector_id, []))

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


class GameWorld:
    def __init__(self):
        self.universe_graph: Optional[UniverseGraph] = None
        self.sector_contents: Optional[dict] = None
        self.characters: Dict[str, Character] = {}
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
    except Exception as e:
        print(f"Failed to load game world: {e}")
        raise
    yield
