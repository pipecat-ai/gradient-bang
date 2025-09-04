from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, Optional

from macos.local_mac_transport import LocalMacTransport, LocalMacTransportParams
from pipecat.audio.vad.silero import SileroVADAnalyzer


class TransportManager:
    """Wrapper to create and manage LocalMacTransport and expose simple callbacks."""

    def __init__(self) -> None:
        self.transport: Optional[LocalMacTransport] = None
        self._on_status: list[Callable[[bool], Awaitable[None] | None]] = []
        self._on_inbound: list[Callable[[Any], Awaitable[None] | None]] = []
        self._on_outbound: list[Callable[[Any], Awaitable[None] | None]] = []

    async def start(self) -> None:
        if self.transport is not None:
            return
        params = LocalMacTransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            vad_analyzer=SileroVADAnalyzer(),
        )
        self.transport = LocalMacTransport(params=params)

        @self.transport.event_handler("on_client_connected")
        async def _on_connected(_transport, _client):  # noqa: ANN001
            await self._emit_status(True)

        @self.transport.event_handler("on_client_disconnected")
        async def _on_disconnected(_transport, _client):  # noqa: ANN001
            await self._emit_status(False)

        @self.transport.event_handler("on_app_message")
        async def _on_app_message(_transport, message: Any):
            await self._emit(self._on_inbound, message)

        @self.transport.event_handler("on_transport_message")
        async def _on_transport_message(_transport, frame):  # noqa: ANN001
            try:
                payload = getattr(frame, "message", frame)
            except Exception:
                payload = frame
            await self._emit(self._on_outbound, payload)

    async def cleanup(self) -> None:
        if self.transport is not None:
            try:
                try:
                    await asyncio.wait_for(self.transport.cleanup(), timeout=5.0)  # type: ignore[attr-defined]
                except asyncio.TimeoutError:
                    # Best-effort cleanup; don't block shutdown
                    pass
            finally:
                self.transport = None

    async def stop(self) -> None:
        """Alias for cleanup for semantic clarity."""
        await self.cleanup()

    def on_status(self, callback: Callable[[bool], Awaitable[None] | None]) -> None:
        self._on_status.append(callback)

    def on_inbound(self, callback: Callable[[Any], Awaitable[None] | None]) -> None:
        self._on_inbound.append(callback)

    def on_outbound(self, callback: Callable[[Any], Awaitable[None] | None]) -> None:
        self._on_outbound.append(callback)

    async def send_app_message(self, msg: Any) -> None:
        if not self.transport:
            raise RuntimeError("Transport not started")
        await self.transport.send_app_message(msg)

    async def _emit_status(self, connected: bool) -> None:
        await self._emit(self._on_status, connected)

    async def _emit(self, callbacks, *args) -> None:  # type: ignore[no-untyped-def]
        for cb in list(callbacks):
            res = cb(*args)
            if asyncio.iscoroutine(res):
                try:
                    await res
                except Exception:
                    # Swallow to avoid breaking the loop
                    pass
