#!/usr/bin/env python3
"""Gradient Bang WebSocket server with unified event dispatch."""

from __future__ import annotations

import json
import logging
import uuid
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from core.world import lifespan as world_lifespan, world
from api import (
    plot_course as api_plot_course,
    join as api_join,
    move as api_move,
    my_status as api_my_status,
    my_map as api_my_map,
    local_map_region as api_local_map_region,
    list_known_ports as api_list_known_ports,
    path_with_region as api_path_with_region,
    check_trade as api_check_trade,
    trade as api_trade,
    recharge_warp_power as api_recharge,
    transfer_warp_power as api_transfer,
    reset_ports as api_reset_ports,
    regenerate_ports as api_regen_ports,
    combat_initiate as api_combat_initiate,
    combat_action as api_combat_action,
    combat_status as api_combat_status,
    combat_leave_fighters as api_combat_leave_fighters,
    combat_collect_fighters as api_combat_collect_fighters,
    combat_set_garrison_mode as api_combat_set_garrison_mode,
    salvage_collect as api_salvage_collect,
    test_reset as api_test_reset,
)
from core.config import get_world_data_path
from messaging.store import MessageStore
from messaging.handlers import handle_send_message
from combat.callbacks import (
    on_round_waiting,
    on_round_resolved,
    on_combat_ended,
    on_toll_payment,
)
from rpc import (
    Connection,
    event_dispatcher,
    rpc_error,
    rpc_success,
    send_initial_status,
    RPCHandler,
    RateLimiter,
)
from core.locks import CreditLockManager, PortLockManager

logger = logging.getLogger("gradient-bang.server")
logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def app_lifespan(app: FastAPI):
    async with world_lifespan(app):
        if world.combat_manager:
            # Configure combat callbacks with dependencies
            world.combat_manager.configure_callbacks(
                on_round_waiting=lambda enc: on_round_waiting(
                    enc, world, event_dispatcher
                ),
                on_round_resolved=lambda enc, out: on_round_resolved(
                    enc, out, world, event_dispatcher
                ),
                on_combat_ended=lambda enc, out: on_combat_ended(
                    enc, out, world, event_dispatcher
                ),
                on_pay_action=lambda payer, amt: on_toll_payment(
                    payer, amt, world, credit_locks
                ),
            )
        yield


