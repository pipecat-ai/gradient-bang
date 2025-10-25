"""Integration tests for AsyncGameClient API methods.

These tests verify that AsyncGameClient methods correctly call server endpoints
and handle responses. They require a running game server on localhost:8000.

To run these tests, start the game server:
    uv run python -m game-server

Then run the tests:
    uv run pytest tests/test_async_game_client.py -v
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any, Awaitable, Callable, Dict, Tuple
import sys
from pathlib import Path

import pytest
import pytest_asyncio

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.api_client import AsyncGameClient, RPCError  # noqa: E402


pytestmark = pytest.mark.asyncio


EventPredicate = Callable[[Dict[str, Any]], bool]


async def _run_and_wait_for_event(
    client: AsyncGameClient,
    *,
    event_name: str,
    action_coro: Awaitable[Dict[str, Any]],
    predicate: EventPredicate | None = None,
    timeout: float = 6.0,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Execute an RPC and wait for the corresponding event payload."""

    waiter = asyncio.create_task(
        client.wait_for_event(event_name, predicate=predicate, timeout=timeout)
    )
    try:
        result = await action_coro
    except Exception:
        waiter.cancel()
        raise
    event = await waiter
    return result, event


def _player_predicate(character_id: str) -> EventPredicate:
    return (
        lambda evt: evt.get("payload", {})
        .get("player", {})
        .get("id") == character_id
    )


def _source_method_predicate(method: str) -> EventPredicate:
    return (
        lambda evt: evt.get("payload", {})
        .get("source", {})
        .get("method") == method
    )


def _char_id(client: AsyncGameClient) -> str:
    return client.character_id


def _display_name(client: AsyncGameClient) -> str:
    return getattr(client, "_display_name", client.character_id)


@pytest_asyncio.fixture
async def client():
    """Create an AsyncGameClient backed by a freshly registered character."""

    base_url = "http://localhost:8000"
    admin_client = AsyncGameClient(base_url=base_url, character_id="test_admin_helper")
    display_name = f"Test Client {uuid.uuid4().hex[:8]}"
    create_result = await admin_client.character_create(
        admin_password="",
        name=display_name,
        player={"credits": 1000},
    )
    character_id = create_result["character_id"]
    await admin_client.close()

    client = AsyncGameClient(base_url=base_url, character_id=character_id)
    client._display_name = display_name  # for assertions
    try:
        yield client
    finally:
        await client.close()


class TestJoinAPI:
    """Tests for join() API method."""

    async def test_join_success(self, client):
        """Test successful join."""
        result, status_event = await _run_and_wait_for_event(
            client,
            event_name="status.snapshot",
            action_coro=client.join(_char_id(client)),
            predicate=_player_predicate(_char_id(client)),
        )

        assert isinstance(result, dict)
        assert result["success"] is True

        payload = status_event["payload"]
        assert payload["player"]["id"] == _char_id(client)
        assert payload["player"]["name"] == _display_name(client)
        assert "sector" in payload
        assert "ship" in payload
        assert payload["sector"]["id"] == 0
        assert "adjacent_sectors" in payload["sector"]

    async def test_join_with_ship_type(self, client):
        """Test join with specified ship type."""
        result, status_event = await _run_and_wait_for_event(
            client,
            event_name="status.snapshot",
            action_coro=client.join(_char_id(client), ship_type="kestrel_courier"),
            predicate=_player_predicate(_char_id(client)),
        )

        assert result["success"] is True
        assert status_event["payload"]["ship"]["ship_type"] == "kestrel_courier"

    async def test_join_wrong_character_id(self, client):
        """Test join with mismatched character_id raises error."""
        with pytest.raises(ValueError, match="bound to character_id"):
            await client.join("wrong_char_id")


class TestMoveAPI:
    """Tests for move() API method."""

    async def test_move_success(self, client):
        """Test successful move to adjacent sector."""
        _, status_event = await _run_and_wait_for_event(
            client,
            event_name="status.snapshot",
            action_coro=client.join(_char_id(client)),
            predicate=_player_predicate(_char_id(client)),
        )

        # Get actual adjacent sectors from join response
        adjacent = status_event["payload"]["sector"]["adjacent_sectors"]
        assert len(adjacent) > 0, "No adjacent sectors found"

        # Move to first adjacent sector
        target = adjacent[0]
        result, move_event = await _run_and_wait_for_event(
            client,
            event_name="movement.complete",
            action_coro=client.move(to_sector=target, character_id=_char_id(client)),
            predicate=_player_predicate(_char_id(client)),
        )

        assert isinstance(result, dict)
        assert result.get("success") is True
        assert move_event["payload"]["sector"]["id"] == target

    async def test_move_non_adjacent_fails(self, client):
        """Test move to non-adjacent sector fails."""
        await client.join(_char_id(client))

        with pytest.raises(RPCError) as exc_info:
            await client.move(to_sector=9, character_id=_char_id(client))

        assert exc_info.value.status == 400

    async def test_move_wrong_character_id(self, client):
        """Test move with mismatched character_id raises error."""
        await client.join(_char_id(client))

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.move(to_sector=1, character_id="wrong_char")


