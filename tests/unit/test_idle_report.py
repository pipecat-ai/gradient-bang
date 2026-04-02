"""Tests for IdleReportProcessor timing, cooldown, and shutdown."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    CancelFrame,
    LLMFullResponseStartFrame,
    UserStartedSpeakingFrame,
)

from gradientbang.pipecat_server.frames import UserTextInputFrame
from gradientbang.pipecat_server.idle_report import IdleReportProcessor


class _FakeDirection:
    DOWNSTREAM = "downstream"


def _make_processor(
    idle_seconds: float = 0.1,
    cooldown_seconds: float = 0.3,
    on_idle: AsyncMock | None = None,
) -> IdleReportProcessor:
    """Create an IdleReportProcessor with short timers for testing."""
    cb = on_idle or AsyncMock(return_value=True)
    proc = IdleReportProcessor(
        idle_seconds=idle_seconds,
        cooldown_seconds=cooldown_seconds,
        on_idle=cb,
    )
    # Stub push_frame so frames aren't sent into a real pipeline.
    proc.push_frame = AsyncMock()
    # Use real asyncio tasks via create_task.
    proc.create_task = lambda coro, *a, **kw: asyncio.get_event_loop().create_task(coro)
    return proc


async def _send(proc, frame, direction=_FakeDirection.DOWNSTREAM):
    await proc.process_frame(frame, direction)


@pytest.mark.unit
class TestIdleReportProcessor:
    """Core idle report timing tests."""

    async def test_no_fire_before_first_bot_speech(self):
        """Timer should not start until BotStoppedSpeakingFrame."""
        cb = AsyncMock(return_value=True)
        proc = _make_processor(idle_seconds=0.05, on_idle=cb)

        # Wait longer than idle_seconds — no report because not started.
        await asyncio.sleep(0.1)
        cb.assert_not_called()

    async def test_no_fire_before_user_interaction(self):
        """Timer should not fire after greeting speech if user hasn't interacted yet."""
        cb = AsyncMock(return_value=True)
        proc = _make_processor(idle_seconds=0.05, on_idle=cb)

        # Bot greeting finishes but no user interaction yet.
        await _send(proc, BotStoppedSpeakingFrame())
        await asyncio.sleep(0.1)
        cb.assert_not_called()

    async def test_fires_after_idle(self):
        """Report fires after idle_seconds of silence."""
        cb = AsyncMock(return_value=True)
        proc = _make_processor(idle_seconds=0.1, on_idle=cb)

        # User must interact before idle monitoring starts.
        await _send(proc, UserStartedSpeakingFrame())
        await _send(proc, BotStoppedSpeakingFrame())
        await asyncio.sleep(0.15)
        cb.assert_called_once()

    async def test_cooldown_prevents_rapid_fire(self):
        """After a report fires, the next one should wait cooldown + idle."""
        cb = AsyncMock(return_value=True)
        proc = _make_processor(idle_seconds=0.05, cooldown_seconds=0.2, on_idle=cb)

        await _send(proc, UserStartedSpeakingFrame())
        await _send(proc, BotStoppedSpeakingFrame())

        # First report fires after ~0.05s.
        await asyncio.sleep(0.08)
        assert cb.call_count == 1

        # Simulate the bot speaking the report and finishing.
        await _send(proc, BotStartedSpeakingFrame())
        await _send(proc, BotStoppedSpeakingFrame())

        # At this point, next timer is cooldown + idle = 0.25s from first fire.
        # Wait less than that — should NOT have fired again.
        await asyncio.sleep(0.1)
        assert cb.call_count == 1

        # Wait for the full cooldown + idle period.
        await asyncio.sleep(0.2)
        assert cb.call_count == 2

    async def test_user_speaking_cancels_timer(self):
        """User speaking cancels timer. Only bot stop restarts it."""
        cb = AsyncMock(return_value=True)
        proc = _make_processor(idle_seconds=0.1, on_idle=cb)

        await _send(proc, UserStartedSpeakingFrame())
        await _send(proc, BotStoppedSpeakingFrame())

        # User speaks — cancels timer.
        await asyncio.sleep(0.07)
        await _send(proc, UserStartedSpeakingFrame())

        # Wait well past idle — should NOT fire (cancelled, not restarted).
        await asyncio.sleep(0.2)
        cb.assert_not_called()

        # Bot responds and finishes — NOW timer starts.
        await _send(proc, BotStartedSpeakingFrame())
        await _send(proc, BotStoppedSpeakingFrame())
        await asyncio.sleep(0.15)
        cb.assert_called_once()

    async def test_user_text_input_cancels_timer(self):
        """Text input cancels timer. Only bot stop restarts it."""
        cb = AsyncMock(return_value=True)
        proc = _make_processor(idle_seconds=0.1, on_idle=cb)

        await _send(proc, UserStartedSpeakingFrame())
        await _send(proc, BotStoppedSpeakingFrame())

        await asyncio.sleep(0.07)
        await _send(proc, UserTextInputFrame(text="hello"))

        # Wait well past idle — should NOT fire.
        await asyncio.sleep(0.2)
        cb.assert_not_called()

        # Bot responds and finishes — NOW timer starts.
        await _send(proc, BotStartedSpeakingFrame())
        await _send(proc, BotStoppedSpeakingFrame())
        await asyncio.sleep(0.15)
        cb.assert_called_once()

    async def test_bot_speech_cancels_then_restarts_on_stop(self):
        """Bot starting to speak cancels timer; stopping restarts it."""
        cb = AsyncMock(return_value=True)
        proc = _make_processor(idle_seconds=0.1, on_idle=cb)

        await _send(proc, UserStartedSpeakingFrame())
        await _send(proc, BotStoppedSpeakingFrame())

        # Bot starts speaking mid-countdown — cancels timer.
        await asyncio.sleep(0.07)
        await _send(proc, BotStartedSpeakingFrame())

        # Wait past original idle — should NOT fire (timer cancelled).
        await asyncio.sleep(0.1)
        cb.assert_not_called()

        # Bot stops speaking — timer restarts from 0.
        await _send(proc, BotStoppedSpeakingFrame())
        await asyncio.sleep(0.15)
        cb.assert_called_once()

    async def test_timer_starts_on_bot_stop_not_start(self):
        """Idle countdown begins after bot finishes speaking, not when it starts."""
        cb = AsyncMock(return_value=True)
        proc = _make_processor(idle_seconds=0.1, on_idle=cb)

        await _send(proc, UserStartedSpeakingFrame())
        await _send(proc, BotStoppedSpeakingFrame())

        # Bot speaks for a while — timer should be cancelled.
        await asyncio.sleep(0.05)
        await _send(proc, BotStartedSpeakingFrame())
        await asyncio.sleep(0.2)  # Long speech, well past idle_seconds
        cb.assert_not_called()

        # Bot finishes — NOW the 0.1s countdown starts.
        await _send(proc, BotStoppedSpeakingFrame())
        await asyncio.sleep(0.05)
        cb.assert_not_called()  # Only 0.05s since stop, not enough
        await asyncio.sleep(0.1)
        cb.assert_called_once()

    async def test_self_speech_does_not_reset_cooldown(self):
        """Bot's own idle report speech should NOT reset the cooldown."""
        cb = AsyncMock(return_value=True)
        proc = _make_processor(idle_seconds=0.05, cooldown_seconds=0.3, on_idle=cb)

        await _send(proc, UserStartedSpeakingFrame())
        await _send(proc, BotStoppedSpeakingFrame())

        # First report fires.
        await asyncio.sleep(0.08)
        assert cb.call_count == 1

        # Bot speaks the report — _report_in_flight is True, so this
        # should NOT reset the timer/cooldown.
        await _send(proc, LLMFullResponseStartFrame())
        await _send(proc, BotStartedSpeakingFrame())
        await _send(proc, BotStoppedSpeakingFrame())

        # Wait idle_seconds — should NOT fire because cooldown is active.
        await asyncio.sleep(0.08)
        assert cb.call_count == 1

    async def test_user_interruption_during_report_clears_cooldown(self):
        """User speaking during report clears cooldown. Timer restarts on next bot stop."""
        cb = AsyncMock(return_value=True)
        proc = _make_processor(idle_seconds=0.05, cooldown_seconds=0.5, on_idle=cb)

        await _send(proc, UserStartedSpeakingFrame())
        await _send(proc, BotStoppedSpeakingFrame())

        # First report fires.
        await asyncio.sleep(0.08)
        assert cb.call_count == 1

        # User interrupts during report speech — cancels timer, clears cooldown.
        await _send(proc, UserStartedSpeakingFrame())

        # Timer does NOT restart until bot speaks again.
        await asyncio.sleep(0.1)
        assert cb.call_count == 1

        # Bot responds to user and finishes — idle timer starts fresh, no cooldown.
        await _send(proc, BotStartedSpeakingFrame())
        await _send(proc, BotStoppedSpeakingFrame())
        await asyncio.sleep(0.08)
        assert cb.call_count == 2

    async def test_callback_returning_false_retries(self):
        """When callback returns False (no tasks), retry after idle period."""
        cb = AsyncMock(side_effect=[False, False, True])
        proc = _make_processor(idle_seconds=0.05, on_idle=cb)

        await _send(proc, UserStartedSpeakingFrame())
        await _send(proc, BotStoppedSpeakingFrame())

        # Should retry until callback returns True.
        await asyncio.sleep(0.2)
        assert cb.call_count >= 3


@pytest.mark.unit
class TestIdleReportShutdown:
    """Shutdown and cleanup tests — timer must never block."""

    async def test_cancel_frame_stops_timer(self):
        """CancelFrame should immediately cancel all tasks."""
        cb = AsyncMock(return_value=True)
        proc = _make_processor(idle_seconds=0.1, on_idle=cb)

        await _send(proc, UserStartedSpeakingFrame())
        await _send(proc, BotStoppedSpeakingFrame())
        await _send(proc, CancelFrame())

        # Timer was cancelled — no report should fire.
        await asyncio.sleep(0.15)
        cb.assert_not_called()

    async def test_cleanup_stops_timer(self):
        """cleanup() should cancel all tasks."""
        cb = AsyncMock(return_value=True)
        proc = _make_processor(idle_seconds=0.1, on_idle=cb)

        await _send(proc, UserStartedSpeakingFrame())
        await _send(proc, BotStoppedSpeakingFrame())
        await proc.cleanup()

        await asyncio.sleep(0.15)
        cb.assert_not_called()
