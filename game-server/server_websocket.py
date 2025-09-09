#!/usr/bin/env python3
"""
Gradient Bang WebSocket server providing RPC + push events over a single connection.
Includes lightweight request logging.
"""

import asyncio
import json
import uuid
from typing import Dict, Any, Callable, Awaitable
import logging
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from core.world import world, lifespan
from api import plot_course as api_plot_course
from api import join as api_join
from api import move as api_move
from api import my_status as api_my_status
from api import my_map as api_my_map
from api import check_trade as api_check_trade
from api import trade as api_trade
from api import recharge_warp_power as api_recharge
from api import transfer_warp_power as api_transfer
from api import reset_ports as api_reset_ports
from api import regenerate_ports as api_regen_ports
from api import send_message as api_send_message
from messaging.store import MessageStore
from core.config import get_world_data_path


app = FastAPI(title="Gradient Bang WS", version="0.1.0", lifespan=lifespan)


logger = logging.getLogger("server_websocket")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# Globals initialized early so they exist for websocket handlers
_messages = MessageStore(get_world_data_path() / "messages")
_rate_limit_last: Dict[str, float] = {}
# Avoid type hint here to not depend on class definition order
_clients = []


@app.get("/")
async def root():
    return {
        "name": "Gradient Bang WS",
        "version": "0.1.0",
        "status": "running",
        "sectors": world.universe_graph.sector_count if world.universe_graph else 0,
    }


# Endpoint router
RPC_HANDLERS: Dict[str, Callable[[Dict[str, Any], Any], Awaitable[Dict[str, Any]]]] = {
    "plot_course": api_plot_course.handle,
    "join": api_join.handle,
    "move": api_move.handle,
    "my_status": api_my_status.handle,
    "my_map": api_my_map.handle,
    "check_trade": api_check_trade.handle,
    "trade": api_trade.handle,
    "recharge_warp_power": api_recharge.handle,
    "transfer_warp_power": api_transfer.handle,
    "reset_ports": api_reset_ports.handle,
    "regenerate_ports": api_regen_ports.handle,
}


class WSClientState:
    def __init__(self, websocket: WebSocket):
        self.ws = websocket
        self.subscriptions: Dict[str, asyncio.Task] = {}
        self.character_ids: set[str] = set()
        self.character_names: set[str] = set()

    def subscribe(self, event: str, task: asyncio.Task):
        self.subscriptions[event] = task

    def cancel_all(self):
        for task in self.subscriptions.values():
            task.cancel()
        self.subscriptions.clear()


async def send_ok(ws: WebSocket, req_id: str, data: Dict[str, Any]):
    await ws.send_json({"id": req_id, "ok": True, "data": data})


async def send_err(ws: WebSocket, req_id: str, status: int, detail: str):
    await ws.send_json({"id": req_id, "ok": False, "error": {"status": status, "detail": detail}})


def _extract_character_id(endpoint: str, payload: Dict[str, Any]) -> str | None:
    # Common key
    if isinstance(payload, dict):
        if "character_id" in payload:
            return str(payload.get("character_id"))
        # Special cases
        if endpoint == "transfer_warp_power":
            if "from_character_id" in payload:
                return str(payload.get("from_character_id"))
            if "to_character_id" in payload:
                return str(payload.get("to_character_id"))
    return None


async def _my_status_push_loop(state: WSClientState, character_id: str):
    # Push my_status every 2 seconds
    while True:
        try:
            payload = {"character_id": character_id}
            data = await api_my_status.handle(payload, world)
            await state.ws.send_json({"type": "event", "event": "my_status", "data": data})
            await asyncio.sleep(2.0)
        except asyncio.CancelledError:
            break
        except Exception as e:
            # If send fails, yield a bit to avoid tight loop
            await asyncio.sleep(0.2)


