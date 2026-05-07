#!/usr/bin/env python3
"""Small WebRTC smoke client for the OpenAI Realtime voice path.

This is intentionally a lightweight integration probe, not a test harness. It:

1. Creates an aiortc peer connection against the local SmallWebRTC /api/offer.
2. Sends RTVI client-ready and five Gradient Bang user-text-input turns.
3. Waits for bot-stopped-speaking between turns.
4. Optionally streams a 24 kHz mono PCM prompt generated with Cartesia.
5. Prints RTVI/server events and counts received bot audio frames.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
import uuid
from fractions import Fraction
from typing import Any

import aiohttp
import numpy as np
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import AudioStreamTrack, MediaStreamError
from av import AudioFrame


SAMPLE_RATE = 24000
SAMPLES_PER_20MS = SAMPLE_RATE * 20 // 1000
BYTES_PER_20MS = SAMPLES_PER_20MS * 2
RTVI_LABEL = "rtvi-ai"
DEFAULT_VOICE_ID = "ec1e269e-9ca0-402f-8a18-58e0e022355a"
DEFAULT_TEXT_TURNS = (
    "Hello, who else is in this sector?",
    "What's the name of our ship?",
    "Use the corporation_info tool now with no arguments, then tell me the corporation ship names.",
    "Thanks, that was helpful.",
    "What sectors are next door?",
)
BOT_STOPPED_SPEAKING = "bot-stopped-speaking"
SESSION_READY_EVENTS = {"session.version"}


def rtvi_message(message_type: str, data: dict[str, Any] | None = None) -> str:
    msg: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "label": RTVI_LABEL,
        "type": message_type,
    }
    if data is not None:
        msg["data"] = data
    return json.dumps(msg)


def client_message(message_type: str, data: dict[str, Any] | None = None) -> str:
    return rtvi_message("client-message", {"t": message_type, "d": data or {}})


def synth_fallback_pcm(text: str) -> bytes:
    """Generate a deterministic fallback tone if Cartesia is unavailable."""
    duration = max(1.2, min(3.0, 0.05 * len(text.split()) + 1.2))
    t = np.arange(int(SAMPLE_RATE * duration), dtype=np.float32) / SAMPLE_RATE
    # Modulated tone with quiet pauses so VAD/S3 sees a speech-like burst.
    carrier = np.sin(2 * np.pi * 220 * t) * 0.18
    envelope = np.clip(np.sin(np.pi * np.minimum(t / 0.12, 1.0)), 0.0, 1.0)
    tail = np.clip((duration - t) / 0.18, 0.0, 1.0)
    samples = carrier * envelope * tail
    return (samples * 32767).astype("<i2").tobytes()


async def cartesia_tts_pcm(text: str, *, voice_id: str) -> bytes:
    api_key = os.getenv("CARTESIA_API_KEY")
    if not api_key:
        print("[smoke] CARTESIA_API_KEY missing; using fallback generated tone")
        return synth_fallback_pcm(text)

    payload = {
        "model_id": os.getenv("CARTESIA_SMOKE_MODEL", "sonic-3"),
        "transcript": text,
        "voice": {"mode": "id", "id": voice_id},
        "output_format": {
            "container": "raw",
            "encoding": "pcm_s16le",
            "sample_rate": SAMPLE_RATE,
        },
        "language": "en",
    }
    headers = {
        "Cartesia-Version": "2026-03-01",
        "X-API-Key": api_key,
        "Content-Type": "application/json",
    }
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                "https://api.cartesia.ai/tts/bytes",
                headers=headers,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                body = await resp.read()
                if resp.status != 200:
                    print(
                        f"[smoke] Cartesia TTS failed with HTTP {resp.status}; "
                        "using fallback generated tone"
                    )
                    return synth_fallback_pcm(text)
                print(f"[smoke] generated {len(body)} bytes of Cartesia PCM")
                return body
    except Exception as exc:  # noqa: BLE001
        print(f"[smoke] Cartesia TTS exception {exc!r}; using fallback generated tone")
        return synth_fallback_pcm(text)


class PromptAudioTrack(AudioStreamTrack):
    kind = "audio"

    def __init__(self, pcm: bytes):
        super().__init__()
        padding = (-len(pcm)) % BYTES_PER_20MS
        self._pcm = pcm + bytes(padding)
        self._offset = 0
        self._pts = 0
        self._started_at = time.monotonic()
        self._start_event = asyncio.Event()
        self._done_event = asyncio.Event()

    def start_prompt(self) -> None:
        self._start_event.set()

    async def wait_done(self, timeout: float) -> bool:
        try:
            await asyncio.wait_for(self._done_event.wait(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            return False

    async def recv(self) -> AudioFrame:
        if self._pts > 0:
            target = self._started_at + self._pts / SAMPLE_RATE
            delay = target - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)

        if self._start_event.is_set() and self._offset < len(self._pcm):
            chunk = self._pcm[self._offset : self._offset + BYTES_PER_20MS]
            self._offset += BYTES_PER_20MS
            if self._offset >= len(self._pcm):
                self._done_event.set()
        else:
            chunk = bytes(BYTES_PER_20MS)

        samples = np.frombuffer(chunk, dtype=np.int16)
        frame = AudioFrame.from_ndarray(samples[None, :], layout="mono")
        frame.sample_rate = SAMPLE_RATE
        frame.pts = self._pts
        frame.time_base = Fraction(1, SAMPLE_RATE)
        self._pts += SAMPLES_PER_20MS
        return frame


async def post_offer(url: str, offer: RTCSessionDescription, request_data: dict[str, Any]):
    payload = {
        "sdp": offer.sdp,
        "type": offer.type,
        "request_data": request_data,
    }
    async with aiohttp.ClientSession() as session:
        async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            text = await resp.text()
            if resp.status != 200:
                raise RuntimeError(f"offer failed HTTP {resp.status}: {text[:500]}")
            return json.loads(text)


def text_turns_from_args(args: argparse.Namespace) -> list[str]:
    if args.turn:
        return [turn for turn in args.turn if turn]
    if args.text is not None:
        return [args.text] if args.text else []
    return list(DEFAULT_TEXT_TURNS)


async def run(args: argparse.Namespace) -> int:
    text_turns = text_turns_from_args(args)
    expect_tool = args.expect_tool
    if expect_tool is None and text_turns == list(DEFAULT_TEXT_TURNS):
        expect_tool = "corporation_info"

    prompt_pcm = await cartesia_tts_pcm(args.audio_text, voice_id=args.voice_id) if args.audio_text else b""
    track = PromptAudioTrack(prompt_pcm)
    pc = RTCPeerConnection()
    pc.addTrack(track)
    channel = pc.createDataChannel("pipecat")

    bot_ready = asyncio.Event()
    session_ready = asyncio.Event()
    turn_state_condition = asyncio.Condition()
    server_messages: list[dict[str, Any]] = []
    function_call_names: list[str] = []
    remote_audio_frames = 0
    bot_stopped_speaking_count = 0
    bot_is_speaking = False
    bot_llm_active = False
    active_function_calls = 0
    last_turn_activity_at = time.monotonic()

    async def notify_turn_state() -> None:
        async with turn_state_condition:
            turn_state_condition.notify_all()

    def mark_turn_activity() -> None:
        nonlocal last_turn_activity_at
        last_turn_activity_at = time.monotonic()
        asyncio.create_task(notify_turn_state())

    async def wait_for_idle(
        label: str,
        *,
        quiet_seconds: float,
        timeout_seconds: float,
        require_new_bot_stop: bool = False,
        baseline_bot_stop_count: int = 0,
        required_tool: str | None = None,
        baseline_required_tool_count: int = 0,
    ) -> bool:
        deadline = time.monotonic() + timeout_seconds
        async with turn_state_condition:
            while True:
                now = time.monotonic()
                stop_requirement_met = (
                    not require_new_bot_stop
                    or bot_stopped_speaking_count > baseline_bot_stop_count
                )
                tool_requirement_met = (
                    required_tool is None
                    or function_call_names.count(required_tool) > baseline_required_tool_count
                )
                if (
                    stop_requirement_met
                    and tool_requirement_met
                    and not bot_is_speaking
                    and not bot_llm_active
                    and active_function_calls == 0
                ):
                    quiet_remaining = quiet_seconds - (now - last_turn_activity_at)
                    if quiet_remaining <= 0:
                        return True
                    timeout = min(quiet_remaining, max(0.0, deadline - now))
                else:
                    timeout = max(0.0, deadline - now)

                if timeout <= 0:
                    print(f"[smoke] timed out waiting for {label} to become idle")
                    return False

                try:
                    await asyncio.wait_for(turn_state_condition.wait(), timeout=timeout)
                except asyncio.TimeoutError:
                    continue

    async def wait_for_turn_complete(
        turn_index: int,
        baseline_bot_stop_count: int,
        *,
        required_tool: str | None,
        baseline_required_tool_count: int,
    ) -> bool:
        return await wait_for_idle(
            f"turn {turn_index}",
            quiet_seconds=args.post_stop_quiet,
            timeout_seconds=args.turn_timeout,
            require_new_bot_stop=True,
            baseline_bot_stop_count=baseline_bot_stop_count,
            required_tool=required_tool,
            baseline_required_tool_count=baseline_required_tool_count,
        )

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        print(f"[smoke] pc.connectionState={pc.connectionState}")

    @pc.on("iceconnectionstatechange")
    async def on_iceconnectionstatechange():
        print(f"[smoke] pc.iceConnectionState={pc.iceConnectionState}")

    @pc.on("track")
    def on_track(remote_track):
        print(f"[smoke] remote track: {remote_track.kind}")

        async def consume_audio():
            nonlocal remote_audio_frames
            while True:
                try:
                    await remote_track.recv()
                except MediaStreamError:
                    return
                if remote_track.kind == "audio":
                    remote_audio_frames += 1
                    if remote_audio_frames in {1, 10, 50, 100}:
                        print(f"[smoke] received bot audio frame #{remote_audio_frames}")

        asyncio.create_task(consume_audio())

    @channel.on("open")
    def on_open():
        print("[smoke] data channel open")
        channel.send(
            rtvi_message(
                "client-ready",
                {
                    "version": "1.2.0",
                    "about": {
                        "library": "gradient-bang-aiortc-smoke",
                        "library_version": "0",
                        "platform": "python",
                    },
                },
            )
        )

        async def ping_loop():
            while channel.readyState == "open":
                channel.send("ping")
                await asyncio.sleep(1)

        asyncio.create_task(ping_loop())

    @channel.on("message")
    def on_message(message):
        nonlocal active_function_calls, bot_is_speaking, bot_llm_active, bot_stopped_speaking_count

        try:
            parsed = json.loads(message)
        except Exception:
            print(f"[smoke] data message: {message!r}")
            return
        if isinstance(parsed, dict) and parsed.get("label") == RTVI_LABEL:
            msg_type = parsed.get("type")
            print(f"[smoke] rtvi <- {msg_type}")
            server_messages.append(parsed)
            if msg_type == "bot-ready":
                bot_ready.set()
            elif msg_type == "server-message":
                data = parsed.get("data") or {}
                if isinstance(data, dict):
                    event_name = data.get("event")
                    if (
                        data.get("frame_type") == "event"
                        and isinstance(event_name, str)
                        and event_name in SESSION_READY_EVENTS
                    ):
                        if not session_ready.is_set():
                            print(f"[smoke] session startup event received: {event_name}")
                        session_ready.set()
            elif msg_type == "bot-started-speaking":
                bot_is_speaking = True
                mark_turn_activity()
            elif msg_type == BOT_STOPPED_SPEAKING:
                bot_stopped_speaking_count += 1
                bot_is_speaking = False
                mark_turn_activity()
            elif msg_type == "bot-llm-started":
                bot_llm_active = True
                mark_turn_activity()
            elif msg_type == "bot-llm-stopped":
                bot_llm_active = False
                mark_turn_activity()
            elif msg_type == "llm-function-call-started":
                active_function_calls += 1
                mark_turn_activity()
            elif msg_type == "llm-function-call-stopped":
                active_function_calls = max(0, active_function_calls - 1)
                mark_turn_activity()
            elif msg_type == "llm-function-call-in-progress":
                data = parsed.get("data") or {}
                function_name = data.get("function_name")
                if isinstance(function_name, str):
                    function_call_names.append(function_name)
                    print(f"[smoke] function call in progress: {function_name}")
                mark_turn_activity()
            return
        print(f"[smoke] data json: {parsed}")

    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    request_data: dict[str, Any] = {"bypass_tutorial": True}
    if os.getenv("BOT_TEST_CHARACTER_ID"):
        request_data["character_id"] = os.environ["BOT_TEST_CHARACTER_ID"]
    if os.getenv("BOT_TEST_CHARACTER_NAME"):
        request_data["character_name"] = os.environ["BOT_TEST_CHARACTER_NAME"]

    answer = await post_offer(args.url, pc.localDescription, request_data)
    await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type=answer["type"]))
    print(f"[smoke] connected offer pc_id={answer.get('pc_id')}")

    try:
        await asyncio.wait_for(bot_ready.wait(), timeout=args.ready_timeout)
        print("[smoke] bot-ready received")
    except asyncio.TimeoutError:
        print("[smoke] timed out waiting for bot-ready")
        await pc.close()
        return 1

    try:
        await asyncio.wait_for(session_ready.wait(), timeout=args.session_timeout)
    except asyncio.TimeoutError:
        print("[smoke] timed out waiting for session startup event")
        await pc.close()
        return 1

    last_turn_activity_at = time.monotonic()
    print("[smoke] waiting for startup idle")
    if not await wait_for_idle(
        "startup",
        quiet_seconds=args.startup_quiet,
        timeout_seconds=args.startup_timeout,
    ):
        await pc.close()
        return 1

    exit_code = 0

    for index, text in enumerate(text_turns, start=1):
        if channel.readyState != "open":
            print(f"[smoke] data channel closed before turn {index}")
            exit_code = 1
            break

        baseline_count = bot_stopped_speaking_count
        baseline_expected_tool_count = function_call_names.count(expect_tool) if expect_tool else 0
        required_tool = (
            expect_tool
            if expect_tool and args.expect_tool_turn == index
            else None
        )
        print(f"[smoke] turn {index}/{len(text_turns)} -> {text}")
        channel.send(client_message("user-text-input", {"text": text}))
        if not await wait_for_turn_complete(
            index,
            baseline_count,
            required_tool=required_tool,
            baseline_required_tool_count=baseline_expected_tool_count,
        ):
            exit_code = 1
            break
        await asyncio.sleep(args.turn_gap)
        if args.turn_gap > 0 and not await wait_for_idle(
            f"post-gap turn {index}",
            quiet_seconds=args.post_stop_quiet,
            timeout_seconds=args.turn_timeout,
        ):
            exit_code = 1
            break
        print(
            f"[smoke] turn {index}/{len(text_turns)} completed after "
            f"{BOT_STOPPED_SPEAKING} and idle"
        )

    if expect_tool and expect_tool not in function_call_names:
        print(
            f"[smoke] expected tool call {expect_tool!r} was not observed; "
            f"observed={function_call_names}"
        )
        exit_code = 1

    if args.audio_text and exit_code == 0:
        baseline_count = bot_stopped_speaking_count
        await asyncio.sleep(args.audio_delay)
        print("[smoke] starting Cartesia audio prompt")
        track.start_prompt()
        if not await track.wait_done(timeout=args.audio_timeout):
            print("[smoke] timed out waiting for audio prompt to finish streaming")
            exit_code = 1
        elif not await wait_for_turn_complete(
            0,
            baseline_count,
            required_tool=None,
            baseline_required_tool_count=0,
        ):
            exit_code = 1
        else:
            print(f"[smoke] audio prompt completed after {BOT_STOPPED_SPEAKING} and idle")

    await asyncio.sleep(args.listen_seconds)

    print(
        "[smoke] summary: "
        f"server_messages={len(server_messages)} "
        f"remote_audio_frames={remote_audio_frames} "
        f"function_calls={function_call_names}"
    )
    await pc.close()
    return exit_code


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:7860/api/offer")
    parser.add_argument(
        "--text",
        default=None,
        help="Legacy single text turn override. Omit to run the default five-turn smoke.",
    )
    parser.add_argument(
        "--turn",
        action="append",
        help="Text turn to send. Repeat to provide a custom multi-turn script.",
    )
    parser.add_argument(
        "--expect-tool",
        default=None,
        help=(
            "Tool name that must be observed in RTVI function-call events. "
            "Defaults to corporation_info for the built-in five-turn script. "
            "Pass an empty string to disable."
        ),
    )
    parser.add_argument(
        "--turn-timeout",
        type=float,
        default=90.0,
        help="Seconds to wait for bot-stopped-speaking after each text turn.",
    )
    parser.add_argument(
        "--turn-gap",
        type=float,
        default=1.0,
        help="Seconds to pause after bot-stopped-speaking before sending the next turn.",
    )
    parser.add_argument(
        "--post-stop-quiet",
        type=float,
        default=1.5,
        help="Seconds of no speech/function-call activity required after bot-stopped-speaking.",
    )
    parser.add_argument(
        "--audio-text",
        default="",
        help="Optional spoken prompt to synthesize and stream after text turns.",
    )
    parser.add_argument("--voice-id", default=DEFAULT_VOICE_ID)
    parser.add_argument("--ready-timeout", type=float, default=30.0)
    parser.add_argument("--session-timeout", type=float, default=60.0)
    parser.add_argument("--startup-timeout", type=float, default=90.0)
    parser.add_argument(
        "--startup-quiet",
        type=float,
        default=2.0,
        help="Seconds of no speech/function-call activity required before the first turn.",
    )
    parser.add_argument(
        "--expect-tool-turn",
        type=int,
        default=3,
        help="Turn index that must observe --expect-tool. Set to 0 to only check by session end.",
    )
    parser.add_argument("--audio-delay", type=float, default=2.0)
    parser.add_argument("--audio-timeout", type=float, default=30.0)
    parser.add_argument("--listen-seconds", type=float, default=2.0)
    raise SystemExit(asyncio.run(run(parser.parse_args())))


if __name__ == "__main__":
    main()
