"""Tests for utils modules."""

import asyncio
import asyncio
import pytest
from unittest.mock import Mock, patch, AsyncMock
import sys
from pathlib import Path
from typing import Any, Dict

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.api_client import AsyncGameClient
try:
    from utils.game_tools import AsyncToolExecutor, get_tool_definitions  # type: ignore
except Exception:  # pragma: no cover
    AsyncToolExecutor = None  # type: ignore
    def get_tool_definitions():  # type: ignore
        return {}
try:
    from utils.prompts import create_system_prompt, create_npc_task_prompt, format_tool_result  # type: ignore
except Exception:  # pragma: no cover
    create_system_prompt = None
    create_npc_task_prompt = None
    format_tool_result = None


class TestAsyncGameClient:
    """Tests for AsyncGameClient class."""

    pytestmark = pytest.mark.asyncio

    @patch.object(AsyncGameClient, "_request", new_callable=AsyncMock)
    async def test_join(self, mock_request):
        """Test join method."""
        mock_request.return_value = {"success": True}

        async with AsyncGameClient(character_id="test_char") as client:
            result = await client.join("test_char")

        assert isinstance(result, dict)
        assert result == {"success": True}
        mock_request.assert_awaited_once_with("join", {"character_id": "test_char"})

    @patch.object(AsyncGameClient, "_request", new_callable=AsyncMock)
    async def test_move(self, mock_request):
        """Test move method."""
        mock_request.return_value = {"success": True}

        async with AsyncGameClient(character_id="test_char") as client:
            result = await client.move(5, "test_char")

        assert isinstance(result, dict)
        assert result == {"success": True}
        mock_request.assert_awaited_with(
            "move", {"character_id": "test_char", "to_sector": 5}
        )

    @patch.object(AsyncGameClient, "_request", new_callable=AsyncMock)
    async def test_plot_course(self, mock_request):
        """Test plot_course method."""
        mock_request.return_value = {"success": True}

        async with AsyncGameClient(character_id="test_char") as client:
            result = await client.plot_course(10, "test_char")

        assert isinstance(result, dict)
        assert result == {"success": True}
        mock_request.assert_awaited_with(
            "plot_course", {"character_id": "test_char", "to_sector": 10}
        )

    @patch.object(AsyncGameClient, "_request", new_callable=AsyncMock)
    async def test_my_status(self, mock_request):
        """Test my_status method."""
        mock_request.return_value = {"success": True}

        async with AsyncGameClient(character_id="test_char") as client:
            result = await client.my_status("test_char")

        assert isinstance(result, dict)
        assert result == {"success": True}
        mock_request.assert_awaited_with(
            "my_status", {"character_id": "test_char"}
        )

    @patch.object(AsyncGameClient, "_request", new_callable=AsyncMock)
    async def test_server_status(self, mock_request):
        """Test server_status method."""
        mock_request.return_value = {
            "name": "Gradient Bang",
            "version": "0.1.0",
            "status": "running",
            "sectors": 5000
        }

        async with AsyncGameClient(character_id="test_char") as client:
            result = await client.server_status()

        assert result["name"] == "Gradient Bang"
        assert result["sectors"] == 5000
        mock_request.assert_awaited_with("server_status", {})

    @pytest.mark.asyncio
    async def test_pause_and_resume_event_delivery(self):
        """Events buffer until delivery is resumed."""
        client = AsyncGameClient(character_id="test_char")
        client.pause_event_delivery()

        queue = client.get_event_queue("status.snapshot")
        calls: list[Dict[str, Any]] = []

        @client.on("status.snapshot")
        def _on_status(event: Dict[str, Any]) -> None:
            calls.append(event)

        payload = {
            "player": {"name": "test_char"},
            "ship": {"cargo": {}, "cargo_capacity": 0, "warp_power": 0, "warp_power_capacity": 0, "shields": 0, "max_shields": 0, "fighters": 0},
            "sector": {"id": 1, "adjacent_sectors": [], "port": None, "players": []},
        }

        await client._process_event("status.snapshot", payload)
        assert queue.empty()
        assert not calls

        await client.resume_event_delivery()
        await asyncio.sleep(0)

        assert not queue.empty()
        event = queue.get_nowait()
        assert event["payload"] is payload
        assert calls and calls[0] == event

        await client.close()

    async def test_get_event_queue_receives_event(self):
        """Event queues should receive formatted event messages."""
        client = AsyncGameClient(character_id="test_char")
        queue = client.get_event_queue("status.snapshot")

        payload = {"player": {"id": "test_char"}}
        await client._process_event("status.snapshot", payload)

        event = await asyncio.wait_for(queue.get(), timeout=0.1)
        assert event["event_name"] == "status.snapshot"
        assert event["payload"] is payload

        await client.close()

    async def test_synthesize_error_event_emits_error_event(self):
        """Synthesized error events should match the event-driven schema."""
        client = AsyncGameClient(character_id="test_char")
        queue = client.get_event_queue("error")

        error_payload = {"status": 400, "detail": "Invalid move", "code": "invalid_sector"}
        await client._synthesize_error_event(
            endpoint="move",
            request_id="req-123",
            error_payload=error_payload,
        )

        event = await asyncio.wait_for(queue.get(), timeout=0.1)
        payload = event["payload"]
        assert event["event_name"] == "error"
        assert payload["endpoint"] == "move"
        assert payload["error"] == "Invalid move"
        assert payload["status"] == 400
        assert payload["code"] == "invalid_sector"
        assert payload["synthesized"] is True
        assert payload["source"]["method"] == "move"
        assert payload["source"]["request_id"] == "req-123"
        assert "timestamp" in payload["source"]

        await client.close()

    async def test_synthesize_error_event_deduplicates_request_id(self):
        """Synthetic events should not emit twice for the same request ID."""
        client = AsyncGameClient(character_id="test_char")
        queue = client.get_event_queue("error")

        error_payload = {"status": 404, "detail": "Character missing"}
        await client._synthesize_error_event(
            endpoint="my_status",
            request_id="req-dupe",
            error_payload=error_payload,
        )
        # Drain first event
        await asyncio.wait_for(queue.get(), timeout=0.1)

        await client._synthesize_error_event(
            endpoint="my_status",
            request_id="req-dupe",
            error_payload=error_payload,
        )

        await asyncio.sleep(0)
        assert queue.empty()

        await client.close()

    async def test_real_error_event_still_delivered_after_synthetic(self):
        """Server-emitted error events should still flow after a synthetic one."""
        client = AsyncGameClient(character_id="test_char")
        queue = client.get_event_queue("error")

        await client._synthesize_error_event(
            endpoint="move",
            request_id="req-live",
            error_payload={"status": 400, "detail": "Invalid"},
        )
        await asyncio.wait_for(queue.get(), timeout=0.1)

        await client._process_event(
            "error",
            {
                "endpoint": "move",
                "error": "Invalid",
                "source": {"request_id": "req-live", "method": "move", "type": "rpc"},
            },
        )

        event = await asyncio.wait_for(queue.get(), timeout=0.1)
        assert event["event_name"] == "error"
        assert event["payload"]["endpoint"] == "move"
        assert event["payload"]["source"]["request_id"] == "req-live"

        await client.close()

    async def test_failure_result_synthesizes_error_event(self):
        """Result objects with success=False should produce error events."""
        client = AsyncGameClient(character_id="test_char")
        queue = client.get_event_queue("error")

        await client._maybe_synthesize_error_from_result(
            endpoint="local_map_region",
            request_id="req-result",
            result={"success": False, "error": "Center sector must be visited"},
        )

        event = await asyncio.wait_for(queue.get(), timeout=0.1)
        payload = event["payload"]
        assert event["event_name"] == "error"
        assert payload["endpoint"] == "local_map_region"
        assert payload["error"] == "Center sector must be visited"
        assert payload["synthesized"] is True
        assert payload["source"]["request_id"] == "req-result"

        await client.close()


