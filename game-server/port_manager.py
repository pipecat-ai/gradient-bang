"""Port state management for Gradient Bang.

Manages persistent port inventory states separate from universe data.
"""

import json
from pathlib import Path
from typing import Dict, Optional, Any
from datetime import datetime, timezone
from dataclasses import dataclass, asdict


@dataclass
class PortState:
    """Current state of a port's inventory."""
    sector_id: int
    port_class: int
    code: str
    stock: Dict[str, int]  # FO, OG, EQ -> current inventory
    max_capacity: Dict[str, int]  # FO, OG, EQ -> maximum capacity
    last_updated: str  # ISO timestamp
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PortState":
        """Create from dictionary."""
        return cls(**data)
    
    @classmethod
    def from_universe_data(cls, sector_id: int, port_data: Dict[str, Any]) -> "PortState":
        """Create initial state from universe sector data.
        
        Args:
            sector_id: Sector ID where port is located
            port_data: Port data from sector_contents.json
            
        Returns:
            New PortState instance
        """
        # Convert old format to new format
        # For commodities the port SELLS: use existing stock
        # For commodities the port BUYS: stock = max_capacity - demand (how much they already have)
        stock = {}
        max_capacity = {}
        
        commodities = [("FO", 0), ("OG", 1), ("EQ", 2)]
        for key, idx in commodities:
            if port_data["code"][idx] == "S":  # Port sells this
                stock[key] = port_data["stock"].get(key, 0)
                max_capacity[key] = port_data["stock_max"].get(key, 1000)
            else:  # Port buys this
                # Convert demand to stock: if demand is 700/1000, stock is 300
                demand = port_data.get("demand", {}).get(key, 700)
                demand_max = port_data.get("demand_max", {}).get(key, 1000)
                stock[key] = demand_max - demand
                max_capacity[key] = demand_max
        
        return cls(
            sector_id=sector_id,
            port_class=port_data["class"],
            code=port_data["code"],
            stock=stock,
            max_capacity=max_capacity,
            last_updated=datetime.now(timezone.utc).isoformat()
        )


