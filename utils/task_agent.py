"""Task execution agent for Gradient Bang - refactored from AsyncLLMAgent."""

import json
from enum import Enum
from typing import Dict, Any, Optional, Callable, Tuple

from utils.api_client import AsyncGameClient
from utils.base_llm_agent import BaseLLMAgent, LLMConfig
from utils.game_tools import get_tool_definitions, AsyncToolExecutor
from utils.prompts import GAME_DESCRIPTION, TASK_EXECUTION_INSTRUCTIONS


class TaskOutputType(Enum):
    """Types of output messages from the task agent."""

    STEP = "STEP"
    FINISHED = "FINISHED"
    MESSAGE = "MESSAGE"
    TOOL_CALL = "TOOL_CALL"
    TOOL_RESULT = "TOOL_RESULT"
    ERROR = "ERROR"


def create_task_system_message() -> str:
    """Create the system prompt for the LLM.

    Returns:
        Complete system prompt including game description and instructions
    """
    return f"""{GAME_DESCRIPTION}

{TASK_EXECUTION_INSTRUCTIONS}
"""


def create_task_instruction_user_message(task: str, initial_state: dict) -> str:
    """Create a task-specific prompt for the LLM.

    Args:
        task: The task to be completed.
        initial_state: Initial game state (sector, time, etc.).

    Returns:
        Formatted prompt for the current decision point.

    Example:
        >>> create_npc_task_prompt("Move to sector 10", {"current_sector": 0})
        '# Agent Instructions\n...'
    """
    prompt_parts = [
        "# Agent Instructions",
        "",
        "You are an autonomous agent. Execute this task step by step. After each step, observe the results and react accordingly. Responses you generate from each inference call will be used only internally to complete the task. The only information that is returned to the user is the final result message that is passed to the `finished` tool call.",
        "",
        "When you have completed the task, call the `finished` tool with a message to be returned to the user who initiated the task.",
        "",
        "You do not need to make an initial call to the `my_status` tool. Here is the result of the most recent my_status() call:",
        "",
        f"{json.dumps(initial_state.get('status', {}))}",
        "",
        f"The current time is: {initial_state.get('time', 'unknown')}",
        "",
        "# Task Instructions",
        "",
        f"{task}",
        "",
    ]

    return "\n".join(prompt_parts)


class TaskAgent(BaseLLMAgent):
    """Task execution agent using OODA loop for complex game tasks."""

    def __init__(
        self,
        config: LLMConfig,
        verbose_prompts: bool = False,
        output_callback: Optional[Callable[[str], None]] = None,
        tool_executor: Optional[AsyncToolExecutor] = None,
    ):
        """Initialize the task agent.

        Args:
            config: LLM configuration
            verbose_prompts: Whether to print messages as they're added
            output_callback: Optional callback for output lines (for TUI integration)
            tool_executor: Tool executor for executing game actions
        """
        super().__init__(config, verbose_prompts, output_callback, tool_executor)
        self.system_message = create_task_system_message()
        self.finished = False
        self.finished_message = None

    async def process_tool_call(self, tool_call: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], bool]:
        """Override to handle 'finished' tool specially.
        
        Args:
            tool_call: Tool call from assistant message
            
        Returns:
            (tool_message, should_continue) - tool_message is None if tool wasn't executed
        """
        tool_name = tool_call["function"]["name"]
        
        # Special handling for "finished" - don't execute, just extract message
        if tool_name == "finished":
            tool_args = json.loads(tool_call["function"]["arguments"])
            self.finished = True
            self.finished_message = tool_args.get("message", "Done")
            self._output(f"{self.finished_message}", TaskOutputType.FINISHED)
            return (None, False)  # Don't add to history, stop processing
            
        # For all other tools, use base implementation
        return await super().process_tool_call(tool_call)

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
        self.reset_cancellation()
        self.clear_messages()

        system_message = {"role": "system", "content": self.system_message}
        self.add_message(system_message)

        user_message = {
            "role": "user",
            "content": create_task_instruction_user_message(task, initial_state),
        }
        self.add_message(user_message)

        for iteration in range(max_iterations):
            if self.cancelled:
                self._output("Task cancelled", TaskOutputType.FINISHED)
                return False

            self._output(f"Step {iteration + 1}", TaskOutputType.STEP)

            try:
                assistant_message = await self.get_assistant_response(
                    tools=get_tool_definitions(), reasoning_effort="minimal"
                )
            except Exception as e:
                self._output(f"Error getting assistant response: {str(e)}", TaskOutputType.ERROR)
                return False

            # Check if the task was marked as finished during tool execution
            if self.finished:
                return True
                
            # Check cancellation after tool execution
            if self.cancelled:
                self._output("Task cancelled", TaskOutputType.FINISHED)
                return False
            
            # Log any non-tool response
            if not assistant_message.get("tool_calls") and assistant_message.get("content"):
                self._output(assistant_message["content"], TaskOutputType.MESSAGE)

        self._output(f"Task reached maximum iterations ({max_iterations})")
        return False