class TestAsyncToolExecutor:
    """Tests for AsyncToolExecutor class."""
    pytestmark = pytest.mark.asyncio
    
    async def test_plot_course_success(self):
        """Test successful plot_course execution."""
        if not AsyncToolExecutor:
            pytest.skip("AsyncToolExecutor unavailable")
        mock_client = Mock()
        mock_client.plot_course = AsyncMock(return_value={
            "path": [0, 1, 2],
            "distance": 2,
            "from_sector": 0,
            "to_sector": 2,
        })

        executor = AsyncToolExecutor(mock_client, "test_char")
        result = await executor.plot_course(0, 2)

        assert result["success"] is True
        assert result["path"] == [0, 1, 2]
        assert result["distance"] == 2
    
    async def test_move_success(self):
        """Test successful move execution."""
        if not AsyncToolExecutor:
            pytest.skip("AsyncToolExecutor unavailable")
        mock_client = Mock()
        mock_client.move = AsyncMock(return_value={
            "sector": 5,
            "name": "test_char",
            "last_active": "2024-01-01T00:00:00",
            "sector_contents": None,
        })

        executor = AsyncToolExecutor(mock_client, "test_char")
        result = await executor.move(5)

        assert result["success"] is True
        assert result["new_sector"] == 5
    
    async def test_my_status_success(self):
        """Test successful status check."""
        if not AsyncToolExecutor:
            pytest.skip("AsyncToolExecutor unavailable")
        mock_client = Mock()
        mock_client.my_status = AsyncMock(return_value={
            "sector": 10,
            "name": "test_char",
            "last_active": "2024-01-01T00:00:00",
            "sector_contents": None,
        })

        executor = AsyncToolExecutor(mock_client, "test_char")
        result = await executor.my_status()

        assert result["success"] is True
        assert result["current_sector"] == 10
    
    async def test_finish_task(self):
        """Test finish task execution."""
        if not AsyncToolExecutor:
            pytest.skip("AsyncToolExecutor unavailable")
        mock_client = Mock()
        executor = AsyncToolExecutor(mock_client, "test_char")
        
        assert executor.finished is False
        
        result = await executor.finish_task("All done!")
        
        assert result["success"] is True
        assert result["message"] == "All done!"
        assert executor.finished is True
        assert executor.finished_message == "All done!"
    
    async def test_execute_tool_unknown(self):
        """Test executing unknown tool."""
        if not AsyncToolExecutor:
            pytest.skip("AsyncToolExecutor unavailable")
        mock_client = Mock()
        executor = AsyncToolExecutor(mock_client, "test_char")

        result = await executor.execute_tool("unknown_tool", {})

        assert result["success"] is False
        assert "Unknown tool" in result["error"]

    @pytest.mark.parametrize(
        "tool_name,tool_args",
        [
            ("plot_course", {"from_sector": 1, "to_sector": 2}),
            ("move", {"to_sector": 5}),
            ("my_status", {}),
            ("my_map", {}),
            (
                "find_port",
                {"commodity": "quantum_foam", "buy_or_sell": "buy", "from_sector": 3},
            ),
            ("wait_for_time", {"seconds": 1}),
            ("finished", {"message": "Done"}),
        ],
    )
    async def test_execute_tool_delegates(self, tool_name, tool_args):
        """Test that execute_tool delegates to correct bound method."""
        if not AsyncToolExecutor:
            pytest.skip("AsyncToolExecutor unavailable")
        executor = AsyncToolExecutor(Mock(), "test_char")
        mock_method = AsyncMock(return_value={"success": True, "tool": tool_name})
        attr_name = tool_name if tool_name != "finished" else "finish_task"
        setattr(executor, attr_name, mock_method)

        result = await executor.execute_tool(tool_name, tool_args)

        assert result == {"success": True, "tool": tool_name}
        mock_method.assert_awaited_with(**tool_args)

    async def test_execute_tool_finished_default_message(self):
        """Test finished tool uses default message when none provided."""
        if not AsyncToolExecutor:
            pytest.skip("AsyncToolExecutor unavailable")
        executor = AsyncToolExecutor(Mock(), "test_char")
        result = await executor.execute_tool("finished", {})

        assert result["success"] is True
        assert result["message"] == "Task completed"


