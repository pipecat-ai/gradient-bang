from fastapi import HTTPException
from datetime import datetime, timezone

from rpc.events import event_dispatcher


async def handle(request: dict, world) -> dict:
    try:
        count = world.port_manager.reset_all_ports()
        await event_dispatcher.emit(
            "port.reset",
            {
                "ports_reset": count,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        )
        return {"success": True, "message": f"Reset {count} ports to initial state", "ports_reset": count}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to reset ports: {str(e)}")
