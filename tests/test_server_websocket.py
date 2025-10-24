import json
import pytest
from fastapi.testclient import TestClient
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent / "game-server"))
from server import app  # type: ignore
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
        join_response = None
        join_snapshot = None
        for _ in range(10):
            msg = ws.receive_json()
            if (
                msg.get("frame_type") == "event"
                and msg.get("event") == "status.snapshot"
                and msg.get("payload", {}).get("source", {}).get("method") == "join"
            ):
                join_snapshot = msg
                if join_response:
                    break
            elif (
                msg.get("frame_type") == "rpc"
                and msg.get("endpoint") == "join"
            ):
                join_response = msg
                if join_snapshot:
                    break

        assert join_response is not None, "Did not receive join RPC response"
        assert join_response["frame_type"] == "rpc"
        assert join_response["ok"] is True
        assert join_response["result"] == {"success": True}

        assert join_snapshot is not None, "Did not receive status.snapshot for join"
        assert join_snapshot["frame_type"] == "event"
        assert join_snapshot["event"] == "status.snapshot"
        join_payload = join_snapshot["payload"]
        assert join_payload["player"]["name"] == "ws_player"
        assert join_payload["sector"]["id"] == 0
        assert join_payload["source"]["method"] == "join"
        assert join_payload["source"]["request_id"] == "1"

        # my_status RPC
        req2 = {"id": "2", "type": "rpc", "endpoint": "my_status", "payload": {"character_id": "ws_player"}}
        ws.send_text(json.dumps(req2))
        status_response = None
        snapshot_event = None
        for _ in range(10):
            msg = ws.receive_json()
            if msg.get("frame_type") == "rpc" and msg.get("endpoint") == "my_status":
                status_response = msg
                if snapshot_event:
                    break
            elif msg.get("frame_type") == "event" and msg.get("event") == "status.snapshot":
                snapshot_event = msg
                if status_response:
                    break

        assert status_response is not None, "Did not receive my_status RPC response"
        assert snapshot_event is not None, "Did not receive status.snapshot event"

        assert status_response["frame_type"] == "rpc"
        assert status_response["ok"] is True
        assert status_response["result"] == {"success": True}

        status_payload = snapshot_event["payload"]
        assert status_payload["player"]["name"] == "ws_player"
        assert status_payload["source"]["method"] == "my_status"
        assert status_payload["source"]["request_id"] == "2"


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
        assert event["payload"]["player"]["name"] == "push_player"
