"""Map widget for displaying local sector information."""

from typing import Dict, Any, Optional, Set
from collections import defaultdict
from textual.app import ComposeResult
from textual.containers import Vertical, ScrollableContainer
from textual.widgets import Static
from textual.reactive import reactive


class MapWidget(Vertical):
    """Widget for displaying ASCII map of local sectors."""
    
    current_sector = reactive(0)
    map_data = reactive({})
    
    def __init__(self, *args, **kwargs):
        """Initialize the map widget."""
        super().__init__(*args, **kwargs)
        self.sector_connections: Dict[int, Set[int]] = defaultdict(set)
        self.sector_contents: Dict[int, dict] = {}
        self.visited_sectors: Set[int] = set()
    
    def compose(self) -> ComposeResult:
        """Create child widgets."""
        yield Static("Local Map", id="map-header")
        yield ScrollableContainer(
            Static("No map data available", id="map-display"),
            id="map-scroll"
        )
    
    def on_mount(self) -> None:
        """Initialize when mounted."""
        self.map_display = self.query_one("#map-display", Static)
        self.header = self.query_one("#map-header", Static)
    
    def update_map(self, current_sector: int, map_data: Dict[str, Any]):
        """Update the map display.
        
        Args:
            current_sector: Current sector ID
            map_data: Map knowledge data from the game client
        """
        self.current_sector = current_sector
        self.map_data = map_data
        
        # Update internal data structures
        self._update_internal_structures()
        
        # Render the map
        self._render_map()
    
    def _update_internal_structures(self):
        """Update internal data structures from map data."""
        sectors_visited = self.map_data.get("sectors_visited", {})
        
        # Clear and rebuild structures
        self.sector_connections.clear()
        self.sector_contents.clear()
        self.visited_sectors.clear()
        
        for sector_key, sector_info in sectors_visited.items():
            # Extract sector ID from key (format: "sector_123")
            try:
                sector_id = int(sector_key.replace("sector_", ""))
            except (ValueError, AttributeError):
                continue
            
            self.visited_sectors.add(sector_id)
            
            # Store sector contents
            if sector_info.get("port_info"):
                if sector_id not in self.sector_contents:
                    self.sector_contents[sector_id] = {}
                self.sector_contents[sector_id]["port"] = sector_info["port_info"]
            
            # Build connections
            adjacent = sector_info.get("adjacent_sectors", [])
            for adj_sector in adjacent:
                self.sector_connections[sector_id].add(adj_sector)
                self.sector_connections[adj_sector].add(sector_id)
    
    def get_sector_display(self, sector: int, is_current: bool = False) -> str:
        """Get display string for a sector including port info.
        
        Args:
            sector: Sector ID
            is_current: Whether this is the current sector
            
        Returns:
            Formatted sector display string
        """
        port_code = ""
        if sector in self.sector_contents:
            port_info = self.sector_contents[sector].get("port")
            if port_info and "code" in port_info:
                port_code = port_info["code"]
        
        if is_current:
            if port_code:
                return f"[{sector:3}]\n [{port_code}]"
            else:
                return f"[{sector:3}]"
        elif sector in self.visited_sectors:
            if port_code:
                return f"({sector:3})\n {port_code} "
            else:
                return f"({sector:3})"
        else:
            if port_code:
                return f" {sector:3} \n {port_code} "
            else:
                return f" {sector:3} "
    
    def create_ascii_map(self, center_sector: int) -> str:
        """Create an ASCII representation of the local map.
        
        Args:
            center_sector: Sector to center the map on
            
        Returns:
            ASCII map string
        """
        if not self.sector_connections:
            return "Exploring... Move to discover connections!"
        
        if center_sector not in self.sector_connections or not self.sector_connections[center_sector]:
            return f"Sector {center_sector} - No connections discovered yet\nMove to adjacent sectors to map them!"
        
        adjacent = sorted(self.sector_connections.get(center_sector, set()))
        
        current_display = self.get_sector_display(center_sector, is_current=True)
        current_lines = current_display.split('\n')
        
        if len(adjacent) == 0:
            return current_display
        elif len(adjacent) == 1:
            adj = adjacent[0]
            adj_display = self.get_sector_display(adj)
            adj_lines = adj_display.split('\n')
            if len(current_lines) > 1 or len(adj_lines) > 1:
                result = []
                result.append(f"{current_lines[0]} ── {adj_lines[0]}")
                if len(current_lines) > 1 or len(adj_lines) > 1:
                    result.append(f"{current_lines[1] if len(current_lines) > 1 else '     '}    {adj_lines[1] if len(adj_lines) > 1 else ''}")
                return '\n'.join(result)
            else:
                return f"{current_display} ── {adj_display}"
        elif len(adjacent) == 2:
            adj1, adj2 = adjacent
            v1 = self.get_sector_display(adj1)
            v2 = self.get_sector_display(adj2)
            v1_lines = v1.split('\n')
            v2_lines = v2.split('\n')
            
            result = []
            result.append(f"    {v1_lines[0]}")
            if len(v1_lines) > 1:
                result.append(f"    {v1_lines[1]}")
            result.append(f"     │")
            result.append(f"{current_lines[0]} ──{v2_lines[0]}")
            if len(current_lines) > 1 or len(v2_lines) > 1:
                result.append(f"{current_lines[1] if len(current_lines) > 1 else '     '}   {v2_lines[1] if len(v2_lines) > 1 else ''}")
            return '\n'.join(result)
        elif len(adjacent) == 3:
            adj1, adj2, adj3 = adjacent
            v1 = self.get_sector_display(adj1)
            v2 = self.get_sector_display(adj2)
            v3 = self.get_sector_display(adj3)
            v1_lines = v1.split('\n')
            v2_lines = v2.split('\n')
            v3_lines = v3.split('\n')
            
            result = []
            result.append(f"     {v1_lines[0]}")
            if len(v1_lines) > 1:
                result.append(f"     {v1_lines[1]}")
            result.append(f"      │")
            result.append(f"{v2_lines[0]} ─{current_lines[0]}─ {v3_lines[0]}")
            
            port_line_parts = []
            if len(v2_lines) > 1:
                port_line_parts.append(v2_lines[1])
            else:
                port_line_parts.append(" " * 5)
            port_line_parts.append("  ")
            if len(current_lines) > 1:
                port_line_parts.append(current_lines[1])
            else:
                port_line_parts.append(" " * 5)
            port_line_parts.append("  ")
            if len(v3_lines) > 1:
                port_line_parts.append(v3_lines[1])
            
            if any(s.strip() for s in port_line_parts):
                result.append(''.join(port_line_parts))
            
            return '\n'.join(result)
        else:
            lines = []
            
            adj_displays = []
            for adj in adjacent[:4]:
                display = self.get_sector_display(adj)
                adj_displays.append(display.split('\n'))
            
            if len(adj_displays) >= 1:
                lines.append(f"      {adj_displays[0][0] if len(adj_displays) > 0 else '     '}")
                if len(adj_displays) > 0 and len(adj_displays[0]) > 1:
                    lines.append(f"      {adj_displays[0][1]}")
                lines.append(f"        │")
            
            if len(adj_displays) >= 3:
                left_sector = adj_displays[1][0] if len(adj_displays) > 1 else "     "
                right_sector = adj_displays[2][0] if len(adj_displays) > 2 else "     "
                lines.append(f"{left_sector} ─{current_lines[0]}─ {right_sector}")
                
                port_parts = []
                if len(adj_displays) > 1 and len(adj_displays[1]) > 1:
                    port_parts.append(adj_displays[1][1])
                else:
                    port_parts.append(" " * 5)
                port_parts.append("  ")
                if len(current_lines) > 1:
                    port_parts.append(current_lines[1])
                else:
                    port_parts.append(" " * 5)
                port_parts.append("  ")
                if len(adj_displays) > 2 and len(adj_displays[2]) > 1:
                    port_parts.append(adj_displays[2][1])
                
                if any(s.strip() for s in port_parts):
                    lines.append(''.join(port_parts))
            
            if len(adj_displays) >= 4:
                lines.append(f"        │")
                lines.append(f"      {adj_displays[3][0]}")
                if len(adj_displays[3]) > 1:
                    lines.append(f"      {adj_displays[3][1]}")
            
            if len(adjacent) > 4:
                extra_sectors = []
                for i in range(4, len(adjacent)):
                    sector_str = str(adjacent[i])
                    if adjacent[i] in self.sector_contents:
                        port_info = self.sector_contents[adjacent[i]].get("port")
                        if port_info and "code" in port_info:
                            sector_str += f"({port_info['code']})"
                    extra_sectors.append(sector_str)
                extra_text = "  Also: " + ", ".join(extra_sectors)
                lines.append(extra_text)
            
            return "\n".join(lines)
    
    def _render_map(self):
        """Render the ASCII map."""
        if not self.map_data:
            self.map_display.update("No map data available")
            return
        
        sectors_visited = self.map_data.get("sectors_visited", {})
        if not sectors_visited:
            self.map_display.update("No sectors visited yet")
            return
        
        # Create the ASCII map using the better algorithm
        map_ascii = self.create_ascii_map(self.current_sector)
        
        # Build the complete display
        map_lines = []
        map_lines.append(f"Centered on Sector {self.current_sector}")
        map_lines.append("")
        map_lines.append(map_ascii)
        map_lines.append("")
        map_lines.append("Legend: [current] (visited) unvisited")
        
        # Add port info if present in current sector
        current_key = f"sector_{self.current_sector}"
        if current_key in sectors_visited:
            current_info = sectors_visited[current_key]
            if current_info.get("port_info"):
                port = current_info["port_info"]
                map_lines.append("")
                map_lines.append(f"Current Port: Class {port.get('class')} (Code: {port.get('code')})")
                if port.get("buys"):
                    map_lines.append(f"Buys: {', '.join(port['buys'])}")
                if port.get("sells"):
                    map_lines.append(f"Sells: {', '.join(port['sells'])}")
        
        self.map_display.update("\n".join(map_lines))
        self.header.update(f"Local Map (Sector {self.current_sector})")