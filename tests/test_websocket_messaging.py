import json
import time
from pathlib import Path
from collections import defaultdict
from typing import Callable, Dict, Any, List

import anyio
import pytest
from fastapi.testclient import TestClient

import sys
sys.path.insert(0, str(Path(__file__).parent.parent / "game-server"))

from server import app  # type: ignore
from core.world import world  # type: ignore
from core.world import UniverseGraph, Character  # type: ignore
from port_manager import PortManager  # type: ignore
from ships import ShipType  # type: ignore


@pytest.fixture(scope="module")
def ws_client():
    # Load test data into shared world
    import json as _json
    test_data_path = Path(__file__).parent / "test-world-data"
    with open(test_data_path / "universe_structure.json", "r") as f:
        universe_data = _json.load(f)
    world.universe_graph = UniverseGraph(universe_data)
    with open(test_data_path / "sector_contents.json", "r") as f:
        world.sector_contents = _json.load(f)
    world.port_manager = PortManager(universe_contents=world.sector_contents)

    # Patch world.load_data so lifespan doesn't read WORLD_DATA_DIR
    original_load = world.load_data
    def _no_load():
        return None
    world.load_data = _no_load
    try:
        with TestClient(app) as c:
            yield c
    finally:
        world.load_data = original_load


def _receive_json_with_timeout(ws, *, timeout: float, label: str) -> Dict[str, Any]:
    """Receive a JSON frame from the websocket with a hard timeout."""

    async def _receive() -> Dict[str, Any]:  # pragma: no cover - exercised in tests
        with anyio.fail_after(timeout):
            message = await ws._send_rx.receive()  # type: ignore[attr-defined]
        ws._raise_on_close(message)
        payload: str | bytes | None = message.get("text")
        if payload is None:
            payload = message.get("bytes")
            if isinstance(payload, bytes):
                payload = payload.decode("utf-8")
        if payload is None:
            raise AssertionError(f"{label}: received websocket frame without data: {message}")
        return json.loads(payload)

    try:
        return ws.portal.call(_receive)
    except TimeoutError as exc:  # pragma: no cover - re-wrapped for clarity
        raise TimeoutError(f"Timed out after {timeout:.1f}s waiting for {label}") from exc


def _recv_until(
    ws,
    predicate: Callable[[Dict[str, Any]], bool],
    *,
    limit: int = 10,
    timeout: float = 15.0,
    label: str = "frame",
) -> Dict[str, Any]:
    deadline = time.monotonic() + timeout
    pending = _PENDING_FRAMES[id(ws)]

    # First drain any queued frames from previous reads.
    for idx, cached in enumerate(list(pending)):
        if predicate(cached):
            pending.pop(idx)
            return cached

    seen: list[Dict[str, Any]] = []
    for attempt in range(limit):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            msg = _receive_json_with_timeout(ws, timeout=remaining, label=f"{label}#{attempt}")
        except TimeoutError:
            break
        if predicate(msg):
            return msg
        pending.append(msg)
        seen.append(msg)
    pretty = json.dumps(seen, indent=2)
    raise AssertionError(f"Did not receive expected {label} within {timeout:.1f}s. Seen frames:\n{pretty}")


def _recv_until_event(ws, event_name: str, *, timeout: float = 15.0) -> Dict[str, Any]:
    frame = _recv_until(
        ws,
        lambda msg: msg.get("frame_type") == "event" and msg.get("event") == event_name,
        label=f"event {event_name}",
        timeout=timeout,
    )
    return frame.get("payload", {})


def _join_character(ws, character_id: str, *, sector: int | None = None):
    payload = {"character_id": character_id}
    if sector is not None:
        payload["sector"] = sector
    ws.send_text(
        json.dumps({"id": f"join-{character_id}", "type": "rpc", "endpoint": "join", "payload": payload})
    )
    _recv_until(
        ws,
        lambda msg: msg.get("frame_type") == "rpc" and msg.get("endpoint") == "join",
    )


