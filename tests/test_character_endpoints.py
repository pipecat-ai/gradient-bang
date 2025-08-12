"""Tests for character-related endpoints: /api/join, /api/move, /api/my-status."""

import pytest
from fastapi.testclient import TestClient
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "game-server"))
from server import app, game_world


@pytest.fixture(scope="module")
def client():
    """Create test client with test universe data."""
    import json
    from server import UniverseGraph
    
    # Save original load_data method
    original_load_data = game_world.load_data
    
    # Override to use test data
    def load_test_data():
        test_data_path = Path(__file__).parent / "test-world-data"
        
        # Load test universe structure
        with open(test_data_path / "universe_structure.json", "r") as f:
            universe_data = json.load(f)
        
        game_world.universe_graph = UniverseGraph(universe_data)
        
        # Load test sector contents
        with open(test_data_path / "sector_contents.json", "r") as f:
            game_world.sector_contents = json.load(f)
        
        print(f"Loaded test universe with {game_world.universe_graph.sector_count} sectors")
    
    # Use test data
    game_world.load_data = load_test_data
    game_world.load_data()
    
    with TestClient(app) as c:
        yield c
    
    # Restore original method
    game_world.load_data = original_load_data


@pytest.fixture(autouse=True)
def reset_characters():
    """Clear characters before each test."""
    game_world.characters.clear()
    yield
    game_world.characters.clear()


@pytest.fixture
def test_character_id():
    """Provide a test character ID."""
    return "test_player_123"


