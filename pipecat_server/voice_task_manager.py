import asyncio
import json
import os
from collections import deque
from typing import Optional, Callable, Dict, Any, Mapping
from types import SimpleNamespace

from loguru import logger

from pipecat.services.llm_service import FunctionCallParams
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.processors.frameworks.rtvi import RTVIServerMessageFrame, RTVIProcessor
from pipecat.frames.frames import LLMMessagesAppendFrame

from utils.api_client import AsyncGameClient
from utils.task_agent import TaskAgent, TaskOutputType
from utils.tools_schema import (
    MyStatus,
    PlotCourse,
    LocalMapRegion,
    ListKnownPorts,
    PathWithRegion,
    Move,
    StartTask,
    StopTask,
    Trade,
    RechargeWarpPower,
    TransferWarpPower,
    SendMessage,
    UI_SHOW_PANEL_SCHEMA,
)


def _extract_display_name(payload: Mapping[str, Any]) -> Optional[str]:
    """Extract the player's display name from a payload if available."""

    def _clean(value: Any) -> Optional[str]:
        if isinstance(value, str):
            value = value.strip()
            if value:
                return value
        return None

    if not isinstance(payload, Mapping):
        return None

    player = payload.get("player")
    if isinstance(player, Mapping):
        for key in ("name", "display_name", "player_name"):
            candidate = _clean(player.get(key))
            if candidate:
                return candidate

    for fallback in ("player_name", "name"):
        candidate = _clean(payload.get(fallback))
        if candidate:
            return candidate

    return None


class VoiceTaskManager:
    def __init__(
        self,
        character_id: str,
        rtvi_processor: RTVIProcessor,
        task_complete_callback: Optional[Callable[[bool, bool], None]] = None,
    ):
        """Initialize the task manager.

        Args:
            character_id: Character ID being controlled
            rtvi_processor: RTVI processor, which we use for pushing frames
            task_complete_callback: Callback when task completes (receives was_cancelled flag)
        """
        self.character_id = character_id
        self.display_name: str = character_id
        # Create a game client; base_url comes from default or env via AsyncGameClient
        self.game_client = AsyncGameClient(
            character_id=character_id,
            base_url="http://localhost:8000",
            transport="websocket",
        )
        self._event_names = [
            "status.snapshot",
            "status.update",
            "sector.update",
            "course.plot",
            "path.region",
            "movement.start",
            "movement.complete",
            "map.knowledge",
            "map.region",
            "map.local",
            "ports.list",
            "character.moved",
            "trade.executed",
            "port.update",
            "warp.purchase",
            "warp.transfer",
            "garrison.deployed",
            "garrison.collected",
            "garrison.mode_changed",
            "salvage.collected",
            "combat.round_waiting",
            "combat.round_resolved",
            "combat.ended",
            "combat.action_accepted",
            "chat.message",
            "error",
        ]
        for event_name in self._event_names:
            self.game_client.on(event_name)(self._relay_event)

        self.task_complete_callback = task_complete_callback

        # Create task agent driven by the Pipecat pipeline
        self.task_agent = TaskAgent(
            game_client=self.game_client,
            character_id=self.character_id,
            output_callback=self._handle_agent_output,
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

    def _update_display_name(self, payload: Mapping[str, Any]) -> None:
        candidate = _extract_display_name(payload)
        if isinstance(candidate, str) and candidate and candidate != self.display_name:
            self.display_name = candidate

    async def join(self):
        logger.info(f"Joining game as character: {self.character_id}")
        result = await self.game_client.join(self.character_id)
        await self.game_client.subscribe_my_messages()
        if isinstance(result, Mapping):
            self._update_display_name(result)
        logger.info(f"Join successful as {self.display_name}: {result}")
        return result

    async def _relay_event(self, event: Dict[str, Any]) -> None:
        event_name = event.get("event_name")
        payload = event.get("payload")
        await self.rtvi_processor.push_frame(
            RTVIServerMessageFrame(
                {
                    "frame_type": "event",
                    "event": event_name,
                    "payload": payload,
                }
            )
        )

        summary = event.get("summary", payload)
        await self.rtvi_processor.push_frame(
            LLMMessagesAppendFrame(
                messages=[
                    {
                        "role": "user",
                        "content": f"<event name={event_name}>\n{summary}\n</event>",
                    }
                ]
            )
        )

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

    def _handle_agent_output(
        self, text: str, message_type: Optional[str] = None
    ) -> None:
        """Schedule processing of agent output asynchronously."""
        asyncio.create_task(self._task_output_handler(text, message_type))

    async def _task_output_handler(
        self, text: str, message_type: Optional[str] = None
    ) -> None:
        """Handle output from the task agent.

        Args:
            text: Output text from task agent
            message_type: Type of message (e.g., step, finished, error)
        """
        logger.info(f"!!! task output: [{message_type}]{text}")

        # send everything from the task agent to the client to be displayed
        await self.rtvi_processor.push_frame(
            RTVIServerMessageFrame(
                data={
                    "frame_type": "event",
                    "event": "task_output",
                    "payload": {
                        "text": text,
                        "task_message_type": message_type,
                    },
                }
            )
        )

        # append for the LLM only the information that won't have arrived as events
        if message_type != TaskOutputType.EVENT:
            self.task_buffer.append(text)

    async def _run_task(self, task_description: str):
        """Run a task to completion.

        Args:
            task_description: Natural language task description
        """
        was_cancelled = False

        try:
            logger.info(f"!!! running task: {task_description}")
            success = await self.task_agent.run_task(
                task=task_description, max_iterations=100
            )
            logger.info(f"!!! task result: {success}")

            if success:
                await self._task_output_handler(
                    "Task completed successfully", "complete"
                )
            else:
                # Check if it was cancelled vs failed
                if self.task_agent.cancelled:
                    was_cancelled = True
                    await self._task_output_handler(
                        "Task was cancelled by user", "cancelled"
                    )
                else:
                    await self._task_output_handler("Task failed", "failed")

        except asyncio.CancelledError:
            was_cancelled = True
            await self._task_output_handler("Task was cancelled", "cancelled")
        except Exception as e:
            await self._task_output_handler(f"Task error: {str(e)}", "error")

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
            self._handle_agent_output(
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
        # Try to discover the tool name from params (Pipecat provides name)
        tool_name = getattr(params, "name", None) or getattr(
            params, "function_name", None
        )
        if not tool_name:
            # Fallback: try to peek at arguments for an injected name (not expected)
            tool_name = "unknown"

        try:
            # Gather arguments for the call
            arguments = params.arguments

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

            await params.result_callback(payload)
        except Exception as e:
            logger.error(f"tool '{tool_name}' failed: {e}")
            error_payload = {"error": str(e)}
            # Emit a standardized error as tool_result
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
            await self.game_client.pause_event_delivery()
            # call my_status so the first thing the task gets is a status.snapshot event
            try:
                self.game_client.my_status(character_id=self.character_id)
            except Exception:
                await self.game_client.resume_event_delivery()
                raise
            self.task_buffer.clear()
            self.task_running = True
            self.current_task = asyncio.create_task(self._run_task(task_desc))
            return {"success": True, "message": "Task started"}
        except Exception as e:
            logger.error(f"start_task failed: {e}")
            await self.game_client.resume_event_delivery()
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
                Trade.schema(),
                RechargeWarpPower.schema(),
                TransferWarpPower.schema(),
                SendMessage.schema(),
                StartTask.schema(),
                StopTask.schema(),
                UI_SHOW_PANEL_SCHEMA,
            ]
        )
