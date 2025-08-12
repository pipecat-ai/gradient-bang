"""History widgets for movement and port tracking."""

from typing import List, Tuple, Dict, Any
from collections import deque
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import Static, DataTable
from datetime import datetime


class MovementHistoryWidget(Vertical):
    """Widget for displaying recent movement history."""
    
    def compose(self) -> ComposeResult:
        """Create child widgets."""
        yield Static("Movement History", id="movement-header")
        yield DataTable(id="movement-table")
    
    def on_mount(self) -> None:
        """Initialize when mounted."""
        self.table = self.query_one("#movement-table", DataTable)
        self.table.add_columns("Time", "From", "To", "Port")
        self.history: deque = deque(maxlen=20)
    
    def add_movement(self, from_sector: int, to_sector: int, port_code: str = ""):
        """Add a movement to the history.
        
        Args:
            from_sector: Source sector
            to_sector: Destination sector
            port_code: Port BBB code if destination has a port (e.g. "BSS")
        """
        timestamp = datetime.now().strftime("%H:%M:%S")
        
        self.history.append((timestamp, from_sector, to_sector, port_code))
        
        # Update table
        self.table.clear()
        for entry in self.history:
            self.table.add_row(*entry)


class PortHistoryWidget(Vertical):
    """Widget for displaying discovered ports."""
    
    def compose(self) -> ComposeResult:
        """Create child widgets."""
        yield Static("Discovered Ports", id="port-header")
        yield DataTable(id="port-table")
    
    def on_mount(self) -> None:
        """Initialize when mounted."""
        self.table = self.query_one("#port-table", DataTable)
        self.table.add_columns("Sector", "Class", "Buys", "Sells")
        self.ports: Dict[int, Dict[str, Any]] = {}
    
    def update_ports(self, map_data: Dict[str, Any]):
        """Update the port list from map data.
        
        Args:
            map_data: Map knowledge data from the game client
        """
        sectors_visited = map_data.get("sectors_visited", {})
        
        # Find all ports
        new_ports = {}
        for sector_key, sector_info in sectors_visited.items():
            if sector_info.get("port_info"):
                # Extract sector ID from the key (format: "sector_123") or from sector_info
                sector_id = sector_info.get("sector_id")
                if sector_id is None:
                    # Try to extract from the key
                    try:
                        sector_id = int(sector_key.replace("sector_", ""))
                    except (ValueError, AttributeError):
                        continue
                
                port = sector_info["port_info"]
                # The server and our cache both use "class_num" field
                port_class = port.get("class_num", "?")
                port_class = str(port_class) if port_class != "?" else "?"
                    
                new_ports[sector_id] = {
                    "class": port_class,
                    "buys": ", ".join(port.get("buys", [])) if port.get("buys") else "-",
                    "sells": ", ".join(port.get("sells", [])) if port.get("sells") else "-"
                }
        
        # Update if changed
        if new_ports != self.ports:
            self.ports = new_ports
            self._refresh_table()
    
    def _refresh_table(self):
        """Refresh the table display."""
        self.table.clear()
        
        # Sort by sector ID
        for sector_id in sorted(self.ports.keys()):
            port = self.ports[sector_id]
            self.table.add_row(
                str(sector_id),
                str(port["class"]),
                port["buys"],
                port["sells"]
            )