class TestMyStatusAPI:
    """Tests for my_status() API method."""

    async def test_my_status_success(self, client):
        """Test successful status check."""
        await client.join(_char_id(client))

        result, status_event = await _run_and_wait_for_event(
            client,
            event_name="status.snapshot",
            action_coro=client.my_status(character_id=_char_id(client)),
            predicate=_source_method_predicate("my_status"),
        )

        assert result["success"] is True
        payload = status_event["payload"]
        assert payload["player"]["name"] == _display_name(client)
        assert "sector" in payload
        assert "ship" in payload

    async def test_my_status_after_move(self, client):
        """Test status reflects movement."""
        _, status_event = await _run_and_wait_for_event(
            client,
            event_name="status.snapshot",
            action_coro=client.join(_char_id(client)),
            predicate=_player_predicate(_char_id(client)),
        )

        # Get an adjacent sector
        adjacent = status_event["payload"]["sector"]["adjacent_sectors"]
        target = adjacent[0]

        await _run_and_wait_for_event(
            client,
            event_name="movement.complete",
            action_coro=client.move(to_sector=target, character_id=_char_id(client)),
            predicate=_player_predicate(_char_id(client)),
        )

        _, status_event = await _run_and_wait_for_event(
            client,
            event_name="status.snapshot",
            action_coro=client.my_status(character_id=_char_id(client)),
            predicate=_source_method_predicate("my_status"),
        )

        assert status_event["payload"]["sector"]["id"] == target

    async def test_my_status_wrong_character_id(self, client):
        """Test my_status with mismatched character_id raises error."""
        await client.join(_char_id(client))

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.my_status(character_id="wrong_char")


class TestPlotCourseAPI:
    """Tests for plot_course() API method."""

    async def test_plot_course_success(self, client):
        """Test successful course plotting."""
        _, status_event = await _run_and_wait_for_event(
            client,
            event_name="status.snapshot",
            action_coro=client.join(_char_id(client)),
            predicate=_player_predicate(_char_id(client)),
        )
        start_sector = status_event["payload"]["sector"]["id"]

        # Plot to a different sector
        target = 100

        result, course_event = await _run_and_wait_for_event(
            client,
            event_name="course.plot",
            action_coro=client.plot_course(to_sector=target, character_id=_char_id(client)),
            predicate=_source_method_predicate("plot_course"),
        )

        payload = course_event["payload"]
        assert isinstance(result, dict)
        assert result["success"] is True
        assert payload["path"][0] == start_sector
        assert payload["path"][-1] == target

    async def test_plot_course_to_same_sector(self, client):
        """Test plotting course to current sector."""
        await client.join(_char_id(client))

        result, course_event = await _run_and_wait_for_event(
            client,
            event_name="course.plot",
            action_coro=client.plot_course(to_sector=0, character_id=_char_id(client)),
            predicate=_source_method_predicate("plot_course"),
        )

        payload = course_event["payload"]
        assert payload["path"] == [0]
        assert payload["distance"] == 0

    async def test_plot_course_wrong_character_id(self, client):
        """Test plot_course with mismatched character_id raises error."""
        await client.join(_char_id(client))

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.plot_course(to_sector=5, character_id="wrong_char")


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
    """Tests for trade() API method."""

    async def test_trade_wrong_character_id(self, client):
        """Test trade with mismatched character_id raises error."""
        await client.join(_char_id(client))

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.trade(
                commodity="quantum_foam",
                quantity=10,
                trade_type="buy",
                character_id="wrong_char"
            )


class TestRechargeWarpPowerAPI:
    """Tests for recharge_warp_power() API method."""

    async def test_recharge_warp_power_wrong_character_id(self, client):
        """Test recharge_warp_power with mismatched character_id raises error."""
        await client.join(_char_id(client))

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.recharge_warp_power(
                units=10,
                character_id="wrong_char"
            )


class TestTransferWarpPowerAPI:
    """Tests for transfer_warp_power() API method."""

    async def test_transfer_warp_power_wrong_character_id(self, client):
        """Test transfer_warp_power with mismatched character_id raises error."""
        await client.join(_char_id(client))

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
        await client.join(_char_id(client))

        result = await client.send_message(
            content="Test message",
            msg_type="broadcast",
            character_id=_char_id(client)
        )

        assert isinstance(result, dict)

    async def test_send_message_wrong_character_id(self, client):
        """Test send_message with mismatched character_id raises error."""
        await client.join(_char_id(client))

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.send_message(
                content="Test",
                character_id="wrong_char"
            )


class TestCombatAPIs:
    """Tests for combat-related API methods."""

    async def test_combat_leave_fighters_wrong_character_id(self, client):
        """Test combat_leave_fighters with mismatched character_id raises error."""
        await client.join(_char_id(client))

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
        await client.join(_char_id(client))

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.combat_collect_fighters(
                sector=0,
                quantity=10,
                character_id="wrong_char"
            )

    async def test_salvage_collect_wrong_character_id(self, client):
        """Test salvage_collect with mismatched character_id raises error."""
        await client.join(_char_id(client))

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.salvage_collect(
                salvage_id="test_salvage",
                character_id="wrong_char"
            )


