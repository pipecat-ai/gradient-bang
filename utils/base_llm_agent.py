"""Base LLM agent with common functionality for Gradient Bang agents."""

import os
import json
from typing import Dict, Any, Optional, List, Callable, Tuple
from dataclasses import dataclass
from openai import AsyncOpenAI
from loguru import logger
from utils.api_client import AsyncGameClient

from utils.tools_schema import get_openai_tools_list


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
        game_client: AsyncGameClient,
        character_id: str,
        verbose_prompts: bool = False,
        output_callback: Optional[Callable[[str, Optional[str]], None]] = None,
        tools_list: Optional[List[Any]] = None,
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
        self.cancelled = False
        self.messages: List[Dict[str, Any]] = []
        self.game_client = game_client
        self.character_id = character_id
        self.tools: Dict[str, Callable[Any]] = {}
        self.openai_tools: List[Dict[str, Any]] = []

        # Keep track of steps. We will treat a "step" as any inference that returns an assistant message or completes a tool call.
        self.steps = 0

        if tools_list:
            self.set_tools(tools_list)

    def set_tools(self, tools_list):
        """tools_list is a list of tool classes from tools_schema.py
        todo: rename that file"""

        self.openai_tools = get_openai_tools_list(self.game_client, tools_list)
        self.tools: Dict[str, Callable[Any]] = {}
        for tool_class in tools_list:
            self.tools[tool_class.schema().name] = tool_class(
                game_client=self.game_client
            )

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
            self._output(f"USER_MSG: {message.get('content', '')}")
        elif message["role"] == "assistant":
            if message.get("content"):
                self._output(f"ASSISTANT_MSG: {message['content']}")
            if "tool_calls" in message:
                for tool_call in message["tool_calls"]:
                    args = json.loads(tool_call["function"]["arguments"])
                    self._output(
                        f"TOOL_CALL [{tool_call['id']}]: {tool_call['function']['name']}: {json.dumps(args)}"
                    )
        elif message["role"] == "tool":
            try:
                result = json.loads(message["content"])
                self._output(
                    f"TOOL_RESULT [{message['tool_call_id']}]: {json.dumps(result)[:200]}"
                )
            except Exception as e:
                self._output(f"TOOL_EXCEPTION [{message['tool_call_id']}]: {str(e)}")

    def _output(self, text: str, message_type: Optional[str] = None):
        """Output text, using callback if available, else log."""
        if self.output_callback:
            self.output_callback(text, message_type)
        else:
            if message_type:
                # Handle both string and Enum types
                if hasattr(message_type, "value"):
                    # It's an Enum
                    type_str = message_type.value
                else:
                    # It's already a string
                    type_str = message_type
                logger.info(f"[{type_str}] {text}")
            else:
                logger.info(text)

    async def get_assistant_response(
        self,
        reasoning_effort: Optional[str] = "minimal",
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

        if self.openai_tools:
            kwargs["tools"] = self.openai_tools

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

        # Always add the assistant message to history
        self.add_message(message_dict)

        # Automatically execute tools
        if assistant_message.tool_calls:
            for tool_call in message_dict["tool_calls"]:
                tool_message, should_continue = await self.process_tool_call(tool_call)

                if tool_message:
                    self.add_message(tool_message)

                if not should_continue:
                    return message_dict

        return message_dict

    def cancel(self):
        """Set cancellation flag to stop execution."""
        self.cancelled = True
        self._output("Execution cancelled")

    def reset_cancellation(self):
        """Reset cancellation flag."""
        self.cancelled = False

    async def process_tool_call(
        self, tool_call: Dict[str, Any]
    ) -> Tuple[Optional[Dict[str, Any]], bool]:
        """Process a single tool call.

        Args:
            tool_call: Tool call from assistant message

        Returns:
            (tool_message, should_continue) - tool_message is None if tool wasn't executed,
            should_continue is False to stop processing remaining tools

        # todo: add hooks here for logging, or leave the logging like it is now (require overriding of this method to log?)
        """
        if self.cancelled:
            self._output("Cancelled during tool execution")
            return (None, False)

        tool_name = tool_call["function"]["name"]
        tool_args = json.loads(tool_call["function"]["arguments"])

        try:
            result = await self.tools[tool_name](**tool_args)
        except Exception as e:
            self._output(f"Error executing tool {tool_name}: {str(e)}")
            return ({"error": str(e)}, False)

        tool_message = self.format_tool_message(tool_call["id"], result)
        return (tool_message, True)

    def format_tool_message(self, tool_call_id: str, result: Any) -> Dict[str, Any]:
        """Format a tool result as a message.

        Args:
            tool_call_id: ID of the tool call
            result: Result from tool execution

        Returns:
            Tool message dictionary
        """
        content = json.dumps(result) if not isinstance(result, str) else result
        return {"role": "tool", "tool_call_id": tool_call_id, "content": content}

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
                wait_time = 2**attempt
                self._output(f"API error, retrying in {wait_time}s: {str(e)}")
                await asyncio.sleep(wait_time)
