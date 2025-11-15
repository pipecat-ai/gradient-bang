import json
from datetime import datetime, timezone
from typing import Dict, List, Set, Optional, Tuple
from collections import deque, defaultdict

from contextlib import asynccontextmanager

from fastapi import FastAPI
from loguru import logger

from gradientbang.game_server.character_knowledge import CharacterKnowledgeManager
from gradientbang.game_server.port_manager import PortManager
from gradientbang.utils.config import get_world_data_path
from gradientbang.game_server.combat import CombatManager, GarrisonStore, SalvageManager
from gradientbang.game_server.ships import ShipType, get_ship_stats
from gradientbang.game_server.core.character_registry import CharacterRegistry
from gradientbang.game_server.core.ships_manager import ShipsManager
from gradientbang.game_server.core.corporation_manager import CorporationManager


class UniverseGraph:
    def __init__(self, universe_data: dict):
        self.sector_count = universe_data["meta"]["sector_count"]
        self.adjacency: Dict[int, List[int]] = {}
        self.positions: Dict[int, Tuple[int, int]] = {}
        # Store warp metadata: sector_id -> list of {to, two_way, hyperlane}
        self.warps: Dict[int, List[Dict[str, any]]] = {}

        undirected: Dict[int, set[int]] = defaultdict(set)

        for sector in universe_data["sectors"]:
            sector_id = sector["id"]
            self.positions[sector_id] = [
                sector["position"].get("x"),
                sector["position"].get("y"),
            ]

            # Parse warp metadata
            warp_list = []
            for warp in sector["warps"]:
                warp_list.append({
                    "to": warp["to"],
                    "two_way": warp.get("two_way", False),
                    "hyperlane": warp.get("is_hyperlane", False),
                })
            self.warps[sector_id] = warp_list

            targets = [warp["to"] for warp in sector["warps"]]
            self.adjacency[sector_id] = targets
            for target in targets:
                undirected[sector_id].add(target)
                undirected[target].add(sector_id)

        # Freeze undirected adjacency into regular dicts for easier access
        self.undirected_adjacency: Dict[int, List[int]] = {
            sector_id: sorted(neighbors) for sector_id, neighbors in undirected.items()
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
        name: Optional[str] = None,
        fighters: int = 0,
        shields: int = 0,
        max_fighters: int = 0,
        max_shields: int = 0,
        first_visit: Optional[datetime] = None,
        last_active: Optional[datetime] = None,
        player_type: Optional[str] = None,
        connected: bool = True,
        in_hyperspace: bool = False,
    ) -> None:
        self.id = character_id
        self.name = name or character_id
        self.sector = sector
        self.last_active = last_active or datetime.now(timezone.utc)
        self.first_visit = first_visit or datetime.now(timezone.utc)
        self.fighters = fighters
        self.shields = shields
        self.max_fighters = max_fighters
        self.max_shields = max_shields
        self.player_type = player_type or "human"
        self.connected = connected
        self.in_hyperspace = in_hyperspace

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
        """Serialize character summary for admin responses."""
        return {
            "id": self.id,
            "name": self.name,
            "sector": self.sector,
            "last_active": self.last_active.isoformat(),
            "first_visit": self.first_visit.isoformat(),
        }


class GameWorld:
    def __init__(self):
        self.world_data_dir = get_world_data_path()
        self.universe_graph: Optional[UniverseGraph] = None
        self.sector_contents: Optional[dict] = None
        self.characters: Dict[str, Character] = {}
        self.knowledge_manager = CharacterKnowledgeManager()
        self.port_manager: Optional[PortManager] = None
        self.combat_manager: Optional[CombatManager] = None
        self.garrisons: Optional[GarrisonStore] = None
        self.salvage_manager: Optional[SalvageManager] = None
        self.character_registry: Optional[CharacterRegistry] = None
        self.ships_manager = ShipsManager(self.world_data_dir)
        self.knowledge_manager.set_ships_manager(self.ships_manager)
        self.corporation_manager = CorporationManager(self.world_data_dir)
        self.character_to_corp: Dict[str, str] = {}

    def load_data(self):
        world_data_path = self.world_data_dir

        universe_path = world_data_path / "universe_structure.json"
        if not universe_path.exists():
            raise FileNotFoundError(
                f"Universe structure file not found: {universe_path}"
            )
        with open(universe_path, "r") as f:
            universe_data = json.load(f)
        self.universe_graph = UniverseGraph(universe_data)

        contents_path = world_data_path / "sector_contents.json"
        if not contents_path.exists():
            raise FileNotFoundError(f"Sector contents file not found: {contents_path}")
        with open(contents_path, "r") as f:
            self.sector_contents = json.load(f)

        self.port_manager = PortManager(universe_contents=self.sector_contents)

        registry_path = world_data_path / "characters.json"
        self.character_registry = CharacterRegistry(registry_path)
        self.character_registry.load()

        garrison_path = world_data_path / "sector_garrisons.json"
        self.garrisons = GarrisonStore(garrison_path)
        self.combat_manager = CombatManager()
        self.salvage_manager = SalvageManager()
        self.ships_manager.load_all_ships()
        self._rebuild_character_to_corp_cache()

        # Hydrate characters from persisted knowledge so they appear immediately.
        for knowledge in self.knowledge_manager.iter_saved_knowledge():
            if knowledge.current_sector is None:
                continue
            ship = self.knowledge_manager.get_ship(knowledge.character_id)
            try:
                ship_type = ShipType(ship["ship_type"])
            except ValueError:
                ship_type = ShipType.KESTREL_COURIER
            stats = get_ship_stats(ship_type)
            state = ship.get("state", {})
            last_active = _parse_timestamp(knowledge.last_update)
            display_name = knowledge.character_id
            if self.character_registry:
                profile = self.character_registry.get_profile(knowledge.character_id)
                if profile:
                    display_name = profile.name
            player_type = "human"
            if ship.get("owner_type") == "corporation" and ship.get("ship_id") == knowledge.character_id:
                player_type = "corporation_ship"
            character = Character(
                knowledge.character_id,
                sector=knowledge.current_sector,
                name=display_name,
                fighters=state.get("fighters", stats.fighters),
                shields=state.get("shields", stats.shields),
                max_fighters=stats.fighters,
                max_shields=stats.shields,
                last_active=last_active,
                connected=False,
                player_type=player_type,
            )
            self.characters[knowledge.character_id] = character

    def _rebuild_character_to_corp_cache(self) -> None:
        """Populate in-memory character -> corporation cache."""
        self.character_to_corp.clear()
        try:
            corp_summaries = self.corporation_manager.list_all()
        except Exception:  # noqa: BLE001
            return
        for summary in corp_summaries:
            corp_id = summary.get("corp_id")
            if not corp_id:
                continue
            try:
                corp = self.corporation_manager.load(corp_id)
            except FileNotFoundError:
                continue
            members = corp.get("members", [])
            for member_id in members:
                if isinstance(member_id, str) and member_id:
                    self.character_to_corp[member_id] = corp_id
            for ship_id in corp.get("ships", []) or []:
                if isinstance(ship_id, str) and ship_id:
                    self.character_to_corp[ship_id] = corp_id


world = GameWorld()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Note: world data check does not raise an exception 
    so FastAPI process will remain active. This allows
    manual universe-bang via ssh
    """
    try:
        world.load_data()
        logger.info("Game world loaded successfully")
    except FileNotFoundError as e:
        logger.error(f"World data not found: {e}")
        logger.error("Server running without world data - manual universe-bang required")
    except Exception as e:
        logger.error(f"Failed to load game world: {e}")
    yield
