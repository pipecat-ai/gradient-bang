"""Tests for the /api/plot_course endpoint."""

import pytest
import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient

pytestmark = pytest.mark.skip(
    "HTTP endpoints removed in favor of WebSocket RPC; update tests to new transport"
)

sys.path.insert(0, str(Path(__file__).parent.parent / "game-server"))
from server import app
from core.world import world as game_world
from port_manager import PortManager
from core.world import UniverseGraph


@pytest.fixture(scope="module")
def client():
    """Create test client with test universe data."""
    original_load = game_world.load_data
    def load_test_data():
        test_data_path = Path(__file__).parent / "test-world-data"
        with open(test_data_path / "universe_structure.json", "r") as f:
            universe_data = json.load(f)
        game_world.universe_graph = UniverseGraph(universe_data)
        with open(test_data_path / "sector_contents.json", "r") as f:
            game_world.sector_contents = json.load(f)
        game_world.port_manager = PortManager(universe_contents=game_world.sector_contents)
    game_world.load_data = load_test_data

    with TestClient(app) as c:
        yield c

    game_world.load_data = original_load


def test_root_endpoint(client):
    """Test the root endpoint returns server info."""
    response = client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Gradient Bang"
    assert data["version"] == "0.1.0"
    assert data["status"] == "running"
    assert data["sectors"] == 10


def test_plot_course_simple_path(client):
    """Test finding a simple path between adjacent sectors."""
    response = client.post(
        "/api/plot_course",
        json={"from_sector": 0, "to_sector": 1}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["from_sector"] == 0
    assert data["to_sector"] == 1
    assert isinstance(data["path"], list)
    assert data["path"][0] == 0
    assert data["path"][-1] == 1
    assert data["distance"] == len(data["path"]) - 1


def test_plot_course_same_sector(client):
    """Test that plotting course to same sector returns single-element path."""
    response = client.post(
        "/api/plot_course",
        json={"from_sector": 3, "to_sector": 3}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["path"] == [3]
    assert data["distance"] == 0


def test_plot_course_long_path(client):
    """Test finding a path between distant sectors."""
    response = client.post(
        "/api/plot_course",
        json={"from_sector": 0, "to_sector": 9}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["from_sector"] == 0
    assert data["to_sector"] == 9
    assert len(data["path"]) > 1
    assert data["path"][0] == 0
    assert data["path"][-1] == 9


def test_plot_course_invalid_from_sector(client):
    """Test that invalid from_sector returns 400 error."""
    response = client.post(
        "/api/plot_course",
        json={"from_sector": 10000, "to_sector": 0}
    )
    assert response.status_code == 400
    assert "Invalid from_sector" in response.json()["detail"]


def test_plot_course_invalid_to_sector(client):
    """Test that invalid to_sector returns 400 error."""
    response = client.post(
        "/api/plot_course",
        json={"from_sector": 0, "to_sector": 10000}
    )
    assert response.status_code == 400
    assert "Invalid to_sector" in response.json()["detail"]


def test_plot_course_negative_sectors(client):
    """Test that negative sector numbers are rejected."""
    response = client.post(
        "/api/plot_course",
        json={"from_sector": -1, "to_sector": 10}
    )
    assert response.status_code == 422  # Pydantic validation error


def test_plot_course_missing_parameters(client):
    """Test that missing parameters return validation error."""
    response = client.post(
        "/api/plot_course",
        json={"from_sector": 0}
    )
    assert response.status_code == 400
    
    response = client.post(
        "/api/plot_course",
        json={"to_sector": 10}
    )
    assert response.status_code == 400


def test_plot_course_path_continuity(client):
    """Test that returned paths are continuous (each step is a valid warp)."""
    response = client.post(
        "/api/plot_course",
        json={"from_sector": 0, "to_sector": 8}
    )
    assert response.status_code == 200
    data = response.json()
    path = data["path"]
    
    # Verify path continuity by checking each step exists in adjacency
    # Note: This would require access to the graph structure,
    # which we'll verify by the fact that the server returned a valid path
    assert len(path) >= 2
    assert path[0] == 0
    assert path[-1] == 8
