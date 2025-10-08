"""Integration tests for AsyncGameClient API methods.

These tests verify that AsyncGameClient methods correctly call server endpoints
and handle responses. They require a running game server on localhost:8000.

To run these tests, start the game server:
    uv run python -m game-server

Then run the tests:
    uv run pytest tests/test_async_game_client.py -v
"""

import sys
from pathlib import Path

import pytest
import pytest_asyncio

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.api_client import AsyncGameClient, RPCError  # noqa: E402


pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def client():
    """Create an AsyncGameClient for testing.

    Note: This requires a running game server on localhost:8000.
    If the server is not running, tests will fail with connection errors.
    """
    client = AsyncGameClient(
        base_url="http://localhost:8000",
        character_id="test_client_char",
    )
    try:
        yield client
    finally:
        await client.close()


class TestJoinAPI:
    """Tests for join() API method."""

    async def test_join_success(self, client):
        """Test successful join."""
        result = await client.join("test_client_char")

        assert isinstance(result, dict)
        assert result["player"]["id"] == "test_client_char"
        assert result["player"]["name"] == "test_client_char"
        assert "sector" in result
        assert "ship" in result
        assert result["sector"]["id"] == 0
        assert "adjacent_sectors" in result["sector"]

    async def test_join_with_ship_type(self, client):
        """Test join with specified ship type."""
        result = await client.join("test_client_char", ship_type="kestrel_courier")

        assert result["player"]["id"] == "test_client_char"
        assert result["ship"]["ship_type"] == "kestrel_courier"

    async def test_join_wrong_character_id(self, client):
        """Test join with mismatched character_id raises error."""
        with pytest.raises(ValueError, match="bound to character_id"):
            await client.join("wrong_char_id")


class TestMoveAPI:
    """Tests for move() API method."""

    async def test_move_success(self, client):
        """Test successful move to adjacent sector."""
        join_result = await client.join("test_client_char")

        # Get actual adjacent sectors from join response
        adjacent = join_result["sector"]["adjacent_sectors"]
        assert len(adjacent) > 0, "No adjacent sectors found"

        # Move to first adjacent sector
        target = adjacent[0]
        result = await client.move(to_sector=target, character_id="test_client_char")

        assert isinstance(result, dict)
        assert result["summary"] == f"Moved to sector {target}"
        status = await client.my_status(character_id="test_client_char")
        assert status["sector"]["id"] == target

    async def test_move_non_adjacent_fails(self, client):
        """Test move to non-adjacent sector fails."""
        await client.join("test_client_char")

        with pytest.raises(RPCError) as exc_info:
            await client.move(to_sector=9, character_id="test_client_char")

        assert exc_info.value.status == 400

    async def test_move_wrong_character_id(self, client):
        """Test move with mismatched character_id raises error."""
        await client.join("test_client_char")

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.move(to_sector=1, character_id="wrong_char")


class TestMyStatusAPI:
    """Tests for my_status() API method."""

    async def test_my_status_success(self, client):
        """Test successful status check."""
        await client.join("test_client_char")

        result = await client.my_status(character_id="test_client_char")

        assert result["player"]["name"] == "test_client_char"
        assert "sector" in result
        assert "ship" in result

    async def test_my_status_after_move(self, client):
        """Test status reflects movement."""
        join_result = await client.join("test_client_char")

        # Get an adjacent sector
        adjacent = join_result["sector"]["adjacent_sectors"]
        target = adjacent[0]

        await client.move(to_sector=target, character_id="test_client_char")

        result = await client.my_status(character_id="test_client_char")

        assert result["sector"]["id"] == target

    async def test_my_status_wrong_character_id(self, client):
        """Test my_status with mismatched character_id raises error."""
        await client.join("test_client_char")

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.my_status(character_id="wrong_char")


