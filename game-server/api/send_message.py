from typing import Dict, Any, Optional
from fastapi import HTTPException


async def handle(payload: Dict[str, Any], world, store, *, rate_limit_check=None) -> Dict[str, Any]:
    """Handle sending a message (broadcast or direct).

    Args:
        payload: { character_id, type: broadcast|direct, content, to_character_id? }
        world: Game world context
        store: MessageStore-like with append()
        rate_limit_check: optional callable(from_id: str) -> None raises on violation
    Returns:
        Message record dict (id, timestamp, ...)
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

    from_name = world.characters.get(from_id).id if from_id in world.characters else from_id
    record = await store.append(from_id=from_id, from_name=from_name, msg_type=msg_type, content=content, to_name=to_name)
    return record
