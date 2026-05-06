#!/usr/bin/env python3
"""Small WebRTC smoke client for the OpenAI Realtime voice path.

This is intentionally a lightweight integration probe, not a test harness. It:

1. Creates an aiortc peer connection against the local SmallWebRTC /api/offer.
2. Sends RTVI client-ready and a synthetic Gradient Bang user-text-input event.
3. Streams a short 24 kHz mono PCM prompt generated with Cartesia.
4. Prints RTVI/server events and counts received bot audio frames.
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


async def run(args: argparse.Namespace) -> int:
    prompt_pcm = await cartesia_tts_pcm(args.audio_text, voice_id=args.voice_id)
    track = PromptAudioTrack(prompt_pcm)
    pc = RTCPeerConnection()
    pc.addTrack(track)
    channel = pc.createDataChannel("pipecat")

    bot_ready = asyncio.Event()
    server_messages: list[dict[str, Any]] = []
    remote_audio_frames = 0

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

    if channel.readyState == "open" and args.text:
        print("[smoke] sending synthetic user-text-input client-message")
        channel.send(client_message("user-text-input", {"text": args.text}))

    await asyncio.sleep(args.audio_delay)
    print("[smoke] starting Cartesia audio prompt")
    track.start_prompt()
    await track.wait_done(timeout=15)
    await asyncio.sleep(args.listen_seconds)

    print(
        "[smoke] summary: "
        f"server_messages={len(server_messages)} remote_audio_frames={remote_audio_frames}"
    )
    await pc.close()
    return 0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:7860/api/offer")
    parser.add_argument(
        "--text",
        default="Typed smoke test: please acknowledge this in one short sentence.",
    )
    parser.add_argument(
        "--audio-text",
        default=(
            "Spoken smoke test from Cartesia audio. Please acknowledge the audio "
            "prompt in one short sentence."
        ),
    )
    parser.add_argument("--voice-id", default=DEFAULT_VOICE_ID)
    parser.add_argument("--ready-timeout", type=float, default=30.0)
    parser.add_argument("--audio-delay", type=float, default=2.0)
    parser.add_argument("--listen-seconds", type=float, default=12.0)
    raise SystemExit(asyncio.run(run(parser.parse_args())))


if __name__ == "__main__":
    main()
