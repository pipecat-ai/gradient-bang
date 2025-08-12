"""Progress widget for showing task execution status."""

from typing import Optional
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import Static, ProgressBar
from textual.reactive import reactive
from datetime import datetime, timedelta
import asyncio


class ProgressWidget(Vertical):
    """Widget for displaying task progress and status."""
    
    task_running = reactive(False)
    task_description = reactive("")
    last_action = reactive("")
    elapsed_time = reactive(timedelta(0))
    
    def compose(self) -> ComposeResult:
        """Create child widgets."""
        yield Static("Task Status: Idle", id="task-status")
        yield Static("", id="task-description")
        yield Static("", id="last-action")
        yield Static("", id="elapsed-time")
    
    def on_mount(self) -> None:
        """Initialize when mounted."""
        self.status_label = self.query_one("#task-status", Static)
        self.description_label = self.query_one("#task-description", Static)
        self.action_label = self.query_one("#last-action", Static)
        self.time_label = self.query_one("#elapsed-time", Static)
        self.start_time: Optional[datetime] = None
        self.update_task = None
    
    def start_task(self, description: str):
        """Start tracking a new task.
        
        Args:
            description: Description of the task
        """
        self.task_running = True
        self.task_description = description
        self.last_action = "Starting..."
        self.start_time = datetime.now()
        self.elapsed_time = timedelta(0)
        
        self._update_display()
        
        # Start the timer update task
        if self.update_task:
            self.update_task.cancel()
        self.update_task = asyncio.create_task(self._update_timer())
    
    def stop_task(self, message: str = "Task completed"):
        """Stop tracking the current task.
        
        Args:
            message: Completion message
        """
        self.task_running = False
        self.last_action = message
        
        if self.update_task:
            self.update_task.cancel()
            self.update_task = None
        
        self._update_display()
    
    def update_action(self, action: str):
        """Update the last action text.
        
        Args:
            action: Description of the last action
        """
        self.last_action = action
        self._update_display()
    
    async def _update_timer(self):
        """Update the elapsed time display."""
        while self.task_running:
            if self.start_time:
                self.elapsed_time = datetime.now() - self.start_time
                self._update_display()
            await asyncio.sleep(1)
    
    def _update_display(self):
        """Update all display elements."""
        if self.task_running:
            self.status_label.update("[bold green]Task Status: Running[/bold green]")
            self.description_label.update(f"Task: {self.task_description}")
            self.action_label.update(f"Action: {self.last_action}")
            
            # Format elapsed time
            total_seconds = int(self.elapsed_time.total_seconds())
            hours = total_seconds // 3600
            minutes = (total_seconds % 3600) // 60
            seconds = total_seconds % 60
            
            if hours > 0:
                time_str = f"{hours:02d}:{minutes:02d}:{seconds:02d}"
            else:
                time_str = f"{minutes:02d}:{seconds:02d}"
            
            self.time_label.update(f"Elapsed: {time_str}")
        else:
            self.status_label.update("[bold yellow]Task Status: Idle[/bold yellow]")
            if self.last_action:
                self.action_label.update(f"Last: {self.last_action}")
            else:
                self.action_label.update("")
            
            if self.task_description:
                self.description_label.update(f"Previous: {self.task_description}")
            else:
                self.description_label.update("")
            
            self.time_label.update("")