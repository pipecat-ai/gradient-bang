import json
import asyncio
import pytest
from fastapi.testclient import TestClient
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent / "game-server"))
from server_websocket import app  # type: ignore
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


def test_ws_join_and_status(ws_client):
    with ws_client.websocket_connect("/ws") as ws:
        req = {"id": "1", "endpoint": "join", "payload": {"character_id": "ws_player"}}
        ws.send_text(json.dumps(req))
        resp = ws.receive_json()
        assert resp["ok"] is True
        data = resp["data"]
        assert data["name"] == "ws_player"
        assert data["sector"] == 0

        # my_status RPC
        req2 = {"id": "2", "endpoint": "my_status", "payload": {"character_id": "ws_player"}}
        ws.send_text(json.dumps(req2))
        resp2 = ws.receive_json()
        assert resp2["ok"] is True
        assert resp2["data"]["name"] == "ws_player"


def test_ws_subscribe_my_status_push(ws_client):
    with ws_client.websocket_connect("/ws") as ws:
        # Join first
        ws.send_text(json.dumps({"id": "1", "endpoint": "join", "payload": {"character_id": "push_player"}}))
        ws.receive_json()
        # Subscribe to my_status
        ws.send_text(json.dumps({"id": "sub1", "action": "subscribe", "event": "my_status", "character_id": "push_player"}))
        ack = ws.receive_json()
        assert ack["ok"] is True
        # Receive one event (may take up to ~2s)
        event = ws.receive_json()
        assert event["type"] == "event"
        assert event["event"] == "my_status"
        assert event["data"]["name"] == "push_player"

