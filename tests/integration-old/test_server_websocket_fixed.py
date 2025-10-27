"""Fixed websocket test connecting to real server on port 8002."""
import json
import asyncio
import pytest
import websockets
import logging

# Set up logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

SERVER_URL = "ws://localhost:8002/ws"


async def send_and_log(ws, message):
    """Send message and log it."""
    logger.info(f"SEND: {json.dumps(message, indent=2)}")
    await ws.send(json.dumps(message))


async def recv_and_log(ws, timeout=5.0):
    """Receive message with timeout and log it."""
    try:
        msg_str = await asyncio.wait_for(ws.recv(), timeout=timeout)
        msg = json.loads(msg_str)
        logger.info(f"RECV: {json.dumps(msg, indent=2)}")
        return msg
    except asyncio.TimeoutError:
        logger.error(f"TIMEOUT: No message received within {timeout}s")
        raise AssertionError(f"Timeout waiting for message ({timeout}s)")


async def recv_until(ws, predicate, limit=10, timeout=5.0):
    """Receive messages until predicate matches or limit reached."""
    for i in range(limit):
        logger.debug(f"recv_until: iteration {i+1}/{limit}")
        msg = await recv_and_log(ws, timeout=timeout)
        if predicate(msg):
            logger.info(f"recv_until: Found matching message on iteration {i+1}")
            return msg
    raise AssertionError(f"Did not receive expected message within {limit} attempts")


@pytest.mark.asyncio
async def test_ws_join_and_status():
    """Test join and status with real server."""
    logger.info("=" * 80)
    logger.info("TEST: test_ws_join_and_status")
    logger.info("=" * 80)

    async with websockets.connect(SERVER_URL) as ws:
        logger.info("Connected to server")

        # Join
        req = {
            "id": "1",
            "type": "rpc",
            "endpoint": "join",
            "payload": {"character_id": "ws_player"}
        }
        await send_and_log(ws, req)

        # Collect join response and events
        join_response = None
        join_snapshot = None

        for i in range(10):
            logger.debug(f"Waiting for message {i+1}/10...")
            msg = await recv_and_log(ws, timeout=5.0)

            # Check for status.snapshot event from join
            if (
                msg.get("frame_type") == "event"
                and msg.get("event") == "status.snapshot"
                and msg.get("payload", {}).get("source", {}).get("method") == "join"
            ):
                logger.info("Got status.snapshot from join")
                join_snapshot = msg
                if join_response:
                    logger.info("Got both RPC response and snapshot, breaking")
                    break

            # Check for join RPC response
            elif (
                msg.get("frame_type") == "rpc"
                and msg.get("endpoint") == "join"
            ):
                logger.info(f"Got join RPC response: ok={msg.get('ok')}")
                if msg.get("ok") is False:
                    logger.error(f"Join failed: {msg.get('error')}")
                    raise AssertionError(f"Join RPC failed: {msg.get('error')}")
                join_response = msg
                if join_snapshot:
                    logger.info("Got both RPC response and snapshot, breaking")
                    break

            # Check for map.local event (also emitted by join)
            elif msg.get("frame_type") == "event" and msg.get("event") == "map.local":
                logger.info("Got map.local event (expected from join)")
                # Keep going, we need RPC response and status.snapshot

        # Validate join response
        assert join_response is not None, "Did not receive join RPC response"
        assert join_response["frame_type"] == "rpc"
        assert join_response["ok"] is True
        assert join_response["result"] == {"success": True}
        logger.info("✓ Join RPC response validated")

        # Validate status.snapshot
        assert join_snapshot is not None, "Did not receive status.snapshot for join"
        assert join_snapshot["frame_type"] == "event"
        assert join_snapshot["event"] == "status.snapshot"
        join_payload = join_snapshot["payload"]
        assert join_payload["player"]["name"] == "ws_player"
        assert join_payload["sector"]["id"] == 0
        assert join_payload["source"]["method"] == "join"
        assert join_payload["source"]["request_id"] == "1"
        logger.info("✓ status.snapshot validated")

        # my_status RPC
        logger.info("\n" + "=" * 80)
        logger.info("Testing my_status...")
        logger.info("=" * 80)

        req2 = {
            "id": "2",
            "type": "rpc",
            "endpoint": "my_status",
            "payload": {"character_id": "ws_player"}
        }
        await send_and_log(ws, req2)

        status_response = None
        snapshot_event = None

        for i in range(10):
            logger.debug(f"Waiting for message {i+1}/10...")
            msg = await recv_and_log(ws, timeout=5.0)

            if msg.get("frame_type") == "rpc" and msg.get("endpoint") == "my_status":
                logger.info(f"Got my_status RPC response: ok={msg.get('ok')}")
                if msg.get("ok") is False:
                    logger.error(f"my_status failed: {msg.get('error')}")
                    raise AssertionError(f"my_status RPC failed: {msg.get('error')}")
                status_response = msg
                if snapshot_event:
                    logger.info("Got both RPC response and snapshot, breaking")
                    break

            elif msg.get("frame_type") == "event" and msg.get("event") == "status.snapshot":
                logger.info("Got status.snapshot from my_status")
                snapshot_event = msg
                if status_response:
                    logger.info("Got both RPC response and snapshot, breaking")
                    break

        assert status_response is not None, "Did not receive my_status RPC response"
        assert snapshot_event is not None, "Did not receive status.snapshot event"

        assert status_response["frame_type"] == "rpc"
        assert status_response["ok"] is True
        assert status_response["result"] == {"success": True}
        logger.info("✓ my_status RPC response validated")

        status_payload = snapshot_event["payload"]
        assert status_payload["player"]["name"] == "ws_player"
        assert status_payload["source"]["method"] == "my_status"
        assert status_payload["source"]["request_id"] == "2"
        logger.info("✓ my_status status.snapshot validated")

        logger.info("\n" + "=" * 80)
        logger.info("TEST PASSED: test_ws_join_and_status")
        logger.info("=" * 80)


