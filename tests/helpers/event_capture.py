"""Event capture helpers for integration and diagnostics tests."""

import asyncio
import json
import os
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

import websockets

from utils.legacy_ids import canonicalize_character_id

try:
    from realtime import AsyncRealtimeClient, RealtimeSubscribeStates
except ImportError:  # pragma: no cover - realtime is available in test deps
    AsyncRealtimeClient = None  # type: ignore
    RealtimeSubscribeStates = None  # type: ignore


_TRUTHY = {"1", "true", "on", "yes"}


def _env_truthy(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in _TRUTHY


USE_SUPABASE_TESTS = _env_truthy("USE_SUPABASE_TESTS")


class EventListener:
    """Capture events from either the FastAPI firehose or Supabase Realtime."""

    def __init__(self, server_url: str, character_id: Optional[str] = None):
        self.server_url = server_url.rstrip("/") if server_url else server_url
        self.character_id = character_id
        self.events: List[Dict[str, Any]] = []
        self.websocket: Optional[websockets.WebSocketClientProtocol] = None
        self._listen_task: Optional[asyncio.Task] = None
        self._connected = False
        self._supabase_mode = USE_SUPABASE_TESTS
        self._rt_client: Optional[AsyncRealtimeClient] = None
        self._rt_channel = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._canonical_character_id: Optional[str] = None
        if self._supabase_mode:
            if not character_id:
                raise ValueError(
                    "Supabase event capture requires character_id when USE_SUPABASE_TESTS=1"
                )
            self._canonical_character_id = canonicalize_character_id(character_id)

    async def __aenter__(self):
        """Connect to event stream."""
        await self.connect()
        return self

    async def __aexit__(self, *args):
        """Disconnect and cleanup."""
        await self.disconnect()

    async def connect(self):
        """Connect to the websocket or Supabase broadcast channel."""
        if self._supabase_mode:
            await self._connect_supabase()
            return

        ws_url = self.server_url.replace("http://", "ws://").replace("https://", "wss://")
        ws_url = ws_url.rstrip("/") + "/ws"

        self.websocket = await websockets.connect(ws_url)
        self._connected = True

        if self.character_id:
            identify_msg = {
                "type": "identify",
                "character_id": self.character_id,
                "id": "identify-1",
            }
            await self.websocket.send(json.dumps(identify_msg))

        self._listen_task = asyncio.create_task(self._listen())

    async def disconnect(self):
        """Disconnect from the WebSocket."""
        self._connected = False

        if self._supabase_mode:
            await self._disconnect_supabase()
            return

        if self._listen_task:
            self._listen_task.cancel()
            try:
                await self._listen_task
            except asyncio.CancelledError:
                pass

        if self.websocket:
            await self.websocket.close()

    async def _listen(self):
        """Background task to listen for FastAPI websocket events."""
        if self._supabase_mode:
            return
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

    async def _connect_supabase(self) -> None:
        if AsyncRealtimeClient is None or RealtimeSubscribeStates is None:
            raise RuntimeError(
                "realtime library is unavailable; install dependencies or disable USE_SUPABASE_TESTS"
            )
        if not self.character_id:
            raise ValueError(
                "Supabase event capture requires character_id. Pass one to create_firehose_listener()."
            )

        supabase_url = self.server_url or os.environ.get("SUPABASE_URL", "http://127.0.0.1:54321")
        realtime_url = f"{supabase_url.rstrip('/')}/realtime/v1"
        anon_key = os.environ.get("SUPABASE_ANON_KEY", "anon-key")

        self._loop = asyncio.get_running_loop()
        self._rt_client = AsyncRealtimeClient(
            url=realtime_url,
            token=anon_key,
            auto_reconnect=True,
        )

        topic = f"public:character:{self._canonical_character_id}"
        params = {
            "config": {
                "broadcast": {"ack": False, "self": False},
                "presence": {"enabled": False, "key": ""},
                "private": False,
            }
        }

        channel = self._rt_client.channel(topic, params)
        channel.broadcast_callbacks.append(self._handle_supabase_broadcast)

        loop = asyncio.get_running_loop()
        subscribed = loop.create_future()

        def _callback(state, error):
            if subscribed.done():
                return
            if state == RealtimeSubscribeStates.SUBSCRIBED:
                subscribed.set_result(None)
            elif state in {
                RealtimeSubscribeStates.CHANNEL_ERROR,
                RealtimeSubscribeStates.TIMED_OUT,
                RealtimeSubscribeStates.CLOSED,
            }:
                subscribed.set_exception(
                    error
                    or RuntimeError(f"Supabase realtime subscribe failed: {getattr(state, 'value', state)}")
                )

        await channel.subscribe(callback=_callback)
        await asyncio.wait_for(subscribed, timeout=5.0)

        self._rt_channel = channel
        self._connected = True

    async def _disconnect_supabase(self) -> None:
        if self._rt_channel is not None:
            try:
                await self._rt_channel.unsubscribe()
            except Exception:  # noqa: BLE001
                pass
            self._rt_channel = None
        if self._rt_client is not None:
            try:
                await self._rt_client.close()
            except Exception:  # noqa: BLE001
                pass
            self._rt_client = None
        self._loop = None

    def _handle_supabase_broadcast(self, message: Dict[str, Any]) -> None:
        event_type = message.get("event")
        payload = message.get("payload") or {}
        if not event_type:
            return

        normalized_payload = payload.copy() if isinstance(payload, dict) else {"value": payload}
        event_id = normalized_payload.pop("__event_id", None)

        frame: Dict[str, Any] = {
            "type": event_type,
            "event": event_type,
            "frame_type": "event",
            "payload": normalized_payload,
            "event_id": event_id,
            "topic": message.get("topic"),
        }

        source = normalized_payload.get("source")
        if isinstance(source, dict) and "timestamp" in source:
            frame["timestamp"] = source["timestamp"]

        loop = self._loop
        if loop is not None:
            loop.call_soon_threadsafe(self.events.append, frame)
        else:  # pragma: no cover - only for shutdown edge cases
            self.events.append(frame)

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
    if USE_SUPABASE_TESTS and not character_id:
        raise RuntimeError(
            "USE_SUPABASE_TESTS=1 requires character_id for event listeners to subscribe to Supabase channels."
        )

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
    if USE_SUPABASE_TESTS and not character_id:
        raise RuntimeError(
            "USE_SUPABASE_TESTS=1 requires character_id for firehose listeners; Supabase has per-character channels."
        )

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
    if USE_SUPABASE_TESTS:
        raise RuntimeError(
            "capture_events_during is unsupported with USE_SUPABASE_TESTS=1. Use explicit create_firehose_listener with a character_id."
        )

    async with create_firehose_listener(server_url) as listener:
        # Wait a moment for listener to connect
        await asyncio.sleep(0.5)

        # Execute the function
        await async_fn()

        # Wait for final events
        await asyncio.sleep(1.0)

        return listener.events.copy()
