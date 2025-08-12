import asyncio
from collections import deque
from typing import Optional, Callable, List, Dict, Any
from loguru import logger

from pipecat.services.llm_service import FunctionCallParams
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.processors.frameworks.rtvi import RTVIServerMessageFrame

from utils.game_tools import AsyncToolExecutor
from utils.api_client import AsyncGameClient
from utils.base_llm_agent import LLMConfig
from utils.task_agent import TaskAgent


class VoiceTaskManager:
    def __init__(
        self,
        character_id: str,
        output_callback: Optional[Callable[[str], None]] = None,
        progress_callback: Optional[Callable[[str, str], None]] = None,
        task_complete_callback: Optional[Callable[[bool, bool], None]] = None,
        task_callback: Optional[Callable[[str, str], asyncio.Task]] = None,
        cancel_task_callback: Optional[Callable[[], None]] = None,
        get_task_progress_callback: Optional[Callable[[], str]] = None,
        verbose_prompts: bool = False,
        debug_callback: Optional[
            Callable[[List[Dict[str, Any]], Optional[str]], None]
        ] = None,
    ):
        """Initialize the task manager.

        Args:
            character_id: Character ID being controlled
            output_callback: Callback for task output lines
            progress_callback: Callback for progress updates (action, description)
            task_complete_callback: Callback when task completes (receives was_cancelled flag)
        """
        self.character_id = character_id
        self.game_client = AsyncGameClient(character_id=character_id)

        self.task_config = LLMConfig(model="gpt-5")

        self.output_callback = output_callback
        self.progress_callback = progress_callback
        self.task_complete_callback = task_complete_callback

        # Create tool executor
        self.tool_executor = AsyncToolExecutor(self.game_client, character_id)

        # Create task agent with gpt-5 for complex planning
        self.task_agent = TaskAgent(
            config=self.task_config,
            tool_executor=self.tool_executor,
            verbose_prompts=False,
            output_callback=self._task_output_handler,
        )

        # Task management
        self.current_task: Optional[asyncio.Task] = None
        self.task_buffer: deque = deque(maxlen=1000)
        self.task_running = False
        self.cancelled_via_tool = False
        self.task_callback = task_callback
        self.cancel_task_callback = cancel_task_callback
        self.get_task_progress_callback = get_task_progress_callback
        self.debug_callback = debug_callback

    def _task_output_handler(self, text: str):
        """Handle output from the task agent.

        Args:
            text: Output text from task agent
        """

        # Add to buffer for chat context
        self.task_buffer.append(text)

        # Send to UI callback if provided
        if self.output_callback:
            self.output_callback(text)

        # Update progress if applicable
        if self.progress_callback:
            # Extract action from output (simplified - could be more sophisticated)
            if "Executing" in text:
                self.progress_callback(text, "action")
            elif "Step" in text:
                self.progress_callback(text, "step")

    def _build_sector_info(self, contents) -> dict:
        """Build sector info from sector contents.

        Args:
            contents: Sector contents from the server

        Returns:
            Dictionary with port and player information
        """
        sector_info = {}
        if contents:
            port_info = None
            if hasattr(contents, "port") and contents.port:
                port = contents.port
                port_info = {
                    "class": getattr(port, "class_num", getattr(port, "class", "?")),
                    "code": port.code,
                    "buys": port.buys,
                    "sells": port.sells,
                    "stock": getattr(port, "stock", {}),
                    "demand": getattr(port, "demand", {}),
                }
            sector_info["port_info"] = port_info

            players = getattr(contents, "other_players", []) or []
            try:
                # Handle both cases: list of player objects or list of strings
                if players and hasattr(players[0], "name"):
                    sector_info["other_players"] = [player.name for player in players]
                else:
                    # Already a list of strings (player names)
                    sector_info["other_players"] = (
                        players if isinstance(players, list) else []
                    )
            except (TypeError, AttributeError, IndexError):
                sector_info["other_players"] = []

            adjacent = getattr(contents, "adjacent_sectors", [])
            if not isinstance(adjacent, list):
                adjacent = []
            sector_info["adjacent_sectors"] = adjacent

        return sector_info

    async def join(self):
        logger.info(f"Joining game as character: {self.character_id}")
        result = await self.game_client.join(self.character_id)
        logger.info(f"Join successful: {result}")
        return result

    #
    # Task management
    #

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

        if self.progress_callback:
            self.progress_callback(task_description, "start")

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
            success = await self.task_agent.run_task(
                task=task_description, initial_state=game_state, max_iterations=50
            )

            if success:
                self._task_output_handler("Task completed successfully")
                if self.progress_callback:
                    self.progress_callback("Task completed successfully", "complete")
            else:
                # Check if it was cancelled vs failed
                if self.task_agent.cancelled:
                    was_cancelled = True
                    self._task_output_handler("Task was cancelled by user")
                    if self.progress_callback:
                        self.progress_callback(
                            "Task was cancelled by user", "cancelled"
                        )
                else:
                    self._task_output_handler("Task failed")
                    if self.progress_callback:
                        self.progress_callback("Task failed", "failed")

        except asyncio.CancelledError:
            was_cancelled = True
            self._task_output_handler("Task was cancelled")
            if self.progress_callback:
                self.progress_callback("Task was cancelled", "cancelled")
            # Don't re-raise - let the finally block execute

        except Exception as e:
            self._task_output_handler(f"Task error: {str(e)}")
            if self.progress_callback:
                self.progress_callback(f"Error: {str(e)}", "error")

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
            self._task_output_handler("Cancellation requested - stopping task...")

    #
    # Tools
    #

    async def tool_move(self, params: FunctionCallParams):
        try:
            result = await self.game_client.move(
                self.character_id, params.arguments["to_sector"]
            )

            # Convert Pydantic model to dict for JSON serialization
            response = {
                "success": True,
                "old_sector": self.game_client.current_sector,  # Track previous sector
                "new_sector": result.sector,
                "character_id": result.id,
                "sector_contents": self._build_sector_info(result.sector_contents),
            }
            logger.debug(
                f"Move successful: {response['old_sector']} -> {response['new_sector']}"
            )
            await params.llm.push_frame(
                RTVIServerMessageFrame({"gg-action": "move", **response})
            )
            await params.result_callback(response)
        except Exception as e:
            logger.error(f"Move failed: {e}")
            result = {"success": False, "error": str(e)}
            await params.llm.push_frame(
                RTVIServerMessageFrame({"gg-action": "move", **result})
            )
            await params.result_callback(result)

    async def tool_my_status(self, params: FunctionCallParams):
        """Execute my-status tool."""
        try:
            logger.debug(f"Calling my_status for character: {self.character_id}")
            result = await self.game_client.my_status()

            # Build sector contents info
            sector_info = self._build_sector_info(result.sector_contents)

            response = {
                "success": True,
                "current_sector": result.sector,
                "character_id": result.id,
                "sector_contents": sector_info,
            }
            logger.debug(f"my_status success: sector {result.sector}")
            await params.llm.push_frame(
                RTVIServerMessageFrame({"gg-action": "my_status", **response})
            )
            await params.result_callback(response)
        except Exception as e:
            logger.error(f"my_status failed: {e}")
            result = {"success": False, "error": str(e)}
            await params.llm.push_frame(
                RTVIServerMessageFrame({"gg-action": "my_status", **result})
            )
            await params.result_callback(result)

    async def tool_my_map(self, params: FunctionCallParams):
        """Execute my-map tool."""
        try:
            response = await self.game_client.my_map()
            # Response should already be a dict from my_map
            result = {"success": True, **response}
            logger.debug(
                f"my_map success: {len(response.get('sectors_visited', {}))} sectors known"
            )
            await params.llm.push_frame(
                RTVIServerMessageFrame({"gg-action": "my_map", **result})
            )
            await params.result_callback(result)
        except Exception as e:
            logger.error(f"my_map failed: {e}")
            result = {"success": False, "error": str(e)}
            await params.llm.push_frame(
                RTVIServerMessageFrame({"gg-action": "my_map", **result})
            )
            await params.result_callback(result)

    async def tool_start_task(self, params: FunctionCallParams):
        try:
            if self.current_task and not self.current_task.done():
                return {
                    "success": False,
                    "error": "A task is already running. Stop it first.",
                }

            task_desc = params.arguments.get("task_description", "")
            context = params.arguments.get("context", "")

            status = await self.game_client.my_status()
            game_state = {
                "current_sector": status.sector,
                "credits": 1000,  # Mock until server provides
                "cargo": {"fuel_ore": 0, "organics": 0, "equipment": 0},
            }

            self.current_task = self._start_task_async(
                f"{context}\n{task_desc}" if context else task_desc, game_state
            )
            return {"success": True, "message": "Task started"}

        except Exception as e:
            logger.error(f"start_task failed: {e}")
            return {"success": False, "error": str(e)}

    async def tool_stop_task(self, params: FunctionCallParams):
        try:
            if self.current_task and not self.current_task.done():
                # Get any task progress before cancelling
                task_progress = ""
                if self.get_task_progress_callback:
                    task_progress = self.get_task_progress_callback()

                # Use the cancel callback which properly sets the TaskAgent's cancelled flag
                if self.cancel_task_callback:
                    self.cancel_task_callback()
                else:
                    # Fallback to direct cancellation if no callback
                    self.current_task.cancel()

                await self.game_client.my_status(force_refresh=True)

                # Include task progress and instruction in the tool response
                return {
                    "success": True,
                    "message": "Task cancelled",
                    "task_progress": task_progress,
                    "text_instruction": "The task was cancelled. Please acknowledge the cancellation and summarize what was done before stopping.",
                }
            else:
                return {"success": False, "error": "No task is currently running"}

        except Exception as e:
            logger.error(f"stop_task failed: {e}")
            return {"success": False, "error": str(e)}

    def get_tools_schema(self) -> ToolsSchema:
        move_schema = FunctionSchema(
            name="move",
            description="Move your ship to an adjacent sector. You can only move one sector at a time.",
            properties={
                "to_sector": {
                    "type": "integer",
                    "description": "Adjacent sector ID to move to",
                }
            },
            required=["to_sector"],
        )

        my_status_schema = FunctionSchema(
            name="my_status",
            description="Get your current status including current sector position",
            properties={},
            required=[],
        )

        my_map_schema = FunctionSchema(
            name="my_map",
            description="Get your map knowledge including all visited sectors, known ports, and discovered connections",
            properties={},
            required=[],
        )

        start_task_schema = FunctionSchema(
            name="start_task",
            description="Start a complex multi-step task for navigation, trading, or exploration",
            properties={
                "task_description": {
                    "type": "string",
                    "description": "Natural language description of the task to execute",
                },
                "context": {
                    "type": "string",
                    "description": "Relevant conversation history or clarifications",
                },
            },
            required=["task_description"],
        )

        stop_task_schema = FunctionSchema(
            name="stop_task",
            description="Cancel the currently running task",
            properties={},
            required=[],
        )

        return ToolsSchema(
            standard_tools=[
                move_schema,
                my_status_schema,
                my_map_schema,
                start_task_schema,
                stop_task_schema,
            ]
        )
