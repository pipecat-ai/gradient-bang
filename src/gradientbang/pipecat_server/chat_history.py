"""Shared chat history utilities for the pipecat server package."""

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

from loguru import logger
from pipecat.processors.frameworks.rtvi import RTVIProcessor, RTVIServerMessageFrame

from gradientbang.utils.supabase_client import AsyncGameClient


async def fetch_chat_history(
    game_client: AsyncGameClient,
    character_id: str,
    *,
    since_hours: int = 24,
    max_rows: int = 50,
) -> List[Dict[str, Any]]:
    """Fetch recent chat messages and return them as clean message dicts.

    Args:
        game_client: The game client to query with.
        character_id: Character to fetch history for.
        since_hours: How many hours back to look (max 72).
        max_rows: Maximum messages to return (max 100).

    Returns:
        List of chat message dicts with id, type, from_name, content, to_name, timestamp.
    """
    since_hours = min(since_hours, 72)
    max_rows = min(max_rows, 100)

    end_time = datetime.now(timezone.utc)
    start_time = end_time - timedelta(hours=since_hours)

    result = await game_client.event_query(
        start=start_time.isoformat(),
        end=end_time.isoformat(),
        character_id=character_id,
        filter_event_type="chat.message",
        include_broadcasts=True,
        max_rows=max_rows,
        sort_direction="reverse",
    )

    raw_events = result.get("events", [])
    return [
        {
            "id": ev.get("payload", {}).get("id"),
            "type": ev.get("payload", {}).get("type"),
            "from_name": ev.get("payload", {}).get("from_name"),
            "content": ev.get("payload", {}).get("content"),
            "to_name": ev.get("payload", {}).get("to_name"),
            "timestamp": ev.get("payload", {}).get("timestamp") or ev.get("timestamp"),
        }
        for ev in raw_events
    ]


async def emit_chat_history(
    rtvi: RTVIProcessor,
    messages: List[Dict[str, Any]],
) -> None:
    """Emit a chat.history event via RTVI with the given messages."""
    await rtvi.push_frame(
        RTVIServerMessageFrame(
            {
                "frame_type": "event",
                "event": "chat.history",
                "payload": {
                    "messages": messages,
                    "total_count": len(messages),
                },
            }
        )
    )
