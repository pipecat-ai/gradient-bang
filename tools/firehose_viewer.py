#!/usr/bin/env python3
"""
Terminal UI viewer for the Gradient Bang firehose event stream.

This tool connects to the game server's WebSocket firehose endpoint
and displays all game events in real-time.
"""

import asyncio
import json
import sys
from datetime import datetime
import websockets
from rich.console import Console
from rich.live import Live
from rich.table import Table
from rich.panel import Panel
from rich.layout import Layout
from rich.text import Text
from collections import deque
import argparse


class FirehoseViewer:
    """Terminal UI for viewing game events."""
    
    def __init__(self, server_url: str, max_events: int = 100):
        """Initialize the viewer.
        
        Args:
            server_url: WebSocket URL of the game server
            max_events: Maximum number of events to keep in history
        """
        self.server_url = server_url
        self.console = Console()
        self.events = deque(maxlen=max_events)
        self.connected = False
        self.stats = {
            "total_events": 0,
            "movements": 0,
            "joins": 0,
            "other": 0
        }
    
    def format_event(self, event: dict) -> str:
        """Format an event for display.
        
        Args:
            event: Event dictionary from the server
            
        Returns:
            Formatted string representation
        """
        event_type = event.get("type", "unknown")
        timestamp = event.get("timestamp", "")
        
        # Try to parse and format timestamp
        try:
            dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            time_str = dt.strftime("%H:%M:%S")
        except:
            time_str = timestamp[:8] if len(timestamp) > 8 else timestamp
        
        if event_type == "movement":
            char_id = event.get("character_id", "?")
            from_sector = event.get("from_sector", "?")
            to_sector = event.get("to_sector", "?")
            return f"[cyan]{time_str}[/cyan] [yellow]MOVE[/yellow] {char_id}: {from_sector} → {to_sector}"
        
        elif event_type == "join":
            char_id = event.get("character_id", "?")
            sector = event.get("sector", "?")
            return f"[cyan]{time_str}[/cyan] [green]JOIN[/green] {char_id} at sector {sector}"
        
        elif event_type == "connected":
            return f"[cyan]{time_str}[/cyan] [magenta]CONNECTED[/magenta] {event.get('message', '')}"
        
        else:
            return f"[cyan]{time_str}[/cyan] [white]{event_type.upper()}[/white] {json.dumps(event)}"
    
    def create_display(self) -> Layout:
        """Create the display layout.
        
        Returns:
            Layout object for Rich display
        """
        layout = Layout()
        
        # Create header
        status = "[green]● Connected[/green]" if self.connected else "[red]● Disconnected[/red]"
        header = Panel(
            f"[bold]Gradient Bang Firehose Viewer[/bold]\n{status} to {self.server_url}",
            style="bold blue"
        )
        
        # Create stats panel
        stats_table = Table(show_header=False, box=None)
        stats_table.add_column("Stat", style="dim")
        stats_table.add_column("Value", justify="right")
        stats_table.add_row("Total Events:", str(self.stats["total_events"]))
        stats_table.add_row("Movements:", str(self.stats["movements"]))
        stats_table.add_row("Joins:", str(self.stats["joins"]))
        stats_table.add_row("Other:", str(self.stats["other"]))
        
        stats_panel = Panel(stats_table, title="Statistics", border_style="green")
        
        # Create events panel
        events_text = Text()
        for event_str in self.events:
            # Parse markup and append to text
            events_text.append(Text.from_markup(event_str))
            events_text.append("\n")
        
        events_panel = Panel(
            events_text if events_text else Text.from_markup("[dim]Waiting for events...[/dim]"),
            title=f"Recent Events (last {len(self.events)})",
            border_style="blue"
        )
        
        # Arrange layout
        layout.split_column(
            Layout(header, size=4),
            Layout(stats_panel, size=7),
            Layout(events_panel)
        )
        
        return layout
    
    def update_stats(self, event: dict):
        """Update statistics based on event type.
        
        Args:
            event: Event dictionary
        """
        self.stats["total_events"] += 1
        event_type = event.get("type", "unknown")
        
        if event_type == "movement":
            self.stats["movements"] += 1
        elif event_type == "join":
            self.stats["joins"] += 1
        else:
            self.stats["other"] += 1
    
    async def connect_and_listen(self):
        """Connect to the WebSocket and listen for events."""
        ws_url = self.server_url.replace("http://", "ws://").replace("https://", "wss://")
        if not ws_url.endswith("/api/firehose"):
            ws_url = ws_url.rstrip("/") + "/api/firehose"
        
        try:
            async with websockets.connect(ws_url) as websocket:
                self.connected = True
                self.console.print("[green]Connected to firehose![/green]")
                
                # Send initial ping to keep connection alive
                asyncio.create_task(self.keep_alive(websocket))
                
                while True:
                    try:
                        message = await websocket.recv()
                        event = json.loads(message)
                        
                        # Format and add event
                        event_str = self.format_event(event)
                        self.events.append(event_str)
                        
                        # Update stats (skip connection message)
                        if event.get("type") != "connected":
                            self.update_stats(event)
                        
                    except websockets.ConnectionClosed:
                        self.connected = False
                        self.console.print("[red]Connection closed[/red]")
                        break
                    except json.JSONDecodeError:
                        self.console.print(f"[red]Invalid JSON received: {message}[/red]")
                    except Exception as e:
                        self.console.print(f"[red]Error: {e}[/red]")
                        
        except Exception as e:
            self.connected = False
            self.console.print(f"[red]Failed to connect: {e}[/red]")
    
    async def keep_alive(self, websocket):
        """Send periodic pings to keep the connection alive.
        
        Args:
            websocket: WebSocket connection
        """
        while self.connected:
            try:
                await asyncio.sleep(30)
                await websocket.send("ping")
            except:
                break
    
    async def run(self):
        """Run the viewer with live display."""
        with Live(self.create_display(), refresh_per_second=2, console=self.console) as live:
            # Start connection task
            connection_task = asyncio.create_task(self.connect_and_listen())
            
            # Update display periodically
            try:
                while True:
                    await asyncio.sleep(0.5)
                    live.update(self.create_display())
            except KeyboardInterrupt:
                self.console.print("\n[yellow]Shutting down...[/yellow]")
                connection_task.cancel()
                await asyncio.sleep(0.5)


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Terminal viewer for Gradient Bang firehose events"
    )
    parser.add_argument(
        "--server",
        default="http://localhost:8000",
        help="Game server URL (default: %(default)s)"
    )
    parser.add_argument(
        "--max-events",
        type=int,
        default=100,
        help="Maximum number of events to display (default: %(default)s)"
    )
    
    args = parser.parse_args()
    
    viewer = FirehoseViewer(args.server, args.max_events)
    
    try:
        asyncio.run(viewer.run())
    except KeyboardInterrupt:
        print("\nGoodbye!")
        sys.exit(0)


if __name__ == "__main__":
    main()