app = FastAPI(title="Gradient Bang", version="0.2.0", lifespan=app_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialise messaging store and rate limiter
_MESSAGES = MessageStore(get_world_data_path() / "messages")
_CONFIG_DIR = Path(__file__).parent / "config"
rate_limiter = RateLimiter(_CONFIG_DIR / "rate_limits.yaml")

# Per-character credit lock manager for atomic credit operations
credit_locks = CreditLockManager(timeout=30.0)

# Per-port lock manager for atomic trade operations
port_locks = PortLockManager(timeout=30.0)


async def _rpc_server_status(_: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "name": "Gradient Bang",
        "version": "0.2.0",
        "status": "running",
        "sectors": world.universe_graph.sector_count if world.universe_graph else 0,
    }


def _with_rate_limit(endpoint: str, handler: RPCHandler) -> RPCHandler:
    """Wrap an RPC handler with rate limiting.

    Args:
        endpoint: The endpoint name for rate limit lookup
        handler: The handler function to wrap

    Returns:
        Rate-limited handler function
    """

    async def wrapped(payload: Dict[str, Any]) -> Dict[str, Any]:
        # Extract character_id from payload
        character_id = payload.get("character_id")
        if not character_id:
            # No character_id means no rate limiting (e.g., server_status)
            return await handler(payload)

        # For send_message, determine message type for rate limiting
        message_type = None
        if endpoint == "send_message":
            message_type = payload.get("type")  # "broadcast" or "direct"

        # Enqueue request with rate limiting
        return await rate_limiter.enqueue_request(
            endpoint=endpoint,
            character_id=character_id,
            handler=lambda: handler(payload),
            message_type=message_type,
        )

    return wrapped


RPC_HANDLERS: Dict[str, RPCHandler] = {
    "plot_course": _with_rate_limit(
        "plot_course", lambda payload: api_plot_course.handle(payload, world)
    ),
    "join": _with_rate_limit("join", lambda payload: api_join.handle(payload, world)),
    "move": _with_rate_limit("move", lambda payload: api_move.handle(payload, world)),
    "my_status": _with_rate_limit(
        "my_status", lambda payload: api_my_status.handle(payload, world)
    ),
    "my_map": _with_rate_limit(
        "my_map", lambda payload: api_my_map.handle(payload, world)
    ),
    "local_map_region": _with_rate_limit(
        "local_map_region", lambda payload: api_local_map_region.handle(payload, world)
    ),
    "list_known_ports": _with_rate_limit(
        "list_known_ports", lambda payload: api_list_known_ports.handle(payload, world)
    ),
    "path_with_region": _with_rate_limit(
        "path_with_region", lambda payload: api_path_with_region.handle(payload, world)
    ),
    "check_trade": _with_rate_limit(
        "check_trade", lambda payload: api_check_trade.handle(payload, world)
    ),
    "trade": _with_rate_limit(
        "trade", lambda payload: api_trade.handle(payload, world, port_locks)
    ),
    "recharge_warp_power": _with_rate_limit(
        "recharge_warp_power", lambda payload: api_recharge.handle(payload, world)
    ),
    "transfer_warp_power": _with_rate_limit(
        "transfer_warp_power", lambda payload: api_transfer.handle(payload, world)
    ),
    "reset_ports": _with_rate_limit(
        "reset_ports", lambda payload: api_reset_ports.handle(payload, world)
    ),
    "regenerate_ports": _with_rate_limit(
        "regenerate_ports", lambda payload: api_regen_ports.handle(payload, world)
    ),
    "send_message": _with_rate_limit(
        "send_message",
        lambda payload: handle_send_message(
            payload, world, _MESSAGES, event_dispatcher
        ),
    ),
    "combat.initiate": _with_rate_limit(
        "combat.initiate", lambda payload: api_combat_initiate.handle(payload, world)
    ),
    "combat.action": _with_rate_limit(
        "combat.action", lambda payload: api_combat_action.handle(payload, world)
    ),
    "combat.status": _with_rate_limit(
        "combat.status", lambda payload: api_combat_status.handle(payload, world)
    ),
    "combat.leave_fighters": _with_rate_limit(
        "combat.leave_fighters",
        lambda payload: api_combat_leave_fighters.handle(payload, world),
    ),
    "combat.collect_fighters": _with_rate_limit(
        "combat.collect_fighters",
        lambda payload: api_combat_collect_fighters.handle(payload, world),
    ),
    "combat.set_garrison_mode": _with_rate_limit(
        "combat.set_garrison_mode",
        lambda payload: api_combat_set_garrison_mode.handle(payload, world),
    ),
    "salvage.collect": _with_rate_limit(
        "salvage.collect", lambda payload: api_salvage_collect.handle(payload, world)
    ),
    "server_status": _with_rate_limit("server_status", _rpc_server_status),
    # Test utilities - no rate limiting for test endpoints
    "test.reset": lambda payload: api_test_reset.handle(payload, world),
}


@app.get("/")
async def root() -> Dict[str, Any]:
    return {
        "name": "Gradient Bang",
        "version": "0.2.0",
        "status": "running",
        "sectors": world.universe_graph.sector_count if world.universe_graph else 0,
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    connection = Connection(websocket)
    await event_dispatcher.register(connection)
    logger.info("WebSocket connected id=%s", connection.connection_id)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json(
                    rpc_error(
                        str(uuid.uuid4()),
                        "unknown",
                        HTTPException(status_code=400, detail="Invalid JSON"),
                    )
                )
                continue

            frame_id = str(frame.get("id") or uuid.uuid4())
            message_type = frame.get("type", "rpc")

            if message_type == "identify":
                character_id = frame.get("character_id")
                if not character_id:
                    await websocket.send_json(
                        rpc_error(
                            frame_id,
                            "identify",
                            HTTPException(
                                status_code=400, detail="Missing character_id"
                            ),
                        )
                    )
                    continue
                try:
                    connection.set_character(character_id)
                except ValueError as e:
                    await websocket.send_json(
                        rpc_error(
                            frame_id,
                            "identify",
                            HTTPException(status_code=400, detail=str(e)),
                        )
                    )
                    continue
                await websocket.send_json(
                    rpc_success(frame_id, "identify", {"identified": True})
                )
                continue

            if message_type == "subscribe":
                event_name = frame.get("event")
                if event_name == "status.update":
                    character_id = frame.get("character_id")
                    if not character_id:
                        await websocket.send_json(
                            rpc_error(
                                frame_id,
                                "subscribe",
                                HTTPException(
                                    status_code=400, detail="Missing character_id"
                                ),
                            )
                        )
                        continue
                    try:
                        connection.set_character(character_id)
                    except ValueError as e:
                        await websocket.send_json(
                            rpc_error(
                                frame_id,
                                "subscribe",
                                HTTPException(status_code=400, detail=str(e)),
                            )
                        )
                        continue
                    await websocket.send_json(
                        rpc_success(
                            frame_id,
                            "subscribe",
                            {
                                "subscribed": "status.update",
                                "character_id": character_id,
                            },
                        )
                    )
                    try:
                        await send_initial_status(connection, str(character_id), world)
                    except HTTPException as exc:
                        await websocket.send_json(rpc_error(frame_id, "subscribe", exc))
                    continue
                if event_name == "chat.message":
                    # Chat messages routed via character_filter, no separate subscription needed
                    await websocket.send_json(
                        rpc_success(
                            frame_id, "subscribe", {"subscribed": "chat.message"}
                        )
                    )
                    continue
                await websocket.send_json(
                    rpc_error(
                        frame_id,
                        "subscribe",
                        HTTPException(
                            status_code=404,
                            detail=f"Unknown event subscription: {event_name}",
                        ),
                    )
                )
                continue

            if message_type != "rpc":
                await websocket.send_json(
                    rpc_error(
                        frame_id,
                        message_type,
                        HTTPException(
                            status_code=400,
                            detail=f"Unknown frame type: {message_type}",
                        ),
                    )
                )
                continue

            endpoint = frame.get("endpoint")
            payload = frame.get("payload", {})
            handler = RPC_HANDLERS.get(endpoint)
            if not handler:
                await websocket.send_json(
                    rpc_error(
                        frame_id,
                        endpoint or "unknown",
                        HTTPException(
                            status_code=404, detail=f"Unknown endpoint: {endpoint}"
                        ),
                    )
                )
                continue

            try:
                # Associate character with this connection BEFORE calling handler
                # so that events emitted during join/my_status are properly delivered
                if endpoint in {"join", "my_status"}:
                    character_id = payload.get("character_id")
                    if character_id:
                        try:
                            connection.set_character(character_id)
                        except ValueError:
                            # Already set to this character, that's fine
                            pass

                result = await handler(payload)
                await websocket.send_json(rpc_success(frame_id, endpoint, result))
            except HTTPException as exc:
                await websocket.send_json(rpc_error(frame_id, endpoint, exc))
            except Exception as exc:  # noqa: BLE001
                logger.exception("RPC handler error endpoint=%s", endpoint)
                await websocket.send_json(rpc_error(frame_id, endpoint, exc))
    except WebSocketDisconnect:
        logger.info("WebSocket disconnected id=%s", connection.connection_id)
    finally:
        # Mark character as disconnected
        if connection.character_id:
            character = world.characters.get(connection.character_id)
            if character:
                character.connected = False
        await event_dispatcher.unregister(connection)


if __name__ == "__main__":
    # For direct execution: cd game-server && uv run python server.py
    # Recommended: uv run python -m game-server (from project root)
    import uvicorn
    import os

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
