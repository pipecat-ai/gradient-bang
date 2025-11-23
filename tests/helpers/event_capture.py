"""Event capture helpers for integration and diagnostics tests."""

import asyncio
import json
import os
from contextlib import asynccontextmanager, suppress
from typing import Any, Dict, List, Optional

import httpx
import websockets

from gradientbang.utils.legacy_ids import canonicalize_character_id


_TRUTHY = {"1", "true", "on", "yes"}


def _env_truthy(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in _TRUTHY


USE_SUPABASE_TESTS = _env_truthy("USE_SUPABASE_TESTS")


class EventListener:
    """Capture events from either the FastAPI firehose or Supabase HTTP polling."""

    def __init__(self, server_url: str, character_id: Optional[str] = None):
        self.server_url = server_url.rstrip("/") if server_url else server_url
        self.character_id = character_id
        self.events: List[Dict[str, Any]] = []
        self.websocket: Optional[websockets.WebSocketClientProtocol] = None
        self._listen_task: Optional[asyncio.Task] = None
        self._connected = False
        self._supabase_mode = USE_SUPABASE_TESTS
        self._poll_task: Optional[asyncio.Task] = None
        self._poll_stop_event: Optional[asyncio.Event] = None
        self._http_client: Optional[httpx.AsyncClient] = None
        self._last_event_id: Optional[int] = None
        self._functions_url: Optional[str] = None
        self._poll_interval = max(0.25, float(os.environ.get("SUPABASE_POLL_INTERVAL_SECONDS", "1.0")))
        self._poll_limit = max(1, min(250, int(os.environ.get("SUPABASE_POLL_LIMIT", "100"))))
        self._canonical_character_id: Optional[str] = None
        self._edge_api_token: Optional[str] = (
            os.environ.get("EDGE_API_TOKEN")
            or os.environ.get("SUPABASE_API_TOKEN")
            or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        )
        self._anon_key = os.environ.get("SUPABASE_ANON_KEY", "anon-key")
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
        """Connect to the websocket or Supabase HTTP polling."""
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
        if not self.character_id:
            raise ValueError(
                "Supabase event capture requires character_id. Pass one to create_firehose_listener()."
            )
        if not self._edge_api_token:
            raise RuntimeError("EDGE_API_TOKEN (or SUPABASE_API_TOKEN) is required for Supabase event capture")

        supabase_url = self.server_url or os.environ.get("SUPABASE_URL", "http://127.0.0.1:54321")
        functions_base = os.environ.get("EDGE_FUNCTIONS_URL")
        if not functions_base:
            functions_base = f"{supabase_url.rstrip('/')}/functions/v1"
        self._functions_url = functions_base.rstrip("/")
        self._http_client = httpx.AsyncClient(timeout=10.0)
        await self._initialize_polling_cursor()
        self._poll_stop_event = asyncio.Event()
        self._poll_task = asyncio.create_task(self._poll_supabase_events())
        self._connected = True

    async def _disconnect_supabase(self) -> None:
        if self._poll_stop_event is not None:
            self._poll_stop_event.set()
        if self._poll_task is not None:
            self._poll_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._poll_task
            self._poll_task = None
        if self._http_client is not None:
            await self._http_client.aclose()
            self._http_client = None
        self._poll_stop_event = None
        self._last_event_id = None

    async def _initialize_polling_cursor(self) -> None:
        result = await self._call_events_since({
            "character_id": self._canonical_character_id,
            "initial_only": True,
        })
        last_id = result.get("last_event_id")
        if isinstance(last_id, int):
            self._last_event_id = last_id
        else:
            self._last_event_id = 0

    async def _poll_supabase_events(self) -> None:
        interval = max(0.25, float(self._poll_interval))
        while self._poll_stop_event and not self._poll_stop_event.is_set():
            try:
                await self._poll_once()
            except asyncio.CancelledError:
                break
            except Exception:  # noqa: BLE001
                # Polling errors shouldn't crash tests; log and retry.
                print("[event_capture] Supabase poll failed", flush=True)
            try:
                await asyncio.wait_for(self._poll_stop_event.wait(), timeout=interval)
                break
            except asyncio.TimeoutError:
                continue

    async def _poll_once(self) -> None:
        if self._last_event_id is None:
            return
        payload = {
            "character_id": self._canonical_character_id,
            "since_event_id": self._last_event_id,
            "limit": max(1, self._poll_limit),
        }
        result = await self._call_events_since(payload)
        events = result.get("events")
        if isinstance(events, list):
            for row in events:
                event = self._normalize_polled_event(row)
                if event:
                    self._append_event_sorted(event)
        last_id = result.get("last_event_id")
        if isinstance(last_id, int):
            self._last_event_id = last_id
        elif isinstance(events, list) and events:
            maybe = events[-1]
            if isinstance(maybe, dict):
                candidate = maybe.get("id")
                if isinstance(candidate, int):
                    self._last_event_id = candidate

    async def _call_events_since(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self._http_client or not self._functions_url:
            raise RuntimeError("Supabase HTTP client not initialized")
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._anon_key}",
            "apikey": self._anon_key,
        }
        if self._edge_api_token:
            headers["x-api-token"] = self._edge_api_token
        response = await self._http_client.post(
            f"{self._functions_url}/events_since",
            headers=headers,
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            raise RuntimeError("Invalid Supabase response")
        if data.get("success") is False:
            raise RuntimeError(data.get("error", "events_since failed"))
        return data

    def _normalize_polled_event(self, row: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(row, dict):
            return None
        event_type = row.get("event_type")
        if not isinstance(event_type, str):
            return None
        payload = row.get("payload")
        if not isinstance(payload, dict):
            payload = {"value": payload}
        event: Dict[str, Any] = {
            "type": event_type,
            "event": event_type,
            "payload": payload,
            "summary": row.get("meta", {}).get("summary") if isinstance(row.get("meta"), dict) else "",
        }
        event_id = row.get("id")
        if isinstance(event_id, int):
            event["__event_id"] = event_id
        return event

    def _append_event_sorted(self, event: Dict[str, Any]) -> None:
        event_id = event.get("__event_id")
        if not isinstance(event_id, int):
            self.events.append(event)
            return

        insert_idx = len(self.events)
        for idx, existing in enumerate(self.events):
            existing_id = existing.get("__event_id")
            if isinstance(existing_id, int) and event_id < existing_id:
                insert_idx = idx
                break

        self.events.insert(insert_idx, event)

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
        """Clear all collected events and update polling cursor to skip them."""
        if self._supabase_mode and self.events:
            # Update cursor to the latest event ID we've seen so we don't re-poll them
            max_id = max(
                (e.get("__event_id") for e in self.events if isinstance(e.get("__event_id"), int)),
                default=None
            )
            if max_id is not None and isinstance(max_id, int):
                self._last_event_id = max_id
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
            "USE_SUPABASE_TESTS=1 requires character_id for firehose listeners because Supabase changefeed auth is per character."
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
