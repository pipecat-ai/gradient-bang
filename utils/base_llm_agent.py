"""Base LLM agent with common functionality for Gradient Bang agents."""

import os
import json
import httpx
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

        self._last_dbg_message_idx = 0

        if tools_list:
            self.set_tools(tools_list)

    def set_tools(self, tools_list):
        """tools_list is a list of tool classes from tools_schema.py
        todo: rename that file"""

        tool_entries: List[Tuple[Any, Dict[str, Any]]] = []
        for entry in tools_list:
            if isinstance(entry, (tuple, list)):
                tool_class, init_kwargs = entry
            else:
                tool_class, init_kwargs = entry, {}
            tool_entries.append((tool_class, dict(init_kwargs)))

        self.openai_tools = get_openai_tools_list(
            self.game_client, [cls for cls, _ in tool_entries]
        )
        self.tools = {}
        for tool_class, init_kwargs in tool_entries:
            init_args = {"game_client": self.game_client}
            init_args.update(init_kwargs)
            tool_instance = tool_class(**init_args)
            self.tools[tool_class.schema().name] = tool_instance

    def add_message(self, message: Dict[str, Any]):
        """Add a message to the conversation history."""
        # Create a shallow copy without token_usage to avoid mutating caller's dict
        msg = {k: v for k, v in message.items() if k != "token_usage"}
        self.messages.append(msg)

        if self.verbose_prompts:
            self._log_message(msg)

    def _log_message(self, message: Dict[str, Any]):
        """Log a message for debugging."""
        try:
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
                        f"TOOL_RESULT [{message['tool_call_id']}]: {json.dumps(result)}"
                    )
                except Exception as e:
                    self._output(
                        f"TOOL_EXCEPTION [{message['tool_call_id']}]: {str(e)}"
                    )
        except Exception:
            self._output(f"GENERIC_LOG: {message}")

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
            kwargs["verbosity"] = "low"

        if self.openai_tools:
            kwargs["tools"] = self.openai_tools

        if self.verbose_prompts:
            # grab the messages at the end of the list back to the last user message
            dbg_messages = self.messages[self._last_dbg_message_idx :]
            self._last_dbg_message_idx = len(self.messages)
            for msg in dbg_messages:
                self._log_message(msg)

        response = await self.client.chat.completions.create(**kwargs)
        assistant_message = response.choices[0].message
        if self.verbose_prompts:
            self._log_message(response.model_dump())

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

        # Collect dynamic token usage categories from the response
        try:
            usage = getattr(response, "usage", None)
            usage_data = (
                usage.model_dump()
                if hasattr(usage, "model_dump")
                else (dict(usage) if isinstance(usage, dict) else None)
            )
        except Exception:
            usage_data = None

        token_usage: Dict[str, int] = {}
        if isinstance(usage_data, dict):
            for key, value in usage_data.items():
                if isinstance(value, int):
                    iv = int(value)
                    if iv != 0:
                        token_usage[key] = token_usage.get(key, 0) + iv
                elif isinstance(value, dict):
                    for subkey, subval in value.items():
                        if isinstance(subval, int):
                            iv = int(subval)
                            if iv != 0:
                                token_usage[subkey] = token_usage.get(subkey, 0) + iv

        if token_usage:
            message_dict["token_usage"] = token_usage
            if self.verbose_prompts:
                # Synthetic JSON-formatted message for per-turn token usage
                self._log_message(
                    {
                        "role": "system",
                        "content": json.dumps({"token_usage": token_usage}),
                    }
                )

        # Always add the assistant message to history
        self.add_message(message_dict)

        # Automatically execute tools
        if assistant_message.tool_calls:
            for tool_call in message_dict["tool_calls"]:
                tool_message, should_continue, _ = await self.process_tool_call(
                    tool_call
                )

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
    ) -> Tuple[Optional[Dict[str, Any]], bool, Any]:
        """Process a single tool call.

        Args:
            tool_call: Tool call from assistant message

        Returns:
            (tool_message, should_continue, raw_result) - tool_message is None if
            the tool wasn't executed, should_continue is False to stop processing
            remaining tools, and raw_result is the object returned by the tool
            (e.g., `LLMResult`).

        # todo: add hooks here for logging, or leave the logging like it is now (require overriding of this method to log?)
        """
        if self.cancelled:
            self._output("Cancelled during tool execution")
            return (None, False, None)

        tool_name = tool_call["function"]["name"]
        tool_args = json.loads(tool_call["function"]["arguments"])

        try:
            result = await self.tools[tool_name](**tool_args)
        except Exception as e:
            detail_msg = None
            if isinstance(e, httpx.HTTPStatusError) and e.response is not None:
                # Prefer JSON detail, then raw response text; avoid logging status text
                try:
                    body = e.response.json()
                except Exception:
                    body = None
                if isinstance(body, dict) and body.get("detail"):
                    detail_msg = body["detail"]
                else:
                    try:
                        text = e.response.text.strip()
                    except Exception:
                        text = None
                    if text:
                        detail_msg = text

            if detail_msg is not None:
                # Return plain detail string as the tool result content
                tool_message = self.format_tool_message(
                    tool_call["id"], {"error": detail_msg}
                )
                return (tool_message, False)

            # Fallback to current behavior with logging
            self._output(f"Error executing tool {tool_name}: {str(e)}")
            tool_message = self.format_tool_message(tool_call["id"], {"error": str(e)})
            return (tool_message, False, None)

        tool_message = self.format_tool_message(tool_call["id"], result)
        return (tool_message, True, result)

    def format_tool_message(self, tool_call_id: str, result: Any) -> Dict[str, Any]:
        """Format a tool result as a message.

        Args:
            tool_call_id: ID of the tool call
            result: Result from tool execution (plain dict or string)

        Returns:
            Tool message dictionary
        """
        if isinstance(result, str):
            content = result
        elif isinstance(result, dict):
            # Check if result has a summary field
            summary = result.get("summary")
            if summary and isinstance(summary, str) and summary.strip():
                # Use summary if available
                payload = {"summary": summary.strip()}
            else:
                # Otherwise use full result
                payload = {"result": result}
            content = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        else:
            payload = {"result": result}
            content = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
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
