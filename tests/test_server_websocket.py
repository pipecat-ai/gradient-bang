import json
import pytest
from fastapi.testclient import TestClient
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent / "game-server"))
from server import app  # type: ignore
from core.world import world  # type: ignore
from core.world import UniverseGraph  # type: ignore


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
    yield TestClient(app)

def _recv_until(ws, predicate, limit=10):
    for _ in range(limit):
        msg = ws.receive_json()
        if predicate(msg):
            return msg
    raise AssertionError("Did not receive expected frame")


def test_ws_join_and_status(ws_client):
    with ws_client.websocket_connect("/ws") as ws:
        req = {"id": "1", "type": "rpc", "endpoint": "join", "payload": {"character_id": "ws_player"}}
        ws.send_text(json.dumps(req))
        resp = _recv_until(ws, lambda m: m.get("frame_type") == "rpc" and m.get("endpoint") == "join")
        assert resp["frame_type"] == "rpc"
        assert resp["ok"] is True
        data = resp["result"]
        assert data["name"] == "ws_player"
        assert data["sector"] == 0

        # my_status RPC
        req2 = {"id": "2", "type": "rpc", "endpoint": "my_status", "payload": {"character_id": "ws_player"}}
        ws.send_text(json.dumps(req2))
        resp2 = _recv_until(ws, lambda m: m.get("frame_type") == "rpc" and m.get("endpoint") == "my_status")
        assert resp2["frame_type"] == "rpc"
        assert resp2["ok"] is True
        assert resp2["result"]["name"] == "ws_player"


def test_ws_subscribe_my_status_push(ws_client):
    with ws_client.websocket_connect("/ws") as ws:
        # Join first
        ws.send_text(json.dumps({"id": "1", "endpoint": "join", "payload": {"character_id": "push_player"}}))
        _recv_until(ws, lambda m: m.get("frame_type") == "rpc" and m.get("endpoint") == "join")
        # Subscribe to my_status
        ws.send_text(json.dumps({"id": "sub1", "type": "subscribe", "event": "status.update", "character_id": "push_player"}))
        ack = _recv_until(ws, lambda m: m.get("frame_type") == "rpc" and m.get("id") == "sub1")
        assert ack["frame_type"] == "rpc"
        assert ack["ok"] is True
        # Receive one event (may take up to ~2s)
        event = _recv_until(ws, lambda m: m.get("frame_type") == "event" and m.get("event") == "status.update")
        assert event["frame_type"] == "event"
        assert event["event"] == "status.update"
        assert event["payload"]["name"] == "push_player"
