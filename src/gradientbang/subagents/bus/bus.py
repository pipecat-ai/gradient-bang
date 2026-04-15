"""Abstract agent bus for inter-agent pub/sub messaging.

Provides the abstract `AgentBus` base class. Concrete implementations
(e.g. `AsyncQueueBus`) live in separate modules.
"""

import asyncio
from abc import abstractmethod
from dataclasses import dataclass, field
from typing import Coroutine, Optional

from pipecat.frames.frames import SystemFrame
from pipecat.utils.asyncio.task_manager import TaskManager
from pipecat.utils.base_object import BaseObject

from gradientbang.subagents.bus.messages import BusLocalMessage, BusMessage
from gradientbang.subagents.bus.queue import BusMessageQueue
from gradientbang.subagents.bus.subscriber import BusSubscriber


@dataclass
class BusSubscription:
    """A single subscriber's state on the bus.

    Parameters:
        subscriber: The subscriber receiving messages.
        queue: Priority queue for incoming messages.
        data_queue: Secondary queue for data messages dispatched by
            the router task.
        router_task: Task that reads from the priority queue, handles
            system messages inline, and routes data messages to the
            data queue.
        data_task: Task that processes data messages sequentially from
            the data queue.
    """

    subscriber: BusSubscriber
    queue: BusMessageQueue = field(default_factory=BusMessageQueue, repr=False)
    data_queue: asyncio.Queue = field(default_factory=asyncio.Queue, repr=False)
    router_task: Optional[asyncio.Task] = field(default=None, repr=False)
    data_task: Optional[asyncio.Task] = field(default=None, repr=False)


class AgentBus(BaseObject):
    """Abstract base for inter-agent and runner-agent communication.

    Provides pub/sub messaging where each subscriber receives messages
    independently through its own priority queue. System messages
    (e.g. cancel) are delivered before normal data messages.

    Subclasses implement ``publish()`` for the specific transport.
    ``send()`` handles local-only messages automatically. For network
    buses, override ``start()``/``stop()`` to manage connections and
    call ``on_message_received()`` when messages arrive from the
    network.
    """

    def __init__(self, **kwargs):
        """Initialize the AgentBus.

        Args:
            **kwargs: Additional arguments passed to `BaseObject`.
        """
        super().__init__(**kwargs)
        self._subscriptions: list[BusSubscription] = []
        self._running = False
        self._task_manager: Optional[TaskManager] = None

    @property
    def task_manager(self) -> Optional[TaskManager]:
        """The shared task manager for asyncio task creation."""
        return self._task_manager

    def set_task_manager(self, task_manager: TaskManager) -> None:
        """Set the shared task manager for asyncio task creation.

        Args:
            task_manager: The shared task manager instance.
        """
        self._task_manager = task_manager

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

    async def start(self):
        """Start dispatch tasks for all registered subscribers."""
        if self._running:
            return
        self._running = True
        for sub in self._subscriptions:
            self._start_dispatch_task(sub)
        # Schedule tasks right away.
        await asyncio.sleep(0)

    async def stop(self):
        """Stop all dispatch tasks."""
        if not self._running:
            return
        self._running = False
        for sub in self._subscriptions:
            if sub.router_task:
                await self.cancel_asyncio_task(sub.router_task)
                sub.router_task = None
            if sub.data_task:
                await self.cancel_asyncio_task(sub.data_task)
                sub.data_task = None

    async def subscribe(self, subscriber: BusSubscriber) -> None:
        """Register a subscriber to receive messages from the bus.

        Args:
            subscriber: The `BusSubscriber` to register.
        """
        sub = BusSubscription(subscriber=subscriber)
        if self._running:
            self._start_dispatch_task(sub)
            # Schedule task right away.
            await asyncio.sleep(0)
        self._subscriptions.append(sub)

    async def unsubscribe(self, subscriber: BusSubscriber) -> None:
        """Remove a subscriber and cancel its dispatch tasks.

        Args:
            subscriber: The `BusSubscriber` to remove.
        """
        for i, sub in enumerate(self._subscriptions):
            if sub.subscriber is subscriber:
                if sub.router_task:
                    await self.cancel_asyncio_task(sub.router_task)
                if sub.data_task:
                    await self.cancel_asyncio_task(sub.data_task)
                self._subscriptions.pop(i)
                return

    async def send(self, message: BusMessage) -> None:
        """Send a message through the bus.

        Local-only messages are delivered directly to subscribers.
        All other messages are passed to ``publish()`` for transport.

        Args:
            message: The bus message to send.
        """
        if isinstance(message, BusLocalMessage):
            self.on_message_received(message)
            return
        await self.publish(message)

    @abstractmethod
    async def publish(self, message: BusMessage) -> None:
        """Publish a message to the transport.

        Subclasses implement this for the specific transport. Called
        by ``send()`` after filtering local-only messages.

        Args:
            message: The bus message to publish.
        """
        pass

    def on_message_received(self, message: BusMessage) -> None:
        """Deliver a message to all local subscribers via their priority queues.

        Called by bus implementations when a message arrives (either from
        a local ``send()`` or from a network transport).
        """
        for sub in self._subscriptions:
            sub.queue.put_nowait(message)

    def _start_dispatch_task(self, sub: BusSubscription) -> None:
        sub.router_task = self.create_asyncio_task(
            self._router_task(sub), f"bus_router_{sub.subscriber}"
        )
        sub.data_task = self.create_asyncio_task(
            self._data_dispatch_task(sub), f"bus_data_{sub.subscriber}"
        )

    async def _router_task(self, sub: BusSubscription):
        """Read from the priority queue, handle system messages inline,
        and route data messages to the data queue."""
        try:
            while True:
                message = await sub.queue.get()
                if isinstance(message, SystemFrame):
                    await sub.subscriber.on_bus_message(message)
                else:
                    sub.data_queue.put_nowait(message)
        except asyncio.CancelledError:
            pass

    async def _data_dispatch_task(self, sub: BusSubscription):
        """Process data messages sequentially from the data queue."""
        try:
            while True:
                message = await sub.data_queue.get()
                await sub.subscriber.on_bus_message(message)
        except asyncio.CancelledError:
            pass
