#!/usr/bin/env python3
"""Gradient Bang WebSocket server with unified event dispatch."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections import deque
from typing import Any, Awaitable, Callable, Dict, Iterable, Optional

import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from world import lifespan, world
from api import (
    plot_course as api_plot_course,
    join as api_join,
    move as api_move,
    my_status as api_my_status,
    my_map as api_my_map,
    local_map as api_local_map,
    check_trade as api_check_trade,
    trade as api_trade,
    recharge_warp_power as api_recharge,
    transfer_warp_power as api_transfer,
    reset_ports as api_reset_ports,
    regenerate_ports as api_regen_ports,
    send_message as api_send_message,
)
from api.utils import build_status_payload
from events import EventSink, event_dispatcher
from messaging.store import MessageStore
from config import get_world_data_path


logger = logging.getLogger("gradient-bang.server")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Gradient Bang", version="0.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


RPCHandler = Callable[[Dict[str, Any]], Awaitable[Dict[str, Any]]]


# Initialise messaging store + rate limits for chat
_MESSAGES = MessageStore(get_world_data_path() / "messages")
_RATE_LIMIT_LAST: Dict[str, float] = {}


async def _handle_send_message(payload: Dict[str, Any]) -> Dict[str, Any]:
    def _rate_limit(from_id: str) -> None:
        now = asyncio.get_running_loop().time()
        last = _RATE_LIMIT_LAST.get(from_id, 0.0)
        if now - last < 1.0:
            raise HTTPException(status_code=429, detail="Rate limit 1 msg/sec")
        _RATE_LIMIT_LAST[from_id] = now

    record = await api_send_message.handle(
        payload,
        world,
        _MESSAGES,
        rate_limit_check=_rate_limit,
    )

    public_record = {k: v for k, v in record.items() if k != "from_character_id"}
    name_filter: Optional[Iterable[str]]
    if public_record.get("type") == "direct":
        to_name = public_record.get("to_name")
        from_name = public_record.get("from_name")
        name_filter = [n for n in (to_name, from_name) if n]
    else:
        name_filter = []
    await event_dispatcher.emit(
        "chat.message",
        public_record,
        name_filter=name_filter,
    )
    return {"id": record["id"]}


async def _rpc_server_status(_: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "name": "Gradient Bang",
        "version": "0.2.0",
        "status": "running",
        "sectors": world.universe_graph.sector_count if world.universe_graph else 0,
    }


RPC_HANDLERS: Dict[str, RPCHandler] = {
    "plot_course": lambda payload: api_plot_course.handle(payload, world),
    "join": lambda payload: api_join.handle(payload, world),
    "move": lambda payload: api_move.handle(payload, world),
    "my_status": lambda payload: api_my_status.handle(payload, world),
    "my_map": lambda payload: api_my_map.handle(payload, world),
    "local_map": lambda payload: api_local_map.handle(payload, world),
    "check_trade": lambda payload: api_check_trade.handle(payload, world),
    "trade": lambda payload: api_trade.handle(payload, world),
    "recharge_warp_power": lambda payload: api_recharge.handle(payload, world),
    "transfer_warp_power": lambda payload: api_transfer.handle(payload, world),
    "reset_ports": lambda payload: api_reset_ports.handle(payload, world),
    "regenerate_ports": lambda payload: api_regen_ports.handle(payload, world),
    "send_message": _handle_send_message,
    "server_status": _rpc_server_status,
}


def _rpc_success(
    frame_id: str, endpoint: str, result: Dict[str, Any]
) -> Dict[str, Any]:
    return {
        "frame_type": "rpc",
        "id": frame_id,
        "endpoint": endpoint,
        "ok": True,
        "result": result,
    }


def _rpc_error(
    frame_id: str, endpoint: str, exc: HTTPException | Exception
) -> Dict[str, Any]:
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


class Connection(EventSink):
    """Represents a connected WebSocket client."""

    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self.connection_id = str(uuid.uuid4())
        self.status_subscriptions: set[str] = set()
        self.known_character_ids: set[str] = set()
        self.known_names: set[str] = set()
        self.chat_subscribed = False
        self._send_lock = asyncio.Lock()

    async def send_event(self, envelope: dict) -> None:
        async with self._send_lock:
            await self.websocket.send_json(envelope)

    def matches_characters(self, character_ids: Iterable[str]) -> bool:
        tracked = self.status_subscriptions | self.known_character_ids
        return any(cid in tracked for cid in character_ids)

    def matches_names(self, names: Iterable[str]) -> bool:
        if not self.chat_subscribed:
            return False
        names = list(names)
        if not names:
            return True
        return any(name in self.known_names for name in names)

    def register_character(self, character_id: str | None, name: str | None) -> None:
        if character_id:
            self.known_character_ids.add(str(character_id))
        if name:
            self.known_names.add(str(name))


async def _send_initial_status(connection: Connection, character_id: str) -> None:
    if character_id not in world.characters:
        raise HTTPException(
            status_code=404, detail=f"Character '{character_id}' not found"
        )
    payload = build_status_payload(world, character_id)
    envelope = {
        "frame_type": "event",
        "event": "status.update",
        "payload": payload,
        "gg-action": "status.update",
        "character_filter": [character_id],
    }
    await connection.send_event(envelope)


@app.get("/")
async def root() -> Dict[str, Any]:
    return {
        "name": "Gradient Bang",
        "version": "0.2.0",
        "status": "running",
        "sectors": world.universe_graph.sector_count if world.universe_graph else 0,
    }


# For testing - http://localhost:5173/map-demo.html
@app.get("/api/local_map")
async def local_map_get(center: int = 0, max_hops: int = 3, max_nodes: int = 25):
    if not world.universe_graph:
        return {"node_list": []}

    visited = set()
    queue = deque([(center, 0)])
    nodes_by_id: Dict[int, Dict[str, Any]] = {}

    while queue and len(nodes_by_id) < max_nodes:
        sector_id, distance = queue.popleft()
        if sector_id in visited or distance > max_hops:
            continue

        visited.add(sector_id)
        adjacent = world.universe_graph.adjacency.get(sector_id, [])
        if sector_id not in world.universe_graph.adjacency:
            continue

        port_type = None
        if world.port_manager:
            port_state = world.port_manager.load_port_state(sector_id)
            if port_state:
                port_type = port_state.code

        position = None
        if world.universe_graph:
            position = world.universe_graph.positions.get(sector_id, (0, 0))

        nodes_by_id[sector_id] = {
            "id": sector_id,
            "visited": True,
            "port_type": port_type,
            "adjacent": adjacent,
            "position": position,
        }

        if distance < max_hops:
            for neighbor in adjacent:
                if neighbor not in visited:
                    queue.append((neighbor, distance + 1))

    node_list = []
    for node_id in sorted(nodes_by_id.keys()):
        node = nodes_by_id[node_id]
        node["adjacent"] = [adj for adj in node["adjacent"] if adj in nodes_by_id]
        node_list.append(node)

    return {"node_list": node_list}


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
                    _rpc_error(
                        str(uuid.uuid4()),
                        "unknown",
                        HTTPException(status_code=400, detail="Invalid JSON"),
                    )
                )
                continue

            frame_id = str(frame.get("id") or uuid.uuid4())
            message_type = frame.get("type", "rpc")

            if message_type == "identify":
                name = frame.get("name")
                character_id = frame.get("character_id")
                if not name and not character_id:
                    await websocket.send_json(
                        _rpc_error(
                            frame_id,
                            "identify",
                            HTTPException(
                                status_code=400, detail="Missing name or character_id"
                            ),
                        )
                    )
                    continue
                connection.register_character(character_id, name)
                await websocket.send_json(
                    _rpc_success(frame_id, "identify", {"identified": True})
                )
                continue

            if message_type == "subscribe":
                event_name = frame.get("event")
                if event_name == "status.update":
                    character_id = frame.get("character_id")
                    if not character_id:
                        await websocket.send_json(
                            _rpc_error(
                                frame_id,
                                "subscribe",
                                HTTPException(
                                    status_code=400, detail="Missing character_id"
                                ),
                            )
                        )
                        continue
                    connection.status_subscriptions.add(str(character_id))
                    connection.register_character(character_id, frame.get("name"))
                    await websocket.send_json(
                        _rpc_success(
                            frame_id,
                            "subscribe",
                            {
                                "subscribed": "status.update",
                                "character_id": character_id,
                            },
                        )
                    )
                    try:
                        await _send_initial_status(connection, str(character_id))
                    except HTTPException as exc:
                        await websocket.send_json(
                            _rpc_error(frame_id, "subscribe", exc)
                        )
                    continue
                if event_name == "chat.message":
                    connection.chat_subscribed = True
                    await websocket.send_json(
                        _rpc_success(
                            frame_id, "subscribe", {"subscribed": "chat.message"}
                        )
                    )
                    continue
                await websocket.send_json(
                    _rpc_error(
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
                    _rpc_error(
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
                    _rpc_error(
                        frame_id,
                        endpoint or "unknown",
                        HTTPException(
                            status_code=404, detail=f"Unknown endpoint: {endpoint}"
                        ),
                    )
                )
                continue

            try:
                result = await handler(payload)
                if endpoint in {"join", "my_status"}:
                    # Register the character for subsequent targeted events
                    character_id = payload.get("character_id")
                    if character_id:
                        connection.register_character(character_id, result.get("name"))
                await websocket.send_json(_rpc_success(frame_id, endpoint, result))
            except HTTPException as exc:
                await websocket.send_json(_rpc_error(frame_id, endpoint, exc))
            except Exception as exc:  # noqa: BLE001
                logger.exception("RPC handler error endpoint=%s", endpoint)
                await websocket.send_json(_rpc_error(frame_id, endpoint, exc))
    except WebSocketDisconnect:
        logger.info("WebSocket disconnected id=%s", connection.connection_id)
    finally:
        await event_dispatcher.unregister(connection)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
