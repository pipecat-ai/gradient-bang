"""Tests for local map query endpoints: local_map_region, list_known_ports, path_with_region."""
import json
import pytest
import uuid
from fastapi.testclient import TestClient
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent / "game-server"))
from server import app  # type: ignore
from core.world import world  # type: ignore
from core.world import UniverseGraph  # type: ignore


def _unique_character_id(prefix="test"):
    """Generate unique character ID for test isolation."""
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


@pytest.fixture(scope="module")
def ws_client():
    """Load test data into shared world."""
    from port_manager import PortManager  # type: ignore

    test_data_path = Path(__file__).parent / "test-world-data"
    with open(test_data_path / "universe_structure.json", "r") as f:
        universe_data = json.load(f)
    world.universe_graph = UniverseGraph(universe_data)
    with open(test_data_path / "sector_contents.json", "r") as f:
        world.sector_contents = json.load(f)
    world.port_manager = PortManager(universe_contents=world.sector_contents)
    yield TestClient(app)


def _recv_until(ws, predicate, limit=10):
    """Receive messages until predicate is True."""
    for _ in range(limit):
        msg = ws.receive_json()
        if predicate(msg):
            return msg
    raise AssertionError("Did not receive expected frame")


def _setup_explored_character(ws, character_id="explorer"):
    """Create a character and have them explore multiple sectors to build map knowledge.

    Explores: 0 -> 1 -> 3 -> 7 -> 9
    This gives knowledge of ports at sectors 1, 3, and 9.
    """
    # Join the game
    ws.send_text(json.dumps({
        "id": "join1",
        "type": "rpc",
        "endpoint": "join",
        "payload": {"character_id": character_id}
    }))
    join_resp = _recv_until(ws, lambda m: m.get("endpoint") == "join" and m.get("frame_type") == "rpc")
    assert join_resp["ok"] is True
    assert join_resp["result"]["sector"] == 0

    # Move to sector 1 (has port BBS)
    ws.send_text(json.dumps({
        "id": "move1",
        "type": "rpc",
        "endpoint": "move",
        "payload": {"character_id": character_id, "to_sector": 1}
    }))
    move1 = _recv_until(ws, lambda m: m.get("endpoint") == "move" and m.get("frame_type") == "rpc")
    assert move1["ok"] is True

    # Move to sector 3 (has port BSS)
    ws.send_text(json.dumps({
        "id": "move2",
        "type": "rpc",
        "endpoint": "move",
        "payload": {"character_id": character_id, "to_sector": 3}
    }))
    move2 = _recv_until(ws, lambda m: m.get("endpoint") == "move" and m.get("frame_type") == "rpc")
    assert move2["ok"] is True

    # Move to sector 7 (no port)
    ws.send_text(json.dumps({
        "id": "move3",
        "type": "rpc",
        "endpoint": "move",
        "payload": {"character_id": character_id, "to_sector": 7}
    }))
    move3 = _recv_until(ws, lambda m: m.get("endpoint") == "move" and m.get("frame_type") == "rpc")
    assert move3["ok"] is True

    # Move to sector 9 (has port BBB)
    ws.send_text(json.dumps({
        "id": "move4",
        "type": "rpc",
        "endpoint": "move",
        "payload": {"character_id": character_id, "to_sector": 9}
    }))
    move4 = _recv_until(ws, lambda m: m.get("endpoint") == "move" and m.get("frame_type") == "rpc")
    assert move4["ok"] is True

    return join_resp["result"]


# ==================== local_map_region tests ====================

def test_local_map_region_basic(ws_client):
    """Test local_map_region with default parameters."""
    with ws_client.websocket_connect("/ws") as ws:
        char_id = _unique_character_id("region")
        _setup_explored_character(ws, char_id)

        # Query region around current sector (9)
        ws.send_text(json.dumps({
            "id": "region1",
            "type": "rpc",
            "endpoint": "local_map_region",
            "payload": {"character_id": char_id}
        }))
        resp = _recv_until(ws, lambda m: m.get("endpoint") == "local_map_region" and m.get("frame_type") == "rpc")

        assert resp["ok"] is True
        result = resp["result"]

        # Validate structure
        assert result["center_sector"] == 9
        assert "sectors" in result
        assert "total_sectors" in result
        assert "total_visited" in result
        assert "total_unvisited" in result

        # Should have visited sector 9 at minimum
        sector_9 = next((s for s in result["sectors"] if s["id"] == 9), None)
        assert sector_9 is not None
        assert sector_9["visited"] is True
        assert sector_9["hops_from_center"] == 0
        assert "port" in sector_9
        assert sector_9["port"] == "BBB"
        assert "lanes" in sector_9


