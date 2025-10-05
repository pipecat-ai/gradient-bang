"""Tests for messaging.handlers module."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from messaging.handlers import handle_send_message


@pytest.mark.asyncio
class TestHandleSendMessage:
    """Tests for handle_send_message function."""

    @patch("messaging.handlers.api_send_message")
    async def test_broadcast_message_emits_to_all(self, mock_api):
        """Test broadcast message emits to all characters without filter."""
        # Mock API response
        mock_api.handle = AsyncMock(
            return_value={
                "id": "msg123",
                "type": "broadcast",
                "from": "alice",
                "message": "Hello everyone!",
                "from_character_id": "alice",
                "timestamp": "2025-01-01T00:00:00Z",
            }
        )

        # Mock dependencies
        world = MagicMock()
        message_store = MagicMock()
        event_dispatcher = AsyncMock()

        # Call handler
        payload = {"character_id": "alice", "type": "broadcast", "message": "Hello everyone!"}
        result = await handle_send_message(payload, world, message_store, event_dispatcher)

        # Verify API handler called
        mock_api.handle.assert_called_once_with(
            payload, world, message_store, rate_limit_check=None
        )

        # Verify result
        assert result == {"id": "msg123"}

        # Verify event emitted without character filter (broadcast to all)
        event_dispatcher.emit.assert_called_once()
        call_args = event_dispatcher.emit.call_args

        assert call_args[0][0] == "chat.message"

        # Verify internal fields stripped from public record
        public_record = call_args[0][1]
        assert "from_character_id" not in public_record
        assert "id" in public_record
        assert "type" in public_record
        assert "message" in public_record

        # Verify no character filter for broadcast
        assert call_args[1]["character_filter"] is None

    @patch("messaging.handlers.api_send_message")
    async def test_direct_message_emits_to_sender_and_recipient(self, mock_api):
        """Test direct message emits only to sender and recipient."""
        # Mock API response
        mock_api.handle = AsyncMock(
            return_value={
                "id": "msg456",
                "type": "direct",
                "from": "alice",
                "to": "bob",
                "message": "Hi Bob!",
                "from_character_id": "alice",
                "to_character_id": "bob",
                "timestamp": "2025-01-01T00:01:00Z",
            }
        )

        # Mock dependencies
        world = MagicMock()
        message_store = MagicMock()
        event_dispatcher = AsyncMock()

        # Call handler
        payload = {
            "character_id": "alice",
            "type": "direct",
            "to": "bob",
            "message": "Hi Bob!",
        }
        result = await handle_send_message(payload, world, message_store, event_dispatcher)

        # Verify result
        assert result == {"id": "msg456"}

        # Verify event emitted with character filter
        event_dispatcher.emit.assert_called_once()
        call_args = event_dispatcher.emit.call_args

        assert call_args[0][0] == "chat.message"

        # Verify internal fields stripped
        public_record = call_args[0][1]
        assert "from_character_id" not in public_record
        assert "to_character_id" not in public_record

        # Verify character filter includes only sender and recipient
        character_filter = call_args[1]["character_filter"]
        assert set(character_filter) == {"alice", "bob"}

    @patch("messaging.handlers.api_send_message")
    async def test_direct_message_handles_missing_character_ids(self, mock_api):
        """Test direct message handles None character IDs gracefully."""
        # Mock API response with one missing ID
        mock_api.handle = AsyncMock(
            return_value={
                "id": "msg789",
                "type": "direct",
                "from": "alice",
                "to": "bob",
                "message": "Hi!",
                "from_character_id": "alice",
                "to_character_id": None,  # Missing recipient ID
                "timestamp": "2025-01-01T00:02:00Z",
            }
        )

        # Mock dependencies
        world = MagicMock()
        message_store = MagicMock()
        event_dispatcher = AsyncMock()

        # Call handler
        payload = {"character_id": "alice", "type": "direct", "message": "Hi!"}
        result = await handle_send_message(payload, world, message_store, event_dispatcher)

        # Verify character filter excludes None values
        call_args = event_dispatcher.emit.call_args
        character_filter = call_args[1]["character_filter"]
        assert character_filter == ["alice"]
        assert None not in character_filter

    @patch("messaging.handlers.api_send_message")
    async def test_api_exception_propagates(self, mock_api):
        """Test that API handler exceptions propagate correctly."""
        # Mock API to raise exception
        mock_api.handle = AsyncMock(side_effect=ValueError("Invalid message"))

        # Mock dependencies
        world = MagicMock()
        message_store = MagicMock()
        event_dispatcher = AsyncMock()

        # Call handler and expect exception
        payload = {"character_id": "alice", "message": "Bad message"}

        with pytest.raises(ValueError, match="Invalid message"):
            await handle_send_message(payload, world, message_store, event_dispatcher)

        # Verify event was NOT emitted
        event_dispatcher.emit.assert_not_called()

    @patch("messaging.handlers.api_send_message")
    async def test_rate_limit_check_is_none(self, mock_api):
        """Test that rate_limit_check is always None (handled by wrapper)."""
        mock_api.handle = AsyncMock(
            return_value={
                "id": "msg999",
                "type": "broadcast",
                "from": "alice",
                "message": "Test",
                "from_character_id": "alice",
                "timestamp": "2025-01-01T00:03:00Z",
            }
        )

        world = MagicMock()
        message_store = MagicMock()
        event_dispatcher = AsyncMock()

        payload = {"character_id": "alice", "type": "broadcast", "message": "Test"}
        await handle_send_message(payload, world, message_store, event_dispatcher)

        # Verify rate_limit_check is None
        call_args = mock_api.handle.call_args
        assert call_args[1]["rate_limit_check"] is None
