"""Abstract agent bus for inter-agent pub/sub messaging.

Provides the abstract `AgentBus` base class. Concrete implementations
(e.g. `AsyncQueueBus`) live in separate modules.
"""

import asyncio
from abc import abstractmethod
from dataclasses import dataclass, field
from typing import Any, Coroutine, Optional

from pipecat.utils.asyncio.task_manager import TaskManager
from pipecat.utils.base_object import BaseObject

from gradientbang.subagents.bus.messages import BusMessage
from gradientbang.subagents.bus.subscriber import BusSubscriber


@dataclass
class BusSubscription:
    """A single subscriber's state on the bus.

    Parameters:
        subscriber: The subscriber receiving messages.
        client: The connection handle returned by `connect()`.
        task: The delivery task, set once the bus is started.
    """

    subscriber: BusSubscriber
    client: Any
    task: Optional[asyncio.Task] = field(default=None, repr=False)


class AgentBus(BaseObject):
    """Abstract base for inter-agent and runner-agent communication.

    Provides pub/sub messaging where each subscriber receives messages
    independently so that slow handlers never block other subscribers.

    Subclasses implement ``connect()``, ``disconnect()``, ``send()``,
    and ``receive()`` for the specific transport (in-process queues,
    Redis pub/sub, etc.).
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
        """Start delivery tasks for all registered subscribers."""
        if self._running:
            return
        self._running = True
        for sub in self._subscriptions:
            sub.task = self.create_asyncio_task(
                self._subscriber_task(sub), f"bus_subscriber_{sub.subscriber}"
            )
        # Schedule tasks right away.
        await asyncio.sleep(0)

    async def stop(self):
        """Stop all subscriber tasks and disconnect them."""
        if not self._running:
            return
        self._running = False
        for sub in self._subscriptions:
            if sub.task:
                await self.cancel_asyncio_task(sub.task)
                sub.task = None

    async def subscribe(self, subscriber: BusSubscriber) -> None:
        """Register a subscriber to receive messages from the bus.

        Args:
            subscriber: The `BusSubscriber` to register.
        """
        client = await self.connect()
        sub = BusSubscription(subscriber=subscriber, client=client)
        if self._running:
            sub.task = self.create_asyncio_task(
                self._subscriber_task(sub), f"bus_subscriber_{sub.subscriber}"
            )
            # Schedule task right away.
            await asyncio.sleep(0)
        self._subscriptions.append(sub)

    async def unsubscribe(self, subscriber: BusSubscriber) -> None:
        """Remove a subscriber, cancel its task, and disconnect.

        Args:
            subscriber: The `BusSubscriber` to remove.
        """
        for i, sub in enumerate(self._subscriptions):
            if sub.subscriber is subscriber:
                if sub.task:
                    await self.cancel_asyncio_task(sub.task)
                else:
                    await self.disconnect(sub.client)
                self._subscriptions.pop(i)
                return

    @abstractmethod
    async def connect(self) -> Any:
        """Create a new connection to the bus for reading messages.

        Returns:
            A client handle passed to `receive()` and `disconnect()`.
        """
        pass

    @abstractmethod
    async def disconnect(self, client: Any) -> None:
        """Clean up a connection created by `connect()`.

        Args:
            client: The client handle returned by `connect()`.
        """
        pass

    @abstractmethod
    async def send(self, message: BusMessage) -> None:
        """Send a message through the bus to all subscribers.

        Args:
            message: The bus message to send.
        """
        pass

    @abstractmethod
    async def receive(self, client: Any) -> BusMessage:
        """Wait for and return the next message from the bus.

        Args:
            client: The client handle returned by `connect()`.

        Returns:
            The next `BusMessage` available on this connection.
        """
        pass

    async def _subscriber_task(self, sub: BusSubscription):
        """Deliver messages from the bus to a subscriber."""
        try:
            while True:
                message = await self.receive(sub.client)
                await sub.subscriber.on_bus_message(message)
        except asyncio.CancelledError:
            pass
        finally:
            await self.disconnect(sub.client)