@pytest.mark.asyncio
async def test_ws_subscribe_my_status_push():
    """Test subscribing to status.update events."""
    logger.info("=" * 80)
    logger.info("TEST: test_ws_subscribe_my_status_push")
    logger.info("=" * 80)

    async with websockets.connect(SERVER_URL) as ws:
        logger.info("Connected to server")

        # Join first
        join_req = {
            "id": "1",
            "type": "rpc",
            "endpoint": "join",
            "payload": {"character_id": "push_player"}
        }
        await send_and_log(ws, join_req)

        # Wait for join response
        join_response = await recv_until(
            ws,
            lambda m: m.get("frame_type") == "rpc" and m.get("endpoint") == "join",
            timeout=5.0
        )
        logger.info(f"Got join response: ok={join_response.get('ok')}")
        if join_response.get("ok") is False:
            raise AssertionError(f"Join failed: {join_response.get('error')}")

        # Subscribe to status.update
        logger.info("\n" + "Subscribing to status.update...")
        subscribe_req = {
            "id": "sub1",
            "type": "subscribe",
            "event": "status.update",
            "character_id": "push_player"
        }
        await send_and_log(ws, subscribe_req)

        # Wait for subscription acknowledgment
        ack = await recv_until(
            ws,
            lambda m: m.get("frame_type") == "rpc" and m.get("id") == "sub1",
            timeout=5.0
        )
        assert ack["frame_type"] == "rpc"
        assert ack["ok"] is True
        logger.info("✓ Subscription acknowledged")

        # Wait for status.update event (should be sent immediately after subscription)
        event = await recv_until(
            ws,
            lambda m: m.get("frame_type") == "event" and m.get("event") == "status.update",
            timeout=5.0
        )
        assert event["frame_type"] == "event"
        assert event["event"] == "status.update"
        assert event["payload"]["player"]["name"] == "push_player"
        logger.info("✓ Received status.update event")

        logger.info("\n" + "=" * 80)
        logger.info("TEST PASSED: test_ws_subscribe_my_status_push")
        logger.info("=" * 80)
