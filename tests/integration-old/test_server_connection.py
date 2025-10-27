"""Tests for server/connection.py WebSocket connection management."""

import asyncio
import pytest
from unittest.mock import AsyncMock, Mock, patch
from fastapi import HTTPException

import sys
from pathlib import Path

# Add game-server to path for imports
REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "game-server"))

from rpc.connection import Connection, send_initial_status


class TestConnection:
    """Test Connection class."""

    def test_init(self):
        """Test Connection initialization."""
        mock_ws = Mock()
        conn = Connection(mock_ws)

        assert conn.websocket is mock_ws
        assert len(conn.connection_id) > 0
        assert conn.character_id is None
        assert isinstance(conn._send_lock, asyncio.Lock)

    @pytest.mark.asyncio
    async def test_send_event_basic(self):
        """Test basic event sending."""
        mock_ws = AsyncMock()
        conn = Connection(mock_ws)

        envelope = {
            "frame_type": "event",
            "event": "test.event",
            "payload": {"data": "value"},
        }

        await conn.send_event(envelope)

        mock_ws.send_json.assert_called_once_with(envelope)

    @pytest.mark.asyncio
    async def test_send_event_concurrent_safety(self):
        """Test that concurrent send_event calls are serialized."""
        mock_ws = AsyncMock()
        # Add small delay to send_json to simulate network latency
        async def delayed_send(data):
            await asyncio.sleep(0.01)
        mock_ws.send_json.side_effect = delayed_send

        conn = Connection(mock_ws)

        # Send multiple events concurrently
        tasks = [
            conn.send_event({"event": f"event_{i}"})
            for i in range(5)
        ]
        await asyncio.gather(*tasks)

        # All events should have been sent
        assert mock_ws.send_json.call_count == 5

    def test_match_character_no_character_set(self):
        """Test match_character when no character is set."""
        conn = Connection(Mock())

        assert not conn.match_character("trader")
        assert not conn.match_character("hunter")

    def test_match_character_set(self):
        """Test match_character when character is set."""
        conn = Connection(Mock())
        conn.set_character("trader")

        assert conn.match_character("trader")
        assert not conn.match_character("hunter")
        assert not conn.match_character("pirate")

    def test_set_character_first_time(self):
        """Test setting character for the first time."""
        conn = Connection(Mock())
        conn.set_character("trader")

        assert conn.character_id == "trader"

    def test_set_character_same_id_allowed(self):
        """Test setting same character ID multiple times is allowed."""
        conn = Connection(Mock())
        conn.set_character("trader")
        conn.set_character("trader")  # Should not raise

        assert conn.character_id == "trader"

    def test_set_character_different_id_raises(self):
        """Test setting different character ID raises ValueError."""
        conn = Connection(Mock())
        conn.set_character("trader")

        with pytest.raises(ValueError, match="already associated with character 'trader'"):
            conn.set_character("hunter")


class TestSendInitialStatus:
    """Test send_initial_status function."""

    @pytest.mark.asyncio
    async def test_send_initial_status_success(self):
        """Test successful initial status send."""
        mock_ws = AsyncMock()
        conn = Connection(mock_ws)

        # Mock world object
        mock_world = Mock()
        mock_world.characters = {"trader": Mock()}

        # Mock build_status_payload
        expected_payload = {"sector": 42, "ship": {"warp_power": 100}}
        with patch("rpc.connection.build_status_payload", AsyncMock(return_value=expected_payload)):
            await send_initial_status(conn, "trader", mock_world)

        # Verify send_json was called with correct envelope
        mock_ws.send_json.assert_called_once()
        envelope = mock_ws.send_json.call_args[0][0]

        assert envelope["frame_type"] == "event"
        assert envelope["event"] == "status.update"
        assert envelope["payload"] == expected_payload
        assert envelope["character_filter"] == ["trader"]

    @pytest.mark.asyncio
    async def test_send_initial_status_character_not_found(self):
        """Test send_initial_status with non-existent character."""
        mock_ws = AsyncMock()
        conn = Connection(mock_ws)

        # Mock world with no characters
        mock_world = Mock()
        mock_world.characters = {}

        with pytest.raises(HTTPException) as exc_info:
            await send_initial_status(conn, "trader", mock_world)

        assert exc_info.value.status_code == 404
        assert "not found" in exc_info.value.detail.lower()

    @pytest.mark.asyncio
    async def test_send_initial_status_payload_integration(self):
        """Test that send_initial_status calls build_status_payload correctly."""
        mock_ws = AsyncMock()
        conn = Connection(mock_ws)

        mock_world = Mock()
        mock_world.characters = {"trader": Mock()}

        mock_payload = {"test": "data"}
        with patch("rpc.connection.build_status_payload", AsyncMock(return_value=mock_payload)) as mock_build:
            await send_initial_status(conn, "trader", mock_world)

            # Verify build_status_payload was called correctly
            mock_build.assert_called_once_with(mock_world, "trader")
