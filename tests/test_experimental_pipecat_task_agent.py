import os
import sys
import site
from pathlib import Path
from typing import Any, Dict, List

import pytest
from loguru import logger
import importlib.util


def ensure_pipecat_package():
    module = sys.modules.get("pipecat")
    if module and getattr(module, "__path__", None):
        if any("site-packages" in path for path in module.__path__):
            return
        sys.modules.pop("pipecat", None)

    for path in site.getsitepackages():
        candidate = Path(path) / "pipecat" / "__init__.py"
        if candidate.exists():
            spec = importlib.util.spec_from_file_location("pipecat", candidate)
            module = importlib.util.module_from_spec(spec)
            sys.modules["pipecat"] = module
            spec.loader.exec_module(module)  # type: ignore[union-attr]
            search_paths = [str(candidate.parent)]
            module.__path__ = search_paths  # type: ignore[attr-defined]
            if getattr(module, "__spec__", None) is not None:  # type: ignore[attr-defined]
                module.__spec__.submodule_search_locations = search_paths  # type: ignore[union-attr]
            return

    raise ModuleNotFoundError("pipecat package not found in site-packages")


ensure_pipecat_package()

from pipecat.frames.frames import (  # noqa: E402
    ErrorFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    FunctionCallFromLLM,
)
from pipecat.processors.frame_processor import FrameDirection
try:
    from pipecat.services.llm_service import LLMService
except ModuleNotFoundError:  # pragma: no cover - namespace conflict fallback
    pytest.skip("pipecat package unavailable", allow_module_level=True)

from utils.base_llm_agent import LLMConfig
from utils.experimental_pipecat_agent import ExperimentalTaskAgent
from utils.tools_schema import MyStatus, TaskFinished


logger.remove()
log_level = os.getenv("LOGURU_LEVEL", "INFO")
logger.add(sys.__stderr__, level=log_level, backtrace=False, diagnose=False)


class ScriptedLLMService(LLMService):
    """Deterministic LLM service used for unit testing."""

    adapter_class = LLMService.adapter_class

    def __init__(self, script: List[List[Dict[str, Any]]]):
        super().__init__(run_in_parallel=False)
        self._script = script
        self._step = 0

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMContextFrame):
            logger.debug(
                f"[ScriptedLLMService] step={self._step} received LLMContextFrame direction={direction}",
            )
            if self._step >= len(self._script):
                logger.error("[ScriptedLLMService] script exhausted, pushing fatal error frame")
                await self.push_frame(
                    ErrorFrame(error="Script exhausted", fatal=True), FrameDirection.UPSTREAM
                )
                await self.push_frame(
                    ErrorFrame(error="Script exhausted", fatal=True), FrameDirection.DOWNSTREAM
                )
                return

            events = self._script[self._step]
            self._step += 1

            await self.push_frame(LLMFullResponseStartFrame())

            for event in events:
                if event["type"] == "function_call":
                    logger.debug(
                        f"[ScriptedLLMService] emitting function call name={event['name']} args={event.get('arguments')}",
                    )
                    function_call = FunctionCallFromLLM(
                        function_name=event["name"],
                        tool_call_id=event.get("id", f"call_{self._step}_{event['name']}"),
                        arguments=event.get("arguments", {}),
                        context=frame.context,
                    )
                    await self.run_function_calls([function_call])
                elif event["type"] == "text":
                    logger.debug(
                        f"[ScriptedLLMService] emitting text chunk text={event['text']}"
                    )
                    await self.push_frame(LLMTextFrame(event["text"]))
                else:
                    raise AssertionError(f"Unknown scripted event: {event}")

            await self.push_frame(LLMFullResponseEndFrame())
        else:
            logger.debug(
                f"[ScriptedLLMService] forwarding frame={frame.__class__.__name__} direction={direction}",
            )
            await self.push_frame(frame, direction)


class StubGameClient:
    def __init__(self, character_id: str):
        self.character_id = character_id
        self.calls: List[str] = []
        self._handlers: Dict[str, List[Any]] = {}
        self._initial_event_emitted = False

    def pause_event_delivery(self) -> None:
        self.calls.append("pause_event_delivery")

    async def resume_event_delivery(self) -> None:
        self.calls.append("resume_event_delivery")
        if not self._initial_event_emitted:
            event = {"event_name": "status.snapshot", "summary": "Initial status"}
            for handler in self._handlers.get("status.snapshot", []):
                await handler(event)
            self._initial_event_emitted = True

    async def my_status(self, *, character_id: str):
        self.calls.append(f"my_status:{character_id}")
        event = {"event_name": "status.snapshot", "summary": "Status nominal"}
        for handler in self._handlers.get("status.snapshot", []):
            await handler(event)
        return {"summary": "Status nominal"}

    def on(self, event_name: str):
        def register(callback):
            self.calls.append(f"on:{event_name}")
            self._handlers.setdefault(event_name, []).append(callback)
            return callback

        return register


@pytest.mark.asyncio
async def test_experimental_task_agent_executes_scripted_loop(capsys):
    script = [
        [{"type": "function_call", "name": "my_status", "arguments": {}}],
        [{"type": "function_call", "name": "finished", "arguments": {"message": "Done"}}],
    ]

    outputs: List[str] = []

    def output_callback(text: str, _type: Any):
        outputs.append(text)
        logger.debug(f"[TestOutput] type={_type} text={text}")

    game_client = StubGameClient(character_id="npc-1")
    logger.info("Test: creating ExperimentalTaskAgent")
    agent = ExperimentalTaskAgent(
            config=LLMConfig(api_key="local-test-key", model="test-model"),
            game_client=game_client,  # type: ignore[arg-type]
            character_id="npc-1",
            output_callback=output_callback,
            llm_service_factory=lambda: ScriptedLLMService(script),
            tools_list=[MyStatus, TaskFinished],
        )
    logger.info("Test: agent created")

    with capsys.disabled():
        logger.info("Test: starting ExperimentalTaskAgent.run_task")
        success = await agent.run_task(
            "Check status and finish", initial_state=None, max_iterations=5
        )
        logger.info(f"Test: run_task finished success={success}")

    assert success is True
    assert agent.finished is True
    assert agent.finished_message == "Done"
    assert "my_status:npc-1" in game_client.calls
    assert "my_status({})" in outputs
    assert "Done" in outputs


@pytest.mark.asyncio
async def test_experimental_base_agent_real_google_smoke(monkeypatch):
    if not os.getenv("RUN_GOOGLE_LLM_TEST") or not os.getenv("GOOGLE_API_KEY"):
        pytest.skip("Set RUN_GOOGLE_LLM_TEST=1 and GOOGLE_API_KEY to run this test.")

    game_client = StubGameClient(character_id="npc-1")
    agent = ExperimentalTaskAgent(
        config=LLMConfig(model="gemini-2.5-flash-preview-09-2025"),
        game_client=game_client,  # type: ignore[arg-type]
        character_id="npc-1",
        tools_list=[TaskFinished],
    )

    success = await agent.run_task(
        "Share a single short greeting and then call the finished tool with that same greeting.",
        initial_state=None,
    )

    assert success is True
    assert agent.finished_message is not None
    assert "hello" in agent.finished_message.lower()