class PortManager:
    """Manages persistent port states."""
    
    def __init__(self, data_dir: Path = None, universe_contents: Dict = None):
        """Initialize the port manager.
        
        Args:
            data_dir: Directory to store port state files
            universe_contents: Loaded sector_contents.json data
        """
        if data_dir is None:
            # Default to world-data/port-states
            self.data_dir = Path(__file__).parent.parent / "world-data" / "port-states"
        else:
            self.data_dir = data_dir
        
        # Ensure directory exists
        self.data_dir.mkdir(parents=True, exist_ok=True)
        
        # Cache for loaded states
        self.cache: Dict[int, PortState] = {}
        
        # Reference to universe data for initialization
        self.universe_contents = universe_contents
    
    def get_file_path(self, sector_id: int) -> Path:
        """Get the file path for a port's state.
        
        Args:
            sector_id: Sector ID where port is located
            
        Returns:
            Path to the port state file
        """
        return self.data_dir / f"sector_{sector_id}.json"
    
    def load_port_state(self, sector_id: int) -> Optional[PortState]:
        """Load port state for a sector.
        
        Args:
            sector_id: Sector ID to load
            
        Returns:
            Port state or None if sector has no port
        """
        # Check cache first
        if sector_id in self.cache:
            return self.cache[sector_id]
        
        file_path = self.get_file_path(sector_id)
        
        if file_path.exists():
            # Load existing state
            try:
                with open(file_path, "r") as f:
                    data = json.load(f)
                state = PortState.from_dict(data)
                self.cache[sector_id] = state
                return state
            except Exception as e:
                print(f"Error loading port state for sector {sector_id}: {e}")
        
        # Initialize from universe data if no state file exists
        if self.universe_contents and sector_id < len(self.universe_contents.get("sectors", [])):
            sector_data = self.universe_contents["sectors"][sector_id]
            if sector_data.get("port"):
                state = PortState.from_universe_data(sector_id, sector_data["port"])
                self.save_port_state(state)
                return state
        
        return None
    
    def save_port_state(self, state: PortState) -> None:
        """Save port state to disk.
        
        Args:
            state: Port state to save
        """
        state.last_updated = datetime.now(timezone.utc).isoformat()
        
        file_path = self.get_file_path(state.sector_id)
        try:
            with open(file_path, "w") as f:
                json.dump(state.to_dict(), f, indent=2)
            
            # Update cache
            self.cache[state.sector_id] = state
        except Exception as e:
            print(f"Error saving port state for sector {state.sector_id}: {e}")
    
    def update_port_inventory(
        self,
        sector_id: int,
        commodity_key: str,  # "FO", "OG", or "EQ"
        quantity: int,
        transaction_type: str  # "buy" or "sell" from player perspective
    ) -> Optional[PortState]:
        """Update port inventory levels.
        
        Args:
            sector_id: Sector ID of port
            commodity_key: Commodity key ("FO", "OG", "EQ")
            quantity: Amount being traded (positive)
            transaction_type: "buy" (player buys from port) or "sell" (player sells to port)
            
        Returns:
            Updated port state or None if no port
        """
        state = self.load_port_state(sector_id)
        if not state:
            return None
        
        # Update stock based on transaction type
        if commodity_key in state.stock:
            if transaction_type == "buy":  # Player buys from port, port stock decreases
                state.stock[commodity_key] = max(0, state.stock[commodity_key] - quantity)
            else:  # Player sells to port, port stock increases
                state.stock[commodity_key] = min(
                    state.max_capacity[commodity_key],
                    state.stock[commodity_key] + quantity
                )
        
        self.save_port_state(state)
        return state
    
    def reset_all_ports(self) -> int:
        """Reset all ports to their initial universe state.
        
        Returns:
            Number of ports reset
        """
        count = 0
        
        if not self.universe_contents:
            raise ValueError("No universe contents available for reset")
        
        # Clear cache
        self.cache.clear()
        
        # Delete all existing state files
        for file_path in self.data_dir.glob("sector_*.json"):
            try:
                file_path.unlink()
            except Exception as e:
                print(f"Error deleting {file_path}: {e}")
        
        # Recreate states from universe data
        for sector_data in self.universe_contents.get("sectors", []):
            if sector_data.get("port"):
                state = PortState.from_universe_data(
                    sector_data["id"],
                    sector_data["port"]
                )
                self.save_port_state(state)
                count += 1
        
        return count
    
    def regenerate_ports(self, fraction: float = 0.25) -> int:
        """Partially regenerate all port inventories.
        
        Args:
            fraction: Fraction of max capacity to regenerate (default 0.25)
            
        Returns:
            Number of ports regenerated
        """
        count = 0
        
        # Process all existing state files
        for file_path in self.data_dir.glob("sector_*.json"):
            try:
                sector_id = int(file_path.stem.split("_")[1])
                state = self.load_port_state(sector_id)
                
                if state:
                    # Regenerate stock for commodities the port sells
                    for com_key in ["FO", "OG", "EQ"]:
                        idx = {"FO": 0, "OG": 1, "EQ": 2}[com_key]
                        if state.code[idx] == "S":  # Port sells this
                            regen_amount = int(state.stock_max[com_key] * fraction)
                            state.stock[com_key] = min(
                                state.stock_max[com_key],
                                state.stock[com_key] + regen_amount
                            )
                        elif state.code[idx] == "B":  # Port buys this
                            regen_amount = int(state.demand_max[com_key] * fraction)
                            state.demand[com_key] = min(
                                state.demand_max[com_key],
                                state.demand[com_key] + regen_amount
                            )
                    
                    self.save_port_state(state)
                    count += 1
                    
            except Exception as e:
                print(f"Error regenerating port {file_path}: {e}")
        
        return count