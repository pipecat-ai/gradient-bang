from fastapi import HTTPException
from datetime import datetime, timezone

from rpc.events import event_dispatcher


async def handle(request: dict, world) -> dict:
    fraction = request.get("fraction", 0.25)
    if not (0.0 <= fraction <= 1.0):
        raise HTTPException(status_code=400, detail="Fraction must be between 0.0 and 1.0")
    try:
        count = world.port_manager.regenerate_ports(fraction)
        await event_dispatcher.emit(
            "port.regenerated",
            {
                "ports_regenerated": count,
                "fraction": fraction,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        )
        return {
            "success": True,
            "message": f"Regenerated {count} ports with {fraction:.1%} of max capacity",
            "ports_regenerated": count,
            "fraction": fraction,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to regenerate ports: {str(e)}")
