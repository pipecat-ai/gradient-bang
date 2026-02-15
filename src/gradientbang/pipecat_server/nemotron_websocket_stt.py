"""Nemotron WebSocket STT service for Pipecat.

Adapted from the pipecat-ai/nemotron-january-2026 reference implementation.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import AsyncGenerator, Optional

import websockets
from loguru import logger
from websockets.protocol import State

from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    ErrorFrame,
    Frame,
    InterimTranscriptionFrame,
    StartFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.stt_service import WebsocketSTTService
from pipecat.utils.time import time_now_iso8601


class NemotronWebSocketSTTService(WebsocketSTTService):
    """Streaming STT service that connects to the Nemotron ASR websocket endpoint."""

    def __init__(
        self,
        *,
        url: str = "ws://localhost:8080",
        sample_rate: int = 16000,
        **kwargs,
    ):
        super().__init__(sample_rate=sample_rate, **kwargs)
        self._url = url
        self._websocket = None
        self._receive_task: Optional[asyncio.Task] = None
        self._ready = False
        self._audio_send_lock = asyncio.Lock()
        self._audio_bytes_sent = 0
        self._waiting_for_final = False
        self._pending_user_stopped_frame: Optional[UserStoppedSpeakingFrame] = None
        self._pending_frame_direction: FrameDirection = FrameDirection.DOWNSTREAM
        self._pending_frame_timeout_task: Optional[asyncio.Task] = None
        self._pending_frame_timeout_s = 0.5
        self.set_model_name("nemotron-asr-websocket")

    def can_generate_metrics(self) -> bool:
        return True

    async def start(self, frame: StartFrame):
        await super().start(frame)
        await self._connect()

    async def stop(self, frame: EndFrame):
        await self._cancel_pending_frame_timeout()
        if self._pending_user_stopped_frame:
            await self.push_frame(
                self._pending_user_stopped_frame,
                self._pending_frame_direction,
            )
            self._pending_user_stopped_frame = None
        await self._send_reset(finalize=True)
        await super().stop(frame)
        await self._disconnect()

    async def cancel(self, frame: CancelFrame):
        await self._cancel_pending_frame_timeout()
        self._pending_user_stopped_frame = None
        self._waiting_for_final = False
        await self._send_reset(finalize=True)
        await super().cancel(frame)
        await self._disconnect()

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        if self._websocket and self._ready:
            try:
                async with self._audio_send_lock:
                    self._audio_bytes_sent += len(audio)
                    await self._websocket.send(audio)
            except Exception as exc:
                logger.error(f"{self} failed to send audio: {exc}")
                await self._report_error(ErrorFrame(f"Failed to send audio: {exc}"))
        yield None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        if isinstance(frame, UserStartedSpeakingFrame):
            await self._cancel_pending_frame_timeout()
            self._pending_user_stopped_frame = None
            self._waiting_for_final = False
            await super().process_frame(frame, direction)
            return

        if isinstance(frame, UserStoppedSpeakingFrame):
            if self._waiting_for_final:
                self._pending_user_stopped_frame = frame
                self._pending_frame_direction = direction
                self._start_pending_frame_timeout()
                logger.debug(f"{self} holding UserStoppedSpeakingFrame at {time.time():.3f}")
                await self._send_reset(finalize=True)
                return
            await super().process_frame(frame, direction)
            return

        await super().process_frame(frame, direction)

        if isinstance(frame, VADUserStoppedSpeakingFrame):
            self._waiting_for_final = True
            await self._send_reset(finalize=False)

    async def _send_reset(self, finalize: bool = True):
        if self._websocket and self._ready:
            try:
                async with self._audio_send_lock:
                    await self._websocket.send(
                        json.dumps({"type": "reset", "finalize": finalize})
                    )
                    samples = self._audio_bytes_sent // 2
                    duration_ms = (samples * 1000) // 16000
                    reset_type = "hard" if finalize else "soft"
                    logger.debug(f"{self} sent {reset_type} reset (audio: {duration_ms}ms)")
                    if finalize:
                        self._audio_bytes_sent = 0
            except Exception as exc:
                logger.error(f"{self} failed to send reset: {exc}")

    def _start_pending_frame_timeout(self):
        if self._pending_frame_timeout_task:
            self._pending_frame_timeout_task.cancel()
        self._pending_frame_timeout_task = asyncio.create_task(
            self._pending_frame_timeout_handler()
        )

    async def _pending_frame_timeout_handler(self):
        try:
            await asyncio.sleep(self._pending_frame_timeout_s)
            if self._pending_user_stopped_frame:
                logger.debug(
                    f"{self} timeout waiting for final transcript, releasing UserStoppedSpeakingFrame"
                )
                await self.push_frame(
                    self._pending_user_stopped_frame,
                    self._pending_frame_direction,
                )
                self._pending_user_stopped_frame = None
                self._waiting_for_final = False
        except asyncio.CancelledError:
            pass

    async def _cancel_pending_frame_timeout(self):
        if self._pending_frame_timeout_task:
            self._pending_frame_timeout_task.cancel()
            try:
                await self._pending_frame_timeout_task
            except asyncio.CancelledError:
                pass
            self._pending_frame_timeout_task = None

    async def _release_pending_frame(self):
        self._waiting_for_final = False
        if self._pending_user_stopped_frame:
            await self._cancel_pending_frame_timeout()
            logger.debug(f"{self} releasing UserStoppedSpeakingFrame at {time.time():.3f}")
            await self.push_frame(
                self._pending_user_stopped_frame,
                self._pending_frame_direction,
            )
            self._pending_user_stopped_frame = None

    async def _connect(self):
        await super()._connect()
        logger.debug(f"{self} connecting to {self._url}")
        await self._connect_websocket()
        self._receive_task = asyncio.create_task(
            self._receive_task_handler(self._report_error)
        )
        await self._call_event_handler("on_connected", self)

    async def _disconnect(self):
        await super()._disconnect()
        logger.debug(f"{self} disconnecting")
        if self._receive_task:
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass
            self._receive_task = None
        await self._disconnect_websocket()
        await self._call_event_handler("on_disconnected", self)

    async def _connect_websocket(self):
        try:
            self._websocket = await websockets.connect(self._url)
            self._ready = False
            try:
                ready_msg = await asyncio.wait_for(self._websocket.recv(), timeout=5.0)
                data = json.loads(ready_msg)
                if data.get("type") == "ready":
                    self._ready = True
                    logger.info(f"{self} connected and ready")
                else:
                    logger.warning(f"{self} unexpected initial message: {data}")
                    self._ready = True
            except asyncio.TimeoutError:
                logger.warning(f"{self} timeout waiting for ready message, proceeding anyway")
                self._ready = True
        except Exception as exc:
            logger.error(f"{self} connection failed: {exc}")
            await self._report_error(ErrorFrame(f"Connection failed: {exc}"))
            raise

    async def _disconnect_websocket(self):
        self._ready = False
        if self._websocket:
            try:
                if self._websocket.state is not State.CLOSED:
                    await self._websocket.close()
            except Exception as exc:
                logger.debug(f"{self} error closing websocket: {exc}")
            finally:
                self._websocket = None

    async def _receive_messages(self):
        if not self._websocket:
            return
        async for message in self._websocket:
            try:
                data = json.loads(message)
                msg_type = data.get("type")
                if msg_type == "transcript":
                    await self._handle_transcript(data)
                elif msg_type == "error":
                    error_msg = data.get("message", "Unknown error")
                    logger.error(f"{self} server error: {error_msg}")
                    await self._report_error(ErrorFrame(f"Server error: {error_msg}"))
                elif msg_type == "ready":
                    self._ready = True
                    logger.debug(f"{self} server ready")
                else:
                    logger.debug(f"{self} unknown message type: {msg_type}")
            except json.JSONDecodeError as exc:
                logger.error(f"{self} invalid JSON: {exc}")
            except Exception as exc:
                logger.error(f"{self} error processing message: {exc}")

    async def _handle_transcript(self, data: dict):
        text = data.get("text", "")
        is_final = data.get("is_final", False)
        is_hard_reset = data.get("finalize", True)

        if not text:
            if is_final and is_hard_reset:
                await self._release_pending_frame()
            return

        await self.stop_ttfb_metrics()
        timestamp = time_now_iso8601()

        if is_final:
            if is_hard_reset:
                await self.push_frame(
                    TranscriptionFrame(text, self._user_id, timestamp, language=None)
                )
                await self.stop_processing_metrics()
                await self._release_pending_frame()
        else:
            await self.push_frame(
                InterimTranscriptionFrame(text, self._user_id, timestamp, language=None)
            )
