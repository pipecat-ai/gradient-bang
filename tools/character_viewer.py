#!/usr/bin/env python3
"""
Textual-based character movement viewer for Gradient Bang.

This tool connects to the game server's WebSocket firehose endpoint
and visualizes a specific character's movement through the universe
using Textual's UI components.
"""

import asyncio
import json
import sys
from datetime import datetime
from typing import Dict, Set, Optional, List
import websockets
from collections import defaultdict, deque
from pathlib import Path
import argparse
import threading

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, ScrollableContainer
from textual.widgets import Header, Footer, Static, DataTable, Label, RichLog
from textual.widgets.data_table import RowKey
from textual.reactive import reactive
from textual.message import Message
from rich.text import Text

sys.path.insert(0, str(Path(__file__).parent.parent))
from utils.api_client import AsyncGameClient


class FirehoseEvent(Message):
    """Message for firehose events."""
    def __init__(self, event: dict) -> None:
        self.event = event
        super().__init__()


class ConnectionStatus(Message):
    """Message for connection status updates."""
    def __init__(self, connected: bool) -> None:
        self.connected = connected
        super().__init__()


class MapWidget(Static):
    """Widget to display the ASCII map."""
    
    map_text = reactive("No map data available")
    
    def render(self) -> str:
        """Render the map."""
        return self.map_text


class StatsWidget(Static):
    """Widget to display character statistics."""
    
    character_name = reactive("None")
    current_sector = reactive(0)
    sectors_visited = reactive(0)
    known_connections = reactive(0)
    
    def render(self) -> str:
        """Render the stats."""
        return f"""[bold cyan]Character:[/bold cyan] {self.character_name}
[bold cyan]Current Sector:[/bold cyan] {self.current_sector}
[bold cyan]Sectors Visited:[/bold cyan] {self.sectors_visited}
[bold cyan]Known Connections:[/bold cyan] {self.known_connections}"""


