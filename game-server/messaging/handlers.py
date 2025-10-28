"""Messaging RPC handlers with event emission."""

from typing import Any, Dict, List, Optional

from api import send_message as api_send_message
from messaging.store import MessageStore
from rpc.events import EventDispatcher


async def handle_send_message(
    payload: Dict[str, Any],
    world,
    message_store: MessageStore,
    event_dispatcher: EventDispatcher,
) -> Dict[str, Any]:
    """Handle send_message RPC with event emission.

    Args:
        payload: RPC request payload containing message details
        world: Game world instance
        message_store: MessageStore for persisting messages
        event_dispatcher: EventDispatcher for broadcasting chat events

    Returns:
        Dictionary with message ID

    Note:
        Rate limiting is handled at the RPC_HANDLERS level via RateLimiter wrapper.
    """
    # Call API handler to validate and store message
    record = await api_send_message.handle(
        payload,
        world,
        message_store,
        rate_limit_check=None,  # Rate limiting handled by wrapper
    )

    # Strip internal fields from public event
    public_record = {
        k: v
        for k, v in record.items()
        if k not in ("from_character_id", "to_character_id")
    }

    # For direct messages, only notify sender and recipient by character ID
    character_filter: Optional[List[str]] = None
    if record.get("type") == "direct":
        from_id = record.get("from_character_id")
        to_id = record.get("to_character_id")
        character_filter = [cid for cid in (from_id, to_id) if cid]

    # Emit chat.message event
    await event_dispatcher.emit(
        "chat.message",
        public_record,
        character_filter=character_filter,
    )

    return {"id": record["id"]}
