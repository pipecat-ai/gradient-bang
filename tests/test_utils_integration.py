"""Integration tests for utils modules with a real game server."""

import sys
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "game-server"))

from server import app, game_world  # noqa: E402
from utils.api_client import AsyncGameClient  # noqa: E402
from utils.game_tools import AsyncToolExecutor  # noqa: E402


@pytest_asyncio.fixture(scope="module")
async def test_client():
    """Create an AsyncClient with test universe data."""
    original_load_data = game_world.load_data

    def load_test_data() -> None:
        import json
        from server import UniverseGraph

        test_data_path = Path(__file__).parent / "test-world-data"

        with open(test_data_path / "universe_structure.json", "r") as f:
            universe_data = json.load(f)
        game_world.universe_graph = UniverseGraph(universe_data)

        with open(test_data_path / "sector_contents.json", "r") as f:
            game_world.sector_contents = json.load(f)

    game_world.load_data = load_test_data
    game_world.load_data()

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client

    game_world.load_data = original_load_data


@pytest_asyncio.fixture(autouse=True)
async def reset_characters():
    """Clear characters before each test."""
    game_world.characters.clear()
    yield
    game_world.characters.clear()


@pytest_asyncio.fixture
async def game_client(test_client):
    """Create an AsyncGameClient connected to the test server."""
    client = AsyncGameClient(base_url="http://testserver")
    client.client = test_client
    yield client


@pytest.mark.asyncio
async def test_full_join_move_status_flow(game_client):
    """Test complete flow: join, move, check status."""
    character_id = "integration_test_char"

    status = await game_client.join(character_id)
    assert status.id == character_id
    assert status.sector == 0

    move_status = await game_client.move(character_id, 1)
    assert move_status.sector == 1

    current_status = await game_client.my_status(character_id)
    assert current_status.sector == 1
    assert current_status.id == character_id


@pytest.mark.asyncio
async def test_plot_course_real_data(game_client):
    """Test plotting course with test universe data."""
    result = await game_client.plot_course(0, 9)

    assert result.from_sector == 0
    assert result.to_sector == 9
    assert len(result.path) > 0
    assert result.path[0] == 0
    assert result.path[-1] == 9
    assert result.distance == len(result.path) - 1


@pytest.mark.asyncio
async def test_move_to_non_adjacent_fails(game_client):
    """Test that moving to non-adjacent sector fails."""
    character_id = "test_char"

    await game_client.join(character_id)

    with pytest.raises(httpx.HTTPStatusError):
        await game_client.move(character_id, 7)


@pytest.mark.asyncio
async def test_server_status(game_client):
    """Test getting server status."""
    status = await game_client.server_status()

    assert status["name"] == "Gradient Bang"
    assert status["sectors"] == 10  # Test universe has 10 sectors
    assert status["status"] == "running"


@pytest.mark.asyncio
async def test_tool_executor_full_flow(game_client):
    """Test AsyncToolExecutor with all tools against real server."""
    character_id = "tool_test_char"
    await game_client.join(character_id)

    executor = AsyncToolExecutor(game_client, character_id)

    status_result = await executor.my_status()
    assert status_result["success"] is True
    assert status_result["current_sector"] == 0

    course_result = await executor.plot_course(0, 9)
    assert course_result["success"] is True
    assert course_result["path"][0] == 0
    assert course_result["path"][-1] == 9

    move_result = await executor.move(1)
    assert move_result["success"] is True
    assert move_result["new_sector"] == 1

    wait_result = await executor.wait_for_time(0.1)
    assert wait_result["success"] is True

    finish_result = await executor.finish_task("Integration test complete")
    assert finish_result["success"] is True
    assert executor.finished is True


@pytest.mark.asyncio
async def test_tool_executor_error_handling(game_client):
    """Test that AsyncToolExecutor handles server errors gracefully."""
    character_id = "error_test_char"
    executor = AsyncToolExecutor(game_client, character_id)

    result = await executor.move(1)
    assert result["success"] is False

    result = await executor.my_status()
    assert result["success"] is False


@pytest.mark.asyncio
async def test_execute_tool_by_name(game_client):
    """Test executing tools by name with args."""
    character_id = "execute_test_char"
    await game_client.join(character_id)

    executor = AsyncToolExecutor(game_client, character_id)

    result = await executor.execute_tool(
        "plot_course", {"from_sector": 0, "to_sector": 5}
    )
    assert result["success"] is True

    result = await executor.execute_tool("my_status", {})
    assert result["success"] is True
    assert result["current_sector"] == 0


@pytest.mark.asyncio
async def test_multiple_paths(game_client):
    """Test pathfinding between various sectors."""
    test_cases = [
        (0, 1),
        (0, 5),
        (0, 9),
        (3, 8),
        (2, 5),
    ]

    for from_sector, to_sector in test_cases:
        result = await game_client.plot_course(from_sector, to_sector)
        assert result.path[0] == from_sector
        assert result.path[-1] == to_sector
        assert result.distance == len(result.path) - 1


@pytest.mark.asyncio
async def test_path_to_same_sector(game_client):
    """Test that plotting to same sector returns single-element path."""
    result = await game_client.plot_course(3, 3)
    assert result.path == [3]
    assert result.distance == 0

