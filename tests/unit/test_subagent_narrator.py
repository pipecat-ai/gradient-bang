"""Tests for SubagentNarrator drain, gating, and silent-flush behavior."""

import asyncio
import time
from dataclasses import replace

import pytest

from gradientbang.runtime import subagent_narrator as sn
from gradientbang.runtime.subagent_narrator import (
    SpeechStateSnapshot,
    SubagentNarrator,
)


def _quiet_state() -> SpeechStateSnapshot:
    # Bot finished speaking long ago, no in-flight activity. Tests override
    # individual fields with dataclasses.replace as needed.
    return SpeechStateSnapshot(
        user_speaking=False,
        awaiting_bot_reply=False,
        assistant_cycle_active=False,
        tool_call_active=False,
        bot_stopped_speaking_at=time.monotonic() - 10.0,
    )


class _Harness:
    def __init__(self) -> None:
        self.narrate_calls: list[str] = []
        self.inject_silent_calls: list[str] = []
        self.state = _quiet_state()
        self._tasks: list[asyncio.Task] = []

    async def narrate(self, xml: str) -> None:
        self.narrate_calls.append(xml)

    async def inject_silent(self, xml: str) -> None:
        self.inject_silent_calls.append(xml)

    def speech_state(self) -> SpeechStateSnapshot:
        return self.state

    def create_task(self, coro, name: str) -> asyncio.Task:
        t = asyncio.get_event_loop().create_task(coro, name=name)
        self._tasks.append(t)
        return t

    def make(self) -> SubagentNarrator:
        return SubagentNarrator(
            narrate=self.narrate,
            inject_silent=self.inject_silent,
            speech_state=self.speech_state,
            create_task=self.create_task,
        )

    async def teardown(self) -> None:
        for t in self._tasks:
            if not t.done():
                t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, BaseException):
                pass


@pytest.fixture
def fast_timers(monkeypatch):
    """Shorten timers so tests finish in <1s."""
    monkeypatch.setattr(sn, "SETTLE_SECONDS", 0.05)
    monkeypatch.setattr(sn, "MAX_SETTLE_SECONDS", 0.5)
    monkeypatch.setattr(sn, "COOLDOWN_SECONDS", 0.0)
    monkeypatch.setattr(sn, "STALE_TURNS", 2)


@pytest.fixture
async def harness():
    h = _Harness()
    try:
        yield h
    finally:
        await h.teardown()


