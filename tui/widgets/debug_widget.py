"""Debug widget for displaying chat agent messages."""

import json
from typing import List, Dict, Any, Optional
from textual.app import ComposeResult
from textual.containers import Vertical, ScrollableContainer
from textual.widgets import Static, RichLog
from rich.json import JSON
from rich.text import Text


class DebugWidget(Vertical):
    """Widget for displaying debug information about chat agent messages."""
    
    def compose(self) -> ComposeResult:
        """Create child widgets."""
        yield Static("Debug Panel - Chat Agent Messages", id="debug-header")
        yield ScrollableContainer(
            RichLog(id="debug-log", wrap=True, highlight=True, markup=True),
            id="debug-container"
        )
    
    def on_mount(self) -> None:
        """Initialize when mounted."""
        self.debug_log = self.query_one("#debug-log", RichLog)
        self.header = self.query_one("#debug-header", Static)
        
        # Add initial message
        self.debug_log.write(Text("Debug panel ready. Messages will appear here when the chat agent makes API calls.", style="dim"))
    
    def update_messages(self, messages: List[Dict[str, Any]], status: Optional[str] = None):
        """Update the debug display with the latest messages.
        
        Args:
            messages: List of message dictionaries from the chat agent
            status: Optional status message (e.g., "Request in progress...")
        """
        self.debug_log.clear()
        
        # Add header with status
        if status:
            # Show status prominently at the top
            if "in progress" in status:
                self.debug_log.write(Text(f"⏳ {status}", style="bold yellow on dark_blue"))
            elif "Complete" in status:
                self.debug_log.write(Text(f"✅ {status}", style="bold green"))
            elif "exceeded" in status:
                self.debug_log.write(Text(f"⚠️ {status}", style="bold red"))
            else:
                self.debug_log.write(Text(status, style="bold cyan"))
            self.debug_log.write("")
            self.debug_log.write(Text("=== Chat Agent Messages ===", style="bold cyan"))
        else:
            self.debug_log.write(Text("=== Chat Agent Messages (Most Recent Inference) ===", style="bold cyan"))
        self.debug_log.write("")
        
        # Display each message
        for i, msg in enumerate(messages):
            # Message header
            role = msg.get("role", "unknown")
            style_map = {
                "system": "bold yellow",
                "user": "bold green",
                "assistant": "bold blue",
                "tool": "bold magenta"
            }
            style = style_map.get(role, "white")
            
            self.debug_log.write(Text(f"[Message {i+1}] Role: {role}", style=style))
            
            # Handle content based on type
            content = msg.get("content", "")
            
            if isinstance(content, str):
                # Simple string content
                if len(content) > 500:
                    self.debug_log.write(f"Content: {content[:500]}... (truncated)")
                else:
                    self.debug_log.write(f"Content: {content}")
            elif isinstance(content, list):
                # Multi-part content (e.g., with task_progress)
                self.debug_log.write("Content (multi-part):")
                for j, part in enumerate(content):
                    if isinstance(part, dict):
                        part_type = part.get("type", "unknown")
                        part_text = part.get("text", "")
                        if len(part_text) > 300:
                            self.debug_log.write(f"  Part {j+1} ({part_type}): {part_text[:300]}... (truncated)")
                        else:
                            self.debug_log.write(f"  Part {j+1} ({part_type}): {part_text}")
            else:
                # Other content types
                self.debug_log.write(f"Content: {str(content)[:500]}")
            
            # Show tool calls if present
            if "tool_calls" in msg:
                self.debug_log.write("Tool Calls:")
                for tc in msg["tool_calls"]:
                    func_name = tc.get("function", {}).get("name", "unknown")
                    func_args = tc.get("function", {}).get("arguments", "{}")
                    self.debug_log.write(f"  - {func_name}: {func_args}")
            
            # Show tool call ID for tool responses
            if role == "tool" and "tool_call_id" in msg:
                self.debug_log.write(f"Tool Call ID: {msg['tool_call_id'][:8]}...")
            
            self.debug_log.write("")  # Empty line between messages
        
        # Add summary footer
        self.debug_log.write(Text("─" * 60, style="dim"))
        
        # Show status in footer if available
        if status:
            if "in progress" in status:
                footer_text = f"Status: {status} | Messages: {len(messages)}"
                self.debug_log.write(Text(footer_text, style="bold yellow"))
            elif "Complete" in status:
                footer_text = f"Status: {status} | Messages: {len(messages)}"
                self.debug_log.write(Text(footer_text, style="bold green"))
            else:
                footer_text = f"Status: {status} | Messages: {len(messages)}"
                self.debug_log.write(Text(footer_text, style="bold cyan"))
        else:
            self.debug_log.write(Text(f"Total Messages: {len(messages)}", style="bold cyan"))
    
    def clear(self):
        """Clear the debug log."""
        self.debug_log.clear()