class TestPlotCourseAPI:
    """Tests for plot_course() API method."""

    async def test_plot_course_success(self, client):
        """Test successful course plotting."""
        join_result = await client.join("test_client_char")
        start_sector = join_result["sector"]["id"]

        # Plot to a different sector
        target = 100

        result = await client.plot_course(
            to_sector=target,
            character_id="test_client_char"
        )

        assert isinstance(result, dict)
        assert "path" in result
        assert "distance" in result
        assert result["path"][0] == start_sector
        assert result["path"][-1] == target

    async def test_plot_course_to_same_sector(self, client):
        """Test plotting course to current sector."""
        await client.join("test_client_char")

        result = await client.plot_course(
            to_sector=0,
            character_id="test_client_char"
        )

        assert result["path"] == [0]
        assert result["distance"] == 0

    async def test_plot_course_wrong_character_id(self, client):
        """Test plot_course with mismatched character_id raises error."""
        await client.join("test_client_char")

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.plot_course(to_sector=5, character_id="wrong_char")


class TestMyMapAPI:
    """Tests for my_map() API method."""

    async def test_my_map_success(self, client):
        """Test successful map retrieval."""
        await client.join("test_client_char")

        result = await client.my_map(character_id="test_client_char")

        assert isinstance(result, dict)
        assert result["character_id"] == "test_client_char"
        assert "sectors_visited" in result

    async def test_my_map_wrong_character_id(self, client):
        """Test my_map with mismatched character_id raises error."""
        await client.join("test_client_char")

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.my_map(character_id="wrong_char")


class TestServerStatusAPI:
    """Tests for server_status() API method."""

    async def test_server_status_success(self, client):
        """Test successful server status check."""
        result = await client.server_status()

        assert isinstance(result, dict)
        assert result["name"] == "Gradient Bang"
        assert "version" in result
        assert result["status"] == "running"
        assert "sectors" in result
        assert isinstance(result["sectors"], int)
        assert result["sectors"] > 0


class TestTradeAPIs:
    """Tests for check_trade() and trade() API methods."""

    async def test_check_trade_success(self, client):
        """Test successful trade preview."""
        await client.join("test_client_char")

        # This will likely fail if no port, but tests the API call structure
        try:
            result = await client.check_trade(
                commodity="fuel_ore",
                quantity=10,
                trade_type="buy",
                character_id="test_client_char"
            )
            assert isinstance(result, dict)
        except RPCError:
            # Expected if no port in sector 0
            pass

    async def test_check_trade_wrong_character_id(self, client):
        """Test check_trade with mismatched character_id raises error."""
        await client.join("test_client_char")

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.check_trade(
                commodity="fuel_ore",
                quantity=10,
                trade_type="buy",
                character_id="wrong_char"
            )

    async def test_trade_wrong_character_id(self, client):
        """Test trade with mismatched character_id raises error."""
        await client.join("test_client_char")

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.trade(
                commodity="fuel_ore",
                quantity=10,
                trade_type="buy",
                character_id="wrong_char"
            )


class TestRechargeWarpPowerAPI:
    """Tests for recharge_warp_power() API method."""

    async def test_recharge_warp_power_wrong_character_id(self, client):
        """Test recharge_warp_power with mismatched character_id raises error."""
        await client.join("test_client_char")

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.recharge_warp_power(
                units=10,
                character_id="wrong_char"
            )


class TestTransferWarpPowerAPI:
    """Tests for transfer_warp_power() API method."""

    async def test_transfer_warp_power_wrong_character_id(self, client):
        """Test transfer_warp_power with mismatched character_id raises error."""
        await client.join("test_client_char")

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.transfer_warp_power(
                to_character_id="other_char",
                units=10,
                character_id="wrong_char"
            )


class TestSendMessageAPI:
    """Tests for send_message() API method."""

    async def test_send_message_broadcast(self, client):
        """Test sending broadcast message."""
        await client.join("test_client_char")

        result = await client.send_message(
            content="Test message",
            msg_type="broadcast",
            character_id="test_client_char"
        )

        assert isinstance(result, dict)

    async def test_send_message_wrong_character_id(self, client):
        """Test send_message with mismatched character_id raises error."""
        await client.join("test_client_char")

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.send_message(
                content="Test",
                character_id="wrong_char"
            )


