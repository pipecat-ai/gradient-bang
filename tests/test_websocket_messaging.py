import json
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

import sys
sys.path.insert(0, str(Path(__file__).parent.parent / "game-server"))

from server_websocket import app  # type: ignore
from core.world import world  # type: ignore
from core.world import UniverseGraph  # type: ignore
from port_manager import PortManager  # type: ignore


@pytest.fixture(scope="module")
def ws_client():
    # Load test data into shared world
    import json as _json
    test_data_path = Path(__file__).parent / "test-world-data"
    with open(test_data_path / "universe_structure.json", "r") as f:
        universe_data = _json.load(f)
    world.universe_graph = UniverseGraph(universe_data)
    with open(test_data_path / "sector_contents.json", "r") as f:
        world.sector_contents = _json.load(f)
    world.port_manager = PortManager(universe_contents=world.sector_contents)

    # Patch world.load_data so lifespan doesn't read WORLD_DATA_DIR
    original_load = world.load_data
    def _no_load():
        return None
    world.load_data = _no_load
    try:
        with TestClient(app) as c:
            yield c
    finally:
        world.load_data = original_load


def _recv_until_event(ws, event_name: str):
    # Helper to receive until desired event arrives
    for _ in range(10):
        msg = ws.receive_json()
        if isinstance(msg, dict) and msg.get("type") == "event" and msg.get("event") == event_name:
            return msg["data"]
    raise AssertionError(f"Did not receive event {event_name}")


def test_ws_broadcast_chat(ws_client):
    with ws_client.websocket_connect("/ws") as a, ws_client.websocket_connect("/ws") as b:
        # Subscribe both to chat events
        a.send_text(json.dumps({"id": "sa", "action": "subscribe", "event": "chat"}))
        b.send_text(json.dumps({"id": "sb", "action": "subscribe", "event": "chat"}))
        assert a.receive_json()["ok"] is True
        assert b.receive_json()["ok"] is True

        # Send broadcast from A
        payload = {
            "character_id": "Charlie",
            "type": "broadcast",
            "content": "Hello World",
        }
        a.send_text(json.dumps({"id": "m1", "endpoint": "send_message", "payload": payload}))
        
        # Both should receive chat event
        evt_a = _recv_until_event(a, "chat")
        evt_b = _recv_until_event(b, "chat")
        assert evt_a["type"] == "broadcast"
        assert evt_b["type"] == "broadcast"
        assert evt_a["content"] == "Hello World"
        assert evt_b["content"] == "Hello World"


def test_ws_direct_chat(ws_client):
    with ws_client.websocket_connect("/ws") as sender, ws_client.websocket_connect("/ws") as recipient:
        # Recipient joins and subscribes my_status to register character id
        recipient.send_text(json.dumps({"id": "j1", "endpoint": "join", "payload": {"character_id": "Bob"}}))
        assert recipient.receive_json()["ok"] is True
        sender.send_text(json.dumps({"id": "j2", "endpoint": "join", "payload": {"character_id": "Charlie"}}))
        assert sender.receive_json()["ok"] is True

        recipient.send_text(json.dumps({"id": "ms1", "action": "subscribe", "event": "my_status", "character_id": "Bob"}))
        assert recipient.receive_json()["ok"] is True

        # Both subscribe to chat
        sender.send_text(json.dumps({"id": "sc1", "action": "subscribe", "event": "chat"}))
        recipient.send_text(json.dumps({"id": "sc2", "action": "subscribe", "event": "chat"}))
        for _ in range(5):
            resp = sender.receive_json()
            if isinstance(resp, dict) and "ok" in resp:
                assert resp["ok"] is True
                break
        for _ in range(5):
            resp = recipient.receive_json()
            if isinstance(resp, dict) and "ok" in resp:
                assert resp["ok"] is True
                break

        # Sender sends direct to Bob
        payload = {
            "character_id": "Alice",
            "type": "direct",
            "to_name": "Bob",
            "content": "Hi Bob",
        }
        sender.send_text(json.dumps({"id": "m1", "endpoint": "send_message", "payload": payload}))
        
        evt = _recv_until_event(recipient, "chat")
        assert evt["type"] == "direct"
        assert evt["to_name"] == "Bob"
        assert evt["from_name"] == "Alice"
        assert evt["content"] == "Hi Bob"
