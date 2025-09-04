from __future__ import annotations

import asyncio
import os
import platform
from typing import Any, Optional, Set

from loguru import logger

from pipecat.frames.frames import (
    InputAudioRawFrame,
    OutputAudioRawFrame,
    StartFrame,
    StartInterruptionFrame,
    TransportMessageFrame,
    TransportMessageUrgentFrame,
)
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.transports.base_input import BaseInputTransport
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import BaseTransport, TransportParams


def _is_macos():
    return platform.system() == "Darwin"


class LocalMacTransportParams(TransportParams):
    audio_in_sample_rate: Optional[int] = 16000
    audio_out_sample_rate: Optional[int] = 16000
    audio_in_channels: int = 1
    audio_out_channels: int = 1
    # Ensure BaseOutputTransport emits 10ms frames by default
    audio_out_10ms_chunks: int = 1
    # Ring buffer capacity in seconds (approx)
    ring_capacity_secs: float = 2.0
    # Playback pacing parameters
    preroll_ms: int = 40
    slice_ms: int = 5
    playback_headroom_ms: int = 10


class _VPIOLib:
    def __init__(self, lib_path: Optional[str] = None):
        if not _is_macos():
            raise RuntimeError("LocalMacTransport only supported on macOS")
        import ctypes as C

        # Resolve dylib path
        lib_path = lib_path or os.getenv("VPIO_LIB", os.path.abspath("./macos/libvpio.dylib"))
        if not os.path.exists(lib_path):
            raise FileNotFoundError(
                f"VPIO helper library not found at {lib_path}. Build it with: clang -dynamiclib -o macos/libvpio.dylib macos/vpio_helper.c -framework AudioToolbox -framework AudioUnit"
            )
        self.C = C
        self.path = lib_path
        self.lib = C.CDLL(lib_path)

        # Prototypes
        self.lib.vpio_init.argtypes = [C.c_double, C.c_int]
        self.lib.vpio_init.restype = C.c_int

        # Streaming API (optional: implemented below in C helper)
        # vpio_start_stream(double sr, int ch, size_t capBytes)
        try:
            self.lib.vpio_start_stream.argtypes = [C.c_double, C.c_int, C.c_size_t]
            self.lib.vpio_start_stream.restype = C.c_int
            self.has_stream = True
        except Exception:
            self.has_stream = False

        # vpio_stop_stream()
        try:
            self.lib.vpio_stop_stream.argtypes = []
            self.lib.vpio_stop_stream.restype = None
        except Exception:
            pass

        # vpio_read_capture(void* dst, size_t maxlen) -> size_t
        try:
            self.lib.vpio_read_capture.argtypes = [C.c_void_p, C.c_size_t]
            self.lib.vpio_read_capture.restype = C.c_size_t
        except Exception:
            pass

        # vpio_write_playback(const void* src, size_t len) -> size_t
        try:
            self.lib.vpio_write_playback.argtypes = [C.c_void_p, C.c_size_t]
            self.lib.vpio_write_playback.restype = C.c_size_t
        except Exception:
            pass

        # New C-paced playback APIs (optional)
        try:
            self.lib.vpio_write_frame_10ms.argtypes = [C.c_void_p, C.c_size_t]
            self.lib.vpio_write_frame_10ms.restype = C.c_size_t
            self.has_write_10ms = True
        except Exception:
            self.has_write_10ms = False
        try:
            self.lib.vpio_start_playback_thread.argtypes = [C.c_int, C.c_int]
            self.lib.vpio_start_playback_thread.restype = C.c_int
            self.lib.vpio_stop_playback_thread.argtypes = []
            self.lib.vpio_stop_playback_thread.restype = None
            self.lib.vpio_set_target_headroom_ms.argtypes = [C.c_int]
            self.lib.vpio_set_target_headroom_ms.restype = None
            # Optional flush for staging ring
            try:
                self.lib.vpio_flush_input.argtypes = []
                self.lib.vpio_flush_input.restype = None
                self.has_flush_input = True
            except Exception:
                self.has_flush_input = False
            self.has_play_thread = True
        except Exception:
            self.has_play_thread = False

        # Fallback single-shot API
        self.lib.vpio_record.argtypes = [C.c_double]
        self.lib.vpio_record.restype = C.c_int
        self.lib.vpio_get_capture_size.argtypes = []
        self.lib.vpio_get_capture_size.restype = C.c_size_t
        self.lib.vpio_copy_capture.argtypes = [C.c_void_p, C.c_size_t]
        self.lib.vpio_copy_capture.restype = C.c_size_t
        try:
            self.lib.vpio_reset_capture.argtypes = []
            self.lib.vpio_reset_capture.restype = C.c_size_t
            self.has_reset_capture = True
        except Exception:
            self.has_reset_capture = False
        self.lib.vpio_play.argtypes = [C.c_void_p, C.c_size_t]
        self.lib.vpio_play.restype = C.c_int

        # Shutdown
        self.lib.vpio_shutdown.argtypes = []
        self.lib.vpio_shutdown.restype = None
        # Debug functions (optional)
        try:
            self.lib.vpio_get_bypass.argtypes = [self.C.POINTER(self.C.c_uint)]
            self.lib.vpio_get_bypass.restype = self.C.c_int
            self.lib.vpio_get_in_sample_rate.argtypes = []
            self.lib.vpio_get_in_sample_rate.restype = self.C.c_double
            self.lib.vpio_get_out_sample_rate.argtypes = []
            self.lib.vpio_get_out_sample_rate.restype = self.C.c_double
            self.lib.vpio_get_ring_levels.argtypes = [
                self.C.POINTER(self.C.c_size_t),
                self.C.POINTER(self.C.c_size_t),
            ]
            self.lib.vpio_get_ring_levels.restype = self.C.c_size_t
            self.lib.vpio_get_underflow_count.argtypes = []
            self.lib.vpio_get_underflow_count.restype = self.C.c_size_t
            self.lib.vpio_reset_underflow_count.argtypes = []
            self.lib.vpio_reset_underflow_count.restype = None
            # Optional: staging ring debug
            try:
                self.lib.vpio_get_staging_level.argtypes = []
                self.lib.vpio_get_staging_level.restype = self.C.c_size_t
                self.lib.vpio_get_staging_capacity.argtypes = []
                self.lib.vpio_get_staging_capacity.restype = self.C.c_size_t
            except Exception:
                pass
            self.has_debug = True
        except Exception:
            self.has_debug = False

    def start_stream(self, sr: int, ch: int, cap_bytes: int) -> bool:
        if self.has_stream:
            rc = self.lib.vpio_start_stream(
                self.C.c_double(sr), self.C.c_int(ch), self.C.c_size_t(cap_bytes)
            )
            return rc == 0
        else:
            rc = self.lib.vpio_init(self.C.c_double(sr), self.C.c_int(ch))
            return rc == 0

    def stop_stream(self):
        try:
            self.lib.vpio_stop_stream()
        except Exception:
            pass
        self.lib.vpio_shutdown()