@pytest.mark.unit
class TestSubagentNarrator:
    async def test_single_enqueue_flushes_after_settle(self, fast_timers, harness):
        n = harness.make()
        n.enqueue("<event a/>")

        await asyncio.sleep(0.15)

        assert harness.narrate_calls == ["<event a/>"]
        assert harness.inject_silent_calls == []

    async def test_multiple_enqueues_coalesce(self, fast_timers, harness):
        # Two enqueues within the settle window produce one batched flush.
        n = harness.make()
        n.enqueue("<event a/>")
        await asyncio.sleep(0.02)
        n.enqueue("<event b/>")

        await asyncio.sleep(0.2)

        assert len(harness.narrate_calls) == 1
        assert harness.narrate_calls[0] == "<event a/>\n<event b/>"

    async def test_max_settle_caps_continuous_enqueues(self, fast_timers, harness):
        # Steady enqueues just under SETTLE_SECONDS apart — without the
        # MAX cap, this would defer indefinitely. MAX_SETTLE_SECONDS=0.5
        # forces a flush after ~0.5s from first enqueue.
        n = harness.make()
        start = time.monotonic()
        n.enqueue("<event 0/>")
        for i in range(1, 20):
            await asyncio.sleep(0.04)
            if harness.narrate_calls:
                break
            n.enqueue(f"<event {i}/>")

        elapsed = time.monotonic() - start
        assert len(harness.narrate_calls) == 1
        assert 0.4 < elapsed < 0.9, f"flush at {elapsed:.2f}s, expected ~0.5s"

    async def test_cooldown_waits_after_bot_speech(self, fast_timers, monkeypatch, harness):
        # COOLDOWN_SECONDS held at 0.0 by fast_timers — re-raise for this test.
        monkeypatch.setattr(sn, "COOLDOWN_SECONDS", 0.2)
        harness.state = replace(harness.state, bot_stopped_speaking_at=time.monotonic())
        n = harness.make()
        n.enqueue("<event a/>")

        # After settle (~0.05s) but before cooldown (0.2s) — no flush yet.
        await asyncio.sleep(0.1)
        assert harness.narrate_calls == []

        # After cooldown elapses, flush fires.
        await asyncio.sleep(0.2)
        assert harness.narrate_calls == ["<event a/>"]

    async def test_stale_fold_in_silent(self, fast_timers, harness):
        # User+bot stops both reach STALE_TURNS (=2) → silent fold-in.
        # Block the drain via user_speaking so it can't flush via the
        # normal path while we accumulate stops.
        harness.state = replace(harness.state, user_speaking=True)
        n = harness.make()
        n.enqueue("<event a/>")

        for _ in range(2):
            n.on_user_stopped_speaking()
            n.on_bot_stopped_speaking()

        # Release the hard gate so the drain can run the stale check.
        harness.state = replace(harness.state, user_speaking=False)
        n.on_user_started_speaking()  # pokes the event
        harness.state = replace(harness.state, user_speaking=False)

        await asyncio.sleep(0.1)

        assert harness.narrate_calls == []
        assert harness.inject_silent_calls == ["<event a/>"]

    async def test_user_speaking_blocks_drain(self, fast_timers, harness):
        harness.state = replace(harness.state, user_speaking=True)
        n = harness.make()
        n.enqueue("<event a/>")

        # Plenty of time for settle+cooldown to elapse if it could.
        await asyncio.sleep(0.2)
        assert harness.narrate_calls == []

        # Release the gate; drain proceeds.
        harness.state = replace(harness.state, user_speaking=False)
        n.on_user_started_speaking()  # pokes the event; user_speaking already false
        await asyncio.sleep(0.2)
        assert harness.narrate_calls == ["<event a/>"]

    async def test_awaiting_bot_reply_blocks_drain(self, fast_timers, harness):
        harness.state = replace(harness.state, awaiting_bot_reply=True)
        n = harness.make()
        n.enqueue("<event a/>")

        await asyncio.sleep(0.2)
        assert harness.narrate_calls == []

        # Bot reply concluded → cycle goes idle, gate clears, drain flushes.
        harness.state = replace(harness.state, awaiting_bot_reply=False)
        n.on_assistant_cycle_idle(was_replying_to_user=False)
        await asyncio.sleep(0.2)
        assert harness.narrate_calls == ["<event a/>"]

    async def test_silent_flush_for_ship_partial(self, fast_timers, harness):
        # Block the drain so silent_flush_for_ship is the only path that fires.
        harness.state = replace(harness.state, user_speaking=True)
        n = harness.make()
        n.enqueue("<event a/>", ship_id="ship-A")
        n.enqueue("<event b/>", ship_id="ship-B")
        n.enqueue("<event c/>", ship_id="ship-A")

        await n.silent_flush_for_ship("ship-A")

        assert harness.inject_silent_calls == ["<event a/>\n<event c/>"]
        assert harness.narrate_calls == []
        # ship-B entry remains; counters/timers not reset.
        assert n.is_active

    async def test_silent_flush_for_ship_drains_all(self, fast_timers, harness):
        harness.state = replace(harness.state, user_speaking=True)
        n = harness.make()
        n.enqueue("<event a/>", ship_id="ship-A")

        await n.silent_flush_for_ship("ship-A")

        assert harness.inject_silent_calls == ["<event a/>"]
        # Last entry drained → counters reset.
        assert not n.is_active

    async def test_silent_flush_for_ship_noop_on_unknown(self, fast_timers, harness):
        harness.state = replace(harness.state, user_speaking=True)
        n = harness.make()
        n.enqueue("<event a/>", ship_id="ship-A")

        await n.silent_flush_for_ship("ship-Z")

        assert harness.inject_silent_calls == []
        assert n.is_active

    async def test_is_active_lifecycle(self, fast_timers, harness):
        n = harness.make()
        assert not n.is_active

        n.enqueue("<event a/>")
        assert n.is_active

        await asyncio.sleep(0.2)
        assert harness.narrate_calls == ["<event a/>"]
        assert not n.is_active

    async def test_settle_reset_on_user_started_speaking(self, fast_timers, harness):
        # Enqueue, then notify on_user_started_speaking shortly after.
        # That notification must push the settle window out so the drain
        # doesn't flush at the original timestamp.
        n = harness.make()
        n.enqueue("<event a/>")
        await asyncio.sleep(0.02)
        # User briefly speaking and stops — settle window resets to now.
        harness.state = replace(harness.state, user_speaking=True)
        n.on_user_started_speaking()
        harness.state = replace(harness.state, user_speaking=False)
        n.on_user_stopped_speaking()
        # Allow time to flush (settle = 0.05s).
        await asyncio.sleep(0.2)
        # Note: on_user_stopped_speaking sets awaiting_bot_reply *only in
        # VoiceAgent's caller* — the narrator itself doesn't touch that
        # flag. So with our quiet state, the drain proceeds after settle.
        assert harness.narrate_calls == ["<event a/>"]
