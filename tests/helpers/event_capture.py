"""
Event capture infrastructure for integration tests.

This module provides utilities for capturing and validating game events during
tests. Events are the real API - API responses are simple (ok/error), but events
contain all the actual game state changes and data.
"""

import asyncio
import json
from typing import List, Dict, Any, Optional
import websockets
from contextlib import asynccontextmanager


class EventListener:
    """
    Captures events from firehose or character-specific streams.

    This class connects to a WebSocket event stream and captures events
    for validation in tests.
    """

    def __init__(self, server_url: str, character_id: Optional[str] = None):
        """
        Initialize the event listener.

        Args:
            server_url: Base URL of the server (e.g., "http://localhost:8002")
            character_id: Optional character ID for filtered events (not implemented yet)
        """
        self.server_url = server_url
        self.character_id = character_id
        self.events: List[Dict[str, Any]] = []
        self.websocket: Optional[websockets.WebSocketClientProtocol] = None
        self._listen_task: Optional[asyncio.Task] = None
        self._connected = False

    async def __aenter__(self):
        """Connect to event stream."""
        await self.connect()
        return self

    async def __aexit__(self, *args):
        """Disconnect and cleanup."""
        await self.disconnect()

    async def connect(self):
        """Connect to the WebSocket event stream."""
        ws_url = self.server_url.replace("http://", "ws://").replace("https://", "wss://")
        ws_url = ws_url.rstrip("/") + "/ws"

        self.websocket = await websockets.connect(ws_url)
        self._connected = True

        # If we have a character_id, identify to receive character-specific events
        if self.character_id:
            import json
            identify_msg = {
                "type": "identify",
                "character_id": self.character_id,
                "id": "identify-1"
            }
            await self.websocket.send(json.dumps(identify_msg))

        # Start listening in background
        self._listen_task = asyncio.create_task(self._listen())

    async def disconnect(self):
        """Disconnect from the WebSocket."""
        self._connected = False

        if self._listen_task:
            self._listen_task.cancel()
            try:
                await self._listen_task
            except asyncio.CancelledError:
                pass

        if self.websocket:
            await self.websocket.close()

    async def _listen(self):
        """Background task to listen for events."""
        try:
            while self._connected and self.websocket:
                try:
                    message = await self.websocket.recv()
                    frame = json.loads(message)

                    # Only capture event frames (not RPC responses)
                    if frame.get("frame_type") == "event":
                        # Normalize: add 'type' field from 'event' field for compatibility
                        event = {
                            **frame,
                            "type": frame.get("event"),  # Map 'event' to 'type'
                        }
                        self.events.append(event)

                except websockets.ConnectionClosed:
                    self._connected = False
                    break
                except json.JSONDecodeError:
                    # Skip invalid JSON
                    pass

        except asyncio.CancelledError:
            # Task was cancelled, clean exit
            pass

    async def wait_for_event(self, event_type: str, timeout: float = 10.0) -> Dict[str, Any]:
        """
        Wait for a specific event type to be received.

        Args:
            event_type: The event type to wait for (e.g., "character.joined")
            timeout: Maximum time to wait in seconds (default: 10.0)

        Returns:
            The event dictionary

        Raises:
            asyncio.TimeoutError: If event not received within timeout
        """
        start_time = asyncio.get_event_loop().time()

        while True:
            # Check if we've exceeded timeout
            if asyncio.get_event_loop().time() - start_time > timeout:
                raise asyncio.TimeoutError(
                    f"Event '{event_type}' not received within {timeout} seconds. "
                    f"Received events: {[e.get('type') for e in self.events]}"
                )

            # Check if event is in our list
            for event in self.events:
                if event.get("type") == event_type:
                    return event

            # Wait a bit before checking again
            await asyncio.sleep(0.1)

    async def wait_for_events(
        self, expected_types: List[str], timeout: float = 10.0
    ) -> List[Dict[str, Any]]:
        """
        Wait for a sequence of events in order.

        Args:
            expected_types: List of event types to wait for in order
            timeout: Maximum time to wait for all events (default: 10.0)

        Returns:
            List of event dictionaries in the order they were received

        Raises:
            asyncio.TimeoutError: If not all events received within timeout
        """
        results = []
        start_time = asyncio.get_event_loop().time()

        for event_type in expected_types:
            # Calculate remaining timeout
            elapsed = asyncio.get_event_loop().time() - start_time
            remaining_timeout = timeout - elapsed

            if remaining_timeout <= 0:
                raise asyncio.TimeoutError(
                    f"Events {expected_types} not all received within {timeout} seconds. "
                    f"Got {len(results)}/{len(expected_types)}: {[e.get('type') for e in results]}"
                )

            event = await self.wait_for_event(event_type, timeout=remaining_timeout)
            results.append(event)

        return results

    async def get_all_events(self, timeout: float = 2.0) -> List[Dict[str, Any]]:
        """
        Collect all events received so far.

        Waits for the specified timeout to allow any in-flight events to arrive,
        then returns all collected events.

        Args:
            timeout: Time to wait for final events (default: 2.0)

        Returns:
            List of all event dictionaries collected
        """
        # Wait for any remaining events
        await asyncio.sleep(timeout)
        return self.events.copy()

    def filter_events(self, event_type: str) -> List[Dict[str, Any]]:
        """
        Filter collected events by type.

        Args:
            event_type: The event type to filter for

        Returns:
            List of events matching the specified type
        """
        return [event for event in self.events if event.get("type") == event_type]

    def clear_events(self):
        """Clear all collected events."""
        self.events.clear()


@asynccontextmanager
async def create_event_listener(
    server_url: str, character_id: Optional[str] = None
):
    """
    Factory for creating character-specific event listeners.

    Args:
        server_url: Base URL of the server
        character_id: Optional character ID for filtering (not implemented yet)

    Yields:
        EventListener instance
    """
    listener = EventListener(server_url, character_id)
    async with listener:
        yield listener


@asynccontextmanager
async def create_firehose_listener(server_url: str, character_id: Optional[str] = None):
    """
    Factory for creating firehose (all events) listeners.

    Args:
        server_url: Base URL of the server
        character_id: Optional character ID to filter events for

    Yields:
        EventListener instance configured for firehose
    """
    listener = EventListener(server_url, character_id=character_id)
    async with listener:
        yield listener


async def capture_events_during(async_fn, server_url: str) -> List[Dict[str, Any]]:
    """
    Context manager to capture events during an async operation.

    Args:
        async_fn: Async function to execute while capturing events
        server_url: Base URL of the server

    Returns:
        List of events captured during the operation
    """
    async with create_firehose_listener(server_url) as listener:
        # Wait a moment for listener to connect
        await asyncio.sleep(0.5)

        # Execute the function
        await async_fn()

        # Wait for final events
        await asyncio.sleep(1.0)

        return listener.events.copy()
