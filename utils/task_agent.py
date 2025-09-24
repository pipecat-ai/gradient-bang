"""Task execution agent for Gradient Bang - refactored from AsyncLLMAgent."""

import json
from enum import Enum
from typing import Dict, Any, Optional, Tuple, List, Callable


from utils.base_llm_agent import BaseLLMAgent
from utils.api_client import LLMResult
from utils.prompts import GAME_DESCRIPTION, TASK_EXECUTION_INSTRUCTIONS
from utils.tools_schema import (
    MyMap,
    MyStatus,
    PlotCourse,
    Move,
    CheckTrade,
    Trade,
    SendMessage,
    RechargeWarpPower,
    TransferWarpPower,
    TaskFinished,
)


class TaskOutputType(Enum):
    """Types of output messages from the task agent."""

    STEP = "STEP"
    FINISHED = "FINISHED"
    MESSAGE = "MESSAGE"
    TOOL_CALL = "TOOL_CALL"
    TOOL_RESULT = "TOOL_RESULT"
    ERROR = "ERROR"
    TOKEN_USAGE = "TOKEN_USAGE"

    def __str__(self):
        return self.value


def create_task_system_message() -> str:
    """Create the system prompt for the LLM.

    Returns:
        Complete system prompt including game description and instructions
    """
    return f"""{GAME_DESCRIPTION}

{TASK_EXECUTION_INSTRUCTIONS}
"""


