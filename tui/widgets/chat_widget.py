"""Chat widget for player-AI conversation."""

from typing import Optional
from textual.app import ComposeResult
from textual.containers import Vertical, ScrollableContainer
from textual.widgets import Static, Input, RichLog
from textual.reactive import reactive
from textual.message import Message
from datetime import datetime
from rich.text import Text


class ChatMessage(Message):
    """Message sent when user submits chat input."""
    def __init__(self, text: str) -> None:
        self.text = text
        super().__init__()


class ChatWidget(Vertical):
    """Widget for chat display and input."""
    
    def compose(self) -> ComposeResult:
        """Create child widgets."""
        yield ScrollableContainer(
            RichLog(id="chat-log", wrap=True, highlight=True, markup=True),
            id="chat-container"
        )
        yield Input(
            placeholder="Type your message...",
            id="chat-input"
        )
    
    def on_mount(self) -> None:
        """Initialize when mounted."""
        self.chat_log = self.query_one("#chat-log", RichLog)
        self.chat_input = self.query_one("#chat-input", Input)
        self.chat_input.focus()
    
    def add_message(self, role: str, content: str, timestamp: Optional[datetime] = None):
        """Add a message to the chat log.
        
        Args:
            role: Role of the message sender (user, assistant, system)
            content: Message content
            timestamp: Optional timestamp (defaults to now)
        """
        if timestamp is None:
            timestamp = datetime.now()
        
        time_str = timestamp.strftime("%H:%M:%S")
        
        if role == "user":
            self.chat_log.write(Text(f"[{time_str}] You: ", style="bold cyan"))
            self.chat_log.write(content)
        elif role == "assistant":
            self.chat_log.write(Text(f"[{time_str}] Ship AI: ", style="bold green"))
            self.chat_log.write(content)
        elif role == "system":
            self.chat_log.write(Text(f"[{time_str}] System: ", style="bold yellow"))
            self.chat_log.write(content)
        else:
            self.chat_log.write(f"[{time_str}] {role}: {content}")
        
        self.chat_log.write("")
        
        # Only focus on input for user messages to avoid conflicts
        if role == "user":
            self.chat_input.focus()
    
    def on_input_submitted(self, event: Input.Submitted) -> None:
        """Handle input submission."""
        text = event.value.strip()
        if text:
            self.add_message("user", text)
            self.post_message(ChatMessage(text))
            self.chat_input.value = ""
            # Keep focus on input
            self.chat_input.focus()
    
    def clear_chat(self):
        """Clear the chat log."""
        self.chat_log.clear()
    
    def set_input_enabled(self, enabled: bool):
        """Enable or disable the input field."""
        self.chat_input.disabled = not enabled