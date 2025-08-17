"""Base LLM agent with common functionality for Gradient Bang agents."""

import os
import json
from typing import Dict, Any, Optional, List, Callable, Tuple
from dataclasses import dataclass
from datetime import datetime
from openai import AsyncOpenAI
from loguru import logger


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
        output_callback: Optional[Callable[[str, Optional[str]], None]] = None,
        tool_executor: Optional[Any] = None,
    ):
        """Initialize the base LLM agent.

        Args:
            config: LLM configuration
            verbose_prompts: Whether to print messages as they're added
            output_callback: Optional callback for output lines (for TUI integration)
            tool_executor: Optional tool executor for executing game actions
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
        self.tool_executor = tool_executor
        self.cancelled = False
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
                if hasattr(message_type, 'value'):
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
        tools: Optional[List[Dict[str, Any]]] = None,
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

        # Always add the assistant message to history
        self.add_message(message_dict)
        
        # Automatically execute tools if we have a tool executor and there are tool calls
        if assistant_message.tool_calls and self.tool_executor:
            for tool_call in message_dict["tool_calls"]:
                tool_message, should_continue = await self.process_tool_call(tool_call)
                
                if tool_message:
                    self.add_message(tool_message)
                    
                if not should_continue:
                    break

        return message_dict

    def cancel(self):
        """Set cancellation flag to stop execution."""
        self.cancelled = True
        self._output("Execution cancelled")
        
    def reset_cancellation(self):
        """Reset cancellation flag."""
        self.cancelled = False
        
    async def process_tool_call(self, tool_call: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], bool]:
        """Process a single tool call.
        
        Args:
            tool_call: Tool call from assistant message
            
        Returns:
            (tool_message, should_continue) - tool_message is None if tool wasn't executed,
            should_continue is False to stop processing remaining tools
        """
        if self.cancelled:
            self._output("Cancelled during tool execution")
            return (None, False)
            
        tool_name = tool_call["function"]["name"]
        tool_args = json.loads(tool_call["function"]["arguments"])
        
        # Import TaskOutputType if available
        try:
            from utils.task_agent import TaskOutputType
            self._output(f"Executing {tool_name}({json.dumps(tool_args)})", TaskOutputType.TOOL_CALL)
        except ImportError:
            self._output(f"Executing {tool_name}({json.dumps(tool_args)})")
        
        result = await self.tool_executor.execute_tool(tool_name, tool_args)
        self._log_tool_result(tool_name, result, tool_args)
        
        tool_message = self.format_tool_message(tool_call["id"], result)
        return (tool_message, True)
        
    def _log_tool_result(self, tool_name: str, result: Dict[str, Any], tool_args: Dict[str, Any] = None):
        """Log tool execution result.
        
        Args:
            tool_name: Name of the tool that was executed
            result: Result from tool execution
            tool_args: Arguments passed to the tool
        """
        # Import TaskOutputType if available
        try:
            from utils.task_agent import TaskOutputType
            if not result.get("success"):
                self._output(f"Tool error ({tool_name}): {result.get('error', 'Unknown error')}", TaskOutputType.ERROR)
            else:
                self._output(f"{json.dumps(result)}", TaskOutputType.TOOL_RESULT)
        except ImportError:
            if not result.get("success"):
                self._output(f"Tool error ({tool_name}): {result.get('error', 'Unknown error')}")
            else:
                self._output(f"{tool_name} -> {json.dumps(result)}")
    
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