class TestPrompts:
    """Tests for prompt utilities."""
    
    def test_create_system_prompt(self):
        """Test system prompt creation."""
        if create_system_prompt is None:
            pytest.skip("Prompt utilities unavailable")
        prompt = create_system_prompt()
        
        assert "Gradient Bang" in prompt
        assert "Movement Rules" in prompt
        assert "one sector at a time" in prompt.lower()
    
    def test_create_npc_task_prompt(self):
        """Test NPC task prompt creation."""
        if create_npc_task_prompt is None:
            pytest.skip("Prompt utilities unavailable")
        task = "Move to sector 10"
        current_state = {"sector": 0, "time": "2024-01-01T00:00:00"}

        prompt = create_npc_task_prompt(task, current_state)

        assert "Move to sector 10" in prompt
        assert '"sector": 0' in prompt
        assert "## Initial State" in prompt
    
    def test_format_tool_result(self):
        """Test tool result formatting."""
        if format_tool_result is None:
            pytest.skip("Prompt utilities unavailable")
        # Test plot_course
        result = format_tool_result("plot_course", {
            "success": True,
            "path": [0, 1, 2, 3],
            "distance": 3
        })
        assert "Course plotted" in result
        assert "3 warps" in result
        
        # Test move
        result = format_tool_result("move", {
            "success": True,
            "new_sector": 10
        })
        assert "Now in sector 10" in result
        
        # Test error
        result = format_tool_result("move", {
            "success": False,
            "error": "Not adjacent"
        })
        assert "failed" in result
        assert "Not adjacent" in result



class TestToolDefinitions:
    """Tests for tool definitions."""
    
    def test_get_tool_definitions(self):
        """Test that tool definitions are properly formatted."""
        tools = get_tool_definitions()
        if not tools:
            pytest.skip("Tool definitions unavailable")
        
        assert len(tools) == 7
        
        # Check tool names
        tool_names = [t["function"]["name"] for t in tools]
        assert "plot_course" in tool_names
        assert "move" in tool_names
        assert "my_status" in tool_names
        assert "my_map" in tool_names
        assert "find_port" in tool_names
        assert "wait_for_time" in tool_names
        assert "finished" in tool_names
        
        # Check structure
        for tool in tools:
            assert tool["type"] == "function"
            assert "function" in tool
            assert "name" in tool["function"]
            assert "description" in tool["function"]
            assert "parameters" in tool["function"]