def _recv_movement(ws, movement: str, *, timeout: float = 15.0):
    frame = _recv_until(
        ws,
        lambda msg: (
            msg.get("frame_type") == "event"
            and msg.get("event") == "character.moved"
            and msg.get("payload", {}).get("movement") == movement
        ),
        label=f"movement {movement}",
        timeout=timeout,
    )
    return frame.get("payload", {})


def _drain_pending_event(ws, event_name: str) -> Dict[str, Any] | None:
    pending = _PENDING_FRAMES.get(id(ws), [])
    for idx, cached in enumerate(list(pending)):
        if cached.get("frame_type") == "event" and cached.get("event") == event_name:
            frame = pending.pop(idx)
            return frame.get("payload", {})
    return None


def test_ws_broadcast_chat(ws_client):
    with ws_client.websocket_connect("/ws") as a, ws_client.websocket_connect("/ws") as b:
        # Subscribe both to chat events
        a.send_text(json.dumps({"id": "sa", "type": "subscribe", "event": "chat.message"}))
        b.send_text(json.dumps({"id": "sb", "type": "subscribe", "event": "chat.message"}))
        assert _recv_until(a, lambda m: m.get("id") == "sa" and m.get("frame_type") == "rpc")["ok"] is True
        assert _recv_until(b, lambda m: m.get("id") == "sb" and m.get("frame_type") == "rpc")["ok"] is True

        # Send broadcast from A
        payload = {
            "character_id": "Charlie",
            "type": "broadcast",
            "content": "Hello World",
        }
        a.send_text(json.dumps({"id": "m1", "endpoint": "send_message", "payload": payload}))
        
        # Both should receive chat event
        evt_a = _recv_until_event(a, "chat.message")
        evt_b = _recv_until_event(b, "chat.message")
        assert evt_a["type"] == "broadcast"
        assert evt_b["type"] == "broadcast"
        assert evt_a["content"] == "Hello World"
        assert evt_b["content"] == "Hello World"


def test_ws_direct_chat(ws_client):
    with ws_client.websocket_connect("/ws") as sender, ws_client.websocket_connect("/ws") as recipient:
        # Recipient joins and subscribes my_status to register character id
        recipient.send_text(json.dumps({"id": "j1", "type": "rpc", "endpoint": "join", "payload": {"character_id": "Bob"}}))
        _recv_until(recipient, lambda m: m.get("frame_type") == "rpc" and m.get("endpoint") == "join")
        sender.send_text(json.dumps({"id": "j2", "type": "rpc", "endpoint": "join", "payload": {"character_id": "Charlie"}}))
        _recv_until(sender, lambda m: m.get("frame_type") == "rpc" and m.get("endpoint") == "join")

        recipient.send_text(
            json.dumps(
                {
                    "id": "ms1",
                    "type": "subscribe",
                    "event": "status.update",
                    "character_id": "Bob",
                }
            )
        )
        _recv_until(recipient, lambda m: m.get("frame_type") == "event" and m.get("event") == "status.update")

        # Both subscribe to chat
        sender.send_text(json.dumps({"id": "sc1", "type": "subscribe", "event": "chat.message"}))
        recipient.send_text(json.dumps({"id": "sc2", "type": "subscribe", "event": "chat.message"}))
        assert _recv_until(sender, lambda m: m.get("id") == "sc1" and m.get("frame_type") == "rpc")["ok"] is True
        assert _recv_until(recipient, lambda m: m.get("id") == "sc2" and m.get("frame_type") == "rpc")["ok"] is True

        # Sender sends direct to Bob
        payload = {
            "character_id": "Alice",
            "type": "direct",
            "to_name": "Bob",
            "content": "Hi Bob",
        }
        sender.send_text(json.dumps({"id": "m1", "endpoint": "send_message", "payload": payload}))
        
        evt = _recv_until_event(recipient, "chat.message")
        assert evt["type"] == "direct"
        assert evt["to_name"] == "Bob"
        assert evt["from_name"] == "Alice"
        assert evt["content"] == "Hi Bob"


