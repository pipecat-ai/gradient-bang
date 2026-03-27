"""Abstract base agent for the multi-agent framework.

Provides the `BaseAgent` class that all agents inherit from, handling
agent lifecycle, parent-child relationships, and long-running task
coordination.
"""

import asyncio
import dataclasses
import uuid
from dataclasses import dataclass
from typing import Coroutine, Optional, Union

from loguru import logger
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    ErrorFrame,
    Frame,
    StartFrame,
    StopFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineTask
from pipecat.processors.filters.identity_filter import IdentityFilter
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor, FrameProcessorSetup
from pipecat.utils.asyncio.task_manager import TaskManager
from pipecat.utils.base_object import BaseObject

from gradientbang.subagents.agents.task_group import (
    TaskGroup,
    TaskGroupContext,
    TaskGroupError,
    TaskGroupEvent,
    TaskGroupResponse,
    TaskStatus,
)
from gradientbang.subagents.bus import (
    AgentBus,
    BusActivateAgentMessage,
    BusAddAgentMessage,
    BusAgentErrorMessage,
    BusAgentLocalErrorMessage,
    BusCancelAgentMessage,
    BusCancelMessage,
    BusDeactivateAgentMessage,
    BusEndAgentMessage,
    BusEndMessage,
    BusMessage,
    BusTaskCancelMessage,
    BusTaskRequestMessage,
    BusTaskResponseMessage,
    BusTaskResponseUrgentMessage,
    BusTaskStreamDataMessage,
    BusTaskStreamEndMessage,
    BusTaskStreamStartMessage,
    BusTaskUpdateMessage,
    BusTaskUpdateRequestMessage,
    BusTaskUpdateUrgentMessage,
)
from gradientbang.subagents.bus.messages import BusFrameMessage
from gradientbang.subagents.bus.subscriber import BusSubscriber
from gradientbang.subagents.registry import AgentRegistry
from gradientbang.subagents.types import AgentErrorData, AgentReadyData


@dataclass
class AgentActivationArgs:
    """Base activation arguments for any agent.

    Parameters:
        metadata: Optional structured data passed during activation.
    """

    metadata: Optional[dict] = None

    @classmethod
    def from_dict(cls, data: dict) -> "AgentActivationArgs":
        """Create from a dict, ignoring unknown keys."""
        fields = {f.name for f in dataclasses.fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in fields})

    def to_dict(self) -> dict:
        """Convert to a dict, excluding None values."""
        return {
            f.name: getattr(self, f.name)
            for f in dataclasses.fields(self)
            if getattr(self, f.name) is not None
        }


_LIFECYCLE_FRAMES = (StartFrame, EndFrame, CancelFrame, StopFrame)


class _BusEdgeProcessor(FrameProcessor, BusSubscriber):
    """Pipeline edge that bridges pipeline frames and bus messages.

    Captures pipeline frames traveling in ``direction`` and sends them to the
    bus. Receives bus frames traveling in the opposite direction and pushes
    them into the pipeline.
    """

    def __init__(
        self,
        *,
        bus: AgentBus,
        agent: "BaseAgent",
        direction: FrameDirection,
        bridges: tuple[str, ...] = (),
        exclude_frames: Optional[tuple[type[Frame], ...]] = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._bus = bus
        self._agent = agent
        self._direction = direction
        self._bridges = bridges
        self._exclude_frames = exclude_frames or ()

    async def setup(self, setup: FrameProcessorSetup):
        await super().setup(setup)
        await self._bus.subscribe(self)

    async def cleanup(self):
        await super().cleanup()
        await self._bus.unsubscribe(self)

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)

        if direction != self._direction:
            return
        if isinstance(frame, _LIFECYCLE_FRAMES):
            return
        if isinstance(frame, self._exclude_frames):
            return
        await self._bus.send(
            BusFrameMessage(source=self._agent.name, frame=frame, direction=direction)
        )

    async def on_bus_message(self, message):
        if not isinstance(message, BusFrameMessage):
            return
        if message.source == self._agent.name:
            return
        if message.direction == self._direction:
            return
        if not self._agent.active:
            return
        if message.target and message.target != self._agent.name:
            return
        if self._bridges and message.bridge not in self._bridges:
            return
        await self.push_frame(message.frame, message.direction)


