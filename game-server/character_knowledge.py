#!/usr/bin/env python3
"""
Character map knowledge persistence for Gradient Bang.

This module handles storing and retrieving map knowledge for each character,
including visited sectors, discovered ports, and learned connections.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Set, Optional, Any
from pydantic import BaseModel, Field
from ships import ShipType, get_ship_stats


class SectorKnowledge(BaseModel):
    """Knowledge about a specific sector."""
    sector_id: int
    last_visited: str
    port_info: Optional[dict] = None
    planets: List[dict] = []
    adjacent_sectors: List[int] = []


class ShipConfiguration(BaseModel):
    """Current ship configuration for a character."""
    ship_type: str = ShipType.KESTREL_COURIER.value
    cargo: Dict[str, int] = {"fuel_ore": 0, "organics": 0, "equipment": 0}
    current_warp_power: int = 300  # Start with full warp power for Kestrel
    current_shields: int = 150  # Start with full shields
    current_fighters: int = 300  # Start with full fighters
    equipped_modules: List[str] = []


class MapKnowledge(BaseModel):
    """Complete map knowledge for a character."""
    character_id: str
    sectors_visited: Dict[str, SectorKnowledge] = {}  # sector_id as string -> knowledge
    total_sectors_visited: int = 0
    first_visit: Optional[str] = None
    last_update: Optional[str] = None
    ship_config: ShipConfiguration = Field(default_factory=ShipConfiguration)
    credits: int = 1000  # Starting credits


class CharacterKnowledgeManager:
    """Manages persistent map knowledge for all characters."""
    
    def __init__(self, data_dir: Path = None):
        """Initialize the knowledge manager.
        
        Args:
            data_dir: Directory to store character knowledge files
        """
        if data_dir is None:
            # Default to world-data/character-map-knowledge
            self.data_dir = Path(__file__).parent.parent / "world-data" / "character-map-knowledge"
        else:
            self.data_dir = data_dir
        
        # Ensure directory exists
        self.data_dir.mkdir(parents=True, exist_ok=True)
        
        # Cache for loaded knowledge
        self.cache: Dict[str, MapKnowledge] = {}
    
    def initialize_ship(self, character_id: str, ship_type: Optional[ShipType] = None):
        """Initialize or update a character's ship configuration.
        
        Args:
            character_id: Character ID
            ship_type: Ship type to assign (defaults to Kestrel Courier)
        """
        knowledge = self.load_knowledge(character_id)
        
        if ship_type is None:
            ship_type = ShipType.KESTREL_COURIER
        
        # Get ship stats
        stats = get_ship_stats(ship_type)
        
        # Update ship configuration
        knowledge.ship_config = ShipConfiguration(
            ship_type=ship_type.value,
            cargo={"fuel_ore": 0, "organics": 0, "equipment": 0},
            current_warp_power=stats.warp_power_capacity,  # Start with full warp power
            current_shields=stats.shields,  # Start with full shields
            current_fighters=stats.fighters,  # Start with full fighters
            equipped_modules=[]
        )
        
        # Save the updated knowledge
        self.save_knowledge(knowledge)
    
    def get_file_path(self, character_id: str) -> Path:
        """Get the file path for a character's knowledge.
        
        Args:
            character_id: Character ID
            
        Returns:
            Path to the character's knowledge file
        """
        # Sanitize character ID for filename
        safe_id = "".join(c if c.isalnum() or c in "_-" else "_" for c in character_id)
        return self.data_dir / f"{safe_id}.json"
    
    def load_knowledge(self, character_id: str) -> MapKnowledge:
        """Load map knowledge for a character.
        
        Args:
            character_id: Character ID
            
        Returns:
            Character's map knowledge
        """
        # Check cache first
        if character_id in self.cache:
            return self.cache[character_id]
        
        file_path = self.get_file_path(character_id)
        
        if file_path.exists():
            try:
                with open(file_path, "r") as f:
                    data = json.load(f)
                knowledge = MapKnowledge(**data)
            except Exception as e:
                print(f"Error loading knowledge for {character_id}: {e}")
                # Create new knowledge if load fails
                knowledge = MapKnowledge(character_id=character_id)
        else:
            # Create new knowledge for character
            knowledge = MapKnowledge(character_id=character_id)
        
        # Cache the knowledge
        self.cache[character_id] = knowledge
        return knowledge
    
    def save_knowledge(self, knowledge: MapKnowledge):
        """Save map knowledge for a character.
        
        Args:
            knowledge: Character's map knowledge
        """
        file_path = self.get_file_path(knowledge.character_id)
        
        try:
            with open(file_path, "w") as f:
                json.dump(knowledge.model_dump(), f, indent=2)
            
            # Update cache
            self.cache[knowledge.character_id] = knowledge
        except Exception as e:
            print(f"Error saving knowledge for {knowledge.character_id}: {e}")
    
    def update_sector_visit(
        self,
        character_id: str,
        sector_id: int,
        port_info: Optional[dict] = None,
        planets: List[dict] = None,
        adjacent_sectors: List[int] = None
    ):
        """Update knowledge when a character visits a sector.
        
        Args:
            character_id: Character ID
            sector_id: Sector visited
            port_info: Port information if present
            planets: Planet information if present
            adjacent_sectors: Adjacent sectors discovered
        """
        knowledge = self.load_knowledge(character_id)
        
        now = datetime.now(timezone.utc).isoformat()
        sector_key = str(sector_id)
        
        # Update first visit time if needed
        if knowledge.first_visit is None:
            knowledge.first_visit = now
        
        # Create or update sector knowledge
        if sector_key not in knowledge.sectors_visited:
            knowledge.total_sectors_visited += 1
        
        sector_knowledge = SectorKnowledge(
            sector_id=sector_id,
            last_visited=now,
            port_info=port_info,
            planets=planets or [],
            adjacent_sectors=adjacent_sectors or []
        )
        
        # Merge with existing knowledge if present
        if sector_key in knowledge.sectors_visited:
            existing = knowledge.sectors_visited[sector_key]
            # Update with new information but keep existing if not provided
            if port_info is not None:
                sector_knowledge.port_info = port_info
            elif existing.port_info is not None:
                sector_knowledge.port_info = existing.port_info
            
            if planets:
                sector_knowledge.planets = planets
            elif existing.planets:
                sector_knowledge.planets = existing.planets
            
            if adjacent_sectors:
                sector_knowledge.adjacent_sectors = adjacent_sectors
            elif existing.adjacent_sectors:
                sector_knowledge.adjacent_sectors = existing.adjacent_sectors
        
        knowledge.sectors_visited[sector_key] = sector_knowledge
        knowledge.last_update = now
        
        # Save to disk
        self.save_knowledge(knowledge)
    
    def get_known_ports(self, character_id: str) -> List[Dict[str, Any]]:
        """Get all ports known by a character.
        
        Args:
            character_id: Character ID
            
        Returns:
            List of known ports with sector information
        """
        knowledge = self.load_knowledge(character_id)
        ports = []
        
        for sector_key, sector_knowledge in knowledge.sectors_visited.items():
            if sector_knowledge.port_info:
                port_data = {
                    "sector": sector_knowledge.sector_id,
                    "last_visited": sector_knowledge.last_visited,
                    **sector_knowledge.port_info
                }
                ports.append(port_data)
        
        return ports
    
    def find_nearest_port_with_commodity(
        self,
        character_id: str,
        current_sector: int,
        commodity: str,
        buy_or_sell: str,
        universe_graph
    ) -> Optional[Dict[str, Any]]:
        """Find the nearest known port that buys or sells a commodity.
        
        Args:
            character_id: Character ID
            current_sector: Current sector of the character
            commodity: Commodity to search for
            buy_or_sell: "buy" or "sell"
            universe_graph: Universe graph for pathfinding
            
        Returns:
            Port information with distance, or None if not found
        """
        knowledge = self.load_knowledge(character_id)
        matching_ports = []
        
        for sector_key, sector_knowledge in knowledge.sectors_visited.items():
            if sector_knowledge.port_info:
                port_info = sector_knowledge.port_info
                
                # Check if port has the commodity
                if buy_or_sell == "sell" and commodity in port_info.get("sells", []):
                    matching_ports.append({
                        "sector": sector_knowledge.sector_id,
                        "port": port_info,
                        "last_visited": sector_knowledge.last_visited
                    })
                elif buy_or_sell == "buy" and commodity in port_info.get("buys", []):
                    matching_ports.append({
                        "sector": sector_knowledge.sector_id,
                        "port": port_info,
                        "last_visited": sector_knowledge.last_visited
                    })
        
        if not matching_ports:
            return None
        
        # Find closest port
        closest = None
        min_distance = float('inf')
        
        for port_data in matching_ports:
            path = universe_graph.find_path(current_sector, port_data["sector"])
            if path:
                distance = len(path) - 1
                if distance < min_distance:
                    min_distance = distance
                    closest = {
                        **port_data,
                        "distance": distance,
                        "path": path
                    }
        
        return closest
    
    def get_adjacent_port_pairs(self, character_id: str) -> List[Dict[str, Any]]:
        """Find all known pairs of ports in adjacent sectors.
        
        Args:
            character_id: Character ID
            
        Returns:
            List of adjacent port pairs
        """
        knowledge = self.load_knowledge(character_id)
        port_pairs = []
        
        # Get all sectors with ports
        port_sectors = {}
        for sector_key, sector_knowledge in knowledge.sectors_visited.items():
            if sector_knowledge.port_info:
                port_sectors[sector_knowledge.sector_id] = sector_knowledge
        
        # Check for adjacent pairs
        for sector_id, sector_knowledge in port_sectors.items():
            for adjacent in sector_knowledge.adjacent_sectors:
                if adjacent in port_sectors and adjacent > sector_id:  # Avoid duplicates
                    pair = {
                        "sector1": sector_id,
                        "port1": sector_knowledge.port_info,
                        "sector2": adjacent,
                        "port2": port_sectors[adjacent].port_info
                    }
                    port_pairs.append(pair)
        
        return port_pairs
    
    def update_credits(self, character_id: str, credits: int) -> None:
        """Update a character's credits and save to disk.
        
        Args:
            character_id: Character ID
            credits: New credit amount
        """
        knowledge = self.load_knowledge(character_id)
        knowledge.credits = credits
        self.save_knowledge(knowledge)
    
    def get_credits(self, character_id: str) -> int:
        """Get a character's current credits.
        
        Args:
            character_id: Character ID
            
        Returns:
            Current credit amount
        """
        knowledge = self.load_knowledge(character_id)
        return knowledge.credits
    
    def update_cargo(self, character_id: str, commodity: str, quantity_delta: int) -> None:
        """Update a character's cargo and save to disk.
        
        Args:
            character_id: Character ID
            commodity: Commodity type (fuel_ore, organics, equipment)
            quantity_delta: Change in quantity (positive for add, negative for remove)
        """
        knowledge = self.load_knowledge(character_id)
        current = knowledge.ship_config.cargo.get(commodity, 0)
        knowledge.ship_config.cargo[commodity] = max(0, current + quantity_delta)
        self.save_knowledge(knowledge)
    
    def get_cargo(self, character_id: str) -> Dict[str, int]:
        """Get a character's current cargo.
        
        Args:
            character_id: Character ID
            
        Returns:
            Current cargo dictionary
        """
        knowledge = self.load_knowledge(character_id)
        return knowledge.ship_config.cargo.copy()