class CharacterViewer(App):
    """Textual-based character movement viewer."""
    
    CSS = """
    #map-container {
        border: solid cyan;
        height: 2fr;
        padding: 1;
    }
    
    #stats-container {
        border: solid magenta;
        height: 10;
        padding: 1;
    }
    
    StatsWidget {
        height: 100%;
    }
    
    #character-table {
        border: solid green;
        height: 100%;
    }
    
    #history-panels {
        height: 1fr;
    }
    
    #movement-panel {
        border: solid yellow;
        width: 50%;
        padding: 1;
    }
    
    #port-panel {
        border: solid green;
        width: 50%;
        padding: 1;
    }
    
    #movement-title, #port-title {
        height: 1;
        margin-bottom: 1;
    }
    
    #movement-log {
        height: 100%;
    }
    
    #port-log {
        height: 100%;
    }
    
    .status-bar {
        dock: bottom;
        height: 1;
        background: $primary-background;
    }
    """
    
    BINDINGS = [
        ("q", "quit", "Quit"),
        ("s", "select_character", "Select Character"),
        ("r", "refresh_map", "Refresh Map"),
        ("c", "clear_history", "Clear History"),
    ]
    
    def __init__(self, server_url: str, initial_character: Optional[str] = None):
        """Initialize the viewer.
        
        Args:
            server_url: HTTP/WebSocket URL of the game server
            initial_character: Optional initial character to watch
        """
        super().__init__()
        self.server_url = server_url
        self.connected = False
        
        self.characters: Dict[str, dict] = {}
        self.selected_character: Optional[str] = initial_character
        
        self.visited_sectors: Set[int] = set()
        self.sector_connections: Dict[int, Set[int]] = defaultdict(set)
        self.sector_contents: Dict[int, dict] = {}
        
        self.movement_history = deque(maxlen=20)
        self.port_history = deque(maxlen=10)
        
        self.total_events = 0
        self.game_client: Optional[AsyncGameClient] = None
        self.websocket_task: Optional[asyncio.Task] = None
        self.websocket: Optional[websockets.WebSocketClientProtocol] = None
        
    def compose(self) -> ComposeResult:
        """Create child widgets."""
        yield Header(show_clock=True)
        
        with Horizontal():
            with Vertical(id="left-panel"):
                yield DataTable(id="character-table")
                yield StatsWidget(id="stats-container")
            
            with Vertical(id="right-panel"):
                yield MapWidget(id="map-container")
                
                with Horizontal(id="history-panels"):
                    with Vertical(id="movement-panel"):
                        yield Label("[bold]Movement History[/bold]", id="movement-title")
                        yield RichLog(id="movement-log", wrap=True, highlight=True)
                    with Vertical(id="port-panel"):
                        yield Label("[bold]Port History[/bold]", id="port-title")
                        yield RichLog(id="port-log", wrap=True, highlight=True)
        
        yield Label("Connected: ○ | Events: 0", 
                   classes="status-bar", id="status-bar")
        yield Footer()
    
    async def on_mount(self) -> None:
        """Called when app starts."""
        table = self.query_one("#character-table", DataTable)
        table.add_columns("Character", "Sector", "Last Seen")
        table.cursor_type = "row"
        
        # Start the WebSocket connection in the background
        self.websocket_task = asyncio.create_task(self.websocket_listener())
        
        if self.selected_character:
            await self.fetch_character_data()
    
    async def websocket_listener(self) -> None:
        """Listen to WebSocket events in the background."""
        ws_url = self.server_url.replace("http://", "ws://").replace("https://", "wss://")
        if not ws_url.endswith("/api/firehose"):
            ws_url = ws_url.rstrip("/") + "/api/firehose"
        
        while True:
            try:
                async with websockets.connect(ws_url) as websocket:
                    self.websocket = websocket
                    self.post_message(ConnectionStatus(True))
                    
                    while True:
                        try:
                            message = await websocket.recv()
                            event = json.loads(message)
                            self.post_message(FirehoseEvent(event))
                        except websockets.ConnectionClosed:
                            self.post_message(ConnectionStatus(False))
                            break
                        except asyncio.CancelledError:
                            raise
                        except Exception as e:
                            self.log.error(f"Error processing message: {e}")
                            
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.post_message(ConnectionStatus(False))
                self.log.error(f"WebSocket connection error: {e}")
                await asyncio.sleep(5)  # Wait before reconnecting
    
    async def on_connection_status(self, message: ConnectionStatus) -> None:
        """Handle connection status updates."""
        self.connected = message.connected
        self.update_status_bar()
        
        if not message.connected:
            log = self.query_one("#movement-log", RichLog)
            log.write(Text("WebSocket disconnected", style="red"))
    
    async def on_firehose_event(self, message: FirehoseEvent) -> None:
        """Handle incoming firehose events."""
        event = message.event
        self.total_events += 1
        self.update_status_bar()
        
        event_type = event.get("type", "unknown")
        
        if event_type == "movement":
            char_id = event.get("character_id")
            from_sector = event.get("from_sector")
            to_sector = event.get("to_sector")
            timestamp = event.get("timestamp", "")
            
            if char_id:
                self.update_character(char_id, to_sector, timestamp)
                
                if char_id == self.selected_character:
                    self.update_connections(from_sector, to_sector)
                    self.visited_sectors.add(to_sector)
                    await self.fetch_character_data()
                    
                    try:
                        dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                        time_str = dt.strftime("%H:%M:%S")
                    except:
                        time_str = "?"
                    
                    move_str = f"{time_str}: {from_sector} → {to_sector}"
                    self.movement_history.append(move_str)
                    
                    log = self.query_one("#movement-log", RichLog)
                    log.write(Text(move_str))
        
        elif event_type == "join":
            char_id = event.get("character_id")
            sector = event.get("sector", 0)
            timestamp = event.get("timestamp", "")
            
            if char_id:
                self.update_character(char_id, sector, timestamp)
                if char_id == self.selected_character:
                    await self.fetch_character_data()
    
    def update_character(self, char_id: str, sector: int, timestamp: str) -> None:
        """Update character information.
        
        Args:
            char_id: Character ID
            sector: Current sector
            timestamp: Last seen timestamp
        """
        if char_id not in self.characters:
            self.characters[char_id] = {}
        
        self.characters[char_id].update({
            "sector": sector,
            "last_seen": timestamp,
            "last_seen_dt": datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        })
        
        self.update_character_table()
        
        if char_id == self.selected_character:
            self.visited_sectors.add(sector)
            self.update_stats()
            self.update_map()
    
    def update_connections(self, from_sector: int, to_sector: int) -> None:
        """Update known sector connections."""
        self.sector_connections[from_sector].add(to_sector)
        self.sector_connections[to_sector].add(from_sector)
    
    def update_character_table(self) -> None:
        """Update the character table display."""
        table = self.query_one("#character-table", DataTable)
        table.clear()
        
        sorted_chars = sorted(
            self.characters.items(),
            key=lambda x: x[1].get("last_seen_dt", datetime.min),
            reverse=True
        )
        
        for char_id, info in sorted_chars[:10]:
            sector = info.get("sector", "?")
            last_seen = info.get("last_seen", "")
            try:
                dt = datetime.fromisoformat(last_seen.replace("Z", "+00:00"))
                time_str = dt.strftime("%H:%M:%S")
            except:
                time_str = "?"
            
            if char_id == self.selected_character:
                table.add_row(f"▶ {char_id}", str(sector), time_str, key=char_id)
            else:
                table.add_row(char_id, str(sector), time_str, key=char_id)
        
        # Auto-select first character only if none selected yet
        if not self.selected_character and self.characters and not hasattr(self, '_auto_selected'):
            sorted_chars = sorted(
                self.characters.items(),
                key=lambda x: x[1].get("last_seen_dt", datetime.min),
                reverse=True
            )
            if sorted_chars:
                self._auto_selected = True  # Flag to prevent repeated auto-selection
                self.selected_character = sorted_chars[0][0]
                self.visited_sectors.clear()
                self.movement_history.clear()
                self.sector_connections.clear()
                current_sector = self.characters[self.selected_character].get("sector")
                if current_sector is not None:
                    self.visited_sectors.add(current_sector)
                    asyncio.create_task(self.fetch_character_data())
    
    def update_stats(self) -> None:
        """Update the stats widget."""
        stats = self.query_one("#stats-container", StatsWidget)
        
        if self.selected_character and self.selected_character in self.characters:
            char_info = self.characters[self.selected_character]
            stats.character_name = self.selected_character
            stats.current_sector = char_info.get("sector", 0)
            stats.sectors_visited = len(self.visited_sectors)
            stats.known_connections = sum(len(c) for c in self.sector_connections.values())
        else:
            stats.character_name = "None"
            stats.current_sector = 0
            stats.sectors_visited = 0
            stats.known_connections = 0
    
    def update_status_bar(self) -> None:
        """Update the status bar."""
        status = self.query_one("#status-bar", Label)
        conn_icon = "●" if self.connected else "○"
        conn_style = "green" if self.connected else "red"
        text = Text()
        text.append("Connected: ", style="dim")
        text.append(conn_icon, style=conn_style)
        text.append(f" | Events: {self.total_events}", style="dim")
        status.update(text)
    
    def get_sector_display(self, sector: int, is_current: bool = False) -> str:
        """Get display string for a sector including port info."""
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
        """Create an ASCII representation of the local map."""
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
    
    def update_map(self) -> None:
        """Update the map display."""
        map_widget = self.query_one("#map-container", MapWidget)
        
        if self.selected_character and self.selected_character in self.characters:
            current_sector = self.characters[self.selected_character].get("sector", 0)
            map_ascii = self.create_ascii_map(current_sector)
            map_text = f"[bold]Local Map[/bold] (centered on sector {current_sector})\n\n{map_ascii}"
            map_text += "\n\nLegend: [current] (visited) unvisited"
        else:
            map_text = "Select a character to view their map"
        
        map_widget.map_text = map_text
    
    async def fetch_character_data(self) -> None:
        """Fetch character status and map knowledge from the API."""
        if not self.selected_character:
            return
        
        try:
            if not self.game_client:
                self.game_client = AsyncGameClient(base_url=self.server_url)
            
            status = await self.game_client.my_status(self.selected_character)
            current_sector = status.sector
            sector_contents = status.sector_contents
            
            self.sector_contents[current_sector] = sector_contents.model_dump()
            
            if sector_contents.port:
                port_info = sector_contents.port
                port_str = f"Sector {current_sector}: {port_info.code} - Buys: {', '.join(port_info.buys) if port_info.buys else 'nothing'}, Sells: {', '.join(port_info.sells) if port_info.sells else 'nothing'}"
                if not self.port_history or self.port_history[-1] != port_str:
                    self.port_history.append(port_str)
                    port_log = self.query_one("#port-log", RichLog)
                    port_log.write(Text(port_str, style="cyan"))
            
            adjacent = sector_contents.adjacent_sectors
            for adj_sector in adjacent:
                self.sector_connections[current_sector].add(adj_sector)
                self.sector_connections[adj_sector].add(current_sector)
            
            map_data = await self.game_client.my_map(self.selected_character)
            sectors_visited = map_data.get("sectors_visited", {})
            
            for sector_key, sector_info in sectors_visited.items():
                sector_id = sector_info.get("sector_id")
                if sector_id and sector_info.get("port_info"):
                    if sector_id not in self.sector_contents:
                        self.sector_contents[sector_id] = {}
                    self.sector_contents[sector_id]["port"] = sector_info["port_info"]
                
                if sector_id and "adjacent_sectors" in sector_info:
                    for adj in sector_info["adjacent_sectors"]:
                        self.sector_connections[sector_id].add(adj)
                        self.sector_connections[adj].add(sector_id)
            
            self.update_map()
            self.update_stats()
            
        except Exception as e:
            log = self.query_one("#movement-log", RichLog)
            log.write(Text(f"Error fetching character status: {e}", style="red"))
    
    def action_quit(self) -> None:
        """Quit the application."""
        if self.websocket_task:
            self.websocket_task.cancel()
        self.exit()
    
    def switch_to_character(self, char_id: str) -> None:
        """Switch to viewing a different character.
        
        Args:
            char_id: The character ID to switch to
        """
        if char_id != self.selected_character and char_id in self.characters:
            self.selected_character = char_id
            
            # Clear all cached data for the previous character
            self.visited_sectors.clear()
            self.movement_history.clear()
            self.port_history.clear()
            self.sector_connections.clear()
            self.sector_contents.clear()
            
            # Add the current sector to visited
            current_sector = self.characters[self.selected_character].get("sector")
            if current_sector is not None:
                self.visited_sectors.add(current_sector)
            
            # Update UI elements
            self.update_character_table()
            self.update_stats()
            self.update_map()
            
            # Clear and update logs
            movement_log = self.query_one("#movement-log", RichLog)
            movement_log.clear()
            movement_log.write(Text(f"Selected character: {char_id}", style="yellow"))
            
            port_log = self.query_one("#port-log", RichLog)
            port_log.clear()
            
            # Fetch fresh data for this character
            asyncio.create_task(self.fetch_character_data())
    
    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        """Handle DataTable row selection (mouse click).
        
        Args:
            event: The row selected event
        """
        # The row_key is the character ID we set when adding the row
        if event.row_key and event.row_key.value in self.characters:
            self.switch_to_character(event.row_key.value)
    
    def action_select_character(self) -> None:
        """Select a character from the table."""
        table = self.query_one("#character-table", DataTable)
        if table.row_count > 0:
            # Get the currently highlighted row
            cursor_row = table.cursor_row
            if cursor_row is not None:
                # The cursor_row is the row index, get the actual row key
                rows = list(table.rows.keys())
                if cursor_row < len(rows):
                    row_key = rows[cursor_row]
                    # row_key should be the character ID we set when adding the row
                    if row_key in self.characters:
                        self.switch_to_character(row_key)
    
    def action_refresh_map(self) -> None:
        """Refresh the map data."""
        if self.selected_character:
            asyncio.create_task(self.fetch_character_data())
            log = self.query_one("#movement-log", RichLog)
            log.write(Text("Refreshing map data...", style="green"))
    
    def action_clear_history(self) -> None:
        """Clear movement and port history."""
        self.movement_history.clear()
        self.port_history.clear()
        
        movement_log = self.query_one("#movement-log", RichLog)
        movement_log.clear()
        movement_log.write(Text("Movement history cleared", style="yellow"))
        
        port_log = self.query_one("#port-log", RichLog)
        port_log.clear()
        port_log.write(Text("Port history cleared", style="yellow"))
    
    async def on_unmount(self) -> None:
        """Clean up when app closes."""
        if self.websocket_task:
            self.websocket_task.cancel()
        if self.websocket:
            await self.websocket.close()
        if self.game_client:
            await self.game_client.close()


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Textual-based character movement viewer for Gradient Bang"
    )
    parser.add_argument(
        "--server",
        default="http://localhost:8000",
        help="Game server URL (default: %(default)s)"
    )
    parser.add_argument(
        "--character",
        help="Character to watch (optional, can select interactively)"
    )
    
    args = parser.parse_args()
    
    app = CharacterViewer(args.server, args.character)
    app.run()


if __name__ == "__main__":
    main()
