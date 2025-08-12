"""Main TUI application for Gradient Bang player interface."""

import asyncio
from typing import Optional, List, Dict, Any
from pathlib import Path
import sys

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, Container
from textual.widgets import Header, Footer, Static
from textual.binding import Binding
from textual.message import Message

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from tui.widgets.chat_widget import ChatWidget, ChatMessage
from tui.widgets.task_output_widget import TaskOutputWidget
from tui.widgets.map_widget import MapWidget
from tui.widgets.history_widgets import MovementHistoryWidget, PortHistoryWidget
from tui.widgets.progress_widget import ProgressWidget
from tui.widgets.debug_widget import DebugWidget
from tui.widgets.status_bar_widget import StatusBarWidget
from tui.task_manager import TaskManager
from utils.api_client import AsyncGameClient
from utils.base_llm_agent import LLMConfig


class StateUpdate(Message):
    """Message for state updates."""
    def __init__(self, state_data: dict) -> None:
        self.state_data = state_data
        super().__init__()


class PlayerApp(App):
    """Main TUI application for player interaction."""
    
    CSS = """
    #status-bar {
        height: 3;
        border: solid white;
        padding: 0 1;
        background: $boost;
    }
    
    #chat-container {
        height: 2fr;
        border: solid cyan;
        padding: 1;
    }
    
    #task-output {
        height: 1fr;
        border: solid green;
        padding: 1;
    }
    
    #map-widget {
        width: 100%;
        height: 40%;
        border: solid magenta;
        padding: 1;
    }
    
    #map-scroll {
        height: 100%;
    }
    
    #progress-widget {
        height: 6;
        border: solid yellow;
        padding: 1;
    }
    
    #movement-history {
        height: 1fr;
        border: solid blue;
        padding: 1;
    }
    
    #port-history {
        height: 1fr;
        border: solid red;
        padding: 1;
    }
    
    #debug-widget {
        border: solid white;
        padding: 1;
        height: 100%;
    }
    
    #left-panel {
        width: 60%;
    }
    
    #right-panel {
        width: 40%;
    }
    """
    
    BINDINGS = [
        Binding("ctrl+c", "cancel_task", "Cancel Task", priority=True),
        Binding("ctrl+l", "clear_output", "Clear Output", priority=True),
        Binding("ctrl+r", "refresh", "Force Refresh", priority=True),
        Binding("ctrl+d", "toggle_debug", "Toggle Debug", priority=True, show=True),
        Binding("f1", "help", "Help", priority=True),
        Binding("ctrl+q", "quit", "Quit", priority=True),
    ]
    
    def __init__(
        self,
        character_id: str,
        server_url: str = "http://localhost:8000",
        chat_model: str = "gpt-4.1",
        task_model: str = "gpt-5",
        *args,
        **kwargs
    ):
        """Initialize the player app.
        
        Args:
            character_id: Character ID to play as
            server_url: Game server URL
            chat_model: Model to use for chat agent
            task_model: Model to use for task agent
        """
        super().__init__(*args, **kwargs)
        self.character_id = character_id
        self.server_url = server_url
        self.chat_model = chat_model
        self.task_model = task_model
        self.task_manager: Optional[TaskManager] = None
        self.game_client: Optional[AsyncGameClient] = None
        self.update_task: Optional[asyncio.Task] = None
        self.current_sector = 0
        self.debug_mode = True  # Start with debug mode enabled
    
    def compose(self) -> ComposeResult:
        """Create the UI layout."""
        yield Header(show_clock=True)
        yield StatusBarWidget(id="status-bar")
        
        with Horizontal():
            # Left panel - Chat and Task Output
            with Vertical(id="left-panel"):
                yield ChatWidget(id="chat-widget")
                yield TaskOutputWidget(id="task-output")
            
            # Right panel - Map, Progress, and History (or Debug)
            with Vertical(id="right-panel"):
                yield MapWidget(id="map-widget")
                yield ProgressWidget(id="progress-widget")
                yield MovementHistoryWidget(id="movement-history")
                yield PortHistoryWidget(id="port-history")
                yield DebugWidget(id="debug-widget")
        
        yield Footer()
    
    async def on_mount(self) -> None:
        """Initialize when the app is mounted."""
        # Get widget references
        self.chat_widget = self.query_one("#chat-widget", ChatWidget)
        self.task_output = self.query_one("#task-output", TaskOutputWidget)
        self.map_widget = self.query_one("#map-widget", MapWidget)
        self.progress_widget = self.query_one("#progress-widget", ProgressWidget)
        self.movement_history = self.query_one("#movement-history", MovementHistoryWidget)
        self.port_history = self.query_one("#port-history", PortHistoryWidget)
        self.debug_widget = self.query_one("#debug-widget", DebugWidget)
        self.status_bar = self.query_one("#status-bar", StatusBarWidget)
        self.right_panel = self.query_one("#right-panel", Vertical)
        
        # Start with debug mode enabled (show debug, hide others)
        self.map_widget.styles.display = "none"
        self.progress_widget.styles.display = "none"
        self.movement_history.styles.display = "none"
        self.port_history.styles.display = "none"
        self.debug_widget.styles.display = "block"
        
        # Initialize game client and task manager
        await self._initialize_game()
        
        # Start the state update loop
        self.update_task = asyncio.create_task(self._state_update_loop())
    
    async def _initialize_game(self):
        """Initialize game connection and agents."""
        try:
            # Create game client
            self.game_client = AsyncGameClient(
                base_url=self.server_url,
                character_id=self.character_id
            )
            
            # Join the game
            status = await self.game_client.join(self.character_id)
            self.current_sector = status.sector
            
            # Update status bar with initial state
            self.status_bar.update_from_status(status.model_dump())
            
            # Create separate LLM configs for chat and task agents
            chat_config = LLMConfig(model=self.chat_model)  # Faster, cheaper for chat
            task_config = LLMConfig(model=self.task_model)   # More capable for complex tasks
            
            # Create task manager with separate configs
            self.task_manager = TaskManager(
                game_client=self.game_client,
                character_id=self.character_id,
                chat_config=chat_config,
                task_config=task_config,
                output_callback=self._task_output_callback,
                progress_callback=self._progress_callback,
                task_complete_callback=lambda was_cancelled, via_stop_tool: asyncio.create_task(self._on_task_complete(was_cancelled, via_stop_tool)),
                status_callback=self._status_update_callback
            )
            
            # Set debug callback for chat agent
            self.task_manager.chat_agent.debug_callback = self._debug_callback
            
            # Initialize chat agent and get welcome message
            welcome = await self.task_manager.initialize()
            self.chat_widget.add_message("assistant", welcome)
            self.chat_widget.add_message("system", "Debug mode enabled - showing chat agent messages. Press Ctrl+D to toggle.")
            
            # Initial state update
            await self._update_state()
            
        except Exception as e:
            self.chat_widget.add_message("system", f"Error initializing: {str(e)}")
    
    def _task_output_callback(self, text: str):
        """Callback for task output.
        
        Args:
            text: Output text from task execution
        """
        self.task_output.add_info(text)
    
    def _status_update_callback(self, status_data: Dict[str, Any]):
        """Callback for status updates from chat and task agents.
        
        Args:
            status_data: Status data from API responses
        """
        # Update status bar with new data
        self.status_bar.update_from_status(status_data)
        
        # Update status bar for trade results
        if "new_credits" in status_data and "new_cargo" in status_data:
            self.status_bar.update_from_trade(status_data)
        
        # Update map if sector changed and add to movement history
        if "sector" in status_data and status_data["sector"] != self.current_sector:
            old_sector = self.current_sector
            new_sector = status_data["sector"]
            
            # Check if new sector has a port and get its code
            port_code = ""
            if "sector_contents" in status_data:
                contents = status_data["sector_contents"]
                if contents and contents.get("port"):
                    port = contents["port"]
                    # Get the port code (BBB pattern)
                    port_code = port.get("code", "")
            
            # Add to movement history
            if old_sector is not None:  # Don't add if this is the initial position
                self.movement_history.add_movement(old_sector, new_sector, port_code)
            
            self.current_sector = new_sector
    
    def _debug_callback(self, messages: List[Dict[str, Any]], status: Optional[str] = None):
        """Callback to update debug panel with chat agent messages.
        
        Args:
            messages: List of messages from chat agent
            status: Optional status message (e.g., "Request in progress...")
        """
        self.debug_widget.update_messages(messages, status)
    
    def _progress_callback(self, text: str, status: str):
        """Callback for progress updates.
        
        Args:
            text: Progress text
            status: Status type (start, action, complete, error, etc.)
        """
        if status == "start":
            self.progress_widget.start_task(text)
        elif status == "complete" or status == "failed" or status == "cancelled" or status == "error":
            self.progress_widget.stop_task(text)
        else:
            self.progress_widget.update_action(text)
    
    async def _state_update_loop(self):
        """Periodically update game state."""
        while True:
            try:
                await asyncio.sleep(2)  # Fixed 2-second polling
                await self._update_state()
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.log.error(f"State update error: {e}")
    
    async def _update_state(self):
        """Update all state-dependent widgets."""
        if not self.game_client:
            return
        
        try:
            # Get current status
            status = await self.game_client.my_status()
            
            # Check for movement
            if status.sector != self.current_sector:
                # Get port code if present
                port_code = ""
                if status.sector_contents and status.sector_contents.port:
                    port_code = status.sector_contents.port.code
                
                self.movement_history.add_movement(
                    self.current_sector,
                    status.sector,
                    port_code
                )
                self.current_sector = status.sector
            
            # Get map data
            map_data = await self.game_client.my_map()
            
            # Update widgets
            self.map_widget.update_map(self.current_sector, map_data)
            self.port_history.update_ports(map_data)
            
        except Exception as e:
            self.log.error(f"Error updating state: {e}")
    
    async def _on_task_complete(self, was_cancelled: bool = False, via_stop_tool: bool = False) -> None:
        """Handle task completion by triggering chat inference with buffered output.
        
        Args:
            was_cancelled: Whether the task was cancelled vs completed normally
            via_stop_tool: Whether cancellation was via stop_task tool (info already in tool response)
        """
        if not self.task_manager:
            return
        
        # If cancelled via stop_task tool, the chat agent already has the info in the tool response
        # Don't inject a new user message
        if via_stop_tool:
            return
        
        # Get buffered task progress
        task_progress = self.task_manager.get_task_progress()
        
        if task_progress:
            try:
                # Use different prompt based on whether task was cancelled
                if was_cancelled:
                    prompt = "The task was cancelled. Please acknowledge the cancellation and summarize what was done before stopping."
                else:
                    prompt = "Task completed. Please summarize what was accomplished."
                
                # Process a summary message with the task progress
                response = await self.task_manager.chat_agent.process_message(
                    prompt,
                    task_progress
                )
                
                # Add response to chat
                self.chat_widget.add_message("assistant", response)
                
            except Exception as e:
                self.chat_widget.add_message("system", f"Error processing task completion: {str(e)}")
    
    async def on_chat_message(self, message: ChatMessage) -> None:
        """Handle chat messages from the user.
        
        Args:
            message: Chat message event
        """
        if not self.task_manager:
            self.chat_widget.add_message("system", "Not connected to game")
            return
        
        try:
            # Disable input while processing
            self.chat_widget.set_input_enabled(False)
            
            # Process the message
            response = await self.task_manager.process_chat_message(message.text)
            
            # Add response to chat
            self.chat_widget.add_message("assistant", response)
            
        except Exception as e:
            self.chat_widget.add_message("system", f"Error: {str(e)}")
        
        finally:
            # Re-enable input and restore focus
            self.chat_widget.set_input_enabled(True)
            self.chat_widget.chat_input.focus()
    
    def action_cancel_task(self) -> None:
        """Cancel the current task."""
        if self.task_manager and self.task_manager.is_task_running():
            # via_tool=False because this is from keyboard shortcut
            self.task_manager.cancel_task(via_tool=False)
            self.chat_widget.add_message("system", "Task cancelled")
    
    def action_clear_output(self) -> None:
        """Clear the task output."""
        self.task_output.clear()
    
    async def action_refresh(self) -> None:
        """Force refresh game state."""
        if self.game_client:
            await self.game_client.my_status(force_refresh=True)
            await self.game_client.my_map(force_refresh=True)
            await self._update_state()
            self.chat_widget.add_message("system", "State refreshed")
    
    def action_toggle_debug(self) -> None:
        """Toggle the debug panel visibility."""
        self.debug_mode = not self.debug_mode
        
        if self.debug_mode:
            # Show debug panel, hide others
            self.map_widget.styles.display = "none"
            self.progress_widget.styles.display = "none"
            self.movement_history.styles.display = "none"
            self.port_history.styles.display = "none"
            self.debug_widget.styles.display = "block"
            self.chat_widget.add_message("system", "Debug mode enabled - showing chat agent messages")
        else:
            # Hide debug panel, show others
            self.map_widget.styles.display = "block"
            self.progress_widget.styles.display = "block"
            self.movement_history.styles.display = "block"
            self.port_history.styles.display = "block"
            self.debug_widget.styles.display = "none"
            self.chat_widget.add_message("system", "Debug mode disabled")
    
    def action_help(self) -> None:
        """Show help information."""
        help_text = """
Keyboard Shortcuts:
- Ctrl+C: Cancel current task
- Ctrl+L: Clear task output
- Ctrl+R: Force refresh from server
- Ctrl+D: Toggle debug panel (shows chat agent messages)
- F1: Show this help
- Ctrl+Q: Quit application
- Tab: Switch focus between panels

Chat Commands:
- Ask the AI to navigate to sectors
- Request trading operations
- Query game state and map knowledge
- Start exploration tasks
"""
        self.chat_widget.add_message("system", help_text)
    
    async def on_unmount(self) -> None:
        """Clean up when app is closing."""
        if self.update_task:
            self.update_task.cancel()
        
        if self.task_manager:
            await self.task_manager.cleanup()