def test_sector_observers_receive_redacted_movement(ws_client):
    with (
        ws_client.websocket_connect("/ws") as mover,
        ws_client.websocket_connect("/ws") as origin,
        ws_client.websocket_connect("/ws") as destination,
    ):
        _join_character(mover, "Mover", sector=0)
        _join_character(origin, "OriginWatcher")
        _join_character(destination, "DestWatcher", sector=1)

        # Move Mover from sector 0 -> 1
        move_payload = {
            "character_id": "Mover",
            "to_sector": 1,
        }
        mover.send_text(
            json.dumps(
                {
                    "id": "move-1",
                    "type": "rpc",
                    "endpoint": "move",
                    "payload": move_payload,
                }
            )
        )
        move_response = _recv_until(
            mover,
            lambda msg: msg.get("frame_type") == "rpc" and msg.get("endpoint") == "move",
        )
        assert move_response.get("ok") is True, move_response
        status_payload = _drain_pending_event(mover, "status.update")
        if status_payload is None:
            try:
                status_payload = _recv_until_event(mover, "status.update", timeout=0.5)
            except AssertionError:
                status_payload = None
        assert status_payload is None or status_payload.get("character_id") == "Mover"
        _recv_until_event(mover, "movement.complete")

        arrive_payload = _recv_movement(destination, "arrive")
        depart_payload = _recv_movement(origin, "depart")

        assert arrive_payload["movement"] == "arrive"
        assert arrive_payload["name"] == "Mover"
        assert arrive_payload["ship_type"] == "kestrel_courier"
        assert arrive_payload["move_type"] == "normal"
        assert "from_sector" not in arrive_payload
        assert "to_sector" not in arrive_payload
        assert "character_id" not in arrive_payload
        assert "timestamp" in arrive_payload

        assert depart_payload["movement"] == "depart"
        assert depart_payload["name"] == "Mover"
        assert depart_payload["ship_type"] == "kestrel_courier"
        assert depart_payload["move_type"] == "normal"
        assert "from_sector" not in depart_payload
        assert "to_sector" not in depart_payload

        # Teleport Mover back to sector 0 via join
        mover.send_text(
            json.dumps(
                {
                    "id": "join-teleport",
                    "type": "rpc",
                    "endpoint": "join",
                    "payload": {"character_id": "Mover", "sector": 0},
                }
            )
        )
        _recv_until(
            mover,
            lambda msg: msg.get("frame_type") == "rpc" and msg.get("endpoint") == "join",
        )
        _drain_pending_event(mover, "status.update")
        # Join teleport doesn't emit mover character.moved; drain any pending status updates
        _drain_pending_event(mover, "character.moved")

        teleport_arrive = _recv_movement(origin, "arrive")
        teleport_depart = _recv_movement(destination, "depart")

        assert teleport_arrive["move_type"] == "teleport"
        assert teleport_arrive["movement"] == "arrive"
        assert teleport_arrive["name"] == "Mover"
        assert teleport_depart["move_type"] == "teleport"
        assert teleport_depart["movement"] == "depart"


