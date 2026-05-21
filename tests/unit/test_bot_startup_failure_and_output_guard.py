from __future__ import annotations

import pytest

from pipecat.frames.frames import Frame, OutputTransportMessageFrame
from pipecat.processors.frame_processor import FrameDirection

from gradientbang.pipecat_server.bot import (
    DisconnectedOutputGuard,
    OutputConnectionState,
    _join_failure_log_message,
)
from gradientbang.utils.api_client import RPCError

pytestmark = pytest.mark.unit


def test_join_failure_log_message_describes_non_auth_rpc_failure() -> None:
    message = _join_failure_log_message(
        RPCError("list_known_ports", 500, "failed to load ports"),
    )

    assert message == (
        "Session initialization failed during list_known_ports: 500 failed to load ports"
    )
    assert "access token" not in message


def test_join_failure_log_message_mentions_token_for_auth_failures() -> None:
    message = _join_failure_log_message(
        RPCError("join", 401, "unauthorized"),
    )

    assert message == (
        "Session initialization failed during join: "
        "401 unauthorized — access token may be invalid or expired"
    )


@pytest.mark.asyncio
async def test_disconnected_output_guard_drops_transport_messages_after_disconnect() -> None:
    state = OutputConnectionState()
    state.mark_client_connected()
    state.mark_client_disconnected()
    guard = DisconnectedOutputGuard(state)
    pushed: list[tuple[Frame, FrameDirection]] = []

    async def capture(frame: Frame, direction: FrameDirection) -> None:
        pushed.append((frame, direction))

    guard.push_frame = capture  # type: ignore[method-assign]

    frame = OutputTransportMessageFrame({"type": "test"})
    await guard.process_frame(frame, FrameDirection.DOWNSTREAM)

    assert pushed == []


@pytest.mark.asyncio
async def test_disconnected_output_guard_passes_non_transport_frames() -> None:
    state = OutputConnectionState()
    state.mark_client_connected()
    state.mark_client_disconnected()
    guard = DisconnectedOutputGuard(state)
    pushed: list[tuple[Frame, FrameDirection]] = []

    async def capture(frame: Frame, direction: FrameDirection) -> None:
        pushed.append((frame, direction))

    guard.push_frame = capture  # type: ignore[method-assign]

    frame = Frame()
    await guard.process_frame(frame, FrameDirection.DOWNSTREAM)

    assert pushed == [(frame, FrameDirection.DOWNSTREAM)]


@pytest.mark.asyncio
async def test_disconnected_output_guard_passes_transport_messages_while_connected() -> None:
    state = OutputConnectionState()
    state.mark_client_connected()
    guard = DisconnectedOutputGuard(state)
    pushed: list[tuple[Frame, FrameDirection]] = []

    async def capture(frame: Frame, direction: FrameDirection) -> None:
        pushed.append((frame, direction))

    guard.push_frame = capture  # type: ignore[method-assign]

    frame = OutputTransportMessageFrame({"type": "test"})
    await guard.process_frame(frame, FrameDirection.DOWNSTREAM)

    assert pushed == [(frame, FrameDirection.DOWNSTREAM)]