class TestLocalMapQueryAPIs:
    """Tests for local map query API methods."""

    async def test_local_map_region_basic(self, client):
        """Test local_map_region with default parameters."""
        await client.join(_char_id(client))

        result, map_event = await _run_and_wait_for_event(
            client,
            event_name="map.local",
            action_coro=client.local_map_region(character_id=_char_id(client)),
            predicate=_source_method_predicate("local_map_region"),
        )

        payload = map_event["payload"]
        assert isinstance(result, dict)
        assert result["success"] is True
        assert "center_sector" in payload
        assert "sectors" in payload
        assert "total_sectors" in payload
        assert "total_visited" in payload
        assert "total_unvisited" in payload

    async def test_local_map_region_with_params(self, client):
        """Test local_map_region with custom parameters."""
        await client.join(_char_id(client))

        _, map_event = await _run_and_wait_for_event(
            client,
            event_name="map.local",
            action_coro=client.local_map_region(
                character_id=_char_id(client),
                center_sector=0,
                max_hops=2,
                max_sectors=50,
            ),
            predicate=_source_method_predicate("local_map_region"),
        )

        payload = map_event["payload"]
        assert payload["center_sector"] == 0
        assert payload["total_sectors"] <= 50

    async def test_local_map_region_wrong_character_id(self, client):
        """Test local_map_region with mismatched character_id raises error."""
        await client.join(_char_id(client))

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.local_map_region(character_id="wrong_char")

    async def test_list_known_ports_basic(self, client):
        """Test list_known_ports with default parameters."""
        await client.join(_char_id(client))

        result, ports_event = await _run_and_wait_for_event(
            client,
            event_name="ports.list",
            action_coro=client.list_known_ports(character_id=_char_id(client)),
            predicate=_source_method_predicate("list_known_ports"),
        )

        payload = ports_event["payload"]
        assert isinstance(result, dict)
        assert result["success"] is True
        assert "from_sector" in payload
        assert "ports" in payload
        assert "total_ports_found" in payload
        assert "searched_sectors" in payload

    async def test_list_known_ports_with_filters(self, client):
        """Test list_known_ports with various filters."""
        await client.join(_char_id(client))

        _, ports_event = await _run_and_wait_for_event(
            client,
            event_name="ports.list",
            action_coro=client.list_known_ports(
                character_id=_char_id(client),
                from_sector=0,
                max_hops=3,
                port_type="BBB",
            ),
            predicate=_source_method_predicate("list_known_ports"),
        )

        payload = ports_event["payload"]
        assert payload["from_sector"] == 0
        assert payload["max_hops"] == 3
        assert payload["port_type"] == "BBB"

    async def test_list_known_ports_commodity_filter(self, client):
        """Test list_known_ports with commodity filter."""
        await client.join(_char_id(client))

        _, ports_event = await _run_and_wait_for_event(
            client,
            event_name="ports.list",
            action_coro=client.list_known_ports(
                character_id=_char_id(client),
                commodity="neuro_symbolics",
                trade_type="buy",
            ),
            predicate=_source_method_predicate("list_known_ports"),
        )

        assert "ports" in ports_event["payload"]

    async def test_list_known_ports_wrong_character_id(self, client):
        """Test list_known_ports with mismatched character_id raises error."""
        await client.join(_char_id(client))

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.list_known_ports(character_id="wrong_char")

    async def test_path_with_region_basic(self, client):
        """Test path_with_region with default parameters."""
        await client.join(_char_id(client))

        # Use plot_course first to find a valid destination
        _, course_event = await _run_and_wait_for_event(
            client,
            event_name="course.plot",
            action_coro=client.plot_course(to_sector=1, character_id=_char_id(client)),
            predicate=_source_method_predicate("plot_course"),
        )
        assert "path" in course_event["payload"]

        _, region_event = await _run_and_wait_for_event(
            client,
            event_name="path.region",
            action_coro=client.path_with_region(
                to_sector=1,
                character_id=_char_id(client),
            ),
            predicate=_source_method_predicate("path_with_region"),
        )

        payload = region_event["payload"]
        assert "path" in payload
        assert "distance" in payload
        assert "sectors" in payload
        assert "total_sectors" in payload
        assert "known_sectors" in payload
        assert "unknown_sectors" in payload

    async def test_path_with_region_with_params(self, client):
        """Test path_with_region with custom parameters."""
        await client.join(_char_id(client))

        _, region_event = await _run_and_wait_for_event(
            client,
            event_name="path.region",
            action_coro=client.path_with_region(
                to_sector=1,
                character_id=_char_id(client),
                region_hops=2,
                max_sectors=100,
            ),
            predicate=_source_method_predicate("path_with_region"),
        )

        payload = region_event["payload"]
        assert payload["total_sectors"] <= 100

    async def test_path_with_region_wrong_character_id(self, client):
        """Test path_with_region with mismatched character_id raises error."""
        await client.join(_char_id(client))

        with pytest.raises(ValueError, match="bound to character_id"):
            await client.path_with_region(
                to_sector=1,
                character_id="wrong_char"
            )
