import json
from typing import List

import pytest
from fastapi import WebSocketDisconnect

from gradientbang.game_server.rpc.events import event_dispatcher
from server import RPC_HANDLERS, websocket_endpoint


class DummyWebSocket:
    """Minimal WebSocket stub for exercising websocket_endpoint."""

    def __init__(self, messages: List[str]) -> None:
        self._messages = list(messages)
        self.sent_frames: list = []
        self.accepted = False

    async def accept(self) -> None:
        self.accepted = True

    async def receive_text(self) -> str:
        if self._messages:
            return self._messages.pop(0)
        raise WebSocketDisconnect(code=1000)

    async def send_json(self, data) -> None:
        self.sent_frames.append(data)


@pytest.mark.asyncio
async def test_request_id_passed_through(monkeypatch):
    recorded_payload = {}

    async def handler(payload):
        recorded_payload.update(payload)
        return {"echo": payload["request_id"]}

    monkeypatch.setitem(RPC_HANDLERS, "mock.endpoint", handler)
    event_dispatcher._sinks.clear()

    request_id = "req-123"
    frame = json.dumps(
        {
            "id": request_id,
            "type": "rpc",
            "endpoint": "mock.endpoint",
            "payload": {"value": 42},
        }
    )
    ws = DummyWebSocket([frame])

    await websocket_endpoint(ws)

    assert ws.accepted
    assert recorded_payload["request_id"] == request_id
    assert recorded_payload["value"] == 42
    assert ws.sent_frames[0]["id"] == request_id
    assert ws.sent_frames[0]["endpoint"] == "mock.endpoint"

    event_dispatcher._sinks.clear()


@pytest.mark.asyncio
async def test_request_id_generated_when_missing(monkeypatch):
    captured_ids: list[str] = []

    async def handler(payload):
        captured_ids.append(payload["request_id"])
        return {"status": "ok"}

    monkeypatch.setitem(RPC_HANDLERS, "mock.generated", handler)
    event_dispatcher._sinks.clear()

    frame = json.dumps(
        {
            "type": "rpc",
            "endpoint": "mock.generated",
            "payload": {},
        }
    )
    ws = DummyWebSocket([frame])

    await websocket_endpoint(ws)

    assert ws.accepted
    assert len(captured_ids) == 1
    generated_id = captured_ids[0]
    assert isinstance(generated_id, str) and generated_id
    assert ws.sent_frames[0]["id"] == generated_id

    event_dispatcher._sinks.clear()
