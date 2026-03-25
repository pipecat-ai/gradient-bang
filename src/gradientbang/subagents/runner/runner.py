"""Agent runner for orchestrating multi-agent lifecycle and pipeline tasks."""

import asyncio
import uuid
from dataclasses import dataclass, field
from typing import Coroutine, Optional

from loguru import logger
from pipecat.pipeline.runner import PipelineRunner
from pipecat.utils.asyncio.task_manager import TaskManager, TaskManagerParams
from pipecat.utils.base_object import BaseObject

from gradientbang.subagents.agents.base_agent import BaseAgent
from gradientbang.subagents.bus import (
    AgentBus,
    AsyncQueueBus,
    BusAddAgentMessage,
    BusAgentRegistryMessage,
    BusCancelAgentMessage,
    BusCancelMessage,
    BusEndAgentMessage,
    BusEndMessage,
    BusMessage,
)
from gradientbang.subagents.bus.subscriber import BusSubscriber
from gradientbang.subagents.registry import AgentRegistry
from gradientbang.subagents.types import AgentReadyData


@dataclass
class AgentEntry:
    """An agent registered with the runner and its pipeline task.

    Parameters:
        agent: The agent instance.
        task: The asyncio task running the agent's pipeline, or None
            for pipeline-less agents.
    """

    agent: BaseAgent
    task: Optional[asyncio.Task] = field(default=None, repr=False)


