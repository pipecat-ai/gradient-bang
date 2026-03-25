"""WebSocket client proxy that forwards bus messages to a remote server."""

import asyncio
from typing import Optional

from loguru import logger

try:
    import websockets
    from websockets.asyncio.client import connect
except ModuleNotFoundError as e:
    logger.error(f"Exception: {e}")
    logger.error(
        "In order to use WebSocketProxyClientAgent, you need to `pip install pipecat-ai-subagents[websocket]`."
    )
    raise Exception(f"Missing module: {e}")

from gradientbang.subagents.agents.base_agent import BaseAgent
from gradientbang.subagents.bus import AgentBus, BusAgentRegistryMessage, BusMessage
from gradientbang.subagents.bus.messages import BusLocalMixin
from gradientbang.subagents.bus.serializers import JSONMessageSerializer
from gradientbang.subagents.bus.serializers.base import MessageSerializer


class WebSocketProxyClientAgent(BaseAgent):
    """Forwards bus messages to a remote agent over WebSocket.

    Connects to a WebSocket URL and forwards messages between a local
    agent and a remote agent. Only messages targeted at the remote agent
    are sent. Only messages targeted at the local agent are accepted.

    Event handlers available:

    - on_connected: Fired when the WebSocket connection is established.
    - on_disconnected: Fired when the WebSocket connection is closed.

    Example::

        proxy = WebSocketProxyClientAgent(
            "proxy",
            bus=runner.bus,
            url="ws://remote-server:8765/ws",
            remote_agent_name="worker",
            local_agent_name="voice",
        )

        @proxy.event_handler("on_connected")
        async def on_connected(agent, websocket):
            logger.info("Connected to remote server")

        @proxy.event_handler("on_disconnected")
        async def on_disconnected(agent, websocket):
            logger.info("Disconnected from remote server")

        await runner.add_agent(proxy)
    """

    def __init__(
        self,
        name: str,
        *,
        bus: AgentBus,
        url: str,
        remote_agent_name: str,
        local_agent_name: str,
        forward_messages: tuple[type[BusMessage], ...] = (),
        headers: Optional[dict[str, str]] = None,
        serializer: Optional[MessageSerializer] = None,
    ):
        """Initialize the WebSocketProxyClientAgent.

        Args:
            name: Unique name for this agent.
            bus: The `AgentBus` for inter-agent communication.
            url: The WebSocket URL to connect to.
            remote_agent_name: Name of the agent on the remote server.
                Only messages targeted at this agent are forwarded.
            local_agent_name: Name of the local agent that should
                receive responses. Only inbound messages targeted at
                this agent are accepted.
            forward_messages: Additional message types to forward from
                the local agent (e.g. ``(BusFrameMessage,)`` for frame
                routing). These are forwarded based on source agent name
                only, regardless of target.
            headers: Optional HTTP headers sent with the WebSocket
                handshake (e.g. for authentication).
            serializer: Serializer for bus messages. Defaults to
                `JSONMessageSerializer`.
        """
        super().__init__(name, bus=bus)
        self._url = url
        self._remote_agent_name = remote_agent_name
        self._local_agent_name = local_agent_name
        self._forward_messages = forward_messages
        self._headers = headers or {}
        self._serializer = serializer or JSONMessageSerializer()
        self._ws = None
        self._receive_task: Optional[asyncio.Task] = None

        self._register_event_handler("on_connected")
        self._register_event_handler("on_disconnected")

    async def cleanup(self):
        """Cancel the receive loop task and release resources."""
        await super().cleanup()
        if self._receive_task:
            await self.cancel_asyncio_task(self._receive_task)
            self._receive_task = None

    async def on_activated(self, args: Optional[dict]) -> None:
        """Connect to the remote WebSocket server."""
        await super().on_activated(args)

        logger.debug(f"Agent '{self}': connecting to {self._url}")

        self._ws = await connect(self._url, additional_headers=self._headers)

        logger.debug(f"Agent '{self}': connected to {self._url}")

        await self._call_event_handler("on_connected", self._ws)

        self._receive_task = self.create_asyncio_task(
            self._receive_loop(), f"{self.name}::ws_receive"
        )

        # Schedule task right away.
        await asyncio.sleep(0)

    async def on_bus_message(self, message: BusMessage) -> None:
        """Forward messages targeted at the remote agent.

        Args:
            message: The bus message to process.
        """
        await super().on_bus_message(message)

        if not self._ws:
            return

        if isinstance(message, BusLocalMixin):
            return

        # Forward targeted messages to the remote agent
        if message.target == self._remote_agent_name:
            await self._send_ws(message)
        # Forward additional message types from the local agent
        elif isinstance(message, self._forward_messages):
            if message.source == self._local_agent_name:
                await self._send_ws(message)

    async def _stop(self) -> None:
        """Close the WebSocket connection and stop."""
        if self._ws:
            await self._ws.close()
            logger.debug(f"Agent '{self}': WebSocket connection closed")
        await super()._stop()

    async def _send_ws(self, message: BusMessage) -> None:
        """Serialize and send a message over the WebSocket."""
        if not self._ws:
            return
        try:
            data = self._serializer.serialize(message)
            await self._ws.send(data)
            logger.trace(f"Agent '{self}': sent {message}")
        except websockets.exceptions.ConnectionClosed:
            logger.warning(f"Agent '{self}': connection closed, stopping forwarding")
            ws = self._ws
            self._ws = None
            await self._call_event_handler("on_disconnected", ws)

    async def _receive_loop(self) -> None:
        """Read messages from the WebSocket and put them on the local bus."""
        try:
            async for data in self._ws:
                try:
                    message = self._serializer.deserialize(data)
                    if not message:
                        continue

                    # Accept registry messages (target=None) for agent discovery
                    if isinstance(message, BusAgentRegistryMessage):
                        logger.trace(
                            f"Agent '{self}': received registry from remote: {message.agents}"
                        )
                        await self.send_message(message)
                        continue

                    # Accept additional message types (e.g. BusFrameMessage)
                    if self._forward_messages and isinstance(message, self._forward_messages):
                        logger.trace(f"Agent '{self}': received {message} from remote")
                        await self.send_message(message)
                        continue

                    # Only accept other messages targeted at the local agent
                    if message.target != self._local_agent_name:
                        logger.warning(
                            f"Agent '{self}': dropped inbound message with "
                            f"unexpected target '{message.target}'"
                        )
                        continue

                    logger.trace(f"Agent '{self}': received {message} from remote")
                    await self.send_message(message)
                except Exception:
                    logger.exception(f"Agent '{self}': failed to deserialize remote message")
        except websockets.exceptions.ConnectionClosed:
            logger.warning(f"Agent '{self}': WebSocket connection closed")
            ws = self._ws
            self._ws = None
            await self._call_event_handler("on_disconnected", ws)