def test_local_map_region_with_center(ws_client):
    """Test local_map_region with explicit center_sector."""
    with ws_client.websocket_connect("/ws") as ws:
        char_id = _unique_character_id("region")
        _setup_explored_character(ws, char_id)

        # Query region around sector 1 (visited earlier)
        ws.send_text(json.dumps({
            "id": "region2",
            "type": "rpc",
            "endpoint": "local_map_region",
            "payload": {
                "character_id": char_id,
                "center_sector": 1
            }
        }))
        resp = _recv_until(ws, lambda m: m.get("endpoint") == "local_map_region" and m.get("frame_type") == "rpc")

        assert resp["ok"] is True
        result = resp["result"]
        assert result["center_sector"] == 1

        # Sector 1 should be in results
        sector_1 = next((s for s in result["sectors"] if s["id"] == 1), None)
        assert sector_1 is not None
        assert sector_1["visited"] is True
        assert sector_1["hops_from_center"] == 0
        assert sector_1["port"] == "BBS"


def test_local_map_region_max_hops(ws_client):
    """Test local_map_region respects max_hops parameter."""
    with ws_client.websocket_connect("/ws") as ws:
        char_id = _unique_character_id("region")
        _setup_explored_character(ws, char_id)

        # Query with max_hops=1
        ws.send_text(json.dumps({
            "id": "region3",
            "type": "rpc",
            "endpoint": "local_map_region",
            "payload": {
                "character_id": char_id,
                "center_sector": 3,
                "max_hops": 1
            }
        }))
        resp = _recv_until(ws, lambda m: m.get("endpoint") == "local_map_region" and m.get("frame_type") == "rpc")

        assert resp["ok"] is True
        result = resp["result"]

        # All sectors should be within 1 hop of center
        for sector in result["sectors"]:
            assert sector["hops_from_center"] <= 1


def test_local_map_region_max_sectors(ws_client):
    """Test local_map_region respects max_sectors parameter."""
    with ws_client.websocket_connect("/ws") as ws:
        char_id = _unique_character_id("region")
        _setup_explored_character(ws, char_id)

        # Query with max_sectors=2
        ws.send_text(json.dumps({
            "id": "region4",
            "type": "rpc",
            "endpoint": "local_map_region",
            "payload": {
                "character_id": char_id,
                "center_sector": 1,
                "max_sectors": 2
            }
        }))
        resp = _recv_until(ws, lambda m: m.get("endpoint") == "local_map_region" and m.get("frame_type") == "rpc")

        assert resp["ok"] is True
        result = resp["result"]

        # Should not exceed max_sectors
        assert result["total_sectors"] <= 2


def test_local_map_region_unvisited_center(ws_client):
    """Test local_map_region fails when center_sector is unvisited."""
    with ws_client.websocket_connect("/ws") as ws:
        char_id = _unique_character_id("region")
        _setup_explored_character(ws, char_id)

        # Try to query region around unvisited sector 8
        ws.send_text(json.dumps({
            "id": "region5",
            "type": "rpc",
            "endpoint": "local_map_region",
            "payload": {
                "character_id": char_id,
                "center_sector": 8
            }
        }))
        resp = _recv_until(ws, lambda m: m.get("endpoint") == "local_map_region" and m.get("frame_type") == "rpc")

        assert resp["ok"] is False
        assert "must be a visited sector" in resp["error"]["detail"]


# ==================== list_known_ports tests ====================

def test_list_known_ports_basic(ws_client):
    """Test list_known_ports finds all visited ports."""
    with ws_client.websocket_connect("/ws") as ws:
        char_id = _unique_character_id("ports")
        _setup_explored_character(ws, char_id)

        # List all known ports from current sector
        ws.send_text(json.dumps({
            "id": "ports1",
            "type": "rpc",
            "endpoint": "list_known_ports",
            "payload": {"character_id": char_id}
        }))
        resp = _recv_until(ws, lambda m: m.get("endpoint") == "list_known_ports" and m.get("frame_type") == "rpc")

        assert resp["ok"] is True
        result = resp["result"]

        # Validate structure
        assert result["from_sector"] == 9  # Current sector
        assert "ports" in result
        assert "total_ports_found" in result
        assert "searched_sectors" in result

        # Should find ports at sectors 1, 3, 9
        port_sectors = [p["sector_id"] for p in result["ports"]]
        assert 9 in port_sectors  # Current sector port


def test_list_known_ports_with_from_sector(ws_client):
    """Test list_known_ports with explicit from_sector."""
    with ws_client.websocket_connect("/ws") as ws:
        char_id = _unique_character_id("ports")
        _setup_explored_character(ws, char_id)

        # List ports from sector 1
        ws.send_text(json.dumps({
            "id": "ports2",
            "type": "rpc",
            "endpoint": "list_known_ports",
            "payload": {
                "character_id": char_id,
                "from_sector": 1
            }
        }))
        resp = _recv_until(ws, lambda m: m.get("endpoint") == "list_known_ports" and m.get("frame_type") == "rpc")

        assert resp["ok"] is True
        result = resp["result"]
        assert result["from_sector"] == 1


