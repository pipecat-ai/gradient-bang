"""Redis pub/sub agent bus for distributed agents."""

import asyncio
from dataclasses import dataclass, field
from typing import Optional

from loguru import logger

try:
    from redis.asyncio import Redis
    from redis.asyncio.client import PubSub
except ModuleNotFoundError as e:
    logger.error(f"Exception: {e}")
    logger.error("In order to use RedisBus, you need to `pip install pipecat-ai-subagents[redis]`.")
    raise Exception(f"Missing module: {e}")

from gradientbang.subagents.bus.bus import AgentBus
from gradientbang.subagents.bus.messages import BusLocalMixin, BusMessage
from gradientbang.subagents.bus.serializers import JSONMessageSerializer
from gradientbang.subagents.bus.serializers.base import MessageSerializer


@dataclass
class RedisConnection:
    """Per-subscriber connection state for `RedisBus`.

    Parameters:
        pubsub: The Redis pub/sub subscription handle.
        queue: Queue fed by both the Redis reader task and local delivery.
        task: Background task reading from Redis pub/sub into the queue.
    """

    pubsub: PubSub
    queue: asyncio.Queue[BusMessage] = field(repr=False)
    task: asyncio.Task = field(repr=False)


class RedisBus(AgentBus):
    """Distributed agent bus backed by Redis pub/sub.

    Publishes serialized messages to a Redis channel for cross-process
    communication. `BusLocalMixin` messages bypass Redis and are delivered
    directly to local subscribers since they carry in-memory references.

    Requires the ``redis[hiredis]`` package (``redis.asyncio``).

    Example::

        from redis.asyncio import Redis

        redis = Redis.from_url("redis://localhost:6379")
        bus = RedisBus(redis=redis, channel="my-session")
    """

    def __init__(
        self,
        *,
        redis: Redis,
        serializer: Optional[MessageSerializer] = None,
        channel: str = "pipecat:bus",
        **kwargs,
    ):
        """Initialize the RedisBus.

        Args:
            redis: A ``redis.asyncio.Redis`` client instance.
            serializer: The `MessageSerializer` for encoding/decoding messages.
                Defaults to `JSONMessageSerializer`.
            channel: The Redis pub/sub channel name. Defaults to ``"pipecat:bus"``.
            **kwargs: Additional arguments passed to `AgentBus`.
        """
        super().__init__(**kwargs)
        self._redis = redis
        self._serializer = serializer or JSONMessageSerializer()
        self._channel = channel
        self._connections: list[RedisConnection] = []

    async def cleanup(self):
        """Cancel all reader tasks and close connections."""
        for conn in list(self._connections):
            await self.disconnect(conn)
        await super().cleanup()

    async def connect(self) -> RedisConnection:
        """Create a Redis pub/sub subscription for a subscriber.

        Returns:
            A `RedisConnection` for receiving messages.
        """
        pubsub = self._redis.pubsub()
        await pubsub.subscribe(self._channel)

        queue: asyncio.Queue[BusMessage] = asyncio.Queue()
        task = self.create_asyncio_task(self._reader_task(pubsub, queue), f"{self}::redis_reader")

        conn = RedisConnection(pubsub=pubsub, queue=queue, task=task)
        self._connections.append(conn)

        # Schedule task right away.
        await asyncio.sleep(0)

        return conn

    async def disconnect(self, client: RedisConnection) -> None:
        """Unsubscribe and clean up a Redis pub/sub connection.

        Args:
            client: The `RedisConnection` returned by `connect()`.
        """
        await self.cancel_asyncio_task(client.task)
        await client.pubsub.unsubscribe(self._channel)
        await client.pubsub.close()
        self._connections.remove(client)

    async def send(self, message: BusMessage) -> None:
        """Send a message to all subscribers.

        ``BusLocalMixin`` messages are delivered directly to local
        subscriber queues. All other messages are published to Redis.

        Args:
            message: The bus message to send.
        """
        if isinstance(message, BusLocalMixin):
            logger.trace(f"{self}: sending local {message}")
            for conn in self._connections:
                conn.queue.put_nowait(message)
            return
        logger.trace(f"{self}: publishing {message} to {self._channel}")
        data = self._serializer.serialize(message)
        await self._redis.publish(self._channel, data)

    async def receive(self, client: RedisConnection) -> BusMessage:
        """Wait for and return the next message from the subscriber's queue.

        Args:
            client: The `RedisConnection` returned by `connect()`.

        Returns:
            The next `BusMessage` available on this connection.
        """
        message = await client.queue.get()
        logger.trace(f"{self}: received {message}")
        return message

    async def _reader_task(self, pubsub: PubSub, queue: asyncio.Queue[BusMessage]) -> None:
        """Read messages from Redis pub/sub and enqueue them."""
        async for raw_message in pubsub.listen():
            if raw_message["type"] != "message":
                continue
            try:
                message = self._serializer.deserialize(raw_message["data"])
                queue.put_nowait(message)
            except Exception:
                logger.exception(f"{self}: failed to deserialize message")
