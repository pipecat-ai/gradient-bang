from fastapi import HTTPException
from datetime import datetime, timezone
import asyncio


async def handle(request: dict, world) -> dict:
    try:
        count = world.port_manager.reset_all_ports()
        reset_event = {
            "event": "port_reset",
            "ports_reset": count,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        asyncio.create_task(world.connection_manager.broadcast_event(reset_event))
        return {"success": True, "message": f"Reset {count} ports to initial state", "ports_reset": count}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to reset ports: {str(e)}")