def test_toll_payment_via_combat_action(ws_client):
    sector_toll = 3
    entry_sector = 1
    owner_id = "toll-owner"
    mover_id = "toll-runner"
    toll_amount = 23

    # Reset garrison state for the sector
    if world.garrisons is None:
        pytest.skip("Garrison system unavailable")
    for garrison in world.garrisons.list_sector(sector_toll):
        world.garrisons.remove(sector_toll, garrison.owner_id)

    # Initialise ships and credits
    world.knowledge_manager.initialize_ship(owner_id, ShipType.KESTREL_COURIER)
    world.knowledge_manager.initialize_ship(mover_id, ShipType.KESTREL_COURIER)

    owner_knowledge = world.knowledge_manager.load_knowledge(owner_id)
    owner_knowledge.current_sector = sector_toll
    owner_knowledge.ship_config.current_fighters = 0
    owner_knowledge.ship_config.current_shields = 150
    world.knowledge_manager.save_knowledge(owner_knowledge)

    mover_knowledge = world.knowledge_manager.load_knowledge(mover_id)
    mover_knowledge.current_sector = entry_sector
    mover_knowledge.ship_config.current_fighters = 120
    mover_knowledge.ship_config.current_shields = 150
    world.knowledge_manager.save_knowledge(mover_knowledge)

    world.characters[owner_id] = Character(
        owner_id,
        sector=sector_toll,
        fighters=0,
        shields=150,
        max_fighters=300,
        max_shields=150,
        connected=False,
    )
    world.characters[mover_id] = Character(
        mover_id,
        sector=entry_sector,
        fighters=120,
        shields=150,
        max_fighters=300,
        max_shields=150,
        connected=False,
    )

    world.knowledge_manager.update_credits(owner_id, 100)
    world.knowledge_manager.update_credits(mover_id, 100)

    world.garrisons.deploy(
        sector_id=sector_toll,
        owner_id=owner_id,
        fighters=20,
        mode="toll",
        toll_amount=toll_amount,
        toll_balance=0,
    )

    with (
        ws_client.websocket_connect("/ws") as owner,
        ws_client.websocket_connect("/ws") as mover,
    ):
        _join_character(owner, owner_id, sector=sector_toll)
        _join_character(mover, mover_id, sector=entry_sector)

        # Move the runner into the toll sector to trigger combat
        mover.send_text(
            json.dumps(
                {
                    "id": "move-to-toll",
                    "type": "rpc",
                    "endpoint": "move",
                    "payload": {"character_id": mover_id, "to_sector": sector_toll},
                }
            )
        )
        _recv_until(
            mover,
            lambda msg: msg.get("frame_type") == "rpc"
            and msg.get("endpoint") == "move"
            and msg.get("ok") is True,
        )
        assert _drain_pending_event(mover, "character.moved") is None

        round_waiting = _recv_until_event(mover, "combat.round_waiting")
        combat_id = round_waiting.get("combat_id")
        assert combat_id
        round_number = round_waiting.get("round") or 1

        # Pay the toll during the demand round
        mover.send_text(
            json.dumps(
                {
                    "id": "pay-1",
                    "type": "rpc",
                    "endpoint": "combat.action",
                    "payload": {
                        "character_id": mover_id,
                        "combat_id": combat_id,
                        "action": "pay",
                        "round": round_number,
                    },
                }
            )
        )
        pay_response = _recv_until(
            mover,
            lambda msg: msg.get("frame_type") == "rpc"
            and msg.get("endpoint") == "combat.action"
            and msg.get("id") == "pay-1",
        )

        payload = pay_response.get("result", {})
        assert payload == {"success": True, "combat_id": combat_id}

        action_event = _recv_until_event(mover, "combat.action_accepted")
        assert action_event["combat_id"] == combat_id
        assert action_event.get("pay_processed") is True

        resolved = _recv_until_event(mover, "combat.round_resolved")
        ended = _recv_until_event(mover, "combat.ended")

        result_flag = ended.get("result") or ended.get("end")
        assert result_flag in {"stalemate", "toll_satisfied"}

        # Toll balance should remain on the garrison until collected
        garrisons = world.garrisons.list_sector(sector_toll)
        assert garrisons and garrisons[0].toll_balance == toll_amount

        # Credits were debited from the payer
        remaining = world.knowledge_manager.get_credits(mover_id)
        assert remaining == 100 - toll_amount

    # Clean up sector garrison for subsequent tests
    for garrison in world.garrisons.list_sector(sector_toll):
        world.garrisons.remove(sector_toll, garrison.owner_id)
_PENDING_FRAMES: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