class TestCombatAPIs:
    """Tests for combat-related API methods."""

    async def test_combat_leave_fighters_wrong_character_id(self, client):
        """Test combat_leave_fighters with mismatched character_id raises error."""
        await client.join("test_client_char")

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.combat_leave_fighters(
                sector=0,
                quantity=10,
                mode="offensive",
                toll_amount=0,
                character_id="wrong_char"
            )

    async def test_combat_collect_fighters_wrong_character_id(self, client):
        """Test combat_collect_fighters with mismatched character_id raises error."""
        await client.join("test_client_char")

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.combat_collect_fighters(
                sector=0,
                quantity=10,
                character_id="wrong_char"
            )

    async def test_salvage_collect_wrong_character_id(self, client):
        """Test salvage_collect with mismatched character_id raises error."""
        await client.join("test_client_char")

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.salvage_collect(
                salvage_id="test_salvage",
                character_id="wrong_char"
            )


class TestLocalMapQueryAPIs:
    """Tests for local map query API methods."""

    async def test_local_map_region_basic(self, client):
        """Test local_map_region with default parameters."""
        await client.join("test_client_char")

        result = await client.local_map_region(character_id="test_client_char")

        assert isinstance(result, dict)
        assert "center_sector" in result
        assert "sectors" in result
        assert "total_sectors" in result
        assert "total_visited" in result
        assert "total_unvisited" in result

    async def test_local_map_region_with_params(self, client):
        """Test local_map_region with custom parameters."""
        await client.join("test_client_char")

        result = await client.local_map_region(
            character_id="test_client_char",
            center_sector=0,
            max_hops=2,
            max_sectors=50
        )

        assert isinstance(result, dict)
        assert result["center_sector"] == 0
        assert result["total_sectors"] <= 50

    async def test_local_map_region_wrong_character_id(self, client):
        """Test local_map_region with mismatched character_id raises error."""
        await client.join("test_client_char")

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.local_map_region(character_id="wrong_char")

    async def test_list_known_ports_basic(self, client):
        """Test list_known_ports with default parameters."""
        await client.join("test_client_char")

        result = await client.list_known_ports(character_id="test_client_char")

        assert isinstance(result, dict)
        assert "from_sector" in result
        assert "ports" in result
        assert "total_ports_found" in result
        assert "searched_sectors" in result

    async def test_list_known_ports_with_filters(self, client):
        """Test list_known_ports with various filters."""
        await client.join("test_client_char")

        result = await client.list_known_ports(
            character_id="test_client_char",
            from_sector=0,
            max_hops=3,
            port_type="BBB"
        )

        assert isinstance(result, dict)
        assert result["from_sector"] == 0

    async def test_list_known_ports_commodity_filter(self, client):
        """Test list_known_ports with commodity filter."""
        await client.join("test_client_char")

        result = await client.list_known_ports(
            character_id="test_client_char",
            commodity="equipment",
            trade_type="buy"
        )

        assert isinstance(result, dict)
        assert "ports" in result

    async def test_list_known_ports_wrong_character_id(self, client):
        """Test list_known_ports with mismatched character_id raises error."""
        await client.join("test_client_char")

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.list_known_ports(character_id="wrong_char")

    async def test_path_with_region_basic(self, client):
        """Test path_with_region with default parameters."""
        await client.join("test_client_char")

        # Use plot_course first to find a valid destination
        course = await client.plot_course(to_sector=1, character_id="test_client_char")
        assert "path" in course

        result = await client.path_with_region(
            to_sector=1,
            character_id="test_client_char"
        )

        assert isinstance(result, dict)
        assert "path" in result
        assert "distance" in result
        assert "sectors" in result
        assert "total_sectors" in result
        assert "known_sectors" in result
        assert "unknown_sectors" in result

    async def test_path_with_region_with_params(self, client):
        """Test path_with_region with custom parameters."""
        await client.join("test_client_char")

        result = await client.path_with_region(
            to_sector=1,
            character_id="test_client_char",
            region_hops=2,
            max_sectors=100
        )

        assert isinstance(result, dict)
        assert result["total_sectors"] <= 100

    async def test_path_with_region_wrong_character_id(self, client):
        """Test path_with_region with mismatched character_id raises error."""
        await client.join("test_client_char")

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.path_with_region(
                to_sector=1,
                character_id="wrong_char"
            )
