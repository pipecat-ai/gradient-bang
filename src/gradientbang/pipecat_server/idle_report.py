"""Idle report processor — monitors pipeline activity and fires idle reports with cooldown."""

import asyncio
from typing import Awaitable, Callable, Optional

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    CancelFrame,
    EndFrame,
    LLMFullResponseStartFrame,
    UserStartedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from gradientbang.pipecat_server.frames import UserTextInputFrame


class IdleReportProcessor(FrameProcessor):
    """Monitors pipeline activity and fires idle reports with cooldown.

    Owns all idle-report timing: the idle timer, the 30s cooldown, and
    activity detection.  Replaces the previous three-part system
    (pipecat UserIdleController + VoiceAgent cooldown + bot.py event handlers).

    The idle timer starts when the bot *finishes* speaking
    (BotStoppedSpeakingFrame), not when it starts.  Bot/LLM starting to
    speak cancels the timer — the countdown only begins once silence
    resumes.

    When the processor fires an idle report the resulting bot speech would
    normally be detected as "activity" and reset the cooldown.  A
    ``_report_in_flight`` flag suppresses bot-activity resets until
    BotStoppedSpeakingFrame arrives.  User activity still resets during
    report speech (real interruption).
    """

    def __init__(
        self,
        *,
        idle_seconds: float = 7.5,
        cooldown_seconds: float = 30.0,
        on_idle: Callable[[], Awaitable[bool]],
        enabled: bool = True,
    ):
        super().__init__()
        self._idle_seconds = idle_seconds
        self._cooldown_seconds = cooldown_seconds
        self._on_idle = on_idle
        self._enabled = enabled

        self._timer_task: Optional[asyncio.Task] = None
        self._started = False
        self._stopped = False
        self._report_in_flight = False
        self._report_safety_task: Optional[asyncio.Task] = None

    # ── Frame processing ──────────────────────────────────────────────

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if not self._enabled:
            await self.push_frame(frame, direction)
            return

        # Shutdown: cancel all tasks immediately, never block.
        if isinstance(frame, (EndFrame, CancelFrame)):
            self._shutdown()
            await self.push_frame(frame, direction)
            return

        # Wait for first user interaction before monitoring idle.
        # Without this, the idle timer fires right after the greeting speech
        # while a task agent may still be running its first turn.
        if not self._started:
            if self._is_user_activity(frame):
                self._started = True
                # Don't start timer yet — wait for the bot's reply to finish.
            await self.push_frame(frame, direction)
            return

        # Activity detection.
        if self._is_user_activity(frame):
            # User activity cancels timer and resets cooldown.
            # Timer only restarts when bot next finishes speaking.
            self._clear_report_in_flight()
            self._cancel_timer()
        elif isinstance(frame, BotStoppedSpeakingFrame):
            if self._report_in_flight:
                # Our report speech finished — start cooldown + idle timer.
                self._clear_report_in_flight()
                self._start_timer(self._cooldown_seconds + self._idle_seconds)
            else:
                # External speech finished — silence begins, start idle timer.
                self._start_timer(self._idle_seconds)
        elif self._is_bot_starting(frame):
            # Always cancel timer when bot/LLM starts speaking.
            self._cancel_timer()

        await self.push_frame(frame, direction)

    # ── Activity classification ───────────────────────────────────────

    @staticmethod
    def _is_user_activity(frame) -> bool:
        return isinstance(frame, (UserStartedSpeakingFrame, UserTextInputFrame))

    @staticmethod
    def _is_bot_starting(frame) -> bool:
        return isinstance(frame, (BotStartedSpeakingFrame, LLMFullResponseStartFrame))

    # ── Timer management ──────────────────────────────────────────────

    def _start_timer(self, delay: float) -> None:
        if self._stopped:
            return
        self._cancel_timer()
        self._timer_task = self.create_task(self._timer_expired(delay))

    def _cancel_timer(self) -> None:
        if self._timer_task and not self._timer_task.done():
            self._timer_task.cancel()
        self._timer_task = None

    def _clear_report_in_flight(self) -> None:
        self._report_in_flight = False
        if self._report_safety_task and not self._report_safety_task.done():
            self._report_safety_task.cancel()
        self._report_safety_task = None

    def _shutdown(self) -> None:
        """Cancel all tasks immediately. Must never block."""
        self._stopped = True
        self._cancel_timer()
        self._clear_report_in_flight()
        self._started = False

    async def cleanup(self) -> None:
        """Called by pipecat on pipeline teardown."""
        self._shutdown()
        await super().cleanup()

    # ── Async tasks ───────────────────────────────────────────────────

    async def _timer_expired(self, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return

        self._timer_task = None

        # Set BEFORE the async callback so frames generated by the report
        # (LLMFullResponseStart, BotStartedSpeaking) don't reset the timer
        # while the callback is still executing.
        self._report_in_flight = True

        fired = await self._on_idle()
        if fired:
            self._report_safety_task = self.create_task(self._report_safety_timeout())
            # Fallback timer in case speech never starts. Will be overridden
            # by BotStoppedSpeakingFrame when the report speech finishes.
            self._start_timer(self._cooldown_seconds + self._idle_seconds)
        else:
            # Callback declined (e.g. no active tasks). Clear flag and retry.
            self._report_in_flight = False
            self._start_timer(self._idle_seconds)

    async def _report_safety_timeout(self) -> None:
        """Clear _report_in_flight if bot speech never arrives."""
        try:
            await asyncio.sleep(15.0)
        except asyncio.CancelledError:
            return
        if self._report_in_flight:
            logger.warning("IdleReportProcessor: safety timeout cleared report_in_flight")
            self._report_in_flight = False
