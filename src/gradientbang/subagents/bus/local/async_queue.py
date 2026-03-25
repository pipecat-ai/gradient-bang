"""In-process agent bus backed by asyncio queues."""

import asyncio

from loguru import logger

from gradientbang.subagents.bus.bus import AgentBus
from gradientbang.subagents.bus.messages import BusMessage


class AsyncQueueBus(AgentBus):
    """In-process bus that delivers messages via per-subscriber `asyncio.Queue` instances."""

    def __init__(self, **kwargs):
        """Initialize the AsyncQueueBus.

        Args:
            **kwargs: Additional arguments passed to `AgentBus`.
        """
        super().__init__(**kwargs)
        self._queues: list[asyncio.Queue[BusMessage]] = []

    async def connect(self) -> asyncio.Queue[BusMessage]:
        """Create a per-subscriber queue.

        Returns:
            An `asyncio.Queue` that `receive()` reads from.
        """
        queue: asyncio.Queue[BusMessage] = asyncio.Queue()
        self._queues.append(queue)
        return queue

    async def disconnect(self, client: asyncio.Queue[BusMessage]) -> None:
        """Remove a subscriber's queue from the fan-out list.

        Args:
            client: The queue returned by `connect()`.
        """
        try:
            self._queues.remove(client)
        except ValueError:
            pass

    async def send(self, message: BusMessage) -> None:
        """Fan out a message to all subscriber queues.

        Args:
            message: The bus message to send.
        """
        logger.trace(f"{self}: sending {message}")
        for queue in self._queues:
            queue.put_nowait(message)

    async def receive(self, client: asyncio.Queue[BusMessage]) -> BusMessage:
        """Wait for and return the next message from a subscriber queue.

        Args:
            client: The queue returned by `connect()`.

        Returns:
            The next `BusMessage` in the queue.
        """
        message = await client.get()
        logger.trace(f"{self}: received {message}")
        return message