def test_join_new_character(client, test_character_id):
    """Test joining with a new character places them at sector 0."""
    response = client.post(
        "/api/join",
        json={"character_id": test_character_id}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == test_character_id
    assert data["sector"] == 0
    assert "last_active" in data
    assert "sector_contents" in data
    assert data["sector_contents"]["adjacent_sectors"] == [1, 2, 5]  # Test universe sector 0 connections


def test_join_existing_character(client, test_character_id):
    """Test joining with existing character returns current state."""
    # First join
    response1 = client.post(
        "/api/join",
        json={"character_id": test_character_id}
    )
    assert response1.status_code == 200
    
    # Move the character to a different sector
    # Find an adjacent sector to 0
    response_move = client.post(
        "/api/move",
        json={"character_id": test_character_id, "to": 1}
    )
    assert response_move.status_code == 200
    assert response_move.json()["sector"] == 1
    
    # Join again - should return current position, not reset to 0
    response2 = client.post(
        "/api/join",
        json={"character_id": test_character_id}
    )
    assert response2.status_code == 200
    data = response2.json()
    assert data["id"] == test_character_id
    assert data["sector"] == 1  # Should still be at sector 1


def test_join_empty_character_id(client):
    """Test that empty character ID is rejected."""
    response = client.post(
        "/api/join",
        json={"character_id": ""}
    )
    assert response.status_code == 422


def test_join_long_character_id(client):
    """Test that overly long character ID is rejected."""
    long_id = "x" * 101
    response = client.post(
        "/api/join",
        json={"character_id": long_id}
    )
    assert response.status_code == 422


def test_my_status_existing_character(client, test_character_id):
    """Test getting status of existing character."""
    # Join first
    join_response = client.post(
        "/api/join",
        json={"character_id": test_character_id}
    )
    assert join_response.status_code == 200
    join_data = join_response.json()
    
    # Get status
    status_response = client.post(
        "/api/my-status",
        json={"character_id": test_character_id}
    )
    assert status_response.status_code == 200
    status_data = status_response.json()
    
    # Should match join response
    assert status_data["id"] == join_data["id"]
    assert status_data["sector"] == join_data["sector"]
    assert "sector_contents" in status_data


def test_my_status_nonexistent_character(client):
    """Test getting status of non-existent character returns 404."""
    response = client.post(
        "/api/my-status",
        json={"character_id": "nonexistent_player"}
    )
    assert response.status_code == 404
    assert "not found" in response.json()["detail"].lower()


def test_move_to_adjacent_sector(client, test_character_id):
    """Test moving to an adjacent sector."""
    # Join first
    client.post("/api/join", json={"character_id": test_character_id})
    
    # Move to sector 1 (adjacent to 0)
    response = client.post(
        "/api/move",
        json={"character_id": test_character_id, "to": 1}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["sector"] == 1
    assert data["id"] == test_character_id


def test_move_to_non_adjacent_sector(client, test_character_id):
    """Test that moving to non-adjacent sector is rejected."""
    # Join first
    client.post("/api/join", json={"character_id": test_character_id})
    
    # Try to move to sector 7 (not adjacent to 0 in test universe)
    response = client.post(
        "/api/move",
        json={"character_id": test_character_id, "to": 7}
    )
    assert response.status_code == 400
    assert "not adjacent" in response.json()["detail"].lower()


def test_move_nonexistent_character(client):
    """Test that moving non-existent character returns 404."""
    response = client.post(
        "/api/move",
        json={"character_id": "ghost_player", "to": 1}
    )
    assert response.status_code == 404
    assert "not found" in response.json()["detail"].lower()


def test_move_to_invalid_sector(client, test_character_id):
    """Test that moving to invalid sector ID is rejected."""
    # Join first
    client.post("/api/join", json={"character_id": test_character_id})
    
    # Try to move to invalid sector (beyond test universe size)
    response = client.post(
        "/api/move",
        json={"character_id": test_character_id, "to": 100}
    )
    assert response.status_code == 400
    assert "Invalid sector" in response.json()["detail"]


def test_move_negative_sector(client, test_character_id):
    """Test that negative sector numbers are rejected."""
    response = client.post(
        "/api/move",
        json={"character_id": test_character_id, "to": -1}
    )
    assert response.status_code == 422


def test_sequential_moves(client, test_character_id):
    """Test a sequence of valid moves."""
    # Join at sector 0
    client.post("/api/join", json={"character_id": test_character_id})
    
    # Move 0 -> 1
    response1 = client.post(
        "/api/move",
        json={"character_id": test_character_id, "to": 1}
    )
    assert response1.status_code == 200
    assert response1.json()["sector"] == 1
    
    # Move 1 -> 0 (back)
    response2 = client.post(
        "/api/move",
        json={"character_id": test_character_id, "to": 0}
    )
    assert response2.status_code == 200
    assert response2.json()["sector"] == 0
    
    # Move 0 -> 2
    response3 = client.post(
        "/api/move",
        json={"character_id": test_character_id, "to": 2}
    )
    assert response3.status_code == 200
    assert response3.json()["sector"] == 2


def test_multiple_characters(client):
    """Test that multiple characters can exist independently."""
    char1 = "player_one"
    char2 = "player_two"
    
    # Both join at sector 0
    response1 = client.post("/api/join", json={"character_id": char1})
    assert response1.status_code == 200
    assert response1.json()["sector"] == 0
    
    response2 = client.post("/api/join", json={"character_id": char2})
    assert response2.status_code == 200
    assert response2.json()["sector"] == 0
    
    # Move char1 to sector 1
    move1 = client.post("/api/move", json={"character_id": char1, "to": 1})
    assert move1.status_code == 200
    assert move1.json()["sector"] == 1
    
    # Char2 should still be at sector 0
    status2 = client.post("/api/my-status", json={"character_id": char2})
    assert status2.status_code == 200
    assert status2.json()["sector"] == 0
    
    # Char1 should be at sector 1
    status1 = client.post("/api/my-status", json={"character_id": char1})
    assert status1.status_code == 200
    assert status1.json()["sector"] == 1


def test_sector_contents_with_port(client, test_character_id):
    """Test that sector contents include port information."""
    # Join at sector 0
    client.post("/api/join", json={"character_id": test_character_id})
    
    # Move to sector 1 (has a port in test universe)
    response = client.post(
        "/api/move",
        json={"character_id": test_character_id, "to": 1}
    )
    assert response.status_code == 200
    data = response.json()
    
    # Check sector contents
    contents = data["sector_contents"]
    assert contents["port"] is not None
    assert contents["port"]["class"] == 1
    assert contents["port"]["code"] == "BBS"
    assert contents["port"]["buys"] == ["fuel_ore", "organics"]
    assert contents["port"]["sells"] == ["equipment"]
    assert "stock" in contents["port"]
    assert "demand" in contents["port"]
    assert contents["adjacent_sectors"] == [0, 3, 4]  # Test universe sector 1 connections


def test_sector_contents_with_other_players(client):
    """Test that other players appear in sector contents."""
    # Join two players at sector 0
    client.post("/api/join", json={"character_id": "player1"})
    client.post("/api/join", json={"character_id": "player2"})
    
    # Check player1's view - should see player2
    response = client.post(
        "/api/my-status",
        json={"character_id": "player1"}
    )
    assert response.status_code == 200
    data = response.json()
    other_players = [p["name"] for p in data["sector_contents"]["other_players"]]
    assert "player2" in other_players
    assert "player1" not in other_players  # Shouldn't see self
    
    # Check player2's view - should see player1
    response = client.post(
        "/api/my-status",
        json={"character_id": "player2"}
    )
    assert response.status_code == 200
    data = response.json()
    other_players = [p["name"] for p in data["sector_contents"]["other_players"]]
    assert "player1" in other_players
    assert "player2" not in other_players  # Shouldn't see self


def test_last_active_updates(client, test_character_id):
    """Test that last_active timestamp updates on actions."""
    import time
    
    # Join
    join_response = client.post("/api/join", json={"character_id": test_character_id})
    assert join_response.status_code == 200
    initial_time = join_response.json()["last_active"]
    
    # Wait a bit
    time.sleep(0.1)
    
    # Check status - should update last_active
    status_response = client.post("/api/my-status", json={"character_id": test_character_id})
    assert status_response.status_code == 200
    status_time = status_response.json()["last_active"]
    
    assert status_time > initial_time
