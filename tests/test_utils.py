"""Tests for utils modules."""

import pytest
from unittest.mock import Mock, patch, AsyncMock
import httpx
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.api_client import AsyncGameClient, CharacterStatus, PlotCourseResponse
from utils.game_tools import AsyncToolExecutor, get_tool_definitions
from utils.prompts import create_system_prompt, create_npc_task_prompt, format_tool_result


class TestAsyncGameClient:
    pytestmark = pytest.mark.asyncio
    """Tests for AsyncGameClient class."""
    
    @patch("httpx.AsyncClient.post")
    async def test_join(self, mock_post):
        """Test join method."""
        mock_response = Mock()
        mock_response.json.return_value = {
            "id": "test_char",
            "sector": 0,
            "last_active": "2024-01-01T00:00:00",
            "sector_contents": {
                "port": None,
                "planets": [],
                "other_players": [],
                "adjacent_sectors": [1, 2]
            }
        }
        mock_response.raise_for_status = Mock()
        mock_post.return_value = mock_response
        
        async with AsyncGameClient() as client:
            result = await client.join("test_char")
        
        assert isinstance(result, CharacterStatus)
        assert result.id == "test_char"
        assert result.sector == 0
        assert mock_post.call_count == 2
    
    @patch("httpx.AsyncClient.post")
    async def test_move(self, mock_post):
        """Test move method."""
        mock_response = Mock()
        mock_response.json.return_value = {
            "id": "test_char",
            "sector": 5,
            "last_active": "2024-01-01T00:00:00",
            "sector_contents": {
                "port": None,
                "planets": [],
                "other_players": [],
                "adjacent_sectors": [4, 6]
            }
        }
        mock_response.raise_for_status = Mock()
        mock_post.return_value = mock_response
        
        async with AsyncGameClient() as client:
            result = await client.move("test_char", 5)
        
        assert isinstance(result, CharacterStatus)
        assert result.sector == 5
        assert mock_post.call_count == 2
    
    @patch("httpx.AsyncClient.post")
    async def test_plot_course(self, mock_post):
        """Test plot_course method."""
        mock_response = Mock()
        mock_response.json.return_value = {
            "from_sector": 0,
            "to_sector": 10,
            "path": [0, 1, 5, 10],
            "distance": 3
        }
        mock_response.raise_for_status = Mock()
        mock_post.return_value = mock_response
        
        async with AsyncGameClient() as client:
            result = await client.plot_course(0, 10)
        
        assert isinstance(result, PlotCourseResponse)
        assert result.distance == 3
        assert result.path == [0, 1, 5, 10]
        mock_post.assert_called_once()
    
    @patch("httpx.AsyncClient.post")
    async def test_my_status(self, mock_post):
        """Test my_status method."""
        mock_response = Mock()
        mock_response.json.return_value = {
            "id": "test_char",
            "sector": 42,
            "last_active": "2024-01-01T00:00:00",
            "sector_contents": {
                "port": None,
                "planets": [],
                "other_players": [],
                "adjacent_sectors": [40, 41, 43]
            }
        }
        mock_response.raise_for_status = Mock()
        mock_post.return_value = mock_response
        
        async with AsyncGameClient() as client:
            result = await client.my_status("test_char")
        
        assert isinstance(result, CharacterStatus)
        assert result.sector == 42
        assert mock_post.call_count == 2
    
    @patch("httpx.AsyncClient.get")
    async def test_server_status(self, mock_get):
        """Test server_status method."""
        mock_response = Mock()
        mock_response.json.return_value = {
            "name": "Gradient Bang",
            "version": "0.1.0",
            "status": "running",
            "sectors": 5000
        }
        mock_response.raise_for_status = Mock()
        mock_get.return_value = mock_response
        
        async with AsyncGameClient() as client:
            result = await client.server_status()
        
        assert result["name"] == "Gradient Bang"
        assert result["sectors"] == 5000
        mock_get.assert_called_once()


class TestAsyncToolExecutor:
    """Tests for AsyncToolExecutor class."""
    pytestmark = pytest.mark.asyncio
    
    async def test_plot_course_success(self):
        """Test successful plot_course execution."""
        mock_client = Mock()
        mock_client.plot_course = AsyncMock(return_value=Mock(
            path=[0, 1, 2],
            distance=2,
            from_sector=0,
            to_sector=2
        ))

        executor = AsyncToolExecutor(mock_client, "test_char")
        result = await executor.plot_course(0, 2)

        assert result["success"] is True
        assert result["path"] == [0, 1, 2]
        assert result["distance"] == 2
    
    async def test_move_success(self):
        """Test successful move execution."""
        mock_client = Mock()
        mock_client.move = AsyncMock(return_value=Mock(
            sector=5,
            id="test_char",
            last_active="2024-01-01T00:00:00",
            sector_contents=None,
        ))

        executor = AsyncToolExecutor(mock_client, "test_char")
        result = await executor.move(5)

        assert result["success"] is True
        assert result["new_sector"] == 5
    
    async def test_my_status_success(self):
        """Test successful status check."""
        mock_client = Mock()
        mock_client.my_status = AsyncMock(return_value=Mock(
            sector=10,
            id="test_char",
            last_active="2024-01-01T00:00:00",
            sector_contents=None,
        ))

        executor = AsyncToolExecutor(mock_client, "test_char")
        result = await executor.my_status()

        assert result["success"] is True
        assert result["current_sector"] == 10
    
    async def test_finish_task(self):
        """Test finish task execution."""
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
                {"commodity": "fuel_ore", "buy_or_sell": "buy", "from_sector": 3},
            ),
            ("wait_for_time", {"seconds": 1}),
            ("finished", {"message": "Done"}),
        ],
    )
    async def test_execute_tool_delegates(self, tool_name, tool_args):
        """Test that execute_tool delegates to correct bound method."""
        executor = AsyncToolExecutor(Mock(), "test_char")
        mock_method = AsyncMock(return_value={"success": True, "tool": tool_name})
        attr_name = tool_name if tool_name != "finished" else "finish_task"
        setattr(executor, attr_name, mock_method)

        result = await executor.execute_tool(tool_name, tool_args)

        assert result == {"success": True, "tool": tool_name}
        mock_method.assert_awaited_with(**tool_args)

    async def test_execute_tool_finished_default_message(self):
        """Test finished tool uses default message when none provided."""
        executor = AsyncToolExecutor(Mock(), "test_char")
        result = await executor.execute_tool("finished", {})

        assert result["success"] is True
        assert result["message"] == "Task completed"


class TestPrompts:
    """Tests for prompt utilities."""
    
    def test_create_system_prompt(self):
        """Test system prompt creation."""
        prompt = create_system_prompt()
        
        assert "Gradient Bang" in prompt
        assert "Movement Rules" in prompt
        assert "one sector at a time" in prompt.lower()
    
    def test_create_npc_task_prompt(self):
        """Test NPC task prompt creation."""
        task = "Move to sector 10"
        current_state = {"sector": 0, "time": "2024-01-01T00:00:00"}

        prompt = create_npc_task_prompt(task, current_state)

        assert "Move to sector 10" in prompt
        assert '"sector": 0' in prompt
        assert "## Initial State" in prompt
    
    def test_format_tool_result(self):
        """Test tool result formatting."""
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
        assert "Moved to sector 10" in result
        
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
