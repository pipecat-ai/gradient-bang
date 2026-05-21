"""Custom-prompt threading on TaskAgent (Phase 3 4/N).

Two guarantees:

- ``TaskAgent.__init__(custom_prompt=...)`` stores the value and
  ``on_task_request`` threads it into the system message via
  ``build_task_agent_prompt(custom_prompt=...)``.
- ``on_task_progress_query`` uses ``build_task_progress_prompt`` instead,
  which deliberately does NOT take ``custom_prompt``. Progress queries are
  operational, not gameplay, and should never pick up operator persona.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from pipecat.processors.aggregators.llm_context import LLMContext

from gradientbang.pipecat_server.subagents.task_agent import TaskAgent
from gradientbang.utils.prompt_loader import build_task_agent_prompt


def _make_agent(*, custom_prompt: str | None = None) -> TaskAgent:
    bus = MagicMock()
    bus.send = AsyncMock()
    bus.send_bus_message = AsyncMock()
    return TaskAgent(
        "test_byoa",
        character_id="ship-pseudo-1",
        is_corp_ship=True,
        custom_prompt=custom_prompt,
    )


@pytest.mark.unit
class TestCustomPromptOnTaskRequest:
    def test_default_construction_has_no_custom_prompt(self):
        agent = _make_agent()
        assert agent._custom_prompt is None

    def test_constructor_stores_custom_prompt(self):
        agent = _make_agent(custom_prompt="Trade aggressively.")
        assert agent._custom_prompt == "Trade aggressively."

    async def test_on_task_request_system_message_includes_custom_prompt(self):
        """The exact text we pass to TaskAgent appears in the system
        message produced by ``on_task_request``."""
        custom = "Never engage combat unless attacked first."
        agent = _make_agent(custom_prompt=custom)
        # build_pipeline initialises _llm_context normally; just provide
        # a stub to capture the messages on_task_request sets.
        agent._llm_context = LLMContext(messages=[])

        # The real on_task_request also pushes an LLMRunFrame via
        # push_frame; we don't care about that for prompt-threading.
        agent.push_frame = AsyncMock()

        msg = MagicMock()
        msg.task_id = "task-1"
        msg.source = "voice_agent"
        msg.payload = {
            "task_description": "haul ore to MP",
            "context": "",
            "task_metadata": {"actor_character_id": "char-operator"},
        }
        await agent.on_job_request(msg)

        messages = agent._llm_context.get_messages()
        system = next(m for m in messages if m.get("role") == "system")
        assert custom in system["content"]
        assert "## Operator guidance" in system["content"]

    async def test_on_task_request_none_custom_prompt_produces_base_prompt(self):
        agent = _make_agent(custom_prompt=None)
        agent._llm_context = LLMContext(messages=[])
        agent.push_frame = AsyncMock()
        msg = MagicMock()
        msg.task_id = "task-1"
        msg.source = "voice_agent"
        msg.payload = {
            "task_description": "haul",
            "context": "",
            "task_metadata": {},
        }
        await agent.on_job_request(msg)
        system = next(
            m for m in agent._llm_context.get_messages() if m.get("role") == "system"
        )
        # Identical to the base form.
        assert system["content"] == build_task_agent_prompt()
        assert "## Operator guidance" not in system["content"]


@pytest.mark.unit
class TestProgressQueryDoesNotLeak:
    def test_progress_query_uses_different_builder_and_no_custom_kwarg(self):
        """Static check: on_task_progress_query reaches for
        ``build_task_progress_prompt``, which doesn't take custom_prompt.
        Guards against a refactor that wires the operator prompt into the
        progress path by accident."""
        import inspect

        from gradientbang.utils.prompt_loader import build_task_progress_prompt

        # The progress builder must not accept a custom_prompt kwarg —
        # that's the API contract.
        sig = inspect.signature(build_task_progress_prompt)
        assert "custom_prompt" not in sig.parameters

        # And on_job_update_requested in TaskAgent (the progress-query
        # path) calls the progress builder, never build_task_agent_prompt
        # with custom_prompt.
        src = inspect.getsource(TaskAgent.on_job_update_requested)
        assert "build_task_progress_prompt" in src
        assert "custom_prompt" not in src
