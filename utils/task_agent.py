"""Task execution agent for Gradient Bang - refactored from AsyncLLMAgent."""

import json
from typing import Dict, Any, Optional, Callable
from utils.base_llm_agent import BaseLLMAgent, LLMConfig
from utils.game_tools import get_tool_definitions, AsyncToolExecutor
from utils.prompts import GAME_DESCRIPTION, TASK_EXECUTION_INSTRUCTIONS


def create_task_system_prompt() -> str:
    """Create the system prompt for the LLM.

    Returns:
        Complete system prompt including game description and instructions
    """
    return f"""{GAME_DESCRIPTION}

{TASK_EXECUTION_INSTRUCTIONS}
"""


def create_npc_task_prompt(task: str, initial_state: dict) -> str:
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
        "## Initial State",
        "",
        f"Starting time: {initial_state.get('time', 'unknown')}",
        f"```json\n{json.dumps(initial_state, indent=2)}\n```",
        "",
        "## Task",
        "",
        f"{task}",
        "## Completion Criteria",
        "",
        "When you have completed the task, call the `finished` tool with a message to be returned to the user who initiated the task.",
    ]

    return "\n".join(prompt_parts)


class TaskAgent(BaseLLMAgent):
    """Task execution agent using OODA loop for complex game tasks."""

    def __init__(
        self,
        config: LLMConfig,
        tool_executor: AsyncToolExecutor,
        verbose_prompts: bool = False,
        output_callback: Optional[Callable[[str], None]] = None,
    ):
        """Initialize the task agent.

        Args:
            config: LLM configuration
            tool_executor: Async tool executor for game actions
            verbose_prompts: Whether to print messages as they're added
            output_callback: Optional callback for output lines (for TUI integration)
        """
        super().__init__(config, verbose_prompts, output_callback)
        self.tool_executor = tool_executor
        self.system_prompt = create_task_system_prompt()
        self.cancelled = False

    def cancel(self):
        """Set cancellation flag to stop task execution."""
        self.cancelled = True
        self._output("Task cancellation requested")

    def reset_cancellation(self):
        """Reset cancellation flag for new task."""
        self.cancelled = False

    async def execute_and_format_tools(
        self, tool_calls: list[Dict[str, Any]]
    ) -> list[Dict[str, Any]]:
        """Execute tool calls and format the results as tool messages.

        Args:
            tool_calls: List of tool calls from the assistant

        Returns:
            List of tool messages with results
        """
        tool_messages = []

        for tool_call in tool_calls:
            if self.cancelled:
                self._output("Task cancelled during tool execution")
                break

            tool_name = tool_call["function"]["name"]
            tool_args = json.loads(tool_call["function"]["arguments"])

            self._output(f"Executing {tool_name} with args: {json.dumps(tool_args)}")

            result = await self.tool_executor.execute_tool(tool_name, tool_args)

            self._log_tool_result(tool_name, result, tool_args)

            tool_message = self.format_tool_message(tool_call["id"], result)
            tool_messages.append(tool_message)

        return tool_messages

    def _log_tool_result(self, tool_name: str, result: Dict[str, Any], tool_args: Dict[str, Any] = None):
        """Log special events based on tool results."""
        if tool_name == "move" and result.get("success"):
            move_info = {
                "from": result.get("old_sector"),
                "to": result.get("new_sector"),
            }
            if result.get("sector_contents"):
                sector_info = result["sector_contents"]
                if sector_info.get("port_info"):
                    port = sector_info["port_info"]
                    move_info["port"] = {
                        "class": port["class"],
                        "code": port["code"],
                        "buys": port["buys"],
                        "sells": port["sells"],
                    }
                if sector_info.get("other_players"):
                    move_info["players"] = sector_info["other_players"]
            self._output(f"Moved from sector {move_info['from']} to {move_info['to']}")
            if "port" in move_info:
                self._output(
                    f"Found port: Class {move_info['port']['class']} (Code: {move_info['port']['code']})"
                )

        elif tool_name == "my_status" and result.get("success"):
            status_info = {"sector": result.get("current_sector")}
            if result.get("sector_contents"):
                sector_contents = result["sector_contents"]
                if sector_contents.get("port_info"):
                    port = sector_contents["port_info"]
                    status_info["port"] = {"class": port["class"], "code": port["code"]}
                if sector_contents.get("other_players"):
                    status_info["players"] = sector_contents["other_players"]
            self._output(f"Current status: Sector {status_info['sector']}")
            if "port" in status_info:
                self._output(f"Port present: Class {status_info['port']['class']}")

        elif tool_name == "plot_course" and result.get("success"):
            plot_info = {
                "from": result.get("from_sector"),
                "to": result.get("to_sector"),
                "distance": result.get("distance"),
                "path": result.get("path", []),
            }
            self._output(
                f"Plotted course from {plot_info['from']} to {plot_info['to']} (distance: {plot_info['distance']})"
            )

        elif tool_name == "find_port":
            if result.get("success"):
                if result.get("found"):
                    self._output(
                        f"Found port in sector {result.get('sector')} at distance {result.get('distance')}"
                    )
                else:
                    self._output(
                        f"No port found: {result.get('message', 'No ports available')}"
                    )
            else:
                self._output(
                    f"Error finding port: {result.get('error', 'Unknown error')}"
                )

        elif tool_name == "my_map":
            if result.get("success"):
                sectors_visited = result.get("sectors_visited", {})
                ports_known = sum(
                    1 for s in sectors_visited.values() if s.get("port_info")
                )
                self._output(
                    f"Map knowledge: {len(sectors_visited)} sectors visited, {ports_known} ports known"
                )

        elif tool_name == "check_trade":
            if result.get("success"):
                if result.get("can_trade"):
                    self._output(
                        f"Trade check: Can {tool_args.get('trade_type', 'trade')} "
                        f"{tool_args.get('quantity', 0)} {tool_args.get('commodity', 'items')} "
                        f"at {result.get('price_per_unit', 0)} cr/unit "
                        f"(total: {result.get('total_price', 0)} cr)"
                    )
                else:
                    self._output(f"Trade check failed: {result.get('error', 'Cannot trade')}")
            else:
                self._output(f"Trade check error: {result.get('error', 'Unknown error')}")
        
        elif tool_name == "trade":
            if result.get("success"):
                trade_type = result.get("trade_type", "trade")
                commodity = result.get("commodity", "items")
                quantity = result.get("quantity", 0)
                price = result.get("price_per_unit", 0)
                total = result.get("total_price", 0)
                new_credits = result.get("new_credits", 0)
                
                self._output(
                    f"Trade executed: {trade_type} {quantity} {commodity} "
                    f"at {price} cr/unit (total: {total} cr). "
                    f"New balance: {new_credits} cr"
                )
                
                # Also log cargo changes if available
                if "new_cargo" in result:
                    cargo = result["new_cargo"]
                    self._output(
                        f"Cargo now: FO:{cargo.get('fuel_ore', 0)} "
                        f"OG:{cargo.get('organics', 0)} "
                        f"EQ:{cargo.get('equipment', 0)}"
                    )
            else:
                self._output(f"Trade failed: {result.get('error', 'Unknown error')}")
        
        elif tool_name == "find_profitable_route":
            if result.get("success"):
                if result.get("found_route"):
                    self._output(
                        f"Profitable route found: Buy {result.get('commodity')} at sector {result.get('buy_sector')} "
                        f"for {result.get('buy_price')} cr, sell at sector {result.get('sell_sector')} "
                        f"for {result.get('sell_price')} cr (profit: {result.get('profit_per_unit')} cr/unit)"
                    )
                else:
                    self._output("No profitable routes found within range")
            else:
                self._output(f"Route finding error: {result.get('error', 'Unknown error')}")
        
        elif tool_name == "finished":
            self._output(f"Task finished: {result.get('message', 'Done')}")

        elif not result.get("success"):
            self._output(
                f"Tool error ({tool_name}): {result.get('error', 'Unknown error')}"
            )

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

        system_message = {"role": "system", "content": self.system_prompt}
        self.add_message(system_message)

        user_message = {
            "role": "user",
            "content": create_npc_task_prompt(task, initial_state),
        }
        self.add_message(user_message)

        for iteration in range(max_iterations):
            if self.cancelled:
                self._output("Task cancelled by user")
                return False

            self._output(f"Step {iteration + 1}")

            try:
                assistant_message = await self.get_assistant_response(
                    tools=get_tool_definitions(), reasoning_effort="minimal"
                )
            except Exception as e:
                self._output(f"Error getting assistant response: {str(e)}")
                return False

            self.add_message(assistant_message)

            if "tool_calls" in assistant_message:
                tool_messages = await self.execute_and_format_tools(
                    assistant_message["tool_calls"]
                )

                # Check cancellation after tool execution
                if self.cancelled:
                    self._output("Task cancelled by user")
                    return False

                for tool_message in tool_messages:
                    self.add_message(tool_message)

                    try:
                        result = json.loads(tool_message["content"])
                        tool_call_id = tool_message["tool_call_id"]

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
                if assistant_message["content"]:
                    self._output(f"Assistant: {assistant_message['content']}")

        self._output(f"Task reached maximum iterations ({max_iterations})")
        return False
