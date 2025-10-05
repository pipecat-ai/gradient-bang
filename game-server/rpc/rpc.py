"""RPC protocol utilities for WebSocket communication."""

from typing import Any, Awaitable, Callable, Dict

from fastapi import HTTPException

# Type alias for RPC handler functions
RPCHandler = Callable[[Dict[str, Any]], Awaitable[Dict[str, Any]]]


def rpc_success(
    frame_id: str, endpoint: str, result: Dict[str, Any]
) -> Dict[str, Any]:
    """Format a successful RPC response.

    Args:
        frame_id: Unique identifier for the RPC frame
        endpoint: The endpoint that was called
        result: The result data to return

    Returns:
        Formatted RPC success response
    """
    return {
        "frame_type": "rpc",
        "id": frame_id,
        "endpoint": endpoint,
        "ok": True,
        "result": result,
    }


def rpc_error(
    frame_id: str, endpoint: str, exc: HTTPException | Exception
) -> Dict[str, Any]:
    """Format an RPC error response.

    Args:
        frame_id: Unique identifier for the RPC frame
        endpoint: The endpoint that was called
        exc: The exception that occurred

    Returns:
        Formatted RPC error response
    """
    status = exc.status_code if isinstance(exc, HTTPException) else 500
    detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
    code = getattr(exc, "code", None)
    payload = {
        "frame_type": "rpc",
        "id": frame_id,
        "endpoint": endpoint,
        "ok": False,
        "error": {"status": status, "detail": detail},
    }
    if code:
        payload["error"]["code"] = code
    return payload