class MacInputTransport(BaseInputTransport):
    _params: LocalMacTransportParams

    def __init__(self, vpio: _VPIOLib, params: LocalMacTransportParams, parent: "LocalMacTransport"):
        super().__init__(params)
        self._vpio = vpio
        self._parent = parent
        self._sample_rate = 0
        self._poll_task: Optional[asyncio.Task] = None
        self._stop = False

    async def start(self, frame: StartFrame):
        await super().start(frame)
        # Ensure the underlying VPIO engine is running
        try:
            await self._parent._ensure_stream_started()
        except Exception:
            logger.exception("Error starting VPIO stream for input")
        self._sample_rate = self._params.audio_in_sample_rate or frame.audio_in_sample_rate
        # Start polling capture ring
        self._stop = False
        self._poll_task = self.create_task(self._poll_capture())
        await self.set_transport_ready(frame)
        # Notify parent that input is ready
        try:
            await self._parent._on_input_ready()
        except Exception:
            logger.exception("Error notifying parent of input ready")
        # Optional debug dump
        if os.getenv("VPIO_DEBUG"):
            if self._vpio.has_debug:
                C = self._vpio.C
                bypass = C.c_uint(0)
                rc = self._vpio.lib.vpio_get_bypass(C.byref(bypass))
                in_sr = self._vpio.lib.vpio_get_in_sample_rate()
                out_sr = self._vpio.lib.vpio_get_out_sample_rate()
                cap = C.c_size_t(0)
                play = C.c_size_t(0)
                _ = self._vpio.lib.vpio_get_ring_levels(C.byref(cap), C.byref(play))
                logger.info(
                    f"VPIO debug: bypass={bypass.value} rc={rc} inSR={in_sr:.2f} outSR={out_sr:.2f} capRing={cap.value} playRing={play.value}"
                )
            else:
                logger.info("VPIO debug not available in helper")

    async def stop(self, frame):
        self._stop = True
        if self._poll_task:
            await self.cancel_task(self._poll_task)
            self._poll_task = None
        await super().stop(frame)
        # Notify parent that input stopped
        try:
            await self._parent._on_input_stopped()
        except Exception:
            logger.exception("Error notifying parent of input stopped")

    async def cancel(self, frame):
        self._stop = True
        if self._poll_task:
            await self.cancel_task(self._poll_task)
            self._poll_task = None
        await super().cancel(frame)
        # Notify parent that input cancelled
        try:
            await self._parent._on_input_stopped()
        except Exception:
            logger.exception("Error notifying parent of input cancel")

    async def _poll_capture(self):
        C = self._vpio.C
        bytes_per_20ms = int(self._sample_rate * 0.02) * self._params.audio_in_channels * 2
        buf = bytearray()
        # Sane buffer to read from helper in chunks
        read_chunk = max(bytes_per_20ms, 1024)
        cbuf = (C.c_ubyte * read_chunk)()
        while not self._stop:
            try:
                n = 0
                try:
                    n = int(self._vpio.lib.vpio_read_capture(cbuf, read_chunk))
                except AttributeError:
                    # Fallback: periodic record small chunk (not ideal, but keeps example working)
                    self._vpio.lib.vpio_record(C.c_double(0.02))
                    sz = int(self._vpio.lib.vpio_get_capture_size())
                    if sz > 0:
                        tmp = (C.c_ubyte * sz)()
                        got = int(self._vpio.lib.vpio_copy_capture(tmp, sz))
                        if got > 0:
                            buf.extend(bytes(tmp[:got]))
                            if self._vpio.has_reset_capture:
                                self._vpio.lib.vpio_reset_capture()
                    await asyncio.sleep(0.005)
                    continue

                if n > 0:
                    buf.extend(bytes(cbuf[:n]))

                while len(buf) >= bytes_per_20ms:
                    chunk = bytes(buf[:bytes_per_20ms])
                    del buf[:bytes_per_20ms]
                    frame = InputAudioRawFrame(
                        audio=chunk,
                        sample_rate=self._sample_rate,
                        num_channels=self._params.audio_in_channels,
                    )
                    await self.push_audio_frame(frame)

                await asyncio.sleep(0.005)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"VPIO poll error: {e}")
                await asyncio.sleep(0.02)

    async def push_app_message(self, message: Any):
        """Push an application message into the input side of the pipeline.

        Mirrors SmallWebRTCInputTransport semantics: wrap as
        TransportMessageUrgentFrame and push upstream immediately.
        """
        frame = TransportMessageUrgentFrame(message=message)
        await self.push_frame(frame)


