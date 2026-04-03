"""Scripted tutorial agent for new players.

Runs a pre-defined tutorial sequence via TTS, sending RTVI events to the
client at each step. Does not use an LLM — all content is scripted.
"""

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

from loguru import logger
from pipecat.frames.frames import BotStoppedSpeakingFrame, TTSSpeakFrame
from pipecat.processors.frameworks.rtvi import (
    RTVIProcessor,
    RTVIServerMessageFrame,
)

from gradientbang.subagents.agents.base_agent import BaseAgent
from gradientbang.subagents.bus import AgentBus


@dataclass
class TutorialStep:
    """A single step in the scripted tutorial."""

    text: str
    start_target: Optional[str] = None
    end_target: Optional[str] = None
    pause: float = 1.5


TUTORIAL_STEPS: list[TutorialStep] = [
    TutorialStep(
        text=(
            "Greetings Commander. Welcome aboard your Sparrow Scout. "
            "She's small, she's scrappy, and she's held together by "
            "optimism and a surprisingly robust warranty. "
        ),
        start_target="panel.overview",
    ),
    TutorialStep(
        text=(
            "Hmm, ship's core systems are cold. First step: boot them up. "
            "Initializing lateral control firmware, version nine point seven. "
            "Cycling the nav-bus and syncing hull telemetry. "
            "One moment."
        ),
        end_target="aside",
        pause=3.0,
    ),
    TutorialStep(
        text=(
            "There we go. This is your command console. "
            "It shows your ship's structural integrity, or as I like to call it, "
            "how many hits we can take before things get, uh, ventilated. "
            "Keep an eye on it. The hull doesn't fix itself. "
            "Well, not yet anyway. I've filed a feature request."
        ),
        start_target="ship.card",
    ),
    TutorialStep(
        text=(
            "Now, these three readouts are critical. "
            "Warp fuel, fighters, and shields. "
            "Fighters keep us from becoming someone else's salvage, "
            "and let us project power when diplomacy fails, which is often. "
            "Lose them all and you're navigating in an escape pod, "
            "which is exactly as dignified as it sounds. "
            "Shields soak up incoming damage. Think of them as your ship's "
            "personal opinion about not exploding."
        ),
        start_target="ship.vitals",
    ),
    TutorialStep(
        text=(
            "Pay special attention to your warp fuel. "
            "Let it hit zero and you're stranded, floating in the void. "
            "Fuel is spent as we traverse between sectors, and can be refueled at any mega port."
        ),
        start_target="ship.fuel",
    ),
    TutorialStep(
        text=(
            "Below is your control deck. "
            "A series of panels for managing your ship, tracking contracts, "
            "and observing the universe around you."
        ),
        start_target="panel.container",
        pause=2.0,
    ),
    TutorialStep(
        text="This is the contracts panel, where you can find jobs to earn credits.",
        start_target="contracts",
        end_target="panel.contracts",
    ),
    TutorialStep(
        text=(
            "Ok, core systems are all online. "
            "Now I just need to reboot myself. "
            "Initiating Gradient Ascent."
        ),
        pause=0,
    ),
]


class ScriptedAgent(BaseAgent):
    """Tutorial agent that plays scripted TTS content for new players.

    Bridges to MainAgent's transport pipeline via the bus. Queued
    ``TTSSpeakFrame`` frames flow through the bus bridge to TTS and
    transport output.

    Sends RTVI events (``tutorial.start``, ``tutorial.step``,
    ``tutorial.complete``) so the client can drive tutorial UI.

    On completion, calls the ``on_complete`` callback which should
    deactivate this agent and activate VoiceAgent.
    """

    def __init__(
        self,
        name: str,
        *,
        bus: AgentBus,
        rtvi_processor: RTVIProcessor,
        on_complete: Callable[[], Awaitable[None]],
    ):
        super().__init__(name, bus=bus, bridged=(), active=False)
        self._rtvi = rtvi_processor
        self._on_complete = on_complete
        self._tutorial_task: Optional[asyncio.Task] = None
        self._speech_done = asyncio.Event()

    async def on_ready(self) -> None:
        """Register frame watchers for speech completion detection."""
        await super().on_ready()
        self.pipeline_task.add_reached_upstream_filter((BotStoppedSpeakingFrame,))

        @self.pipeline_task.event_handler("on_frame_reached_upstream")
        async def _on_speech_done(task, frame):
            if isinstance(frame, BotStoppedSpeakingFrame):
                self._speech_done.set()

    async def on_activated(self, args: Optional[dict]) -> None:
        await super().on_activated(args)
        logger.info("ScriptedAgent: activated, starting tutorial")
        self._tutorial_task = asyncio.create_task(self._run_tutorial())

    async def on_deactivated(self) -> None:
        await super().on_deactivated()
        if self._tutorial_task and not self._tutorial_task.done():
            self._tutorial_task.cancel()
            self._tutorial_task = None

    async def _send_event(self, event: str, payload: Optional[dict[str, Any]] = None) -> None:
        """Push an RTVI server message to the client."""
        await self._rtvi.push_frame(
            RTVIServerMessageFrame(
                {
                    "frame_type": "event",
                    "event": event,
                    "payload": payload or {},
                }
            )
        )

    async def _speak_and_wait(self, text: str) -> None:
        """Queue TTS and wait for speech to complete."""
        self._speech_done.clear()
        await self.queue_frame(TTSSpeakFrame(text=text, append_to_context=False))
        await self._speech_done.wait()

    async def _run_tutorial(self) -> None:
        """Run the scripted tutorial sequence."""
        try:
            await self._send_event("tutorial.start")

            for i, step in enumerate(TUTORIAL_STEPS):
                logger.info(f"ScriptedAgent: step {i + 1}/{len(TUTORIAL_STEPS)}")

                if step.start_target:
                    payload: dict[str, Any] = {"step": i, "target": step.start_target}
                    await self._send_event("tutorial.step", payload)

                await self._speak_and_wait(step.text)

                if step.end_target:
                    payload = {"step": i, "target": step.end_target}
                    await self._send_event("tutorial.step", payload)

                if step.pause > 0:
                    await asyncio.sleep(step.pause)

            await self._send_event("tutorial.complete")
            logger.info("ScriptedAgent: tutorial complete, handing off")
            await self._on_complete()
        except asyncio.CancelledError:
            logger.info("ScriptedAgent: tutorial cancelled")
        except Exception:
            logger.exception("ScriptedAgent: tutorial error, forcing handoff")
            await self._send_event("tutorial.complete")
            await self._on_complete()