def test_list_known_ports_port_type_filter(ws_client):
    """Test list_known_ports with port_type filter."""
    with ws_client.websocket_connect("/ws") as ws:
        char_id = _unique_character_id("ports")
        _setup_explored_character(ws, char_id)

        # List only BBB ports
        ws.send_text(json.dumps({
            "id": "ports3",
            "type": "rpc",
            "endpoint": "list_known_ports",
            "payload": {
                "character_id": char_id,
                "port_type": "BBB"
            }
        }))
        resp = _recv_until(ws, lambda m: m.get("endpoint") == "list_known_ports" and m.get("frame_type") == "rpc")

        assert resp["ok"] is True
        result = resp["result"]

        # All returned ports should be BBB
        for port in result["ports"]:
            assert port["port"]["code"] == "BBB"

        # Should find sector 9 (BBB)
        port_sectors = [p["sector_id"] for p in result["ports"]]
        assert 9 in port_sectors


def test_list_known_ports_commodity_filter(ws_client):
    """Test list_known_ports with commodity and trade_type filters."""
    with ws_client.websocket_connect("/ws") as ws:
        char_id = _unique_character_id("ports")
        _setup_explored_character(ws, char_id)

        # Find ports that sell neuro_symbolics (player wants to buy neuro_symbolics)
        ws.send_text(json.dumps({
            "id": "ports4",
            "type": "rpc",
            "endpoint": "list_known_ports",
            "payload": {
                "character_id": char_id,
                "commodity": "neuro_symbolics",
                "trade_type": "buy"
            }
        }))
        resp = _recv_until(ws, lambda m: m.get("endpoint") == "list_known_ports" and m.get("frame_type") == "rpc")

        assert resp["ok"] is True
        result = resp["result"]

        # All returned ports should sell neuro_symbolics (S in position 2)
        for port in result["ports"]:
            port_code = port["port"]["code"]
            assert port_code[2] == "S"  # Neuro-symbolics is position 2


def test_list_known_ports_max_hops(ws_client):
    """Test list_known_ports respects max_hops parameter."""
    with ws_client.websocket_connect("/ws") as ws:
        char_id = _unique_character_id("ports")
        _setup_explored_character(ws, char_id)

        # List ports within 1 hop
        ws.send_text(json.dumps({
            "id": "ports5",
            "type": "rpc",
            "endpoint": "list_known_ports",
            "payload": {
                "character_id": char_id,
                "max_hops": 1
            }
        }))
        resp = _recv_until(ws, lambda m: m.get("endpoint") == "list_known_ports" and m.get("frame_type") == "rpc")

        assert resp["ok"] is True
        result = resp["result"]

        # All ports should be within max_hops
        for port in result["ports"]:
            assert port["hops_from_start"] <= 1


def test_list_known_ports_missing_commodity_with_trade_type(ws_client):
    """Test list_known_ports fails when trade_type specified without commodity."""
    with ws_client.websocket_connect("/ws") as ws:
        char_id = _unique_character_id("ports")
        _setup_explored_character(ws, char_id)

        # Try to use trade_type without commodity
        ws.send_text(json.dumps({
            "id": "ports6",
            "type": "rpc",
            "endpoint": "list_known_ports",
            "payload": {
                "character_id": char_id,
                "trade_type": "buy"
            }
        }))
        resp = _recv_until(ws, lambda m: m.get("endpoint") == "list_known_ports" and m.get("frame_type") == "rpc")

        assert resp["ok"] is False
        assert "commodity required" in resp["error"]["detail"]


def test_list_known_ports_missing_trade_type_with_commodity(ws_client):
    """Test list_known_ports fails when commodity specified without trade_type."""
    with ws_client.websocket_connect("/ws") as ws:
        char_id = _unique_character_id("ports")
        _setup_explored_character(ws, char_id)

        # Try to use commodity without trade_type
        ws.send_text(json.dumps({
            "id": "ports7",
            "type": "rpc",
            "endpoint": "list_known_ports",
            "payload": {
                "character_id": char_id,
                "commodity": "neuro_symbolics"
            }
        }))
        resp = _recv_until(ws, lambda m: m.get("endpoint") == "list_known_ports" and m.get("frame_type") == "rpc")

        assert resp["ok"] is False
        assert "trade_type required" in resp["error"]["detail"]


# ==================== path_with_region tests ====================

