"""Task output widget for displaying task execution logs."""

from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import RichLog, Static
from textual.reactive import reactive
from datetime import datetime
from rich.text import Text


class TaskOutputWidget(Vertical):
    """Widget for displaying task execution output."""
    
    def compose(self) -> ComposeResult:
        """Create child widgets."""
        yield Static("Task Output", id="task-output-header")
        yield RichLog(id="task-output-log", wrap=True, highlight=True, markup=True)
    
    def on_mount(self) -> None:
        """Initialize when mounted."""
        self.output_log = self.query_one("#task-output-log", RichLog)
        self.header = self.query_one("#task-output-header", Static)
    
    def add_line(self, text: str, style: str = ""):
        """Add a line to the task output.
        
        Args:
            text: Text to add
            style: Optional Rich style
        """
        timestamp = datetime.now().strftime("%H:%M:%S")
        
        if style:
            self.output_log.write(Text(f"[{timestamp}] {text}", style=style))
        else:
            self.output_log.write(f"[{timestamp}] {text}")
    
    def add_info(self, text: str):
        """Add an info line."""
        self.add_line(text, "cyan")
    
    def add_success(self, text: str):
        """Add a success line."""
        self.add_line(text, "green")
    
    def add_error(self, text: str):
        """Add an error line."""
        self.add_line(text, "red")
    
    def add_warning(self, text: str):
        """Add a warning line."""
        self.add_line(text, "yellow")
    
    def clear(self):
        """Clear the output log."""
        self.output_log.clear()
    
    def set_task_status(self, status: str):
        """Update the header to show task status.
        
        Args:
            status: Status text to display
        """
        self.header.update(f"Task Output - {status}")