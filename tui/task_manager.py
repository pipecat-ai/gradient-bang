"""Task manager for coordinating between chat and task agents."""

import asyncio
from typing import Optional, Callable, Dict, Any
from collections import deque
from utils.task_agent import TaskAgent
from utils.chat_agent import ChatAgent
from utils.base_llm_agent import LLMConfig
from utils.game_tools import AsyncToolExecutor
from utils.api_client import AsyncGameClient


class TaskManager:
    """Manages task execution and communication between agents."""
    
    def __init__(
        self,
        game_client: AsyncGameClient,
        character_id: str,
        chat_config: Optional[LLMConfig] = None,
        task_config: Optional[LLMConfig] = None,
        output_callback: Optional[Callable[[str], None]] = None,
        progress_callback: Optional[Callable[[str, str], None]] = None,
        task_complete_callback: Optional[Callable[[bool], None]] = None,
        status_callback: Optional[Callable[[Dict[str, Any]], None]] = None
    ):
        """Initialize the task manager.
        
        Args:
            game_client: Shared game client instance
            character_id: Character ID being controlled
            chat_config: LLM configuration for chat agent (defaults to gpt-4.1)
            task_config: LLM configuration for task agent (defaults to gpt-5)
            output_callback: Callback for task output lines
            progress_callback: Callback for progress updates (action, description)
            task_complete_callback: Callback when task completes (receives was_cancelled flag)
            status_callback: Callback for status updates from chat and task agents
        """
        self.game_client = game_client
        self.character_id = character_id
        
        # Use different models for each agent
        self.chat_config = chat_config or LLMConfig(model="gpt-4.1")
        self.task_config = task_config or LLMConfig(model="gpt-5")
        
        self.output_callback = output_callback
        self.progress_callback = progress_callback
        self.task_complete_callback = task_complete_callback
        self.status_callback = status_callback
        
        # Create tool executor with status callback
        self.tool_executor = AsyncToolExecutor(game_client, character_id, status_callback)
        
        # Create task agent with gpt-5 for complex planning
        self.task_agent = TaskAgent(
            config=self.task_config,
            tool_executor=self.tool_executor,
            verbose_prompts=False,
            output_callback=self._task_output_handler
        )
        
        # Create chat agent with gpt-4.1 for faster responses, sharing the tool executor
        self.chat_agent = ChatAgent(
            config=self.chat_config,
            game_client=game_client,
            tool_executor=self.tool_executor,  # Share the same tool executor
            task_callback=self._start_task_async,
            cancel_task_callback=self.cancel_task,
            get_task_progress_callback=self.get_task_progress,
            verbose_prompts=False,
            debug_callback=None,  # Will be set by PlayerApp
            status_callback=status_callback
        )
        
        # Task management
        self.current_task: Optional[asyncio.Task] = None
        self.task_buffer: deque = deque(maxlen=1000)
        self.task_running = False
        self.cancelled_via_tool = False
    
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
                task=task_description,
                initial_state=game_state,
                max_iterations=50
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
                        self.progress_callback("Task was cancelled by user", "cancelled")
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
    
    def is_task_running(self) -> bool:
        """Check if a task is currently running.
        
        Returns:
            True if a task is running
        """
        return self.task_running and self.current_task and not self.current_task.done()
    
    async def initialize(self):
        """Initialize the chat agent conversation."""
        self.chat_agent.initialize_conversation()
        
        # Get initial status for welcome message
        try:
            status = await self.game_client.my_status()
            
            # Convert sector_contents to dict if it's a Pydantic model
            sector_contents_dict = {}
            if status.sector_contents:
                if hasattr(status.sector_contents, 'model_dump'):
                    sector_contents_dict = status.sector_contents.model_dump()
                elif hasattr(status.sector_contents, 'dict'):
                    sector_contents_dict = status.sector_contents.dict()
                elif hasattr(status.sector_contents, '__dict__'):
                    sector_contents_dict = status.sector_contents.__dict__
                else:
                    sector_contents_dict = dict(status.sector_contents)
            
            initial_state = {
                "current_sector": status.sector,
                "sector_contents": sector_contents_dict
            }
            
            # Process initial status as a message
            welcome_prompt = f"I've just connected to the ship. Current status: Sector {status.sector}"
            if status.sector_contents and status.sector_contents.port:
                port = status.sector_contents.port
                welcome_prompt += f" with a Class {port.class_num} port"
            
            return await self.chat_agent.process_message(welcome_prompt)
        
        except Exception as e:
            return f"Error initializing: {str(e)}"
    
    async def process_chat_message(self, message: str) -> str:
        """Process a chat message from the user.
        
        Args:
            message: User's chat message
            
        Returns:
            Assistant's response
        """
        # Get any task progress to include
        task_progress = self.get_task_progress()
        
        # Process message with chat agent
        return await self.chat_agent.process_message(message, task_progress)
    
    async def cleanup(self):
        """Clean up resources."""
        self.cancel_task()
        await self.game_client.close()