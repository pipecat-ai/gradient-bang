"""Base LLM agent with common functionality for Gradient Bang agents."""

import os
import json
from typing import Dict, Any, Optional, List, Callable
from dataclasses import dataclass
from datetime import datetime
from openai import AsyncOpenAI


def log(message: str, data: dict = None):
    """Print a timestamped log message."""
    timestamp = datetime.now().strftime("%H:%M:%S")
    if data:
        print(f"{timestamp} {message}: {json.dumps(data, separators=(',', ':'))}")
    else:
        print(f"{timestamp} {message}")


@dataclass
class LLMConfig:
    """Configuration for LLM client."""
    api_key: Optional[str] = None
    model: str = "gpt-5"


class BaseLLMAgent:
    """Base class for async LLM agents with common OpenAI functionality."""

    def __init__(
        self,
        config: LLMConfig,
        verbose_prompts: bool = False,
        output_callback: Optional[Callable[[str], None]] = None
    ):
        """Initialize the base LLM agent.

        Args:
            config: LLM configuration
            verbose_prompts: Whether to print messages as they're added
            output_callback: Optional callback for output lines (for TUI integration)
        """
        api_key = config.api_key or os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError(
                "OpenAI API key must be provided in config or OPENAI_API_KEY environment variable"
            )

        self.client = AsyncOpenAI(api_key=api_key)
        self.config = config
        self.verbose_prompts = verbose_prompts
        self.output_callback = output_callback
        self.messages: List[Dict[str, Any]] = []

    def add_message(self, message: Dict[str, Any]):
        """Add a message to the conversation history."""
        self.messages.append(message)

        if self.verbose_prompts:
            self._log_message(message)

    def _log_message(self, message: Dict[str, Any]):
        """Log a message for debugging."""
        if message["role"] == "system":
            self._output(f"SYSTEM_MSG: {message['content'][:200]}...")
        elif message["role"] == "user":
            if isinstance(message["content"], list):
                for content in message["content"]:
                    if content["type"] == "text":
                        text = content["text"][:200] + "..." if len(content["text"]) > 200 else content["text"]
                        self._output(f"USER_MSG: {text}")
            else:
                self._output(f"USER_MSG: {message['content'][:200]}...")
        elif message["role"] == "assistant":
            if message.get("content"):
                self._output(f"ASSISTANT_MSG: {message['content']}")
            if "tool_calls" in message:
                for tool_call in message["tool_calls"]:
                    args = json.loads(tool_call["function"]["arguments"])
                    self._output(f"TOOL_CALL {tool_call['function']['name']}: {json.dumps(args)}")
        elif message["role"] == "tool":
            try:
                result = json.loads(message["content"])
                self._output(f"TOOL_RESULT [{message['tool_call_id'][:8]}]: {json.dumps(result)[:200]}")
            except:
                self._output(f"TOOL_RESULT [{message['tool_call_id'][:8]}]: {message['content'][:200]}")

    def _output(self, text: str):
        """Output text, using callback if available, else print."""
        if self.output_callback:
            self.output_callback(text)
        else:
            timestamp = datetime.now().strftime("%H:%M:%S")
            print(f"{timestamp} {text}")

    async def get_assistant_response(
        self,
        tools: Optional[List[Dict[str, Any]]] = None,
        reasoning_effort: Optional[str] = "minimal"
    ) -> Dict[str, Any]:
        """Get a response from the assistant using the current message history.
        
        Args:
            tools: Optional list of tool definitions
            reasoning_effort: Reasoning effort level for models that support it (e.g., gpt-5)
            
        Returns:
            Assistant message dictionary
        """
        kwargs = {
            "model": self.config.model,
            "messages": self.messages,
        }
        
        # Only add reasoning_effort for models that support it (gpt-5)
        if reasoning_effort and "gpt-5" in self.config.model:
            kwargs["reasoning_effort"] = reasoning_effort
        
        if tools:
            kwargs["tools"] = tools

        response = await self.client.chat.completions.create(**kwargs)
        assistant_message = response.choices[0].message

        message_dict = {"role": "assistant", "content": assistant_message.content or ""}

        if assistant_message.tool_calls:
            message_dict["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": tc.type,
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                }
                for tc in assistant_message.tool_calls
            ]

        return message_dict

    def format_tool_message(self, tool_call_id: str, result: Any) -> Dict[str, Any]:
        """Format a tool result as a message.
        
        Args:
            tool_call_id: ID of the tool call
            result: Result from tool execution
            
        Returns:
            Tool message dictionary
        """
        content = json.dumps(result) if not isinstance(result, str) else result
        return {
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": content
        }

    def clear_messages(self):
        """Clear the message history."""
        self.messages = []

    def get_message_count(self) -> int:
        """Get the number of messages in history."""
        return len(self.messages)

    async def handle_retry_with_backoff(self, func, max_retries: int = 3):
        """Handle API calls with exponential backoff retry logic.
        
        Args:
            func: Async function to call
            max_retries: Maximum number of retries
            
        Returns:
            Result from the function
        """
        import asyncio
        
        for attempt in range(max_retries):
            try:
                return await func()
            except Exception as e:
                if attempt == max_retries - 1:
                    raise
                wait_time = 2 ** attempt
                self._output(f"API error, retrying in {wait_time}s: {str(e)}")
                await asyncio.sleep(wait_time)