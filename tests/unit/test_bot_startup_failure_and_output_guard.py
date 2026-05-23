from __future__ import annotations

import os

import pytest

from pipecat.frames.frames import Frame, OutputTransportMessageFrame
from pipecat.processors.frame_processor import FrameDirection

import gradientbang.pipecat_server.bot as bot_module
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
async def test_bot_startup_passes_local_api_url_explicitly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LOCAL_API_POSTGRES_URL", "postgresql://local")
    monkeypatch.delenv("EDGE_FUNCTIONS_URL", raising=False)

    class FakeLocalApiServer:
        async def warmup(self, _character_id: str) -> None:
            return None

    fake_local_api_server = FakeLocalApiServer()

    async def fake_init_local_api():
        return fake_local_api_server, "http://localhost:54380"

    async def fake_resolve_character(*args, **kwargs):
        return "11111111-1111-1111-1111-111111111111", "Test Pilot"

    async def fake_init_stt(*args, **kwargs):
        return "stt"

    async def fake_init_tts(*args, **kwargs):
        return "tts"

    captured_client_kwargs: dict = {}

    class FakeRTVIProcessor:
        pass

    class FakeAsyncGameClient:
        def __init__(self, **kwargs):
            captured_client_kwargs.update(kwargs)

    monkeypatch.setattr(bot_module, "RTVIProcessor", FakeRTVIProcessor)
    monkeypatch.setattr(bot_module, "_startup_init_local_api", fake_init_local_api)
    monkeypatch.setattr(bot_module, "_startup_resolve_character", fake_resolve_character)
    monkeypatch.setattr(bot_module, "_startup_init_stt", fake_init_stt)
    monkeypatch.setattr(bot_module, "_startup_init_tts", fake_init_tts)
    monkeypatch.setattr(bot_module, "AsyncGameClient", FakeAsyncGameClient)

    (
        _rtvi,
        local_api_server,
        character_id,
        character_display_name,
        _game_client,
        stt,
        tts,
    ) = await bot_module.bot_startup(
        character_id_hint="11111111-1111-1111-1111-111111111111",
        character_name_hint="Test Pilot",
        server_url="http://supabase.local",
        voice_id="voice-id",
    )

    assert local_api_server is fake_local_api_server
    assert character_id == "11111111-1111-1111-1111-111111111111"
    assert character_display_name == "Test Pilot"
    assert stt == "stt"
    assert tts == "tts"
    assert captured_client_kwargs["base_url"] == "http://supabase.local"
    assert captured_client_kwargs["functions_url"] == "http://localhost:54380"
    assert "EDGE_FUNCTIONS_URL" not in os.environ


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
