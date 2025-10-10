import asyncio
import json
from collections import deque
from typing import Optional, Callable, Dict, Any
from loguru import logger
import time

from pipecat.services.llm_service import FunctionCallParams
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.processors.frameworks.rtvi import RTVIServerMessageFrame, RTVIProcessor

from utils.api_client import AsyncGameClient
from utils.base_llm_agent import LLMConfig
from utils.task_agent import TaskAgent
from utils.tools_schema import (
    MyStatus,
    PlotCourse,
    LocalMapRegion,
    ListKnownPorts,
    PathWithRegion,
    Move,
    StartTask,
    StopTask,
    CheckTrade,
    Trade,
    RechargeWarpPower,
    TransferWarpPower,
    SendMessage,
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
        self.game_client = AsyncGameClient(
            character_id=character_id,
            base_url="http://localhost:8000",
            transport="websocket",
        )
        # Register event handlers for server events
        self.game_client.on("chat.message")(self._handle_chat_message)
        self.game_client.on("course.plot")(self._handle_course_plot)
        self.game_client.on("character.moved")(self._handle_character_moved)
        self.game_client.on("movement.start")(self._handle_movement_start)
        self.game_client.on("movement.complete")(self._handle_movement_complete)
        self.game_client.on("map.local")(self._handle_map_local)

        # Combat events
        self.game_client.on("combat.round_waiting")(self._handle_combat_round_waiting)
        self.game_client.on("combat.round_resolved")(self._handle_combat_round_resolved)
        self.game_client.on("combat.ended")(self._handle_combat_ended)

        # Trade events
        self.game_client.on("trade.executed")(self._handle_trade_executed)
        self.game_client.on("port.update")(self._handle_port_update)

        self.task_config = LLMConfig(model="gpt-5")

        self.task_complete_callback = task_complete_callback

        # Create task agent with gpt-5 for complex planning
        self.task_agent = TaskAgent(
            config=self.task_config,
            game_client=self.game_client,
            character_id=self.character_id,
            verbose_prompts=verbose_prompts,
            output_callback=self._task_output_handler,
            tool_call_event_callback=self._on_tool_call_event,
            tool_result_event_callback=self._on_tool_result_event,
        )

        # Task management
        self.rtvi_processor = rtvi_processor
        self.current_task: Optional[asyncio.Task] = None
        self.task_buffer: deque = deque(maxlen=1000)
        self.task_running = False
        self.cancelled_via_tool = False

        # Build generic tool dispatch map for common game tools
        # Start/stop/ui_show_panel are handled inline in execute_tool_call
        # Note: Most game_client methods require character_id, but the LLM tools
        # don't expose it. We wrap methods to inject self.character_id automatically.
        self._tool_dispatch = {
            "my_status": lambda: self.game_client.my_status(
                character_id=self.character_id
            ),
            "plot_course": lambda to_sector: self.game_client.plot_course(
                to_sector=to_sector, character_id=self.character_id
            ),
            "local_map_region": lambda **kwargs: self.game_client.local_map_region(
                character_id=self.character_id, **kwargs
            ),
            "list_known_ports": lambda **kwargs: self.game_client.list_known_ports(
                character_id=self.character_id, **kwargs
            ),
            "path_with_region": lambda **kwargs: self.game_client.path_with_region(
                character_id=self.character_id, **kwargs
            ),
            "move": lambda to_sector: self.game_client.move(
                to_sector=to_sector, character_id=self.character_id
            ),
            "check_trade": lambda **kwargs: self.game_client.check_trade(
                character_id=self.character_id, **kwargs
            ),
            "trade": lambda **kwargs: self.game_client.trade(
                character_id=self.character_id, **kwargs
            ),
            "send_message": lambda **kwargs: self.game_client.send_message(
                character_id=self.character_id, **kwargs
            ),
            "recharge_warp_power": lambda amount: self.game_client.recharge_warp_power(
                character_id=self.character_id, amount=amount
            ),
            "transfer_warp_power": lambda **kwargs: self.game_client.transfer_warp_power(
                character_id=self.character_id, **kwargs
            ),
        }

    async def join(self):
        logger.info(f"Joining game as character: {self.character_id}")
        result = await self.game_client.join(self.character_id)
        await self.game_client.subscribe_my_messages()
        logger.info(f"Join successful: {result}")
        return result

    async def _on_tool_call_event(self, tool_name: str, arguments: Any):
        await self.rtvi_processor.push_frame(
            RTVIServerMessageFrame(
                {
                    "frame_type": "event",
                    "event": "tool_call",
                    "gg-action": "tool_call",
                    "tool_name": tool_name,
                    "payload": {"arguments": arguments},
                }
            )
        )

    def _normalize_tool_event_payload(self, payload: Any) -> Dict[str, Any]:
        if not isinstance(payload, dict):
            payload = {"result": payload}

        if "error" in payload:
            # Propagate errors as-is
            return {"error": payload["error"]}

        normalized: Dict[str, Any] = {}
        result = payload.get("result")
        summary = payload.get("summary")

        if result is not None:
            normalized["result"] = result

        # Extract summary from result dict if not already provided
        if not summary and isinstance(result, dict):
            summary = result.get("summary")

        if summary and isinstance(summary, str):
            normalized["summary"] = summary.strip()

        if "tool_message" in payload:
            normalized["tool_message"] = payload["tool_message"]

        return normalized

    async def _on_tool_result_event(self, tool_name: str, payload: Any):
        normalized_payload = self._normalize_tool_event_payload(payload)
        await self.rtvi_processor.push_frame(
            RTVIServerMessageFrame(
                {
                    "frame_type": "event",
                    "event": "tool_result",
                    "gg-action": "tool_result",
                    "tool_name": tool_name,
                    "payload": normalized_payload,
                }
            )
        )

    async def _handle_event(self, event_name: str, payload: Dict[str, Any]) -> None:
        """General handler to relay any event to RTVI clients.

        Args:
            event_name: Name of the event (e.g., "chat.message", "character.moved")
            payload: Event payload data
        """
        await self.rtvi_processor.push_frame(
            RTVIServerMessageFrame(
                {
                    "frame_type": "event",
                    "event": event_name,
                    "payload": payload,
                }
            )
        )

    async def _handle_chat_message(self, payload: Dict[str, Any]) -> None:
        """Relay chat.message events to RTVI clients."""
        await self._handle_event("chat.message", payload)

    async def _handle_course_plot(self, payload: Dict[str, Any]) -> None:
        """Relay course.plot events to RTVI clients."""
        await self._handle_event("course.plot", payload)

    async def _handle_character_moved(self, payload: Dict[str, Any]) -> None:
        """Relay character.moved events to RTVI clients."""
        await self._handle_event("character.moved", payload)

    async def _handle_movement_start(self, payload: Dict[str, Any]) -> None:
        """Relay movement.start events to RTVI clients."""
        await self._handle_event("movement.start", payload)

    async def _handle_movement_complete(self, payload: Dict[str, Any]) -> None:
        """Relay movement.complete events to RTVI clients."""
        await self._handle_event("movement.complete", payload)

    async def _handle_map_local(self, payload: Dict[str, Any]) -> None:
        """Relay map.local events to RTVI clients."""
        await self._handle_event("map.local", payload)

    async def _handle_combat_round_waiting(self, payload: Dict[str, Any]) -> None:
        """Relay combat.round_waiting events to RTVI clients."""
        await self._handle_event("combat.round_waiting", payload)

    async def _handle_combat_round_resolved(self, payload: Dict[str, Any]) -> None:
        """Relay combat.round_resolved events to RTVI clients."""
        await self._handle_event("combat.round_resolved", payload)

    async def _handle_combat_ended(self, payload: Dict[str, Any]) -> None:
        """Relay combat.ended events to RTVI clients."""
        await self._handle_event("combat.ended", payload)

    async def _handle_trade_executed(self, payload: Dict[str, Any]) -> None:
        """Relay trade.executed events to RTVI clients."""
        await self._handle_event("trade.executed", payload)

    async def _handle_port_update(self, payload: Dict[str, Any]) -> None:
        """Relay port.update events to RTVI clients."""
        await self._handle_event("port.update", payload)

    #
    # Task management
    #

    def get_task_progress(self) -> str:
        """Get buffered task progress for chat context.

        Returns:
            Formatted task progress string
        """
        if not self.task_buffer:
            return ""

        # Get all buffered lines and clear buffer
        lines = list(self.task_buffer)
        self.task_buffer.clear()

        return "\n".join(lines)

    @staticmethod
    def _summarize_tool_result(raw_text: str) -> Optional[str]:
        """Extract the summary line from a serialized tool message."""

        try:
            message = json.loads(raw_text)
        except json.JSONDecodeError:
            return None

        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str):
            return None

        try:
            payload = json.loads(content)
            if isinstance(payload, dict):
                summary_value = payload.get("summary")
                if isinstance(summary_value, str) and summary_value.strip():
                    return summary_value.strip()
        except json.JSONDecodeError:
            pass

        summary_line = content.split("\n", 1)[0].strip()
        if (
            not summary_line
            or summary_line.startswith("Delta:")
            or summary_line.startswith("Result:")
        ):
            return None

        return summary_line

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

        display_text = text
        if mt == "TOOL_RESULT":
            summary_only = self._summarize_tool_result(text)
            if summary_only:
                display_text = summary_only

        # Add to buffer for chat context
        self.task_buffer.append(display_text)
        asyncio.create_task(
            self.rtvi_processor.push_frame(
                RTVIServerMessageFrame(
                    data={
                        "frame_type": "event",
                        "event": "task_output",
                        "gg-action": "task_output",
                        "payload": {
                            "text": display_text,
                            "task_message_type": mt,
                        },
                    }
                )
            )
        )

    def _start_task_async(
        self, task_description: str, game_state: Dict[str, Any]
    ) -> asyncio.Task:
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

        self.current_task = asyncio.create_task(
            self._run_task(task_description, game_state)
        )
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
            self._task_output_handler(
                "Cancellation requested - stopping task...", "cancelled"
            )

    async def execute_tool_call(self, params: FunctionCallParams):
        """Generic executor for all declared tools, for tool calls from the
        conversation LLM.

        Dispatches to AsyncGameClient methods or manager handlers, then sends
        a single RTVI server message with gg-action=<tool_name> and either
        {result: ...} on success or {error: ...} on failure. Always calls
        params.result_callback with the same payload.
        """
        start_time = time.time()

        # Try to discover the tool name from params (Pipecat provides name)
        tool_name = getattr(params, "name", None) or getattr(
            params, "function_name", None
        )
        if not tool_name:
            # Fallback: try to peek at arguments for an injected name (not expected)
            tool_name = "unknown"

        try:
            # Gather arguments for the call (for pre-call event)
            arguments = params.arguments

            # Emit a pre-call notification
            await self._on_tool_call_event(tool_name, arguments)

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
                # Call the tool function via our dispatch table
                if tool_name not in self._tool_dispatch:
                    raise ValueError(f"Unknown tool: {tool_name}")

                func = self._tool_dispatch[tool_name]
                result = await func(**arguments)
                payload = {"result": result}

            # Emit tool result message for clients to consume
            await self._on_tool_result_event(tool_name, payload)

            logger.info(f"!!! TOOL RESULT: {payload}")

            # Extract summary if present
            summary = None
            result_obj = payload.get("result")
            if isinstance(result_obj, dict):
                summary = result_obj.get("summary")
                if summary and isinstance(summary, str):
                    summary = summary.strip()

            # Send summary or full payload to LLM
            if summary and tool_name != "my_status":
                callback_payload = {"summary": summary}
                logger.info(f"!!! FORMATTED FOR LLM: {callback_payload}")
            else:
                callback_payload = payload

            await params.result_callback(callback_payload)
            # await params.result_callback(payload)
        except Exception as e:
            logger.error(f"tool '{tool_name}' failed: {e}")
            error_payload = {"error": str(e)}
            # Emit a standardized error as tool_result
            await self._on_tool_result_event(tool_name, error_payload)
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
            game_state = await self.game_client.my_status(
                character_id=self.character_id
            )
            task_content = f"{context}\n{task_desc}" if context else task_desc
            self.task_buffer.clear()
            self.task_running = True
            self.current_task = asyncio.create_task(
                self._run_task(task_content, game_state)
            )
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
                PlotCourse.schema(),
                LocalMapRegion.schema(),
                ListKnownPorts.schema(),
                PathWithRegion.schema(),
                Move.schema(),
                CheckTrade.schema(),
                Trade.schema(),
                RechargeWarpPower.schema(),
                TransferWarpPower.schema(),
                SendMessage.schema(),
                StartTask.schema(),
                StopTask.schema(),
                UI_SHOW_PANEL_SCHEMA,
            ]
        )
