"""WebSocket connection management for Gradient Bang server."""

import asyncio
import logging
import uuid

from fastapi import HTTPException, WebSocket

from gradientbang.game_server.rpc.events import EventSink
from gradientbang.game_server.api.utils import build_status_payload

logger = logging.getLogger("gradient-bang.server.connection")


class Connection(EventSink):
    """Represents a connected WebSocket client for a single character.

    Design: One WebSocket connection = One character
    The character is set once (on first join/identify) and cannot change.
    """

    def __init__(self, websocket: WebSocket) -> None:
        """Initialize a new WebSocket connection.

        Args:
            websocket: The FastAPI WebSocket instance
        """
        self.websocket = websocket
        self.connection_id = str(uuid.uuid4())
        self.character_id: str | None = None
        self._send_lock = asyncio.Lock()

    async def send_event(self, envelope: dict) -> None:
        """Send an event envelope to the WebSocket client.

        Args:
            envelope: The event envelope to send

        Note:
            This method is thread-safe via _send_lock.
        """
        logger.debug(
            "Connection %s sending event %s", self.connection_id, envelope.get("event")
        )
        async with self._send_lock:
            await self.websocket.send_json(envelope)
        logger.debug(
            "Connection %s sent event %s", self.connection_id, envelope.get("event")
        )

    def match_character(self, character_id: str) -> bool:
        """Check if this connection is for the given character.

        Args:
            character_id: Character ID to check

        Returns:
            True if this connection's character matches
        """
        return self.character_id == character_id

    def set_character(self, character_id: str) -> None:
        """Set the character for this connection.

        Args:
            character_id: Character ID to associate with this connection

        Raises:
            ValueError: If character is already set to a different ID

        Note:
            Character can only be set once per connection lifetime.
        """
        if self.character_id is not None and self.character_id != character_id:
            raise ValueError(
                f"Connection already associated with character '{self.character_id}', "
                f"cannot change to '{character_id}'"
            )
        self.character_id = str(character_id)


async def send_initial_status(
    connection: Connection,
    character_id: str,
    world,
) -> None:
    """Send initial status update to a newly connected client.

    Args:
        connection: The WebSocket connection
        character_id: The character ID to send status for
        world: The game world instance

    Raises:
        HTTPException: If character not found (404)
    """
    if character_id not in world.characters:
        raise HTTPException(
            status_code=404, detail=f"Character '{character_id}' not found"
        )
    payload = await build_status_payload(world, character_id)
    envelope = {
        "frame_type": "event",
        "event": "status.update",
        "payload": payload,
        "gg-action": "status.update",
        "character_filter": [character_id],
    }
    await connection.send_event(envelope)
