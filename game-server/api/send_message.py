from typing import Dict, Any, Optional
from fastapi import HTTPException

from api.utils import resolve_character_name


async def handle(payload: Dict[str, Any], world, store, *, rate_limit_check=None) -> Dict[str, Any]:
    """Handle sending a message (broadcast or direct).

    Client API uses character names for addressing (to_name).
    Server converts names to IDs for internal dispatch.

    Args:
        payload: { character_id, type: broadcast|direct, content, to_name? }
            - character_id: sender's character ID
            - type: "broadcast" or "direct"
            - content: message text (max 512 chars)
            - to_name: recipient's character name (required for direct messages)
        world: Game world context
        store: MessageStore-like with append()
        rate_limit_check: optional callable(from_id: str) -> None raises on violation
    Returns:
        Message record dict with to_character_id added for direct messages
    """
    from_id = payload.get("character_id")
    msg_type = payload.get("type")
    content = payload.get("content", "")
    to_name: Optional[str] = payload.get("to_name")

    if not from_id or msg_type not in ("broadcast", "direct"):
        raise HTTPException(status_code=400, detail="Invalid parameters")
    if not isinstance(content, str) or len(content.strip()) == 0:
        raise HTTPException(status_code=400, detail="Empty content")
    if len(content) > 512:
        raise HTTPException(status_code=400, detail="Content too long (max 512)")
    if msg_type == "direct" and not to_name:
        raise HTTPException(status_code=400, detail="Missing to_name for direct message")

    if rate_limit_check:
        rate_limit_check(from_id)

    # Look up sender's display name
    from_name = resolve_character_name(world, from_id)

    # For direct messages, look up recipient's character ID from display name
    to_character_id: Optional[str] = None
    if msg_type == "direct" and to_name:
        recipient_profile = world.character_registry.find_by_name(to_name)
        if not recipient_profile:
            raise HTTPException(status_code=404, detail=f"Character '{to_name}' not found")
        to_character_id = recipient_profile.character_id

    record = await store.append(from_id=from_id, from_name=from_name, msg_type=msg_type, content=content, to_name=to_name, to_character_id=to_character_id)

    # Add to_character_id to record for server-side filtering
    if to_character_id:
        record["to_character_id"] = to_character_id

    return record
