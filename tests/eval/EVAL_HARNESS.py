#!/usr/bin/env python3
"""RTVI eval harness: start a Pipecat Cloud bot, join its Daily room, send
client-ready, and capture bot events/transcripts until idle or timeout.

Usage:
  uv run --with pipecatcloud==0.4.3 --with daily-python python EVAL_HARNESS.py \
      --bot-name gb-bot-dev --api-key pk_... \
      --body '{"character_id":"...","character_name":"Cekura_Eval","bypass_tutorial":true}' \
      --timeout 60
"""
import argparse
import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from daily import CallClient, Daily, EventHandler
from pipecatcloud.session import Session, SessionParams


RTVI_LABEL = "rtvi-ai"


@dataclass
class Capture:
    started_at: float = field(default_factory=time.time)
    bot_messages: list[dict] = field(default_factory=list)
    bot_transcripts: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    bot_ready: asyncio.Event = field(default_factory=asyncio.Event)


class RTVIHandler(EventHandler):
    def __init__(self, capture: Capture, loop: asyncio.AbstractEventLoop):
        super().__init__()
        self._capture = capture
        self._loop = loop

    def on_app_message(self, message, sender):
        # Bot → client messages arrive as dicts when label == "rtvi-ai"
        if not isinstance(message, dict):
            return
        if message.get("label") != RTVI_LABEL:
            return
        msg_type = message.get("type", "")
        data = message.get("data", {})
        self._capture.bot_messages.append(message)

        if msg_type == "bot-ready":
            self._loop.call_soon_threadsafe(self._capture.bot_ready.set)
        elif msg_type in ("bot-transcription", "bot-tts-text"):
            text = data.get("text") if isinstance(data, dict) else None
            if text:
                self._capture.bot_transcripts.append(text)
        elif msg_type == "error":
            self._capture.errors.append(json.dumps(data))

    def on_participant_left(self, participant, reason):
        # noop — harness decides when to leave
        pass


async def run_eval(bot_name: str, api_key: str, body: dict, timeout: float) -> Capture:
    # 1. Start the bot via Pipecat Cloud (creates the Daily room).
    session = Session(
        agent_name=bot_name,
        api_key=api_key,
        params=SessionParams(data=body, use_daily=True),
    )
    result = await session.start()
    room_url = result.get("dailyRoom") or result.get("room_url")
    token = result.get("dailyToken") or result.get("token")
    if not room_url or not token:
        raise RuntimeError(f"No Daily room in session start response: {result}")
    print(f"[harness] bot started; joining {room_url}?t={token}")

    # 2. Join the Daily room with daily-python.
    Daily.init()
    loop = asyncio.get_running_loop()
    capture = Capture()
    handler = RTVIHandler(capture, loop)
    client = CallClient(event_handler=handler)

    join_done = asyncio.Event()
    join_error: dict = {}

    def _on_joined(data, error):
        if error:
            join_error["err"] = error
        loop.call_soon_threadsafe(join_done.set)

    client.join(
        room_url,
        token,
        client_settings={
            "inputs": {
                "camera": False,
                "microphone": {"isEnabled": True, "settings": {"deviceId": "default"}},
            },
            "publishing": {"microphone": {"isPublishing": False}},
        },
        completion=_on_joined,
    )
    await asyncio.wait_for(join_done.wait(), timeout=15)
    if join_error:
        raise RuntimeError(f"Daily join failed: {join_error}")
    print("[harness] joined room")


    print("[harness] sleep 5")
    await asyncio.sleep(5)
    print("[harness] done sleep 5")
    # 3. Send RTVI client-ready — this is what the bot's on_client_ready listens for.
    print("[harness] sending client-ready")
    client.send_app_message({"id": str(uuid.uuid4()), "label": "rtvi-ai", "type": "client-ready"})

    # 4. Wait for bot-ready, then capture until timeout.
    try:
        await asyncio.wait_for(capture.bot_ready.wait(), timeout=timeout)
        print("[harness] bot-ready received")
    except asyncio.TimeoutError:
        capture.errors.append("timeout waiting for bot-ready")

    # Keep listening for additional messages for the remaining budget.
    remaining = max(0.0, timeout - (time.time() - capture.started_at))
    await asyncio.sleep(remaining)

    # 5. Leave.
    leave_done = asyncio.Event()
    client.leave(completion=lambda *_: loop.call_soon_threadsafe(leave_done.set))
    try:
        await asyncio.wait_for(leave_done.wait(), timeout=5)
    except asyncio.TimeoutError:
        pass
    client.release()
    Daily.deinit()
    return capture


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bot-name", required=True)
    ap.add_argument("--api-key", required=True)
    ap.add_argument("--body", default="{}")
    ap.add_argument("--timeout", type=float, default=60.0)
    args = ap.parse_args()

    capture = asyncio.run(
        run_eval(args.bot_name, args.api_key, json.loads(args.body), args.timeout)
    )

    print("\n=== eval result ===")
    print(f"bot_ready:  {capture.bot_ready.is_set()}")
    print(f"messages:   {len(capture.bot_messages)}")
    print(f"transcripts: {len(capture.bot_transcripts)}")
    print(f"errors:     {capture.errors}")
    for t in capture.bot_transcripts:
        print(f"  bot> {t}")


if __name__ == "__main__":
    main()