class MacOutputTransport(BaseOutputTransport):
    _params: LocalMacTransportParams

    def __init__(self, vpio: _VPIOLib, params: LocalMacTransportParams, parent: "LocalMacTransport"):
        super().__init__(params)
        self._vpio = vpio
        self._parent = parent
        self._play_task: Optional[asyncio.Task] = None
        self._play_queue: Optional[asyncio.Queue[bytes]] = None
        self._metrics_task: Optional[asyncio.Task] = None
        self._pacer_last_ts: Optional[float] = None
        self._pacer_sum_dt: float = 0.0
        self._pacer_count: int = 0
        self._pacer_max_dt: float = 0.0
        self._pacer_slow_count: int = 0
        # Optional flush API
        try:
            self._vpio.lib.vpio_flush_playback.argtypes = []
            self._vpio.lib.vpio_flush_playback.restype = None
            self._has_flush = True
        except Exception:
            self._has_flush = False
        # Capability flags from helper
        self._has_play_thread = getattr(self._vpio, "has_play_thread", False)
        self._has_write_10ms = getattr(self._vpio, "has_write_10ms", False)

    async def start(self, frame: StartFrame):
        # Initialize base (sample rate, chunking)
        await super().start(frame)
        # Ensure the underlying VPIO engine is running
        try:
            await self._parent._ensure_stream_started()
        except Exception:
            logger.exception("Error starting VPIO stream for output")
        # Start C-paced playback thread if available; else fall back to Python pacer
        if self._has_play_thread and self._has_write_10ms:
            # Configure headroom and start thread
            try:
                self._vpio.lib.vpio_set_target_headroom_ms(self._params.playback_headroom_ms)
            except Exception:
                pass
            rc = self._vpio.lib.vpio_start_playback_thread(
                self._params.slice_ms, self._params.preroll_ms
            )
            if rc != 0:
                logger.warning("VPIO playback thread failed to start; falling back to Python pacer")
                self._has_play_thread = False
        if not self._has_play_thread or not self._has_write_10ms:
            self._play_queue = asyncio.Queue()
            self._play_task = self.create_task(self._playback_pacer())
        if os.getenv("VPIO_DEBUG"):
            self._metrics_task = self.create_task(self._pacer_metrics())
        # Register media senders after playback is ready
        await self.set_transport_ready(frame)
        # Notify parent that output is ready after playback path is established
        try:
            await self._parent._on_output_ready()
        except Exception:
            logger.exception("Error notifying parent of output ready")

    async def stop(self, frame):
        if self._play_task:
            await self.cancel_task(self._play_task)
            self._play_task = None
        if self._metrics_task:
            await self.cancel_task(self._metrics_task)
            self._metrics_task = None
        # Stop C playback thread if running
        if self._has_play_thread:
            try:
                self._vpio.lib.vpio_stop_playback_thread()
            except Exception:
                pass
        await super().stop(frame)
        # Notify parent that output stopped
        try:
            await self._parent._on_output_stopped()
        except Exception:
            logger.exception("Error notifying parent of output stopped")

    async def cancel(self, frame):
        if self._play_task:
            await self.cancel_task(self._play_task)
            self._play_task = None
        if self._metrics_task:
            await self.cancel_task(self._metrics_task)
            self._metrics_task = None
        if self._has_play_thread:
            try:
                self._vpio.lib.vpio_stop_playback_thread()
            except Exception:
                pass
        await super().cancel(frame)
        # Notify parent that output cancelled
        try:
            await self._parent._on_output_stopped()
        except Exception:
            logger.exception("Error notifying parent of output cancel")

    async def write_audio_frame(self, frame: OutputAudioRawFrame):
        if not frame.audio:
            return
        # Validate frame matches our configured output format; log anomalies once/second
        now = asyncio.get_running_loop().time()
        if not hasattr(self, "_warn_ts"):
            self._warn_ts = 0.0
        try:
            if frame.sample_rate and frame.sample_rate != self.sample_rate:
                if now - self._warn_ts >= 1.0:
                    logger.warning(
                        f"Output frame SR mismatch: frame={frame.sample_rate} transport={self.sample_rate}"
                    )
                    self._warn_ts = now
        except Exception:
            pass
        try:
            expected_10ms = int(self.sample_rate / 100) * self._params.audio_out_channels * 2
            if len(frame.audio) % expected_10ms != 0:
                if now - self._warn_ts >= 1.0:
                    logger.warning(
                        f"Unexpected frame size: len={len(frame.audio)} not a multiple of 10ms={expected_10ms}"
                    )
                    self._warn_ts = now
        except Exception:
            pass
        if self._has_play_thread and self._has_write_10ms:
            # Push 10ms frames directly into helper staging ring
            C = self._vpio.C
            c_arr = (C.c_ubyte * len(frame.audio)).from_buffer_copy(frame.audio)
            try:
                _ = self._vpio.lib.vpio_write_frame_10ms(c_arr, len(frame.audio))
            except Exception as e:
                logger.warning(f"vpio_write_frame_10ms failed: {e}; falling back to pacer queue")
                if self._play_queue is None:
                    self._play_queue = asyncio.Queue()
                await self._play_queue.put(frame.audio)
        else:
            # Enqueue raw bytes; pacer will slice to 10ms and feed helper at ~real-time
            if self._play_queue is None:
                self._play_queue = asyncio.Queue()
            await self._play_queue.put(frame.audio)

    async def _playback_pacer(self):
        C = self._vpio.C
        bytes_per_10ms = int(self.sample_rate / 100) * self._params.audio_out_channels * 2
        bytes_per_5ms = max(1, bytes_per_10ms // 2)
        buf = bytearray()
        try:
            while True:
                if not buf:
                    chunk = await self._play_queue.get()
                    buf.extend(chunk)
                # Write out in 5ms slices to pace near real-time
                while len(buf) >= bytes_per_5ms:
                    slice = bytes(buf[:bytes_per_5ms])
                    del buf[:bytes_per_5ms]
                    c_arr = (C.c_ubyte * len(slice)).from_buffer_copy(slice)
                    try:
                        self._vpio.lib.vpio_write_playback(c_arr, len(slice))
                    except AttributeError:
                        # Fallback to blocking play (will be choppy, but avoids crashing)
                        self._vpio.lib.vpio_play(c_arr, len(slice))
                    # Pacer metrics and pacing
                    now = asyncio.get_running_loop().time()
                    if self._pacer_last_ts is not None:
                        dt = now - self._pacer_last_ts
                        self._pacer_sum_dt += dt
                        self._pacer_count += 1
                        if dt > self._pacer_max_dt:
                            self._pacer_max_dt = dt
                        if dt > 0.012:  # >12ms considered slow
                            self._pacer_slow_count += 1
                    self._pacer_last_ts = now
                    await asyncio.sleep(0.005)
                # Tiny yield to avoid starving loop
                await asyncio.sleep(0)
        except asyncio.CancelledError:
            return

    async def _pacer_metrics(self):
        C = self._vpio.C
        last_underflows = 0
        while True:
            try:
                await asyncio.sleep(1.0)
                # Gather metrics
                avg = (
                    (self._pacer_sum_dt / self._pacer_count)
                    if (self._pacer_count and not self._has_play_thread)
                    else 0.0
                )
                mx = self._pacer_max_dt if not self._has_play_thread else 0.0
                slow = self._pacer_slow_count if not self._has_play_thread else 0
                if not self._has_play_thread:
                    # Reset local metrics (only meaningful for Python pacer)
                    self._pacer_sum_dt = 0.0
                    self._pacer_count = 0
                    self._pacer_max_dt = 0.0
                    self._pacer_slow_count = 0
                underflows = 0
                ring_play = C.c_size_t(0)
                ring_cap = C.c_size_t(0)
                try:
                    if self._vpio.has_debug:
                        underflows = int(self._vpio.lib.vpio_get_underflow_count())
                        _ = self._vpio.lib.vpio_get_ring_levels(
                            C.byref(ring_cap), C.byref(ring_play)
                        )
                        # Optional staging metrics
                        try:
                            stage = int(self._vpio.lib.vpio_get_staging_level())
                            stage_cap = int(self._vpio.lib.vpio_get_staging_capacity())
                        except Exception:
                            stage = 0
                            stage_cap = 0
                except Exception:
                    pass
                delta_uf = underflows - last_underflows
                last_underflows = underflows
                try:
                    logger.info(
                        f"VPIO pacer: avg={avg * 1000:.2f}ms max={mx * 1000:.2f}ms slow(>12ms)={slow} underflows+={delta_uf} playRing={ring_play.value} capRing={ring_cap.value} stageRing={stage}/{stage_cap}"
                    )
                except Exception:
                    logger.info(
                        f"VPIO pacer: avg={avg * 1000:.2f}ms max={mx * 1000:.2f}ms slow(>12ms)={slow} underflows+={delta_uf} playRing={ring_play.value} capRing={ring_cap.value}"
                    )
            except asyncio.CancelledError:
                return

    async def _clear_play_queue(self):
        if self._play_queue is None:
            return
        try:
            while True:
                self._play_queue.get_nowait()
        except asyncio.QueueEmpty:
            pass

    async def process_frame(self, frame, direction):
        # On interruption, drop enqueued slices and flush helper ring
        if isinstance(frame, StartInterruptionFrame):
            await self._clear_play_queue()
            try:
                if self._has_flush:
                    self._vpio.lib.vpio_flush_playback()
                if getattr(self._vpio, "has_flush_input", False):
                    self._vpio.lib.vpio_flush_input()
            except Exception:
                pass
        await super().process_frame(frame, direction)
    
    async def send_message(self, frame: TransportMessageFrame | TransportMessageUrgentFrame):
        # Forward to parent so observers (e.g., TUI) can receive transport messages
        try:
            await self._parent._on_transport_message(frame)
        except Exception:
            logger.exception("Error emitting transport message")


class LocalMacTransport(BaseTransport):
    """Local macOS transport using VoiceProcessingIO (VPIO).

    Registers on_client_connected and on_client_disconnected like network
    transports. For local use, the "client" argument passed to handlers is
    None by design.
    """
    def __init__(self, params: LocalMacTransportParams, lib_path: Optional[str] = None):
        super().__init__()
        if not _is_macos():
            raise RuntimeError("LocalMacTransport only supported on macOS")
        self._params = params
        self._vpio = _VPIOLib(lib_path)
        logger.info(
            f"Loaded VPIO helper: {self._vpio.path} (streaming={'yes' if self._vpio.has_stream else 'no'})"
        )
        # Register compatible connection & message events
        self._register_event_handler("on_client_connected")
        self._register_event_handler("on_client_disconnected")
        self._register_event_handler("on_app_message")
        self._register_event_handler("on_transport_message")

        # Track readiness of sides
        required: Set[str] = set()
        if self._params.audio_in_enabled:
            required.add("in")
        if self._params.audio_out_enabled:
            required.add("out")
        self._required_sides: Set[str] = required
        self._ready_sides: Set[str] = set()
        self._connected_emitted: bool = False
        self._disconnected_emitted: bool = False
        # Defer starting the VPIO engine until first start() of input/output.
        self._stream_started: bool = False
        self._input: Optional[MacInputTransport] = None
        self._output: Optional[MacOutputTransport] = None

    def input(self) -> FrameProcessor:
        if not self._input:
            self._input = MacInputTransport(self._vpio, self._params, self)
        return self._input

    def output(self) -> FrameProcessor:
        if not self._output:
            self._output = MacOutputTransport(self._vpio, self._params, self)
        return self._output

    # Internal helpers to emit connection lifecycle events
    async def _on_input_ready(self):
        await self._on_side_ready("in")

    async def _on_output_ready(self):
        await self._on_side_ready("out")

    async def _on_input_stopped(self):
        await self._on_side_stopped("in")

    async def _on_output_stopped(self):
        await self._on_side_stopped("out")

    async def _on_side_ready(self, side: str):
        # Do nothing if no sides are required
        if not self._required_sides:
            return
        # If we previously disconnected, reset for a new session
        if self._disconnected_emitted:
            self._ready_sides = set()
            self._connected_emitted = False
            self._disconnected_emitted = False
        if side in self._required_sides:
            self._ready_sides.add(side)
            await self._maybe_emit_connected()

    async def _maybe_emit_connected(self):
        if (
            not self._connected_emitted
            and self._required_sides
            and self._required_sides.issubset(self._ready_sides)
        ):
            self._connected_emitted = True
            try:
                await self._call_event_handler("on_client_connected", None)
            except Exception:
                logger.exception("Exception in on_client_connected handler")

    async def _on_side_stopped(self, side: str):
        if side in self._ready_sides:
            self._ready_sides.discard(side)
        await self._emit_disconnected_once()

    async def _emit_disconnected_once(self):
        if self._required_sides and self._connected_emitted and not self._disconnected_emitted:
            self._disconnected_emitted = True
            try:
                await self._call_event_handler("on_client_disconnected", None)
            except Exception:
                logger.exception("Exception in on_client_disconnected handler")

    async def _ensure_stream_started(self):
        if self._stream_started:
            return
        sr = self._params.audio_in_sample_rate or 16000
        ch = self._params.audio_in_channels
        cap_bytes = int(
            (self._params.ring_capacity_secs if hasattr(self._params, "ring_capacity_secs") else 2.0)
            * sr
            * ch
            * 2
        )
        if not self._vpio.start_stream(sr, ch, cap_bytes):
            raise RuntimeError("Failed to start VPIO stream")
        self._stream_started = True

    async def cleanup(self):
        await super().cleanup()
        if self._stream_started:
            try:
                self._vpio.stop_stream()
            except Exception:
                pass
            self._stream_started = False

    # Application messaging (simulated in-process app <-> transport link)
    async def send_app_message(self, message: Any):
        """Send an application message into the pipeline and emit event.

        Matches SmallWebRTC semantics: requires input to be ready; does not
        create processors implicitly.
        """
        if self._input is None or not self._connected_emitted:
            raise RuntimeError("Transport input not ready; cannot send app message")
        await self._input.push_app_message(message)
        await self._call_event_handler("on_app_message", message)

    async def _on_transport_message(self, frame: TransportMessageFrame | TransportMessageUrgentFrame):
        """Emit outgoing transport messages for the TUI/app to consume."""
        await self._call_event_handler("on_transport_message", frame)
