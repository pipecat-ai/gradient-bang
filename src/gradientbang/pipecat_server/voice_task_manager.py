import asyncio
import json
from collections import deque
from typing import Optional, Callable, Dict, Any, Mapping

from loguru import logger

from pipecat.services.llm_service import FunctionCallParams
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.processors.frameworks.rtvi import RTVIServerMessageFrame, RTVIProcessor
from pipecat.frames.frames import LLMMessagesAppendFrame

import os

if os.getenv("SUPABASE_URL"):
    from gradientbang.utils.supabase_client import AsyncGameClient
else:
    from gradientbang.utils.api_client import AsyncGameClient
from gradientbang.utils.task_agent import TaskAgent, TaskOutputType
from gradientbang.utils.tools_schema import (
    MyStatus,
    LeaderboardResources,
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
    TransferCredits,
    BankDeposit,
    BankWithdraw,
    DumpCargo,
    SendMessage,
    PurchaseFighters,
    CombatInitiate,
    CombatAction,
    PlaceFighters,
    CollectFighters,
    SalvageCollect,
    CorporationInfo,
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
        base_url: Optional[str] = None,
    ):
        """Initialize the task manager.

        Args:
            character_id: Character ID being controlled
            rtvi_processor: RTVI processor, which we use for pushing frames
            task_complete_callback: Callback when task completes (receives was_cancelled flag)
            base_url: Optional game server URL (defaults to http://localhost:8000)
        """
        self.character_id = character_id
        self.display_name: str = character_id
        # Create a game client; use SUPABASE_URL if available, otherwise use provided base_url or default
        resolved_base_url = os.getenv("SUPABASE_URL") or base_url or os.getenv("GAME_SERVER_URL", "http://localhost:8000")
        self.game_client = AsyncGameClient(
            character_id=character_id,
            base_url=resolved_base_url,
            transport="websocket",  # Supabase client auto-converts this to "supabase" transport
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
            "fighter.purchase",
            "warp.purchase",
            "warp.transfer",
            "credits.transfer",
            "garrison.deployed",
            "garrison.collected",
            "garrison.mode_changed",
            "salvage.collected",
            "salvage.created",
            "bank.transaction",
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

        # Task management - now supports multiple concurrent tasks
        self.rtvi_processor = rtvi_processor
        self._task_id_counter = 0  # Auto-incrementing task ID counter
        self._active_tasks: Dict[str, Dict[str, Any]] = {}  # task_id -> task info
        self.task_buffer: deque = deque(maxlen=1000)
        self.task_running = False  # Deprecated, kept for backwards compatibility
        self.cancelled_via_tool = False
        # Track request IDs from voice agent tool calls for inference triggering
        self._voice_agent_request_ids: set[str] = set()

        # Build generic tool dispatch map for common game tools
        # Start/stop/ui_show_panel are handled inline in execute_tool_call
        # Note: Most game_client methods require character_id, but the LLM tools
        # don't expose it. We wrap methods to inject self.character_id automatically.
        self._tool_dispatch = {
            "my_status": lambda: self.game_client.my_status(
                character_id=self.character_id
            ),
            "leaderboard_resources": lambda **kwargs: self.game_client.leaderboard_resources(
                character_id=self.character_id, **kwargs
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
            "purchase_fighters": lambda **kwargs: self.game_client.purchase_fighters(
                character_id=self.character_id, **kwargs
            ),
            "dump_cargo": lambda **kwargs: self.game_client.dump_cargo(
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
            "transfer_credits": lambda **kwargs: self.game_client.transfer_credits(
                character_id=self.character_id, **kwargs
            ),
            "bank_deposit": lambda **kwargs: self.game_client.deposit_to_bank(
                character_id=self.character_id, **kwargs
            ),
            "bank_withdraw": lambda **kwargs: self.game_client.withdraw_from_bank(
                character_id=self.character_id, **kwargs
            ),
            "combat_initiate": lambda **kwargs: self.game_client.combat_initiate(
                character_id=self.character_id, **kwargs
            ),
            "combat_action": lambda **kwargs: self.game_client.combat_action(
                character_id=self.character_id, **kwargs
            ),
            "place_fighters": lambda **kwargs: self.game_client.combat_leave_fighters(
                character_id=self.character_id, **kwargs
            ),
            "collect_fighters": lambda **kwargs: self.game_client.combat_collect_fighters(
                character_id=self.character_id, **kwargs
            ),
            "salvage_collect": lambda **kwargs: self.game_client.salvage_collect(
                character_id=self.character_id, **kwargs
            ),
            "corporation_info": lambda **kwargs: self.game_client._request(
                "corporation.list" if kwargs.get("list_all") else "corporation.info",
                {} if kwargs.get("list_all") else {"character_id": self.character_id}
            ),
        }

    def _generate_task_id(self) -> str:
        """Generate a new four-digit task ID."""
        self._task_id_counter += 1
        return f"{self._task_id_counter:04d}"

    def _get_task_type(self, ship_id: Optional[str]) -> str:
        """Determine task type based on whether it's controlling a corp ship."""
        if ship_id and ship_id != self.character_id:
            return "corp_ship"
        return "player_ship"

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

        # Find the task_id for this event (if it belongs to a task)
        task_id = self._get_task_id_for_character(self.character_id)

        # Build event XML with optional task_id
        if task_id:
            event_xml = f"<event name={event_name} task_id={task_id}>\n{summary}\n</event>"
        else:
            event_xml = f"<event name={event_name}>\n{summary}\n</event>"

        # Determine if this event should trigger LLM inference
        # Only trigger inference when event came from voice agent's own tool calls
        # (task events don't match our tracked request IDs and handle their own inference)
        inference_triggering_events = {
            "ports.list",           # list_known_ports results
            "map.region",           # local_map_region results
            "path.region",          # path_with_region results
            "chat.message",         # Direct messages to bot
            "combat.round_resolved",# Combat updates
            "combat.ended",         # Combat finished
            "error",                # Error messages
        }

        # Check if event came from voice agent's tool call
        event_request_id = event.get("request_id")
        is_voice_agent_event = event_request_id in self._voice_agent_request_ids

        # Debug logging for request ID tracking
        logger.info(f"!!! EVENT ARRIVED: {event_name}")
        logger.info(f"!!!   event keys: {list(event.keys())}")
        logger.info(f"!!!   event_request_id: {event_request_id}")
        logger.info(f"!!!   tracked IDs: {self._voice_agent_request_ids}")
        logger.info(f"!!!   is_voice_agent_event: {is_voice_agent_event}")
        logger.info(f"!!!   in inference_triggering_events: {event_name in inference_triggering_events}")

        # Only trigger inference if this is an important event AND from voice agent
        should_run_llm = (event_name in inference_triggering_events) and is_voice_agent_event
        logger.info(f"!!!   should_run_llm: {should_run_llm}")

        await self.rtvi_processor.push_frame(
            LLMMessagesAppendFrame(
                messages=[
                    {
                        "role": "user",
                        "content": event_xml,
                    }
                ],
                run_llm=should_run_llm,
            )
        )

    #
    # Task management
    #

    def _get_task_id_for_character(self, character_id: str) -> Optional[str]:
        """Find the task_id for an active task that matches the given character_id.

        Args:
            character_id: The character ID to look up

        Returns:
            The task_id if found, None otherwise
        """
        for task_id, task_info in self._active_tasks.items():
            if task_info.get("target_character_id") == character_id:
                return task_id
        return None

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

    def _create_agent_output_callback(self, task_id: str, task_type: str) -> Callable:
        """Create a task-specific output callback that includes task_id and task_type."""
        def _handle_agent_output(text: str, message_type: Optional[str] = None) -> None:
            """Schedule processing of agent output asynchronously."""
            asyncio.create_task(self._task_output_handler(text, message_type, task_id, task_type))
        return _handle_agent_output

    def _handle_agent_output(
        self, text: str, message_type: Optional[str] = None
    ) -> None:
        """Legacy callback for backwards compatibility - uses player_ship task type."""
        asyncio.create_task(self._task_output_handler(text, message_type, None, "player_ship"))

    async def _task_output_handler(
        self, text: str, message_type: Optional[str] = None, task_id: Optional[str] = None, task_type: str = "player_ship"
    ) -> None:
        """Handle output from the task agent.

        Args:
            text: Output text from task agent
            message_type: Type of message (e.g., step, finished, error)
            task_id: Optional task ID for multi-task tracking
            task_type: Type of task ("player_ship" or "corp_ship")
        """
        logger.info(f"!!! task output: [{message_type}] task_id={task_id} task_type={task_type} {text}")

        # send everything from the task agent to the client to be displayed
        await self.rtvi_processor.push_frame(
            RTVIServerMessageFrame(
                data={
                    "frame_type": "event",
                    "event": "task_output",
                    "task_id": task_id,
                    "task_type": task_type,
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

    async def _run_task_with_tracking(
        self,
        task_id: str,
        task_agent: TaskAgent,
        task_game_client: AsyncGameClient,
        task_description: str,
        target_character_id: str,
        is_corp_ship: bool,
    ):
        """Run a task to completion with multi-task tracking.

        Args:
            task_id: Unique task identifier
            task_agent: TaskAgent instance for this task
            task_game_client: AsyncGameClient for this task
            task_description: Natural language task description
            target_character_id: Character ID being controlled
            is_corp_ship: Whether this is a corporation ship
        """
        was_cancelled = False
        task_type = "corp_ship" if is_corp_ship else "player_ship"

        try:
            logger.info(f"!!! running task {task_id} ({task_type}): {task_description}")
            success = await task_agent.run_task(
                task=task_description, max_iterations=100
            )
            logger.info(f"!!! task {task_id} result: {success}")

            if success:
                await self._task_output_handler(
                    "Task completed successfully", "complete", task_id, task_type
                )
            else:
                # Check if it was cancelled vs failed
                if task_agent.cancelled:
                    was_cancelled = True
                    await self._task_output_handler(
                        "Task was cancelled by user", "cancelled", task_id, task_type
                    )
                else:
                    await self._task_output_handler("Task failed", "failed", task_id, task_type)

        except asyncio.CancelledError:
            was_cancelled = True
            await self._task_output_handler("Task was cancelled", "cancelled", task_id, task_type)
        except Exception as e:
            await self._task_output_handler(f"Task error: {str(e)}", "error", task_id, task_type)

        finally:
            # Clean up task tracking
            if task_id in self._active_tasks:
                del self._active_tasks[task_id]

            # Clean up corp ship client
            if is_corp_ship and task_game_client != self.game_client:
                try:
                    await task_game_client.close()
                except Exception as e:
                    logger.error(f"Failed to close corp ship client: {e}")

            # Update legacy flags for backwards compatibility
            if target_character_id == self.character_id:
                self.task_running = False
                # Trigger task complete callback to process buffered output in chat
                # Pass whether this was cancelled via the stop_task tool
                if self.task_complete_callback:
                    self.task_complete_callback(was_cancelled, self.cancelled_via_tool)
                # Reset the flag for next time
                self.cancelled_via_tool = False

    async def _run_task(self, task_description: str):
        """Legacy method for backwards compatibility. Redirects to tracked version."""
        task_id = self._generate_task_id()
        await self._run_task_with_tracking(
            task_id=task_id,
            task_agent=self.task_agent,
            task_game_client=self.game_client,
            task_description=task_description,
            target_character_id=self.character_id,
            is_corp_ship=False,
        )

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

                # Track request ID for voice agent inference triggering
                # Extract from result (preferred) or fall back to last_request_id
                req_id = None
                if isinstance(result, dict):
                    req_id = result.get('request_id')
                if not req_id and hasattr(self.game_client, 'last_request_id'):
                    req_id = self.game_client.last_request_id
                if req_id:
                    self._voice_agent_request_ids.add(req_id)
                    logger.info(f"!!! TOOL COMPLETE: {tool_name} - tracking request_id={req_id}")
                    logger.info(f"!!! TRACKED IDS: {self._voice_agent_request_ids}")

            await params.result_callback(payload)
        except Exception as e:
            logger.error(f"tool '{tool_name}' failed: {e}")
            error_payload = {"error": str(e)}
            # Emit a standardized error as tool_result
            await params.result_callback(error_payload)

    async def _handle_start_task(self, params: FunctionCallParams):
        task_game_client = None
        try:
            logger.info(f"!!! start_task: {params.arguments}")
            task_desc = params.arguments.get("task_description", "")
            ship_id = params.arguments.get("ship_id")

            # Determine target character (ship or player)
            target_character_id = ship_id if ship_id else self.character_id
            actor_character_id = self.character_id if ship_id else None

            # Check if this specific ship already has a running task
            for task_id, task_info in self._active_tasks.items():
                if task_info["target_character_id"] == target_character_id and not task_info["asyncio_task"].done():
                    return {
                        "success": False,
                        "error": f"Ship {target_character_id[:8]}... already has task {task_id} running. Stop it first.",
                    }

            # Generate new task ID
            new_task_id = self._generate_task_id()
            task_type = self._get_task_type(ship_id)

            # Create a new game client for this task (if corp ship)
            if ship_id:
                task_game_client = AsyncGameClient(
                    base_url=self.game_client.base_url,
                    character_id=target_character_id,
                    actor_character_id=actor_character_id,
                    entity_type="corporation_ship",
                    transport="websocket",
                )
                await task_game_client.join(target_character_id)
            else:
                task_game_client = self.game_client
                await task_game_client.pause_event_delivery()

            # Create task-specific agent with custom output callback
            task_agent = TaskAgent(
                game_client=task_game_client,
                character_id=target_character_id,
                output_callback=self._create_agent_output_callback(new_task_id, task_type),
            )

            # call my_status so the first thing the task gets is a status.snapshot event
            try:
                await task_game_client.my_status(character_id=target_character_id)
            except Exception:
                if task_game_client != self.game_client:
                    await task_game_client.close()
                else:
                    await self.game_client.resume_event_delivery()
                raise

            # Start the task
            asyncio_task = asyncio.create_task(
                self._run_task_with_tracking(
                    task_id=new_task_id,
                    task_agent=task_agent,
                    task_game_client=task_game_client,
                    task_description=task_desc,
                    target_character_id=target_character_id,
                    is_corp_ship=(ship_id is not None),
                )
            )

            # Track the task
            self._active_tasks[new_task_id] = {
                "task_id": new_task_id,
                "task_type": task_type,
                "target_character_id": target_character_id,
                "actor_character_id": actor_character_id,
                "task_agent": task_agent,
                "task_game_client": task_game_client,
                "asyncio_task": asyncio_task,
                "description": task_desc,
                "is_corp_ship": (ship_id is not None),
            }

            # Update legacy flags for backwards compatibility
            if not ship_id:
                self.task_running = True
                self.current_task = asyncio_task

            return {
                "success": True,
                "message": f"Task {new_task_id} started",
                "task_id": new_task_id,
                "task_type": task_type,
            }
        except Exception as e:
            logger.error(f"start_task failed: {e}")
            if task_game_client and task_game_client != self.game_client:
                await task_game_client.close()
            elif task_game_client == self.game_client:
                await self.game_client.resume_event_delivery()
            return {"success": False, "error": str(e)}

    async def _handle_stop_task(self, params: FunctionCallParams):
        try:
            task_id = params.arguments.get("task_id")

            if task_id:
                # Cancel specific task by ID
                task_info = self._active_tasks.get(task_id)
                if not task_info:
                    return {
                        "success": False,
                        "error": f"Task {task_id} not found",
                    }

                asyncio_task = task_info["asyncio_task"]
                if asyncio_task.done():
                    return {
                        "success": False,
                        "error": f"Task {task_id} is not running",
                    }

                task_agent = task_info["task_agent"]
                task_agent.cancel()
                asyncio_task.cancel()

                return {
                    "success": True,
                    "message": f"Task {task_id} cancelled",
                    "task_id": task_id,
                }
            else:
                # Cancel player ship task (backwards compatibility)
                player_ship_task_id = None
                for tid, task_info in self._active_tasks.items():
                    if task_info["target_character_id"] == self.character_id and not task_info["asyncio_task"].done():
                        player_ship_task_id = tid
                        break

                if not player_ship_task_id:
                    # Fall back to legacy current_task
                    if self.current_task and not self.current_task.done():
                        self.current_task.cancel()
                        return {"success": True, "message": "Task cancelled"}
                    else:
                        return {"success": False, "error": "No player ship task is currently running"}

                task_info = self._active_tasks[player_ship_task_id]
                task_agent = task_info["task_agent"]
                asyncio_task = task_info["asyncio_task"]

                task_agent.cancel()
                asyncio_task.cancel()

                return {
                    "success": True,
                    "message": f"Task {player_ship_task_id} cancelled",
                    "task_id": player_ship_task_id,
                }

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
                LeaderboardResources.schema(),
                PlotCourse.schema(),
                LocalMapRegion.schema(),
                ListKnownPorts.schema(),
                PathWithRegion.schema(),
                Move.schema(),
                Trade.schema(),
                DumpCargo.schema(),
                RechargeWarpPower.schema(),
                TransferWarpPower.schema(),
                TransferCredits.schema(),
                PurchaseFighters.schema(),
                BankDeposit.schema(),
                BankWithdraw.schema(),
                SendMessage.schema(),
                CombatInitiate.schema(),
                CombatAction.schema(),
                PlaceFighters.schema(),
                CollectFighters.schema(),
                SalvageCollect.schema(),
                CorporationInfo.schema(),
                StartTask.schema(),
                StopTask.schema(),
                UI_SHOW_PANEL_SCHEMA,
            ]
        )