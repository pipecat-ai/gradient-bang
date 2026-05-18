"""Speech-aware queue for narrating async subagent reports.

Use when long-running background agents in a pipecat app need to surface
status (task completed, task cancelled, errors) into the same voice channel
the user is talking on. A plain queue would step on the user's turn; this
one gates on voice-pipeline state, coalesces close-together reports, and
silently folds stale entries into context once the conversation has moved
on. See ``SubagentNarrator`` for the contract.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Awaitable, Callable, Coroutine, Optional

from loguru import logger

# Time the drain waits after the bot finishes speaking before flushing, so
# completion narrations don't land back-to-back with a TTS reply.
COOLDOWN_SECONDS = 1.5
# Number of user+bot speech turns after which a pending entry is folded in
# silently rather than narrated — the topic has clearly moved on.
STALE_TURNS = 5
# Quiet period after the last enqueue before flushing, so close-together
# completions coalesce into one narration.
SETTLE_SECONDS = 2.0
# Hard cap on settle wait measured from the first enqueue, so a steady
# trickle of enqueues can't starve the flush indefinitely.
MAX_SETTLE_SECONDS = 8.0


@dataclass(frozen=True)
class SpeechStateSnapshot:
    """Voice-pipeline state the narrator reads at each gate check.

    Producer (the voice agent) owns these fields; narrator only consumes via
    the ``speech_state`` callback. Snapshot is taken fresh per gate so the
    drain reflects the latest pipeline state.
    """

    user_speaking: bool
    awaiting_bot_reply: bool
    assistant_cycle_active: bool
    tool_call_active: bool
    bot_stopped_speaking_at: float


@dataclass
class _PendingReport:
    xml: str
    ship_id: Optional[str] = None


class SubagentNarrator:
    """Speech-aware queue for subagent reports.

    Subagents (task completions, wake failures, etc.) call ``enqueue`` with
    a pre-rendered XML event. A drain loop holds each report until the voice
    pipeline is quiet, then injects a batched message into the LLM context
    so the main agent can speak it. Reports that go stale (the user clearly
    moved on) are folded into context silently instead of narrated.
    """

    def __init__(
        self,
        *,
        narrate: Callable[[str], Awaitable[None]],
        inject_silent: Callable[[str], Awaitable[None]],
        speech_state: Callable[[], SpeechStateSnapshot],
        create_task: Callable[[Coroutine, str], asyncio.Task],
    ) -> None:
        # narrate: queue an LLMMessagesAppendFrame(run_llm=True) on the main
        #   pipeline. The result is that the LLM is invoked and speaks the
        #   batched report.
        # inject_silent: append a user message to context without invoking
        #   the LLM. Used for stale fold-in and silent_flush_for_ship.
        # speech_state: fresh snapshot of voice-pipeline state per call.
        # create_task: spawn a managed asyncio task (cancelled on host close).
        self._narrate = narrate
        self._inject_silent = inject_silent
        self._speech_state = speech_state
        self._create_task = create_task

        self._reports: list[_PendingReport] = []
        self._first_enqueued_at: Optional[float] = None
        self._last_enqueued_at: Optional[float] = None
        self._user_stops: int = 0
        self._bot_stops: int = 0
        self._event: asyncio.Event = asyncio.Event()
        self._drain_task: Optional[asyncio.Task] = None
        self._flushing: bool = False

    # ── Public surface ─────────────────────────────────────────────────

    def enqueue(self, event_xml: str, *, ship_id: Optional[str] = None) -> None:
        # Drain is lazy-spawned: it exits as soon as the queue drains, so
        # it is short-lived by construction.
        now = time.monotonic()
        self._reports.append(_PendingReport(xml=event_xml, ship_id=ship_id))
        if self._first_enqueued_at is None:
            self._first_enqueued_at = now
        self._last_enqueued_at = now
        if self._drain_task is None or self._drain_task.done():
            self._drain_task = self._create_task(self._drain(), "subagent_narrator_drain")
        self._event.set()
        logger.debug(
            "SubagentNarrator: enqueued (queue_size={}, ship_id={})",
            len(self._reports),
            ship_id,
        )

    async def silent_flush_for_ship(self, ship_id: str) -> None:
        """Fold matching ship's pending reports into context without narrating.

        Caller signals (e.g. user issued a new command on this ship) that the
        prior report is no longer worth speaking aloud, but is still useful
        for the LLM to know about on its next turn.
        """
        if not ship_id or not self._reports:
            return
        matching = [r for r in self._reports if r.ship_id == ship_id]
        if not matching:
            return
        self._reports = [r for r in self._reports if r.ship_id != ship_id]
        if not self._reports:
            self._first_enqueued_at = None
            self._last_enqueued_at = None
            self._user_stops = 0
            self._bot_stops = 0
        batched = "\n".join(r.xml for r in matching)
        logger.debug(
            "SubagentNarrator: silent flush for ship {} ({} entry/entries)",
            ship_id[:8],
            len(matching),
        )
        await self._inject_silent(batched)
        self._event.set()

    @property
    def is_active(self) -> bool:
        """True while reports are queued or a flush is in progress.

        Hosts use this to suppress proactive narrations (e.g. idle status
        reports) that would step on an imminent flush.
        """
        return bool(self._reports) or self._flushing

    # ── Notifications from the voice pipeline ──────────────────────────

    def on_assistant_cycle_idle(self, *, was_replying_to_user: bool) -> None:
        # Reset the settle window after a user→bot turn so the drain waits
        # a fresh SETTLE_SECONDS before flushing. Without this, a flush can
        # land just COOLDOWN_SECONDS after the bot answers, which stacks.
        if was_replying_to_user and self._first_enqueued_at is not None:
            self._last_enqueued_at = time.monotonic()
        self._event.set()

    def on_bot_stopped_speaking(self) -> None:
        if self._first_enqueued_at is not None:
            self._bot_stops += 1

    def on_user_started_speaking(self) -> None:
        # User is engaging — push the settle window out so a queued report
        # can't fire ahead of (or interleave with) their turn.
        if self._first_enqueued_at is not None:
            self._last_enqueued_at = time.monotonic()
        self._event.set()

    def on_user_stopped_speaking(self) -> None:
        if self._first_enqueued_at is not None:
            self._user_stops += 1
        self._event.set()

    # ── Drain coordinator ──────────────────────────────────────────────

    async def _drain(self) -> None:
        try:
            while self._reports:
                # 1. Stale check — silent fold-in once topic has moved on.
                if min(self._user_stops, self._bot_stops) >= STALE_TURNS:
                    logger.debug(
                        "SubagentNarrator: stale (user_stops={}, bot_stops={}); silent flush",
                        self._user_stops,
                        self._bot_stops,
                    )
                    await self._flush(run_llm=False)
                    continue

                # 2. Hard gates — wait for a poke if any fail.
                #    awaiting_bot_reply keeps the queue blocked between the
                #    user finishing a turn and the bot's reply going idle,
                #    so a pending narration can't front-load itself ahead
                #    of (or interleave with) the bot's response to the user.
                state = self._speech_state()
                if (
                    state.tool_call_active
                    or state.assistant_cycle_active
                    or state.user_speaking
                    or state.awaiting_bot_reply
                ):
                    self._event.clear()
                    await self._event.wait()
                    continue

                # 3. Settle window — wait until no new entry has arrived for
                #    SETTLE_SECONDS, capped by MAX from first enqueue.
                now = time.monotonic()
                settle_remaining = SETTLE_SECONDS - (now - (self._last_enqueued_at or now))
                max_remaining = MAX_SETTLE_SECONDS - (now - (self._first_enqueued_at or now))
                settle_wait = min(settle_remaining, max_remaining)
                if settle_wait > 0:
                    self._event.clear()
                    try:
                        await asyncio.wait_for(self._event.wait(), timeout=settle_wait)
                        continue  # state changed — re-evaluate from the top
                    except asyncio.TimeoutError:
                        pass  # settle elapsed, fall through to cooldown

                # 4. Cooldown — finish out the post-bot-speech buffer or wait for a poke.
                state = self._speech_state()
                elapsed = time.monotonic() - state.bot_stopped_speaking_at
                cooldown_remaining = COOLDOWN_SECONDS - elapsed
                if cooldown_remaining > 0:
                    self._event.clear()
                    try:
                        await asyncio.wait_for(self._event.wait(), timeout=cooldown_remaining)
                        continue  # state changed mid-cooldown — re-evaluate
                    except asyncio.TimeoutError:
                        pass  # cooldown expired, fall through to flush

                # 5. Pre-flush gate recheck — yield once so any in-flight
                #    UserStartedSpeakingFrame can land and flip the gates
                #    before we commit to flushing. Closes the race where a
                #    user starts speaking the same moment all gates passed.
                await asyncio.sleep(0)
                state = self._speech_state()
                if (
                    state.tool_call_active
                    or state.assistant_cycle_active
                    or state.user_speaking
                    or state.awaiting_bot_reply
                ):
                    continue

                # 6. Flush with inference.
                await self._flush(run_llm=True)
        except asyncio.CancelledError:
            raise
        finally:
            if asyncio.current_task() is self._drain_task:
                self._drain_task = None

    async def _flush(self, *, run_llm: bool) -> None:
        if not self._reports:
            return
        self._flushing = True
        try:
            items = self._reports
            self._reports = []
            self._first_enqueued_at = None
            self._last_enqueued_at = None
            self._user_stops = 0
            self._bot_stops = 0

            batched = "\n".join(r.xml for r in items)
            logger.debug(
                "SubagentNarrator: flushing {} update(s) (run_llm={})",
                len(items),
                run_llm,
            )
            if run_llm:
                await self._narrate(batched)
            else:
                await self._inject_silent(batched)
        finally:
            self._flushing = False
