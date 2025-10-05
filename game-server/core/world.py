import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Set, Optional, Any, Tuple
from collections import deque, defaultdict

from contextlib import asynccontextmanager

from fastapi import FastAPI

from character_knowledge import CharacterKnowledgeManager
from port_manager import PortManager
from .config import get_world_data_path
from combat import CombatManager, GarrisonStore, SalvageManager
from ships import ShipType, get_ship_stats


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


def _parse_timestamp(value: Optional[str]) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    try:
        timestamp = datetime.fromisoformat(value)
    except ValueError:
        return datetime.now(timezone.utc)
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    return timestamp


class Character:
    def __init__(
        self,
        character_id: str,
        sector: int = 0,
        *,
        fighters: int = 0,
        shields: int = 0,
        max_fighters: int = 0,
        max_shields: int = 0,
        last_active: Optional[datetime] = None,
        connected: bool = True,
    ) -> None:
        self.id = character_id
        self.sector = sector
        self.last_active = last_active or datetime.now(timezone.utc)
        self.fighters = fighters
        self.shields = shields
        self.max_fighters = max_fighters
        self.max_shields = max_shields
        self.connected = connected

    def update_activity(self) -> None:
        self.last_active = datetime.now(timezone.utc)
        self.connected = True

    def update_ship_state(
        self,
        *,
        fighters: Optional[int] = None,
        shields: Optional[int] = None,
        max_fighters: Optional[int] = None,
        max_shields: Optional[int] = None,
    ) -> None:
        if fighters is not None:
            self.fighters = fighters
        if shields is not None:
            self.shields = shields
        if max_fighters is not None:
            self.max_fighters = max_fighters
        if max_shields is not None:
            self.max_shields = max_shields

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
        self.combat_manager: Optional[CombatManager] = None
        self.garrisons: Optional[GarrisonStore] = None
        self.salvage_manager: Optional[SalvageManager] = None

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

        garrison_path = world_data_path / "sector_garrisons.json"
        self.garrisons = GarrisonStore(garrison_path)
        self.combat_manager = CombatManager()
        self.salvage_manager = SalvageManager()

        # Hydrate characters from persisted knowledge so they appear immediately.
        for knowledge in self.knowledge_manager.iter_saved_knowledge():
            if knowledge.current_sector is None:
                continue
            try:
                ship_type = ShipType(knowledge.ship_config.ship_type)
            except ValueError:
                continue
            stats = get_ship_stats(ship_type)
            last_active = _parse_timestamp(knowledge.last_update)
            character = Character(
                knowledge.character_id,
                sector=knowledge.current_sector,
                fighters=knowledge.ship_config.current_fighters,
                shields=knowledge.ship_config.current_shields,
                max_fighters=stats.fighters,
                max_shields=stats.shields,
                last_active=last_active,
                connected=False,
            )
            self.characters[knowledge.character_id] = character


world = GameWorld()


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        world.load_data()
    except Exception as e:
        print(f"Failed to load game world: {e}")
        raise
    yield