class BaseAgent(BaseObject, BusSubscriber):
    """Abstract base class for agents in the multi-agent framework.

    Each agent connects to the bus and optionally runs a Pipecat pipeline
    defined via ``build_pipeline()``. Agents that return None from
    ``build_pipeline()`` operate purely through bus messages.

    Overridable lifecycle methods (always call ``super()``):

    - ``on_ready()``: Called once when the agent is ready.
    - ``on_finished()``: Called when the agent's pipeline has finished.
    - ``on_activated(args)``: Called when this agent is activated.
    - ``on_deactivated()``: Called when this agent is deactivated.
    - ``on_agent_ready(agent_info)``: Called when another agent is ready
      to receive messages. For local root agents, fires automatically.
      For children, fires only on the parent. For remote agents, fires
      only for agents watched via ``watch_agent()``.
    - ``on_task_request(message)``: Called when a task request is received.
    - ``on_task_response(message)``: Called when a task agent sends a response.
    - ``on_task_update(message)``: Called when a task agent sends a progress
      update.
    - ``on_task_update_requested(message)``: Called when the requester asks
      for a progress update.
    - ``on_task_completed(result)``: Called when all agents in a task group
      have responded.
    - ``on_task_error(message)``: Called when a worker errors and the group
      is cancelled (``cancel_on_error``).
    - ``on_task_stream_start(message)``: Called when a task agent begins
      streaming.
    - ``on_task_stream_data(message)``: Called for each streaming chunk from
      a task agent.
    - ``on_task_stream_end(message)``: Called when a task agent finishes
      streaming.
    - ``on_task_cancelled(message)``: Called when this agent's task is
      cancelled by the requester.
    - ``on_bus_message(message)``: Called for bus messages after default
      lifecycle handling.

    Event handlers available:

    - on_ready: Agent is ready to operate.
    - on_finished: Agent's pipeline has finished.
    - on_error: A pipeline error occurred.
    - on_activated: Agent was activated.
    - on_deactivated: Agent was deactivated.
    - on_agent_ready: Another agent is ready.
    - on_agent_error: A child agent reported an error.
    - on_task_request: Received a task request.
    - on_task_response: A worker sent a task response.
    - on_task_update: A worker sent a progress update.
    - on_task_update_requested: Requester asked for a progress update.
    - on_task_completed: All workers in a task group responded.
    - on_task_error: A worker errored and the group was cancelled.
    - on_task_stream_start: A worker started streaming.
    - on_task_stream_data: A worker sent a streaming chunk.
    - on_task_stream_end: A worker finished streaming.
    - on_task_cancelled: This agent's task was cancelled.
    - on_bus_message: A bus message was received.

    Example::

        agent = MyAgent(name="my_agent", bus=bus)

        @agent.event_handler("on_ready")
        async def on_ready(agent):
            logger.info("Agent pipeline is ready")
    """

    def __init__(
        self,
        name: str,
        *,
        bus: AgentBus,
        active: bool = False,
        bridged: Optional[tuple[str, ...]] = None,
        exclude_frames: Optional[tuple[type[Frame], ...]] = None,
    ):
        """Initialize the BaseAgent.

        Args:
            name: Unique name for this agent.
            bus: The `AgentBus` for inter-agent communication.
            active: Whether the agent starts active. Defaults to False.
            bridged: Bridge configuration. ``None`` means not bridged.
                An empty tuple ``()`` means bridged, accepting frames
                from all bridges. A tuple of names like ``("voice",)``
                means bridged, accepting only frames from those bridges.
            exclude_frames: Frame types to exclude from bus forwarding
                when bridged. Lifecycle frames are always excluded.
        """
        super().__init__(name=name)

        # Bus and bridge. When bridged, edge processors wrap the pipeline
        # to route frames to/from the bus.
        self._bus = bus
        self._bridged = bridged
        self._exclude_frames = exclude_frames

        # Activation. Pending activation is deferred until the pipeline
        # starts, then on_activated fires.
        self._active = active
        self._pending_activation = active
        self._activation_args: Optional[dict] = None

        # Agent lifecycle. Parent/children form a tree. The pipeline task
        # runs the agent's pipeline. Finished is set when the agent stops.
        self._parent: Optional[str] = None
        self._children: list["BaseAgent"] = []
        self._pipeline_task: Optional[PipelineTask] = None
        self._pipeline_started = False
        self._finished: asyncio.Event = asyncio.Event()

        # Shared infrastructure, set by the runner via set_registry()
        # and set_task_manager().
        self._registry: Optional[AgentRegistry] = None
        self._task_manager: Optional[TaskManager] = None

        # Task coordination. Worker state tracks the current task being
        # worked on. Requester state tracks task groups launched by this agent.
        self._task_id: Optional[str] = None
        self._task_requester: Optional[str] = None
        self._task_groups: dict[str, TaskGroup] = {}

        # This agent's lifecycle
        self._register_event_handler("on_ready")
        self._register_event_handler("on_finished")
        self._register_event_handler("on_error")
        self._register_event_handler("on_activated")
        self._register_event_handler("on_deactivated")
        self._register_event_handler("on_bus_message")
        self._register_event_handler("on_task_request")
        self._register_event_handler("on_task_response")
        self._register_event_handler("on_task_update")
        self._register_event_handler("on_task_update_requested")
        self._register_event_handler("on_task_completed")
        self._register_event_handler("on_task_error")
        self._register_event_handler("on_task_stream_start")
        self._register_event_handler("on_task_stream_data")
        self._register_event_handler("on_task_stream_end")
        self._register_event_handler("on_task_cancelled")

        # Other agents
        self._register_event_handler("on_agent_ready")
        self._register_event_handler("on_agent_error")

    @property
    def bus(self) -> AgentBus:
        """The bus instance for agent communication."""
        return self._bus

    @property
    def active(self) -> bool:
        """Whether this agent is currently active."""
        return self._active

    @property
    def parent(self) -> Optional[str]:
        """The name of the parent agent, or None if this is a root agent."""
        return self._parent

    @property
    def registry(self) -> Optional[AgentRegistry]:
        """The shared agent registry, if set by a runner."""
        return self._registry

    @property
    def children(self) -> list["BaseAgent"]:
        """The list of child agents added via ``add_agent()``."""
        return self._children

    @property
    def pipeline_task(self) -> PipelineTask:
        """The `PipelineTask` for this agent.

        Raises:
            RuntimeError: If the pipeline task has not been created yet.
        """
        if not self._pipeline_task:
            raise RuntimeError(f"Agent '{self}': task not available.")
        return self._pipeline_task

    @property
    def task_id(self) -> Optional[str]:
        """The ID of the task this agent is currently working on."""
        return self._task_id

    @property
    def task_groups(self) -> dict[str, TaskGroup]:
        """Active task groups launched by this agent, keyed by task_id."""
        return self._task_groups

    def set_registry(self, registry: AgentRegistry) -> None:
        """Set the shared agent registry.

        Args:
            registry: The shared registry instance.
        """
        self._registry = registry

    def set_task_manager(self, task_manager: TaskManager) -> None:
        """Set the shared task manager for asyncio task creation.

        Args:
            task_manager: The shared task manager instance.
        """
        self._task_manager = task_manager

    async def cleanup(self) -> None:
        """Clean up the agent and release resources.

        Cancels running tasks, unsubscribes from the bus, and signals
        that the agent has stopped.
        """
        await self._stop()

    def create_asyncio_task(self, coroutine: Coroutine, name: str) -> asyncio.Task:
        """Create a managed asyncio task.

        Args:
            coroutine: The coroutine to run.
            name: Human-readable name for the task (used in logs).

        Returns:
            The created `asyncio.Task`.

        Raises:
            RuntimeError: If the task manager has not been set.
        """
        if not self._task_manager:
            raise RuntimeError(f"Agent '{self}': task manager not set")
        return self._task_manager.create_task(coroutine, name)

    async def cancel_asyncio_task(self, task: asyncio.Task) -> None:
        """Cancel a managed asyncio task.

        Args:
            task: The task to cancel.

        Raises:
            RuntimeError: If the task manager has not been set.
        """
        if not self._task_manager:
            raise RuntimeError(f"Agent '{self}': task manager not set")
        await self._task_manager.cancel_task(task)

    async def on_ready(self) -> None:
        """Called once when the agent is ready."""
        pass

    async def on_finished(self) -> None:
        """Called when the agent's pipeline has finished."""
        pass

    async def on_error(self, error: str, fatal: bool) -> None:
        """Called when a pipeline error occurs.

        Override to handle errors (e.g. propagate via ``send_error()``,
        fail a running task, or log and recover).

        Args:
            error: Description of the error.
            fatal: Whether the error is unrecoverable.
        """
        pass

    async def on_activated(self, args: Optional[dict]) -> None:
        """Called when this agent is activated.

        Override in subclasses to react to activation.
        Always call ``super().on_activated(args)``.

        Args:
            args: Optional arguments from the caller.
        """
        pass

    async def on_deactivated(self) -> None:
        """Called when this agent is deactivated.

        Override in subclasses to react to deactivation.
        Always call ``super().on_deactivated()``.
        """
        pass

    async def on_agent_ready(self, data: AgentReadyData) -> None:
        """Called when another agent is ready to receive messages.

        For local root agents this fires automatically. For remote agents
        it fires only for agents watched via ``watch_agent()``. For child
        agents it fires only on the parent that created them.

        Args:
            data: Information about the ready agent.
        """
        logger.debug(f"Agent '{self}': agent '{data.agent_name}' ready")

    async def on_agent_error(self, data: AgentErrorData) -> None:
        """Called when a child agent reports an error.

        Args:
            data: Information about the error.
        """
        pass

    async def on_task_request(self, message: BusTaskRequestMessage) -> None:
        """Called when this agent receives a task request.

        Override to perform work. Use ``send_task_update()`` to report
        progress and ``send_task_response()`` to return results.
        """
        pass

    async def on_task_response(self, message: BusTaskResponseMessage) -> None:
        """Called when a task agent sends a response.

        Override to process individual results as they arrive.
        """
        pass

    async def on_task_update(self, message: BusTaskUpdateMessage) -> None:
        """Called when a task agent sends a progress update."""
        pass

    async def on_task_update_requested(self, message: BusTaskUpdateRequestMessage) -> None:
        """Called when the requester asks for a progress update.

        Override to send back a progress update via ``send_task_update()``.
        """
        pass

    async def on_task_completed(self, result: TaskGroupResponse) -> None:
        """Called when all agents in a task group have responded."""
        pass

    async def on_task_error(self, message: BusTaskResponseMessage) -> None:
        """Called when a task group is cancelled due to a worker error.

        Fires when a worker responds with ``ERROR`` or ``FAILED`` status
        and ``cancel_on_error`` is set. The group is cancelled and
        ``on_task_completed`` will not fire. Partial responses from
        workers that completed before the error are available in
        the task group's ``responses``.
        """
        pass

    async def on_task_stream_start(self, message: BusTaskStreamStartMessage) -> None:
        """Called when a task agent begins streaming."""
        pass

    async def on_task_stream_data(self, message: BusTaskStreamDataMessage) -> None:
        """Called for each streaming chunk from a task agent."""
        pass

    async def on_task_stream_end(self, message: BusTaskStreamEndMessage) -> None:
        """Called when a task agent finishes streaming."""
        pass

    async def on_task_cancelled(self, message: BusTaskCancelMessage) -> None:
        """Called when this agent's task is cancelled by the requester.

        Override to clean up resources or stop in-progress work.
        """
        pass

    async def on_bus_message(self, message: BusMessage) -> None:
        """Called for every bus message after built-in lifecycle handling.

        Override to handle custom message types. Built-in message types
        (activation, end, cancel, task) are already dispatched to their
        respective hooks before this method is called.

        Args:
            message: The `BusMessage` to process.
        """
        # Frame messages are handled by edge processors
        if isinstance(message, BusFrameMessage):
            return

        # Ignore targeted messages for other agents
        if message.target and message.target != self.name:
            return

        if isinstance(message, (BusAgentErrorMessage, BusAgentLocalErrorMessage)):
            await self._handle_agent_error(message)
        elif isinstance(message, BusActivateAgentMessage):
            await self._handle_agent_activate(message)
        elif isinstance(message, BusDeactivateAgentMessage):
            await self._handle_agent_deactivate(message)
        elif isinstance(message, BusEndAgentMessage):
            await self._handle_agent_end(message)
        elif isinstance(message, BusCancelAgentMessage):
            await self._handle_agent_cancel(message)
        elif isinstance(message, BusTaskRequestMessage):
            await self._handle_task_request(message)
        elif isinstance(message, (BusTaskResponseMessage, BusTaskResponseUrgentMessage)):
            await self._handle_task_response(message)
        elif isinstance(message, (BusTaskUpdateMessage, BusTaskUpdateUrgentMessage)):
            await self._handle_task_update(message)
        elif isinstance(message, BusTaskUpdateRequestMessage):
            await self._handle_task_update_request(message)
        elif isinstance(message, BusTaskCancelMessage):
            await self._handle_task_cancel(message)
        elif isinstance(message, BusTaskStreamStartMessage):
            await self._handle_task_stream_start(message)
        elif isinstance(message, BusTaskStreamDataMessage):
            await self._handle_task_stream_data(message)
        elif isinstance(message, BusTaskStreamEndMessage):
            await self._handle_task_stream_end(message)

        await self._call_event_handler("on_bus_message", message)

    async def build_pipeline(self) -> Pipeline:
        """Return this agent's pipeline.

        Override to define a processing pipeline. The default returns a
        no-op pipeline for agents that operate purely through bus messages
        (e.g. coordinators, factories).

        Returns:
            A ``Pipeline``.
        """
        return Pipeline([IdentityFilter()])

    async def create_pipeline(self, user_pipeline: Pipeline) -> Pipeline:
        """Assemble the final pipeline from the user pipeline.

        When bridged, wraps the pipeline with bus edge processors.
        Can be overridden to add additional processors.

        Args:
            user_pipeline: The pipeline returned by ``build_pipeline()``.

        Returns:
            The assembled ``Pipeline``.
        """
        if self._bridged is not None:
            edge_source = _BusEdgeProcessor(
                bus=self._bus,
                agent=self,
                direction=FrameDirection.UPSTREAM,
                bridges=self._bridged,
                exclude_frames=self._exclude_frames,
                name=f"{self.name}::EdgeSource",
            )
            edge_sink = _BusEdgeProcessor(
                bus=self._bus,
                agent=self,
                direction=FrameDirection.DOWNSTREAM,
                bridges=self._bridged,
                exclude_frames=self._exclude_frames,
                name=f"{self.name}::EdgeSink",
            )
            return Pipeline([edge_source, user_pipeline, edge_sink])
        return user_pipeline

    def build_pipeline_task(self, pipeline: Pipeline) -> PipelineTask:
        """Create the ``PipelineTask`` for this agent's pipeline.

        Override to customize task parameters (e.g. enable interruptions).
        The default creates a task with default ``PipelineParams``.

        Args:
            pipeline: The fully assembled pipeline (including any
                edge-to-bus wiring).

        Returns:
            A ``PipelineTask``.
        """
        return PipelineTask(
            pipeline,
            enable_rtvi=False,
            idle_timeout_secs=None,
        )

    async def create_pipeline_task(self) -> PipelineTask:
        """Create the agent's pipeline task.

        Called by the runner.

        Returns:
            The configured ``PipelineTask``.
        """
        await self._bus.subscribe(self)

        user_pipeline = await self.build_pipeline()
        pipeline = await self.create_pipeline(user_pipeline)

        task = self.build_pipeline_task(pipeline)
        self._pipeline_task = task

        @task.event_handler("on_pipeline_started")
        async def on_pipeline_started(task, frame: StartFrame):
            logger.debug(f"Agent '{self}': pipeline started")
            self._pipeline_started = True
            await self._start()

        @task.event_handler("on_pipeline_error")
        async def on_pipeline_error(task, frame: ErrorFrame):
            logger.error(f"Agent '{self}': pipeline error: {frame.error}")
            await self.on_error(frame.error, frame.fatal)
            await self._call_event_handler("on_error", frame.error, frame.fatal)

        @task.event_handler("on_pipeline_finished")
        async def on_pipeline_finished(task, frame):
            logger.debug(f"Agent '{self}': pipeline {task} finished ({frame})")
            await self.on_finished()
            await self._call_event_handler("on_finished")
            await self._stop()

        return task

    async def end(self, *, reason: Optional[str] = None) -> None:
        """Request a graceful end of the session.

        Args:
            reason: Optional human-readable reason for ending.
        """
        await self.send_message(BusEndMessage(source=self.name, reason=reason))

    async def cancel(self) -> None:
        """Request an immediate cancellation of all agents."""
        await self.send_message(BusCancelMessage(source=self.name))

    async def wait(self) -> None:
        """Wait for this agent to finish."""
        await self._finished.wait()

    async def send_message(self, message: BusMessage) -> None:
        """Send a message on the bus.

        Args:
            message: The `BusMessage` to send.
        """
        await self._bus.send(message)

    async def send_error(self, error: str) -> None:
        """Report an error on the bus.

        Child agents send a local-only message to the parent.
        Root agents broadcast over the network.

        Args:
            error: Description of the error.
        """
        if self._parent:
            await self.send_message(BusAgentLocalErrorMessage(source=self.name, error=error))
        else:
            await self.send_message(BusAgentErrorMessage(source=self.name, error=error))

    async def queue_frame(
        self, frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM
    ) -> None:
        """Queue a frame into this agent's pipeline task.

        Args:
            frame: The frame to queue into the pipeline task.
            direction: Direction the frame should travel. Defaults to
                ``FrameDirection.DOWNSTREAM``.
        """
        if self._pipeline_task:
            await self._pipeline_task.queue_frame(frame, direction)

    async def queue_frames(
        self, frames, direction: FrameDirection = FrameDirection.DOWNSTREAM
    ) -> None:
        """Queue multiple frames into this agent's pipeline task.

        Args:
            frames: The frames to queue into the pipeline task.
            direction: Direction the frames should travel. Defaults to
                ``FrameDirection.DOWNSTREAM``.
        """
        if self._pipeline_task:
            await self._pipeline_task.queue_frames(frames, direction)

    async def add_agent(self, agent: "BaseAgent") -> None:
        """Register a child agent under this parent.

        The child's lifecycle (end, cancel) is automatically managed
        by this parent agent. The parent is notified via
        ``on_agent_ready`` when the child's pipeline starts.

        Args:
            agent: The child `BaseAgent` instance to add.
        """
        if agent._parent is not None:
            logger.error(f"Agent '{agent.name}' already has parent '{agent._parent}', skipping")
            return
        agent._parent = self.name
        self._children.append(agent)
        if self._registry:
            await self._registry.watch(agent.name, self._on_watched_agent_ready)
        await self.send_message(BusAddAgentMessage(source=self.name, agent=agent))

    async def activate_agent(
        self,
        agent_name: str,
        *,
        args: Optional[AgentActivationArgs] = None,
    ) -> None:
        """Activate an agent by name.

        The target agent's ``on_activated`` hook will be called
        with the provided arguments.

        Args:
            agent_name: The name of the agent to activate.
            args: Optional ``AgentActivationArgs`` forwarded to the
                target agent's ``on_activated``.
        """
        await self.send_message(
            BusActivateAgentMessage(
                source=self.name, target=agent_name, args=args.to_dict() if args else None
            )
        )

    async def deactivate_agent(self, agent_name: str) -> None:
        """Deactivate an agent by name.

        The target agent's ``on_deactivated`` hook will be called.

        Args:
            agent_name: The name of the agent to deactivate.
        """
        await self.send_message(BusDeactivateAgentMessage(source=self.name, target=agent_name))

    async def handoff_to(
        self,
        agent_name: str,
        *,
        args: Optional[AgentActivationArgs] = None,
    ) -> None:
        """Hand off to another agent.

        Deactivates this agent and activates the target. For independent
        control, use ``activate_agent()`` and ``deactivate_agent()`` directly.

        Args:
            agent_name: The name of the agent to hand off to.
            args: Optional arguments forwarded to the target agent's
                ``on_activated`` handler.
        """
        if self._active:
            self._active = False
        await self.activate_agent(agent_name, args=args)

    async def watch_agent(self, agent_name: str) -> None:
        """Request notification when an agent registers.

        If the agent is already registered, ``on_agent_ready`` fires
        immediately. Otherwise ``on_agent_ready`` fires when the
        agent eventually registers.

        Args:
            agent_name: The name of the agent to watch for.
        """
        if self._registry:
            logger.debug(f"Agent '{self}': watching for agent '{agent_name}'")
            await self._registry.watch(agent_name, self._on_watched_agent_ready)

    async def request_task(
        self,
        *agent_names: str,
        payload: Optional[dict] = None,
        timeout: Optional[float] = None,
        cancel_on_error: bool = True,
    ) -> str:
        """Send a task request to agents.

        Waits for all agents to be ready before sending requests.
        Does not wait for the task group to complete; use callbacks
        (``on_task_response``, ``on_task_completed``) or ``task_group``
        for that.

        Args:
            *agent_names: Names of the agents to send the task to.
            payload: Optional structured data describing the work.
            timeout: Optional timeout in seconds. If set, the task is
                automatically cancelled after this duration.
            cancel_on_error: Whether to cancel the entire group if a
                worker responds with an error status. Defaults to True.

        Returns:
            The generated task_id shared by all agents in the group.
        """
        for name in agent_names:
            if not isinstance(name, str):
                raise TypeError(f"{self} Expected agent name as str, got {type(name).__name__}")

        group = await self.create_task_group_and_request_task(
            list(agent_names),
            payload=payload,
            timeout=timeout,
            cancel_on_error=cancel_on_error,
        )
        return group.task_id

    async def cancel_task(self, task_id: str, *, reason: Optional[str] = None) -> None:
        """Cancel a running task group.

        Args:
            task_id: The task identifier to cancel.
            reason: Optional human-readable reason for cancellation.
        """
        group = self._task_groups.pop(task_id, None)
        if group:
            if group.timeout_task:
                await self.cancel_asyncio_task(group.timeout_task)
            for agent_name in group.agent_names:
                await self.send_message(
                    BusTaskCancelMessage(
                        source=self.name, target=agent_name, task_id=task_id, reason=reason
                    )
                )
            group.fail(reason)

    def request_task_group(
        self,
        *agent_names: str,
        payload: Optional[dict] = None,
        timeout: Optional[float] = None,
        cancel_on_error: bool = True,
    ) -> TaskGroupContext:
        """Create a structured task group context manager.

        Waits for agents to be ready, sends task requests, and waits
        for all responses on exit. Supports ``async for`` inside the
        block to receive intermediate events (updates and streaming
        data) from workers while waiting.

        On normal completion, results are available via ``responses``.
        On worker error (with ``cancel_on_error=True``) or timeout,
        raises ``TaskGroupError``.

        Args:
            *agent_names: Names of the agents to send the task to.
            payload: Optional structured data describing the work.
            timeout: Optional timeout in seconds.
            cancel_on_error: Whether to cancel the group if a worker
                errors. Defaults to True.

        Returns:
            A ``TaskGroupContext`` to use with ``async with``.

        Example::

            async with self.request_task_group("w1", "w2", payload=data) as tg:
                async for event in tg:
                    if event.type == TaskGroupEvent.UPDATE:
                        print(f"{event.agent_name}: {event.data}")

            for name, result in tg.responses.items():
                print(name, result)
        """
        for name in agent_names:
            if not isinstance(name, str):
                raise TypeError(f"{self} Expected agent name as str, got {type(name).__name__}")

        return TaskGroupContext(
            self,
            agent_names,
            payload=payload,
            timeout=timeout,
            cancel_on_error=cancel_on_error,
        )

    async def request_task_update(self, task_id: str, agent_name: str) -> None:
        """Request a progress update from a task agent.

        Args:
            task_id: The task identifier.
            agent_name: The name of the agent to request an update from.
        """
        await self.send_message(
            BusTaskUpdateRequestMessage(source=self.name, target=agent_name, task_id=task_id)
        )

    async def send_task_response(
        self,
        response: Optional[dict] = None,
        *,
        status: TaskStatus = TaskStatus.COMPLETED,
        urgent: bool = False,
    ) -> None:
        """Send a task response back to the requester.

        After sending, the agent is ready to accept a new task.

        Args:
            response: Optional result data.
            status: Completion status. Defaults to ``TaskStatus.COMPLETED``.
            urgent: When True, the response is delivered with system
                priority, preempting queued data messages.

        Raises:
            RuntimeError: If this agent has no active task.
        """
        if not self._task_id or not self._task_requester:
            raise RuntimeError(f"Agent '{self}': no active task to respond to")
        msg_class = BusTaskResponseUrgentMessage if urgent else BusTaskResponseMessage
        await self.send_message(
            msg_class(
                source=self.name,
                target=self._task_requester,
                task_id=self._task_id,
                response=response,
                status=status,
            )
        )
        self._task_id = None
        self._task_requester = None

    async def send_task_update(
        self, update: Optional[dict] = None, *, urgent: bool = False
    ) -> None:
        """Send a progress update to the requester.

        Args:
            update: Optional progress data.
            urgent: When True, the update is delivered with system
                priority, preempting queued data messages.

        Raises:
            RuntimeError: If this agent has no active task.
        """
        if not self._task_id or not self._task_requester:
            raise RuntimeError(f"Agent '{self}': no active task to update")
        msg_class = BusTaskUpdateUrgentMessage if urgent else BusTaskUpdateMessage
        await self.send_message(
            msg_class(
                source=self.name,
                target=self._task_requester,
                task_id=self._task_id,
                update=update,
            )
        )

    async def send_task_stream_start(self, data: Optional[dict] = None) -> None:
        """Begin streaming task results back to the requester.

        Args:
            data: Optional metadata about the stream.

        Raises:
            RuntimeError: If this agent has no active task.
        """
        if not self._task_id or not self._task_requester:
            raise RuntimeError(f"Agent '{self}': no active task to stream")
        await self.send_message(
            BusTaskStreamStartMessage(
                source=self.name,
                target=self._task_requester,
                task_id=self._task_id,
                data=data,
            )
        )

    async def send_task_stream_data(self, data: Optional[dict] = None) -> None:
        """Send a streaming chunk to the requester.

        Args:
            data: The chunk payload.

        Raises:
            RuntimeError: If this agent has no active task.
        """
        if not self._task_id or not self._task_requester:
            raise RuntimeError(f"Agent '{self}': no active task to stream")
        await self.send_message(
            BusTaskStreamDataMessage(
                source=self.name,
                target=self._task_requester,
                task_id=self._task_id,
                data=data,
            )
        )

    async def send_task_stream_end(self, data: Optional[dict] = None) -> None:
        """End the current stream and mark this agent's task as complete.

        Args:
            data: Optional final metadata.

        Raises:
            RuntimeError: If this agent has no active task.
        """
        if not self._task_id or not self._task_requester:
            raise RuntimeError(f"Agent '{self}': no active task to stream")
        await self.send_message(
            BusTaskStreamEndMessage(
                source=self.name,
                target=self._task_requester,
                task_id=self._task_id,
                data=data,
            )
        )

    async def _start(self) -> None:
        """Fire agent lifecycle hooks and register as ready.

        Called automatically when the pipeline starts, or directly by
        ``create_pipeline_task()`` for pipeline-less agents.
        """
        await self.on_ready()
        await self._call_event_handler("on_ready")
        await self._register_ready()
        await self._maybe_activate()

    async def _stop(self) -> None:
        """Clean up and signal that this agent has stopped.

        Cancels all running task groups. Called by
        ``on_pipeline_finished`` for pipeline agents, or by the
        end/cancel handlers for pipeline-less agents.
        """
        for task_id in list(self._task_groups.keys()):
            await self.cancel_task(task_id, reason=f"agent '{self}' stopped")
        self._finished.set()

    async def _register_ready(self) -> None:
        """Register this agent as ready in the shared registry.

        Called automatically after ``on_ready()`` completes.
        The registry notifies watchers (parent for children, runner
        for root agents).
        """
        if self._registry:
            await self._registry.register(
                AgentReadyData(
                    agent_name=self.name,
                    runner=self._registry.runner_name,
                )
            )

    async def _on_watched_agent_ready(self, agent_data: AgentReadyData) -> None:
        """Called when a watched agent is ready.

        Proxies to ``on_agent_ready``.
        """
        await self.on_agent_ready(agent_data)
        await self._call_event_handler("on_agent_ready", agent_data)

    def _create_task_group(
        self,
        agent_names: list[str],
        *,
        timeout: Optional[float] = None,
        cancel_on_error: bool = True,
    ) -> TaskGroup:
        task_id = str(uuid.uuid4())
        group = TaskGroup(
            task_id=task_id, agent_names=set(agent_names), cancel_on_error=cancel_on_error
        )
        self._task_groups[task_id] = group

        if timeout is not None:
            group.timeout_task = self.create_asyncio_task(
                self._task_timeout(task_id, timeout), f"task_timeout_{task_id[:8]}"
            )

        return group

    async def _wait_agents_ready(self, agent_names: list[str]) -> asyncio.Future:
        """Return a future that resolves when all named agents are ready.

        Callers can race the returned future against a timeout or group
        done signal.

        Raises:
            RuntimeError: If the registry is not available.
        """
        if not self._registry:
            raise RuntimeError(f"Agent '{self}': registry not available")

        ready_events: dict[str, asyncio.Event] = {}
        for name in agent_names:
            event = asyncio.Event()
            ready_events[name] = event

            async def _on_ready(data, ev=event):
                ev.set()

            await self._registry.watch(name, _on_ready)

        return asyncio.ensure_future(asyncio.gather(*(ev.wait() for ev in ready_events.values())))

    async def create_task_group_and_request_task(
        self,
        agent_names: list[str],
        *,
        payload: Optional[dict] = None,
        timeout: Optional[float] = None,
        cancel_on_error: bool = True,
    ) -> TaskGroup:
        """Wait for agents to be ready, create a task group, and send requests.

        Waits for all agents to be registered as ready, then creates
        the group and sends a task request to each agent. Does not wait
        for the group to complete; call ``group.wait()`` or use
        ``request_task_group()`` for that.

        Args:
            agent_names: Names of the agents to send the task to.
            payload: Optional structured data describing the work.
            timeout: Optional timeout in seconds. Covers both the
                ready-wait and task execution.
            cancel_on_error: Whether to cancel the group if a worker
                errors. Defaults to True.

        Returns:
            The created ``TaskGroup``.

        Raises:
            TaskGroupError: If agents are not ready within the timeout.
        """
        all_ready = await self._wait_agents_ready(agent_names)
        try:
            await asyncio.wait_for(all_ready, timeout=timeout)
        except asyncio.TimeoutError:
            raise TaskGroupError("agents not ready within timeout")

        group = self._create_task_group(
            agent_names, timeout=timeout, cancel_on_error=cancel_on_error
        )

        for name in agent_names:
            await self._send_task_request(name, group.task_id, payload)

        return group

    async def _send_task_request(
        self, agent_name: str, task_id: str, payload: Optional[dict]
    ) -> None:
        await self.send_message(
            BusTaskRequestMessage(
                source=self.name, target=agent_name, task_id=task_id, payload=payload
            )
        )

    async def _task_timeout(self, task_id: str, timeout: float) -> None:
        try:
            await asyncio.sleep(timeout)
        except asyncio.CancelledError:
            return
        await self.cancel_task(task_id, reason="timeout")

    async def _handle_agent_error(
        self, message: Union[BusAgentErrorMessage, BusAgentLocalErrorMessage]
    ) -> None:
        """Handle an error reported by a child or remote agent."""
        child_names = {child.name for child in self._children}
        if message.source in child_names:
            error_info = AgentErrorData(agent_name=message.source, error=message.error)
            await self.on_agent_error(error_info)
            await self._call_event_handler("on_agent_error", error_info)

    async def _handle_agent_activate(self, message: BusActivateAgentMessage) -> None:
        """Handle an activation message.

        Stores the activation arguments and marks the agent as pending
        activation, then delegates to ``_maybe_activate()``.

        Args:
            message: The ``BusActivateAgentMessage`` requesting activation.
        """
        self._activation_args = message.args
        self._pending_activation = True
        await self._maybe_activate()

    async def _handle_agent_deactivate(self, message: BusDeactivateAgentMessage) -> None:
        """Deactivate this agent.

        Args:
            message: The ``BusDeactivateAgentMessage`` requesting deactivation.
        """
        logger.debug(f"Agent '{self}': deactivated")
        self._active = False
        await self.on_deactivated()
        await self._call_event_handler("on_deactivated")

    async def _handle_agent_end(self, message: BusEndAgentMessage) -> None:
        """Propagate end to children, wait for them, then end own pipeline.

        Args:
            message: The ``BusEndAgentMessage`` requesting a graceful end.
        """
        logger.debug(f"Agent '{self}': received end, ending pipeline ({self._pipeline_task})")
        for child in self._children:
            await self.send_message(
                BusEndAgentMessage(source=self.name, target=child.name, reason=message.reason)
            )
        await asyncio.gather(*(child.wait() for child in self._children))
        if self._pipeline_task:
            await self._pipeline_task.queue_frame(EndFrame(reason=message.reason))

    async def _handle_agent_cancel(self, message: BusCancelAgentMessage) -> None:
        """Propagate cancel to children, then cancel own pipeline.

        Args:
            message: The ``BusCancelAgentMessage`` requesting cancellation.
        """
        logger.debug(f"Agent '{self}': received cancel, cancelling task")
        for child in self._children:
            await self.send_message(
                BusCancelAgentMessage(source=self.name, target=child.name, reason=message.reason)
            )
        if self._pipeline_task:
            await self._pipeline_task.cancel()

    async def _handle_task_request(self, message: BusTaskRequestMessage) -> None:
        """Handle an incoming task request."""
        self._task_id = message.task_id
        self._task_requester = message.source
        await self.on_task_request(message)
        await self._call_event_handler("on_task_request", message)

    async def _handle_task_response(
        self, message: Union[BusTaskResponseMessage, BusTaskResponseUrgentMessage]
    ) -> None:
        """Handle a task response and track group completion."""
        await self.on_task_response(message)
        await self._call_event_handler("on_task_response", message)

        # Auto-cancel the group on error/failed if cancel_on_error is set
        if message.status in (TaskStatus.ERROR, TaskStatus.FAILED):
            group = self._task_groups.get(message.task_id)
            if group and group.cancel_on_error:
                group.responses[message.source] = message.response or {}
                await self.on_task_error(message)
                await self._call_event_handler("on_task_error", message)
                await self.cancel_task(message.task_id, reason=f"worker '{message.source}' errored")
                return

        await self._track_task_group_response(message.task_id, message.source, message.response)

    async def _handle_task_update(
        self, message: Union[BusTaskUpdateMessage, BusTaskUpdateUrgentMessage]
    ) -> None:
        """Handle a task progress update."""
        await self.on_task_update(message)
        await self._call_event_handler("on_task_update", message)
        self._push_task_group_event(
            message.task_id, TaskGroupEvent(TaskGroupEvent.UPDATE, message.source, message.update)
        )

    async def _handle_task_update_request(self, message: BusTaskUpdateRequestMessage) -> None:
        """Handle a task update request from the requester."""
        if self._task_id == message.task_id:
            await self.on_task_update_requested(message)
            await self._call_event_handler("on_task_update_requested", message)

    async def _handle_task_cancel(self, message: BusTaskCancelMessage) -> None:
        """Handle a task cancellation.

        Calls the ``on_task_cancelled`` hook for cleanup, then
        automatically sends a cancelled response back to the requester.
        The requester receives ``on_task_response`` with
        ``status="cancelled"``, same path as completed or failed tasks.
        """
        if self._task_id == message.task_id:
            await self.on_task_cancelled(message)
            await self._call_event_handler("on_task_cancelled", message)
            await self.send_task_response(status=TaskStatus.CANCELLED)

    async def _handle_task_stream_start(self, message: BusTaskStreamStartMessage) -> None:
        """Handle the start of a streaming task response."""
        await self.on_task_stream_start(message)
        await self._call_event_handler("on_task_stream_start", message)
        self._push_task_group_event(
            message.task_id,
            TaskGroupEvent(TaskGroupEvent.STREAM_START, message.source, message.data),
        )

    async def _handle_task_stream_data(self, message: BusTaskStreamDataMessage) -> None:
        """Handle a streaming task data chunk."""
        await self.on_task_stream_data(message)
        await self._call_event_handler("on_task_stream_data", message)
        self._push_task_group_event(
            message.task_id,
            TaskGroupEvent(TaskGroupEvent.STREAM_DATA, message.source, message.data),
        )

    async def _handle_task_stream_end(self, message: BusTaskStreamEndMessage) -> None:
        """Handle the end of a streaming task response."""
        await self.on_task_stream_end(message)
        await self._call_event_handler("on_task_stream_end", message)
        self._push_task_group_event(
            message.task_id, TaskGroupEvent(TaskGroupEvent.STREAM_END, message.source, message.data)
        )
        await self._track_task_group_response(message.task_id, message.source, message.data)

    def _push_task_group_event(self, task_id: str, event: TaskGroupEvent) -> None:
        group = self._task_groups.get(task_id)
        if group and group.event_queue:
            group.event_queue.put_nowait(event)

    async def _track_task_group_response(
        self, task_id: str, source: str, response: Optional[dict]
    ) -> None:
        """Record a task agent's response and fire completion when all have responded."""
        group = self._task_groups.get(task_id)
        if group:
            group.responses[source] = response or {}
            if group.responses.keys() >= group.agent_names:
                if group.timeout_task:
                    await self.cancel_asyncio_task(group.timeout_task)
                del self._task_groups[task_id]
                result = TaskGroupResponse(task_id=task_id, responses=group.responses)
                await self.on_task_completed(result)
                await self._call_event_handler("on_task_completed", result)
                group.complete()

    async def _maybe_activate(self) -> None:
        """Activate the agent, call on_agent_activated, and fire event handlers."""
        if self._pipeline_started and self._pending_activation:
            logger.debug(f"Agent '{self}': activated")
            self._active = True
            self._pending_activation = False
            await self.on_activated(self._activation_args)
            await self._call_event_handler("on_activated", self._activation_args)