class AgentRunner(BaseObject, BusSubscriber):
    """Lifecycle orchestrator for multi-agent systems.

    Manages agent pipelines, coordinates startup and shutdown, and
    responds to bus messages. On graceful end, root agents are ended
    first; parent agents propagate shutdown to their children.

    Event handlers available:

    - on_ready: Fired after all registered agents have been started.
    - on_error: Fired when the runner encounters an error.

    Example::

        runner = AgentRunner()

        agent = MyAgent("my_agent", bus=runner.bus, ...)
        await runner.add_agent(agent)

        await runner.run()
    """

    def __init__(
        self,
        *,
        name: Optional[str] = None,
        bus: Optional[AgentBus] = None,
        handle_sigint: bool = True,
    ):
        """Initialize the `AgentRunner`.

        Args:
            name: Optional unique name for this runner. Defaults to a
                UUID-based name. Must be unique across all runners in a
                distributed setup.
            bus: Optional `AgentBus` instance. Creates an `AsyncQueueBus`
                if not provided.
            handle_sigint: Whether to handle SIGINT for graceful shutdown.
                Defaults to True.
        """
        super().__init__(name=name or f"runner-{uuid.uuid4().hex[:8]}")
        self._bus = bus or AsyncQueueBus()
        self._registry = AgentRegistry(runner_name=self.name)
        self._task_manager = TaskManager()
        self._pipecat_runner = PipelineRunner(handle_sigint=handle_sigint)

        self._running: bool = False
        self._entries: dict[str, AgentEntry] = {}
        self._shutdown_event = asyncio.Event()
        self._known_runners: set[str] = set()

        self._register_event_handler("on_ready")
        self._register_event_handler("on_error")

    @property
    def bus(self) -> AgentBus:
        """The bus instance for agent communication."""
        return self._bus

    @property
    def registry(self) -> AgentRegistry:
        """The shared agent registry."""
        return self._registry

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

    async def on_bus_message(self, message: BusMessage) -> None:
        """Process incoming bus messages for runner-level concerns.

        Handles end/cancel signals, dynamic agent addition, and remote
        registry synchronization. Ignores messages originating from
        this runner.

        Args:
            message: The bus message to process.
        """
        if message.source == self.name:
            return
        if isinstance(message, BusEndMessage):
            self.create_asyncio_task(self.end(message.reason), "end")
        elif isinstance(message, BusCancelMessage):
            self.create_asyncio_task(self.cancel(message.reason), "cancel")
        elif isinstance(message, BusAddAgentMessage) and message.agent:
            await self.add_agent(message.agent)
        elif isinstance(message, BusAgentRegistryMessage):
            await self._handle_agent_registry(message)

    async def add_agent(self, agent: BaseAgent) -> None:
        """Add an agent to this runner.

        Can be called before or after run(). When called after run() has
        started, the agent's pipeline task is created and started immediately.

        Args:
            agent: The agent to add.
        """
        if agent.name in self._entries:
            logger.error(f"AgentRunner '{self}': agent '{agent.name}' already exists, skipping")
            return
        agent.set_registry(self._registry)
        agent.set_task_manager(self._task_manager)
        await self._registry.watch(agent.name, self._on_agent_ready)
        entry = AgentEntry(agent=agent)
        self._entries[agent.name] = entry
        logger.debug(f"AgentRunner '{self}': added agent '{agent.name}'")

        if self._running:
            await self._start_agent_task(entry)

    async def run(self) -> None:
        """Start all agents, block until shutdown.

        Starts all registered agents, fires ``on_ready``, then blocks
        until `end()` or `cancel()` is called. New agents can be added
        dynamically via `add_agent()` after ``run()`` has started.
        """
        self._running = True
        self._shutdown_event.clear()

        self._task_manager.setup(TaskManagerParams(loop=asyncio.get_running_loop()))
        self._bus.set_task_manager(self._task_manager)

        await self._bus.subscribe(self)
        await self._bus.start()

        for entry in self._entries.values():
            await self._start_agent_task(entry)

        await self._call_event_handler("on_ready")

        await self._shutdown_event.wait()

        # Wait for remaining agent tasks to finish cleanup
        remaining = [e.task for e in self._entries.values() if e.task and not e.task.done()]
        if remaining:
            await asyncio.gather(*remaining, return_exceptions=True)

        await self._bus.stop()
        self._running = False

    async def end(self, reason: Optional[str] = None) -> None:
        """Gracefully end all agents and shut down.

        Ends root agents first; parent agents propagate shutdown to
        their children automatically. Idempotent; subsequent calls
        are ignored.

        Args:
            reason: Optional human-readable reason for ending.
        """
        if self._shutdown_event.is_set():
            return
        logger.debug(f"AgentRunner '{self}': ending gracefully (reason={reason})")
        self._shutdown_event.set()
        for name, entry in self._entries.items():
            if entry.agent.parent is None:
                await self._bus.send(
                    BusEndAgentMessage(source=self.name, target=name, reason=reason)
                )

    async def cancel(self, reason: Optional[str] = None) -> None:
        """Immediately cancel all agents and shut down.

        Cancels root agents first; parent agents propagate cancellation
        to their children automatically. Idempotent; subsequent calls
        are ignored.

        Args:
            reason: Optional human-readable reason for cancelling.
        """
        if self._shutdown_event.is_set():
            return
        logger.debug(f"AgentRunner '{self}': cancelling (reason={reason})")
        self._shutdown_event.set()
        for name, entry in self._entries.items():
            if entry.agent.parent is None:
                await self._bus.send(
                    BusCancelAgentMessage(source=self.name, target=name, reason=reason)
                )
        await self._pipecat_runner.cancel()

    async def _start_agent_task(self, entry: AgentEntry) -> None:
        """Create an agent's pipeline task and start it as a background asyncio task."""
        agent = entry.agent
        logger.debug(f"AgentRunner '{self}': starting agent '{agent.name}'")
        try:
            pipeline_task = await agent.create_pipeline_task()
        except Exception as e:
            error = f"Failed to create pipeline task for agent '{agent.name}': {e}"
            logger.exception(f"AgentRunner '{self}': {error}")
            await self._call_event_handler("on_error", error)
            return

        entry.task = self.create_asyncio_task(
            self._pipecat_runner.run(pipeline_task),
            f"agent_{agent.name}",
        )

        # Add the task to event loop right away without needing to `await`.
        await asyncio.sleep(0)

    async def _on_agent_ready(self, agent_data: AgentReadyData) -> None:
        """Called when a local agent registers as ready.

        For root agents, broadcasts ``on_agent_ready`` to all local
        agents and sends an updated registry to remote runners.
        Child readiness is handled by the parent directly (via its
        own watch).
        """
        if agent_data.runner != self.name:
            return

        entry = self._entries.get(agent_data.agent_name)
        if not entry or entry.agent.parent is not None:
            # Child agent: parent handles it via its own watch
            return

        # Root agent: broadcast to other local root agents
        for other in self._entries.values():
            if other.agent.name != agent_data.agent_name and other.agent.parent is None:
                await other.agent._on_watched_agent_ready(agent_data)

        await self._send_registry()

    async def _send_registry(self) -> None:
        """Broadcast this runner's root agents to the bus."""
        agents = [name for name, entry in self._entries.items() if entry.agent.parent is None]
        if agents:
            logger.debug(f"AgentRunner '{self}': broadcasting registry: {agents}")
            await self._bus.send(
                BusAgentRegistryMessage(
                    source=self.name,
                    runner=self.name,
                    agents=agents,
                )
            )

    async def _handle_agent_registry(self, message: BusAgentRegistryMessage) -> None:
        """Handle a registry from a remote runner.

        Merges remote agents into the shared registry and, if this runner
        hasn't seen this remote runner before, sends its own registry back
        so both sides discover each other.
        """
        logger.debug(
            f"AgentRunner '{self}': received registry from '{message.runner}' with agents: {message.agents}"
        )
        for agent_name in message.agents:
            await self._registry.register(
                AgentReadyData(agent_name=agent_name, runner=message.runner)
            )
        if message.runner not in self._known_runners:
            self._known_runners.add(message.runner)
            logger.debug(
                f"AgentRunner '{self}': new runner '{message.runner}', sending our registry back"
            )
            await self._send_registry()