def test_path_with_region_basic(ws_client):
    """Test path_with_region returns path and nearby sectors."""
    with ws_client.websocket_connect("/ws") as ws:
        char_id = _unique_character_id("path")
        _setup_explored_character(ws, char_id)

        # Get path from current sector (9) back to sector 1
        ws.send_text(json.dumps({
            "id": "path1",
            "type": "rpc",
            "endpoint": "path_with_region",
            "payload": {
                "character_id": char_id,
                "to_sector": 1
            }
        }))
        resp = _recv_until(ws, lambda m: m.get("endpoint") == "path_with_region" and m.get("frame_type") == "rpc")

        assert resp["ok"] is True
        result = resp["result"]

        # Validate structure
        assert "path" in result
        assert "distance" in result
        assert "sectors" in result
        assert "total_sectors" in result
        assert "known_sectors" in result
        assert "unknown_sectors" in result

        # Path should start at 9 and end at 1
        assert result["path"][0] == 9
        assert result["path"][-1] == 1
        assert result["distance"] == len(result["path"]) - 1

        # All path nodes should be marked on_path=True
        path_set = set(result["path"])
        for sector in result["sectors"]:
            if sector["sector_id"] in path_set:
                assert sector["on_path"] is True
                assert sector["hops_from_path"] == 0


def test_path_with_region_region_hops(ws_client):
    """Test path_with_region includes sectors around path nodes."""
    with ws_client.websocket_connect("/ws") as ws:
        char_id = _unique_character_id("path")
        _setup_explored_character(ws, char_id)

        # Get path with region_hops=1
        ws.send_text(json.dumps({
            "id": "path2",
            "type": "rpc",
            "endpoint": "path_with_region",
            "payload": {
                "character_id": char_id,
                "to_sector": 1,
                "region_hops": 1
            }
        }))
        resp = _recv_until(ws, lambda m: m.get("endpoint") == "path_with_region" and m.get("frame_type") == "rpc")

        assert resp["ok"] is True
        result = resp["result"]

        # Should include sectors adjacent to path nodes
        path_sectors = set(result["path"])
        non_path_sectors = [s for s in result["sectors"] if not s["on_path"]]

        # All non-path sectors should be within region_hops of path
        for sector in non_path_sectors:
            assert sector["hops_from_path"] <= 1
            if sector["visited"]:
                assert "adjacent_to_path_nodes" in sector or sector["hops_from_path"] == 0


def test_path_with_region_max_sectors(ws_client):
    """Test path_with_region respects max_sectors parameter."""
    with ws_client.websocket_connect("/ws") as ws:
        char_id = _unique_character_id("path")
        _setup_explored_character(ws, char_id)

        # Get path with max_sectors=5
        ws.send_text(json.dumps({
            "id": "path3",
            "type": "rpc",
            "endpoint": "path_with_region",
            "payload": {
                "character_id": char_id,
                "to_sector": 1,
                "max_sectors": 5
            }
        }))
        resp = _recv_until(ws, lambda m: m.get("endpoint") == "path_with_region" and m.get("frame_type") == "rpc")

        assert resp["ok"] is True
        result = resp["result"]

        # Should not exceed max_sectors
        assert result["total_sectors"] <= 5


def test_path_with_region_unknown_sectors_on_path(ws_client):
    """Test path_with_region handles unknown sectors on path correctly."""
    with ws_client.websocket_connect("/ws") as ws:
        char_id = _unique_character_id("path")
        _setup_explored_character(ws, char_id)

        # Get path to sector 2 (not visited, but may be on path)
        ws.send_text(json.dumps({
            "id": "path4",
            "type": "rpc",
            "endpoint": "path_with_region",
            "payload": {
                "character_id": char_id,
                "to_sector": 2
            }
        }))
        resp = _recv_until(ws, lambda m: m.get("endpoint") == "path_with_region" and m.get("frame_type") == "rpc")

        assert resp["ok"] is True
        result = resp["result"]

        # Check if path includes unknown sectors
        for sector in result["sectors"]:
            if not sector["visited"]:
                # Unknown sectors should have minimal info
                assert sector["on_path"] is True or "seen_from" in sector
                assert "port" not in sector or sector.get("port") is None


def test_path_with_region_invalid_destination(ws_client):
    """Test path_with_region fails with invalid to_sector."""
    with ws_client.websocket_connect("/ws") as ws:
        char_id = _unique_character_id("path")
        _setup_explored_character(ws, char_id)

        # Try invalid sector
        ws.send_text(json.dumps({
            "id": "path5",
            "type": "rpc",
            "endpoint": "path_with_region",
            "payload": {
                "character_id": char_id,
                "to_sector": 999
            }
        }))
        resp = _recv_until(ws, lambda m: m.get("endpoint") == "path_with_region" and m.get("frame_type") == "rpc")

        assert resp["ok"] is False
        assert "Invalid to_sector" in resp["error"]["detail"]