def create_task_instruction_user_message(task: str) -> str:
    """Create a task-specific prompt for the LLM.

    Args:
        task: The task to be completed.

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
        "# Task Instructions",
        "",
        f"{task}",
        "",
    ]
    return "\n".join(prompt_parts)


def create_initial_status_messages(
    initial_state: Dict[str, Any],
) -> List[Dict[str, Any]]:
    tool_call = {
        "role": "assistant",
        "tool_calls": [
            {
                "id": "call_ulwjyWabbDDwS6uHOAoWZKGG",
                "type": "function",
                "function": {"name": "my_status", "arguments": "{}"},
            }
        ],
    }
    tool_result = {
        "role": "tool",
        "tool_call_id": "call_ulwjyWabbDDwS6uHOAoWZKGG",
        "content": json.dumps(initial_state.get("status", {})),
    }
    return [tool_call, tool_result]


class TaskAgent(BaseLLMAgent):
    """Task execution agent using OODA loop for complex game tasks."""

    def __init__(
        self,
        tool_call_event_callback: Optional[Callable[[str, Any], None]] = None,
        tool_result_event_callback: Optional[Callable[[str, Any], None]] = None,
        **kwargs,
    ):
        """Initialize the task agent."""
        super().__init__(**kwargs)
        self.system_message = create_task_system_message()
        self.finished = False
        self.finished_message = None
        self.tool_call_event_callback = tool_call_event_callback
        self.tool_result_event_callback = tool_result_event_callback

        # for now let's define all tools for the task agent
        self.set_tools(
            [
                MyMap,
                MyStatus,
                PlotCourse,
                Move,
                CheckTrade,
                Trade,
                SendMessage,
                RechargeWarpPower,
                TransferWarpPower,
                TaskFinished,
            ]
        )

    async def process_tool_call(
        self, tool_call: Dict[str, Any]
    ) -> Tuple[Optional[Dict[str, Any]], bool, Any]:
        """Override base class method to exit the task when the 'finished' tool is called.

        Args:
            tool_call: Tool call from assistant message

        Returns:
            (tool_message, should_continue, raw_result) where raw_result is the
            underlying tool output (e.g. `LLMResult`). tool_message is None if
            the tool wasn't executed.
        """
        tool_name = tool_call["function"]["name"]
        tool_args = json.loads(tool_call["function"]["arguments"])

        self._output(
            f"Executing {tool_name}({json.dumps(tool_args)})", TaskOutputType.TOOL_CALL
        )

        if self.tool_call_event_callback:
            await self.tool_call_event_callback(tool_name, tool_args)

        # Special handling for "finished" - don't execute, just extract message
        if tool_name == "finished":
            self.finished = True
            self.finished_message = tool_args.get("message", "Done")
            self._output(f"{self.finished_message}", TaskOutputType.FINISHED)
            return (None, False, None)  # Don't add to history, stop processing

        # For all other tools, use base implementation
        tool_message, should_continue, raw_result = await super().process_tool_call(
            tool_call
        )
        try:
            self._output(f"{json.dumps(tool_message)}", TaskOutputType.TOOL_RESULT)
        except Exception:
            self._output(f"{str(tool_message)}", TaskOutputType.TOOL_RESULT)

        if self.tool_result_event_callback:
            structured_payload: Dict[str, Any] = {}
            if raw_result is not None:
                if isinstance(raw_result, LLMResult) or hasattr(
                    raw_result, "llm_summary"
                ):
                    structured_payload["result"] = dict(raw_result)
                    summary = (getattr(raw_result, "llm_summary", "") or "").strip()
                    structured_payload["summary"] = summary
                    delta = getattr(raw_result, "llm_delta", None)
                    if delta:
                        structured_payload["delta"] = delta
                elif isinstance(raw_result, (dict, list, str, int, float, bool)):
                    structured_payload["result"] = raw_result
                else:
                    structured_payload["result"] = raw_result
            if tool_message is not None:
                structured_payload["tool_message"] = tool_message

            await self.tool_result_event_callback(tool_name, structured_payload)

        return (tool_message, should_continue, raw_result)

    async def run_task(
        self,
        task: str,
        initial_state: Optional[Dict[str, Any]] = None,
        max_iterations: int = 50,
    ) -> bool:
        """Run a complete task until finished or max iterations reached.

        Args:
            task: Natural language description of the task
            initial_state: Initial game state
            max_iterations: Maximum iterations

        Returns:
            True if task completed successfully, False otherwise
        """
        # todo: should we move/add the guard about not running a task if one is already running here?
        self.finished = False
        self.finished_message = None
        self.reset_cancellation()
        self.clear_messages()

        self.add_message({"role": "system", "content": self.system_message})
        self.add_message(
            {
                "role": "user",
                "content": create_task_instruction_user_message(task),
            }
        )
        if initial_state:
            for message in create_initial_status_messages(initial_state):
                self.add_message(message)

        # Accumulate token usage across all assistant responses
        token_usage_totals: Dict[str, int] = {}

        for iteration in range(max_iterations):
            if self.cancelled:
                # Emit token usage summary before exiting
                if token_usage_totals:
                    filtered = {k: v for k, v in token_usage_totals.items() if v != 0}
                    if filtered:
                        self._output(json.dumps(filtered), TaskOutputType.TOKEN_USAGE)
                self._output("Task cancelled", TaskOutputType.FINISHED)
                return False

            self._output(f"Step {iteration}", TaskOutputType.STEP)

            try:
                assistant_message = await self.get_assistant_response(
                    reasoning_effort="minimal"
                )
            except Exception as e:
                self._output(
                    f"Error getting assistant response: {str(e)}", TaskOutputType.ERROR
                )
                # Emit token usage summary before exiting
                if token_usage_totals:
                    filtered = {k: v for k, v in token_usage_totals.items() if v != 0}
                    if filtered:
                        self._output(json.dumps(filtered), TaskOutputType.TOKEN_USAGE)
                return False

            # Accumulate token usage for this assistant response
            usage = assistant_message.get("token_usage")
            if isinstance(usage, dict):
                for k, v in usage.items():
                    try:
                        token_usage_totals[k] = token_usage_totals.get(k, 0) + int(v)
                    except Exception:
                        # Ignore non-integer values
                        pass

            # Check if the task was marked as finished during tool execution
            if self.finished:
                if token_usage_totals:
                    filtered = {k: v for k, v in token_usage_totals.items() if v != 0}
                    if filtered:
                        self._output(json.dumps(filtered), TaskOutputType.TOKEN_USAGE)
                return True

            # Check cancellation after tool execution
            if self.cancelled:
                if token_usage_totals:
                    filtered = {k: v for k, v in token_usage_totals.items() if v != 0}
                    if filtered:
                        self._output(json.dumps(filtered), TaskOutputType.TOKEN_USAGE)
                self._output("Task cancelled", TaskOutputType.FINISHED)
                return False

            # Log any non-tool response
            if not assistant_message.get("tool_calls") and assistant_message.get(
                "content"
            ):
                self._output(assistant_message["content"], TaskOutputType.MESSAGE)

        if token_usage_totals:
            filtered = {k: v for k, v in token_usage_totals.items() if v != 0}
            if filtered:
                self._output(json.dumps(filtered), TaskOutputType.TOKEN_USAGE)
        self._output(f"Task reached maximum iterations ({max_iterations})")
        return False
