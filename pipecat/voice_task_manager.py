import asyncio
from collections import deque
from typing import Optional, Callable, Dict, Any
from loguru import logger

from pipecat.services.llm_service import FunctionCallParams
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.processors.frameworks.rtvi import RTVIServerMessageFrame, RTVIProcessor

from utils.api_client import AsyncGameClient
from utils.base_llm_agent import LLMConfig
from utils.task_agent import TaskAgent
from utils.tools_schema import (
    MyMap,
    MyStatus,
    PlotCourse,
    Move,
    StartTask,
    StopTask,
    CheckTrade,
    Trade,
    RechargeWarpPower,
    TransferWarpPower,
    UI_SHOW_PANEL_SCHEMA,
)


class VoiceTaskManager:
    def __init__(
        self,
        character_id: str,
        rtvi_processor: RTVIProcessor,
        task_complete_callback: Optional[Callable[[bool, bool], None]] = None,
        verbose_prompts: bool = False,
    ):
        """Initialize the task manager.

        Args:
            character_id: Character ID being controlled
            rtvi_processor: RTVI processor, which we use for pushing frames
            task_complete_callback: Callback when task completes (receives was_cancelled flag)
        """
        self.character_id = character_id
        # Create a game client; base_url comes from default or env via AsyncGameClient
        self.game_client = AsyncGameClient(character_id=character_id)

        self.task_config = LLMConfig(model="gpt-5")

        self.task_complete_callback = task_complete_callback

        # Create task agent with gpt-5 for complex planning
        self.task_agent = TaskAgent(
            config=self.task_config,
            game_client=self.game_client,
            character_id=self.character_id,
            verbose_prompts=verbose_prompts,
            output_callback=self._task_output_handler,
        )

        # Task management
        self.rtvi_processor = rtvi_processor
        self.current_task: Optional[asyncio.Task] = None
        self.task_buffer: deque = deque(maxlen=1000)
        self.task_running = False
        self.cancelled_via_tool = False

        # Build generic tool dispatch map for common game tools
        # Start/stop/ui_show_panel are handled inline in execute_tool_call
        self._tool_dispatch = {
            "my_status": self.game_client.my_status,
            "my_map": self.game_client.my_map,
            "plot_course": self.game_client.plot_course,
            "move": self.game_client.move,
            "check_trade": self.game_client.check_trade,
            "trade": self.game_client.trade,
            "recharge_warp_power": self.game_client.recharge_warp_power,
            "transfer_warp_power": self.game_client.transfer_warp_power,
        }

    async def join(self):
        logger.info(f"Joining game as character: {self.character_id}")
        result = await self.game_client.join(self.character_id)
        logger.info(f"Join successful: {result}")
        return result

    #
    # Task management
    #

    def _task_output_handler(self, text: str, message_type: Optional[str] = None):
        """Handle output from the task agent.

        Args:
            text: Output text from task agent
            message_type: Type of message (e.g., step, finished, error)
        """
        # Normalize enum types to JSON-safe strings
        mt: Optional[str]
        if hasattr(message_type, "value"):
            mt = getattr(message_type, "value")  # Enum -> its value
        elif message_type is None:
            mt = None
        else:
            mt = str(message_type)

        logger.info(f"!!! task output: {text} | {mt}")

        # Add to buffer for chat context
        self.task_buffer.append(text)
        asyncio.create_task(
            self.rtvi_processor.push_frame(
                RTVIServerMessageFrame(
                    data={
                        "gg-action": "task-output",
                        "text": text,
                        "task_message_type": mt,
                    }
                )
            )
        )

    def _start_task_async(self, task_description: str, game_state: Dict[str, Any]) -> asyncio.Task:
        """Start a task asynchronously.

        Args:
            task_description: Natural language task description
            game_state: Current game state

        Returns:
            Asyncio task for the running task
        """
        if self.current_task and not self.current_task.done():
            raise RuntimeError("A task is already running")

        self.task_buffer.clear()
        self.task_running = True

        self.current_task = asyncio.create_task(self._run_task(task_description, game_state))
        return self.current_task

    async def _run_task(self, task_description: str, game_state: Dict[str, Any]):
        """Run a task to completion.

        Args:
            task_description: Natural language task description
            game_state: Current game state
        """
        was_cancelled = False

        try:
            logger.info(f"!!! running task: {task_description}")
            success = await self.task_agent.run_task(
                task=task_description, initial_state=game_state, max_iterations=50
            )
            logger.info(f"!!! task result: {success}")

            if success:
                self._task_output_handler("Task completed successfully", "complete")
            else:
                # Check if it was cancelled vs failed
                if self.task_agent.cancelled:
                    was_cancelled = True
                    self._task_output_handler("Task was cancelled by user", "cancelled")
                else:
                    self._task_output_handler("Task failed", "failed")

        except asyncio.CancelledError:
            was_cancelled = True
            self._task_output_handler("Task was cancelled", "cancelled")
        except Exception as e:
            self._task_output_handler(f"Task error: {str(e)}", "error")

        finally:
            self.task_running = False

            # Trigger task complete callback to process buffered output in chat
            # Pass whether this was cancelled via the stop_task tool
            if self.task_complete_callback:
                self.task_complete_callback(was_cancelled, self.cancelled_via_tool)

            # Reset the flag for next time
            self.cancelled_via_tool = False

    def cancel_task(self, via_tool: bool = True):
        """Cancel the currently running task.

        Args:
            via_tool: Whether this was called via the stop_task tool
        """
        if self.current_task and not self.current_task.done():
            # Store whether this was via tool for the completion callback
            self.cancelled_via_tool = via_tool
            # Set the cancellation flag first
            self.task_agent.cancel()
            # Then cancel the asyncio task
            self.current_task.cancel()
            self.task_running = False
            # Add immediate feedback
            self._task_output_handler("Cancellation requested - stopping task...", "cancelled")

    #
    # Tools
    #

    async def execute_tool_call(self, params: FunctionCallParams):
        """Generic executor for all declared tools.

        Dispatches to AsyncGameClient methods or manager handlers, then sends
        a single RTVI server message with gg-action=<tool_name> and either
        {result: ...} on success or {error: ...} on failure. Always calls
        params.result_callback with the same payload.
        """
        # Try to discover the tool name from params (Pipecat provides name)
        tool_name = getattr(params, "name", None) or getattr(params, "function_name", None)
        if not tool_name:
            # Fallback: try to peek at arguments for an injected name (not expected)
            tool_name = "unknown"

        try:
            # Special tools managed by the voice task manager
            if tool_name == "start_task":
                result = await self._handle_start_task(params)
                payload = {"result": result}
            elif tool_name == "stop_task":
                result = await self._handle_stop_task(params)
                payload = {"result": result}
            elif tool_name == "ui_show_panel":
                result = await self._handle_ui_show_panel(params)
                payload = {"result": result}
            else:
                # Dispatch to AsyncGameClient methods
                if tool_name not in self._tool_dispatch:
                    raise ValueError(f"Unknown tool: {tool_name}")

                # Normalize argument order based on AsyncGameClient signatures
                func = self._tool_dispatch[tool_name]
                arguments = params.arguments
                result = await func(**arguments)
                payload = {"result": result}

            await params.llm.push_frame(RTVIServerMessageFrame({"gg-action": tool_name, **payload}))
            await params.result_callback(payload)
        except Exception as e:
            logger.error(f"tool '{tool_name}' failed: {e}")
            error_payload = {"error": str(e)}
            await params.llm.push_frame(
                RTVIServerMessageFrame({"gg-action": tool_name, **error_payload})
            )
            await params.result_callback(error_payload)

    async def _handle_start_task(self, params: FunctionCallParams):
        try:
            logger.info(f"!!! start_task: {params.arguments}")
            if self.current_task and not self.current_task.done():
                return {
                    "success": False,
                    "error": "A task is already running. Stop it first.",
                }

            task_desc = params.arguments.get("task_description", "")
            context = params.arguments.get("context", "")
            game_state = await self.game_client.my_status()
            task_content = f"{context}\n{task_desc}" if context else task_desc
            self.task_buffer.clear()
            self.task_running = True
            self.current_task = asyncio.create_task(self._run_task(task_content, game_state))
            return {"success": True, "message": "Task started"}
        except Exception as e:
            logger.error(f"start_task failed: {e}")
            return {"success": False, "error": str(e)}

    async def _handle_stop_task(self, params: FunctionCallParams):
        try:
            if self.current_task and not self.current_task.done():
                self.current_task.cancel()
                return {"success": True, "message": "Task cancelled"}
            else:
                return {"success": False, "error": "No task is currently running"}
        except Exception as e:
            logger.error(f"stop_task failed: {e}")
            return {"success": False, "error": str(e)}

    async def _handle_ui_show_panel(self, params: FunctionCallParams):
        try:
            logger.info(f"show_panel: {params.arguments}")
            await params.llm.push_frame(
                RTVIServerMessageFrame({"ui-action": "show_panel", **params.arguments})
            )
            return {"success": True, "message": "Panel shown"}
        except Exception as e:
            logger.error(f"ui_show_panel failed: {e}")
            return {"success": False, "error": str(e)}

    def get_tools_schema(self) -> ToolsSchema:
        # Use the central tool schemas for consistency with TUI/NPC
        return ToolsSchema(
            standard_tools=[
                MyStatus.schema(),
                MyMap.schema(),
                PlotCourse.schema(),
                Move.schema(),
                CheckTrade.schema(),
                Trade.schema(),
                RechargeWarpPower.schema(),
                TransferWarpPower.schema(),
                StartTask.schema(),
                StopTask.schema(),
                UI_SHOW_PANEL_SCHEMA,
            ]
        )