@app.websocket("/ws")
async def ws_main(websocket: WebSocket):
    await websocket.accept()
    state = WSClientState(websocket)
    logger.info("ws connected")
    _clients.append(state)
    try:
        while True:
            msg = await websocket.receive_text()
            try:
                frame = json.loads(msg)
            except Exception:
                # Non-JSON payload
                detail = "Invalid JSON"
                logger.warning("ws invalid_json detail=%s", detail)
                await websocket.send_json({"ok": False, "error": {"status": 400, "detail": detail}})
                continue

            # Handle subscription control
            if frame.get("action") == "subscribe":
                event = frame.get("event")
                req_id = frame.get("id") or str(uuid.uuid4())
                if event == "my_status":
                    character_id = frame.get("character_id")
                    if not character_id:
                        detail = "Missing character_id"
                        logger.warning("subscribe error event=%s char=? detail=%s", event, detail)
                        await send_err(websocket, req_id, 400, detail)
                        continue
                    # Track character ids for direct message delivery
                    try:
                        state.character_ids.add(str(character_id))
                        try:
                            nm = world.characters.get(str(character_id)).id
                        except Exception:
                            nm = str(character_id)
                        state.character_names.add(nm)
                    except Exception:
                        pass
                    if "my_status" in state.subscriptions:
                        state.subscriptions["my_status"].cancel()
                    task = asyncio.create_task(_my_status_push_loop(state, character_id))
                    state.subscribe("my_status", task)
                    logger.info("subscribe ok event=%s char=%s", event, character_id)
                    await send_ok(websocket, req_id, {"subscribed": "my_status"})
                elif event == "chat":
                    logger.info("subscribe ok event=chat")
                    await send_ok(websocket, req_id, {"subscribed": "chat"})
                else:
                    detail = f"Unknown event: {event}"
                    logger.warning("subscribe error event=%s char=? detail=%s", event, detail)
                    await send_err(websocket, req_id, 404, detail)
                continue

            # Lightweight identity registration (no status push loop)
            if frame.get("action") == "identify":
                req_id = frame.get("id") or str(uuid.uuid4())
                name = frame.get("name")
                char_id = frame.get("character_id")
                if not name and not char_id:
                    await send_err(websocket, req_id, 400, "Missing name or character_id")
                    continue
                try:
                    state.character_names.add(str(name) if name else world.characters.get(str(char_id)).id)
                    if char_id:
                        state.character_ids.add(str(char_id))
                except Exception:
                    # Fallback to provided strings
                    if name:
                        state.character_names.add(str(name))
                    if char_id:
                        state.character_ids.add(str(char_id))
                logger.info("identify ok name=%s char=%s", name or "-", char_id or "-")
                await send_ok(websocket, req_id, {"identified": True})
                continue

            # Handle RPC
            req_id = frame.get("id") or str(uuid.uuid4())
            endpoint = frame.get("endpoint")
            payload = frame.get("payload", {})
            handler = RPC_HANDLERS.get(endpoint)
            if not handler:
                if False and endpoint == "send_message":
                    payload = frame.get("payload", {})
                    from_id = payload.get("character_id")
                    msg_type = payload.get("type")
                    content = payload.get("content", "")
                    to_id = payload.get("to_character_id")
                    if not from_id or msg_type not in ("broadcast", "direct"):
                        await send_err(websocket, req_id, 400, "Invalid parameters")
                        continue
                    if not isinstance(content, str) or len(content) == 0:
                        await send_err(websocket, req_id, 400, "Empty content")
                        continue
                    if len(content) > 512:
                        await send_err(websocket, req_id, 400, "Content too long (max 512)")
                        continue
                    # Rate limit per sender
                    now = asyncio.get_event_loop().time()
                    last = _rate_limit_last.get(from_id, 0.0)
                    if now - last < 1.0:
                        await send_err(websocket, req_id, 429, "Rate limit 1 msg/sec")
                        continue
                    _rate_limit_last[from_id] = now
                    from_name = world.characters.get(from_id).id if from_id in world.characters else from_id
                    record = await _messages._append_async(from_id, from_name, msg_type, content, to_id)
                    # Deliver
                    # Sanitize payload for clients: never expose character IDs
                    public_record = {k: v for k, v in record.items() if k != "from_character_id"}
                    # Deliver: broadcast to all, direct only to recipient name
                    if msg_type == "broadcast":
                        for conn in list(_clients):
                            try:
                                await conn.ws.send_json({"type": "event", "event": "chat", "data": public_record})
                            except Exception:
                                pass
                    else:
                        to_name = record.get("to_name")
                        for conn in list(_clients):
                            try:
                                if to_name and to_name in conn.character_names:
                                    await conn.ws.send_json({"type": "event", "event": "chat", "data": public_record})
                            except Exception:
                                pass
                    logger.info("rpc ok endpoint=send_message char=%s", from_id)
                    await send_ok(websocket, req_id, {"id": record["id"]})
                    continue
                else:
                    detail = f"Unknown endpoint: {endpoint}"
                    if endpoint == "send_message":
                        payload = frame.get("payload", {})
                        def rate_limit_check(from_id: str):
                            now = asyncio.get_event_loop().time()
                            last = _rate_limit_last.get(from_id, 0.0)
                            if now - last < 1.0:
                                raise HTTPExceptionLike(429, "Rate limit 1 msg/sec")
                            _rate_limit_last[from_id] = now
                        try:
                            record = await api_send_message.handle(payload, world, _messages, rate_limit_check=rate_limit_check)
                        except HTTPExceptionLike as e:
                            await send_err(websocket, req_id, e.status_code, e.detail)
                            continue
                        # Sanitize payload for clients: never expose character IDs
                        public_record = {k: v for k, v in record.items() if k != "from_character_id"}
                        # Deliver: broadcast to all, direct only to recipient name
                        msg_type = public_record.get("type")
                        if msg_type == "broadcast":
                            for conn in list(_clients):
                                try:
                                    await conn.ws.send_json({"type": "event", "event": "chat", "data": public_record})
                                except Exception:
                                    pass
                        else:
                            to_name = public_record.get("to_name")
                            for conn in list(_clients):
                                try:
                                    if to_name and to_name in conn.character_names:
                                        await conn.ws.send_json({"type": "event", "event": "chat", "data": public_record})
                                except Exception:
                                    pass
                        logger.info("rpc ok endpoint=send_message char=%s", payload.get("character_id"))
                        await send_ok(websocket, req_id, {"id": record["id"]})
                        continue
                    logger.warning("rpc error endpoint=%s char=? detail=%s", endpoint, detail)
                    await send_err(websocket, req_id, 404, detail)
                    continue
            try:
                data = await handler(payload, world)
                char_id = _extract_character_id(endpoint, payload)
                logger.info("rpc ok endpoint=%s char=%s", endpoint, char_id or "-")
                await send_ok(websocket, req_id, data)
            except Exception as e:
                # Map FastAPI HTTPException if needed
                status = getattr(e, "status_code", 500)
                detail = getattr(e, "detail", str(e))
                char_id = _extract_character_id(endpoint, payload)
                logger.warning("rpc error endpoint=%s char=%s status=%s detail=%s", endpoint, char_id or "-", status, detail)
                await send_err(websocket, req_id, status, detail)
    except WebSocketDisconnect:
        logger.info("ws disconnected")
    finally:
        state.cancel_all()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)

# --- Messaging store and globals ---

_messages = MessageStore(get_world_data_path() / "messages")
_rate_limit_last: Dict[str, float] = {}
_clients: list[WSClientState] = []
