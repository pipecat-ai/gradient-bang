"""LLM interface utilities for Gradient Bang agents."""

import os
import json
import asyncio
from typing import List, Dict, Any, Optional
from dataclasses import dataclass
from datetime import datetime
from openai import AsyncOpenAI
from utils.game_tools import get_tool_definitions, AsyncToolExecutor
from utils.prompts import GAME_DESCRIPTION, TASK_EXECUTION_INSTRUCTIONS


def log(message: str, data: dict = None):
    """Print a timestamped log message."""
    timestamp = datetime.now().strftime("%H:%M:%S")
    if data:
        # Compact JSON representation on same line
        print(f"{timestamp} {message}: {json.dumps(data, separators=(',', ':'))}")
    else:
        print(f"{timestamp} {message}")


@dataclass
class LLMConfig:
    """Configuration for LLM client."""

    api_key: Optional[str] = None
    model: str = "gpt-5"


class AsyncLLMAgent:
    """Async LLM agent for executing game tasks."""

    def __init__(
        self,
        config: LLMConfig,
        tool_executor: AsyncToolExecutor,
        verbose_prompts: bool = False,
    ):
        """Initialize the async LLM agent.

        Args:
            config: LLM configuration
            tool_executor: Async tool executor for game actions
            verbose_prompts: Whether to print messages as they're added
        """
        # Get API key from config or environment
        api_key = config.api_key or os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError(
                "OpenAI API key must be provided in config or OPENAI_API_KEY environment variable"
            )

        self.client = AsyncOpenAI(api_key=api_key)
        self.config = config
        self.tool_executor = tool_executor
        self.verbose_prompts = verbose_prompts
        self.messages = []  # Persistent messages array
        self.system_prompt = GAME_DESCRIPTION + "\n\n" + TASK_EXECUTION_INSTRUCTIONS

    def add_message(self, message: Dict[str, Any]):
        """Add a message to the conversation history."""
        self.messages.append(message)

        if self.verbose_prompts:
            # Pretty-print the message
            if message["role"] == "system":
                log("SYSTEM_MSG", {"content": message["content"][:200] + "..."})
            elif message["role"] == "user":
                log("USER_MSG", {"content": message["content"][:200] + "..."})
            elif message["role"] == "assistant":
                if message.get("content"):
                    log("ASSISTANT_MSG", {"content": message["content"]})
                if "tool_calls" in message:
                    for tool_call in message["tool_calls"]:
                        args = json.loads(tool_call["function"]["arguments"])
                        log("TOOL_CALL", {
                            "name": tool_call["function"]["name"],
                            "args": args
                        })
            elif message["role"] == "tool":
                try:
                    result = json.loads(message["content"])
                    log("TOOL_RESULT", {
                        "id": message["tool_call_id"][:8],
                        "result": result
                    })
                except:
                    log("TOOL_RESULT", {
                        "id": message["tool_call_id"][:8],
                        "content": message["content"][:200]
                    })

    async def get_assistant_response(self) -> Dict[str, Any]:
        """Get a response from the assistant using the current message history."""
        tools = get_tool_definitions()

        # Call the OpenAI API
        response = await self.client.chat.completions.create(
            model=self.config.model,
            messages=self.messages,
            tools=tools,
            reasoning_effort="minimal",
        )

        # Extract the assistant's message
        assistant_message = response.choices[0].message

        # Convert to dict format
        message_dict = {"role": "assistant", "content": assistant_message.content or ""}

        # Add tool calls if present
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

    async def execute_and_format_tools(
        self, tool_calls: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Execute tool calls and format the results as tool messages.

        Args:
            tool_calls: List of tool calls from the assistant

        Returns:
            List of tool messages with results
        """
        tool_messages = []

        for tool_call in tool_calls:
            tool_name = tool_call["function"]["name"]
            tool_args = json.loads(tool_call["function"]["arguments"])

            # Log the tool execution
            log("EXEC_TOOL", {"name": tool_name, "args": tool_args})

            # Execute the tool
            result = await self.tool_executor.execute_tool(tool_name, tool_args)

            # Log special events based on tool results
            if tool_name == "move" and result.get("success"):
                move_info = {
                    "from": result.get("old_sector"),
                    "to": result.get("new_sector")
                }
                if result.get("sector_contents"):
                    sector_info = result["sector_contents"]
                    if sector_info.get("port_info"):
                        port = sector_info["port_info"]
                        move_info["port"] = {
                            "class": port["class"],
                            "code": port["code"],
                            "buys": port["buys"],
                            "sells": port["sells"]
                        }
                    if sector_info.get("other_players"):
                        move_info["players"] = sector_info["other_players"]
                log("MOVE", move_info)
            elif tool_name == "my_status" and result.get("success"):
                status_info = {"sector": result.get("current_sector")}
                if result.get("sector_contents"):
                    sector_contents = result["sector_contents"]
                    if sector_contents.get("port_info"):
                        port = sector_contents["port_info"]
                        status_info["port"] = {
                            "class": port["class"],
                            "code": port["code"]
                        }
                    if sector_contents.get("other_players"):
                        status_info["players"] = sector_contents["other_players"]
                log("STATUS", status_info)
            elif tool_name == "plot_course" and result.get("success"):
                log("PLOT", {
                    "from": result.get("from_sector"),
                    "to": result.get("to_sector"),
                    "distance": result.get("distance"),
                    "path": result.get("path", [])
                })
            elif tool_name == "find_port":
                if result.get("success"):
                    if result.get("found"):
                        port_info = {
                            "sector": result.get("sector"),
                            "distance": result.get("distance")
                        }
                        if result.get("port"):
                            port = result["port"]
                            port_info["port"] = {
                                "class": port.get("class"),
                                "code": port.get("code"),
                                "buys": port.get("buys", []),
                                "sells": port.get("sells", [])
                            }
                        if result.get("path"):
                            port_info["path"] = result["path"]
                        log("FOUND_PORT", port_info)
                    else:
                        log("NO_PORT", {"message": result.get("message", "No ports found")})
                else:
                    log("TOOL_ERROR", {
                        "tool": "find_port",
                        "error": result.get("error", "Unknown error")
                    })
            elif tool_name == "my_map":
                if result.get("success"):
                    # The result contains the map data directly (minus the "success" key)
                    sectors_visited = result.get("sectors_visited", {})
                    log("MAP", {
                        "sectors_visited": len(sectors_visited),
                        "ports_known": sum(1 for s in sectors_visited.values() if s.get("port_info"))
                    })
            elif tool_name == "finished":
                log("FINISHED", {"message": result.get("message", "Done")})
            elif not result.get("success"):
                log("TOOL_ERROR", {
                    "tool": tool_name,
                    "error": result.get("error", "Unknown error")
                })

            # Format as tool message
            tool_message = {
                "role": "tool",
                "tool_call_id": tool_call["id"],
                "content": json.dumps(result),
            }

            tool_messages.append(tool_message)

        return tool_messages

    async def run_task(
        self, task: str, initial_state: Dict[str, Any], max_iterations: int = 50
    ) -> bool:
        """Run a complete task until finished or max iterations reached.

        Args:
            task: Natural language description of the task
            initial_state: Initial game state
            max_iterations: Maximum iterations

        Returns:
            True if task completed successfully, False otherwise
        """
        # Initialize conversation with system and user messages
        self.messages = []

        # Add system message
        system_message = {"role": "system", "content": self.system_prompt}
        self.add_message(system_message)

        # Add initial user message with task
        task_prompt = f"Your task: {task}\n\nCurrent state:\n{json.dumps(initial_state, indent=2)}"
        user_message = {
            "role": "user",
            "content": task_prompt,
        }
        self.add_message(user_message)

        # Main execution loop
        for iteration in range(max_iterations):
            log(f"STEP {iteration + 1}")

            # Get assistant response
            assistant_message = await self.get_assistant_response()
            self.add_message(assistant_message)

            # Check if assistant has tool calls
            if "tool_calls" in assistant_message:
                # Execute tools and get results
                tool_messages = await self.execute_and_format_tools(
                    assistant_message["tool_calls"]
                )

                # Add tool messages to history
                for tool_message in tool_messages:
                    self.add_message(tool_message)

                    # Check if task is finished
                    try:
                        result = json.loads(tool_message["content"])
                        tool_call_id = tool_message["tool_call_id"]

                        # Find which tool this result is for
                        for tc in assistant_message["tool_calls"]:
                            if (
                                tc["id"] == tool_call_id
                                and tc["function"]["name"] == "finished"
                            ):
                                if result.get("success"):
                                    return True
                    except json.JSONDecodeError:
                        pass
            else:
                # Assistant responded without tools
                if assistant_message["content"]:
                    log("RESPONSE", {"content": assistant_message["content"]})

        log("MAX_ITER", {"limit": max_iterations})
        return False
