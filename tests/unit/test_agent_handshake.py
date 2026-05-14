"""BYOA wake-up handshake regression tests.

  - TaskAgent only responds ``ready=True`` after its LLM context is up.
  - VoiceAgent's hello-response correlator hands the awaiting future the
    right result (or rejects with the agent's error on ``ready=False``).
  - The hello sender wraps a fresh ``correlation_id`` and the configured
    timeout.
  - The new-agent spawn's rollback path runs cleanly on hello timeout.
  - TaskAgent's teardown path is wired correctly per agent flavour: local
    corp ships use the idle timer, BYOA workers self-end after one task,
    and player-ship agents stay warm.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from gradientbang.pipecat_server.subagents.bus_messages import (
    BusAgentHelloRequest,
    BusAgentHelloResponse,
    BUS_PROTOCOL_VERSION,
)
from gradientbang.pipecat_server.subagents.task_agent import TaskAgent
from gradientbang.pipecat_server.subagents.voice_agent import VoiceAgent
from pipecat_subagents.bus import BusEndAgentMessage


# ── TaskAgent side ───────────────────────────────────────────────────


def _make_task_agent(**overrides) -> TaskAgent:
    bus = MagicMock()
    bus.send_message = AsyncMock()
    name = overrides.pop("name", "task_test")
    kwargs = {"bus": bus, "character_id": "char-123"}
    kwargs.update(overrides)
    agent = TaskAgent(name, **kwargs)
    agent.send_message = AsyncMock()
    return agent


@pytest.mark.unit
class TestTaskAgentHelloHandler:
    @pytest.mark.asyncio
    async def test_responds_ready_when_llm_context_is_initialised(self):
        agent = _make_task_agent()
        # Simulate the post-build_pipeline state: _llm_context is set.
        agent._llm_context = MagicMock()

        await agent.on_bus_message(
            BusAgentHelloRequest(
                source="voice_agent",
                target=agent.name,
                correlation_id="hello-1",
            )
        )

        sent = agent.send_message.await_args.args[0]
        assert isinstance(sent, BusAgentHelloResponse)
        assert sent.correlation_id == "hello-1"
        assert sent.ready is True
        assert sent.error is None
        assert sent.target == "voice_agent"
        assert sent.protocol_version == BUS_PROTOCOL_VERSION

    @pytest.mark.asyncio
    async def test_responds_unready_before_llm_context(self):
        agent = _make_task_agent()
        # _llm_context is None until build_pipeline runs.
        agent._llm_context = None

        await agent.on_bus_message(
            BusAgentHelloRequest(
                source="voice_agent",
                target=agent.name,
                correlation_id="hello-2",
            )
        )

        sent = agent.send_message.await_args.args[0]
        assert isinstance(sent, BusAgentHelloResponse)
        assert sent.ready is False
        assert sent.error is not None

    @pytest.mark.asyncio
    async def test_ignores_hello_targeted_at_another_agent(self):
        agent = _make_task_agent()
        agent._llm_context = MagicMock()

        await agent.on_bus_message(
            BusAgentHelloRequest(
                source="voice_agent",
                target="some_other_agent",
                correlation_id="hello-3",
            )
        )

        # No response sent for a hello targeted elsewhere.
        for call in agent.send_message.await_args_list:
            if call.args:
                assert not isinstance(call.args[0], BusAgentHelloResponse)


# ── TaskAgent idle teardown ──────────────────────────────────────────


@pytest.mark.unit
class TestIdleTeardownTimer:
    @pytest.mark.asyncio
    async def test_corp_ship_agent_arms_and_cancels(self):
        agent = _make_task_agent(is_corp_ship=True)
        # Long delay so the timer doesn't actually fire during the test.
        agent._byoa_config = type(agent._byoa_config)(
            tool_call_timeout_seconds=30.0,
            agent_wake_timeout_seconds=30.0,
            agent_idle_teardown_seconds=3600.0,
        )
        agent._arm_idle_teardown()
        assert agent._idle_teardown_handle is not None
        agent._cancel_idle_teardown()
        assert agent._idle_teardown_handle is None

    @pytest.mark.asyncio
    async def test_corp_ship_teardown_fires_after_delay(self):
        """The handle fires its callback and the agent emits BusEndAgentMessage."""
        from gradientbang.pipecat_server.subagents.bus_messages import (
            BusGameToolCallRequest,  # noqa: F401
        )
        from pipecat_subagents.bus import BusEndAgentMessage

        agent = _make_task_agent(is_corp_ship=True)
        # Very short delay so the timer fires inside the test window.
        agent._byoa_config = type(agent._byoa_config)(
            tool_call_timeout_seconds=30.0,
            agent_wake_timeout_seconds=30.0,
            agent_idle_teardown_seconds=0.01,
        )
        agent._arm_idle_teardown()
        # Let the loop fire the call_later and run the created task.
        await asyncio.sleep(0.1)

        sent_types = [
            type(call.args[0]) for call in agent.send_message.await_args_list if call.args
        ]
        assert BusEndAgentMessage in sent_types

    @pytest.mark.asyncio
    async def test_teardown_reset_when_active_task_arrives(self):
        agent = _make_task_agent(is_corp_ship=True)
        agent._byoa_config = type(agent._byoa_config)(
            tool_call_timeout_seconds=30.0,
            agent_wake_timeout_seconds=30.0,
            agent_idle_teardown_seconds=3600.0,
        )
        agent._arm_idle_teardown()
        assert agent._idle_teardown_handle is not None
        # New task triggers _reset_task_state which cancels the timer.
        agent._reset_task_state()
        assert agent._idle_teardown_handle is None

    @pytest.mark.asyncio
    async def test_byoa_agent_does_not_arm_idle_teardown(self):
        agent = _make_task_agent(name="byoa_ship-123", is_corp_ship=True)
        agent._byoa_config = type(agent._byoa_config)(
            tool_call_timeout_seconds=30.0,
            agent_wake_timeout_seconds=30.0,
            agent_idle_teardown_seconds=3600.0,
        )

        agent._arm_idle_teardown()

        assert agent._idle_teardown_handle is None

    @pytest.mark.asyncio
    async def test_byoa_agent_self_ends_after_completion(self):
        agent = _make_task_agent(name="byoa_ship-123", is_corp_ship=True)
        agent._upload_context_snapshot = MagicMock()
        agent._drain_pending_task_outputs = AsyncMock()
        agent._clear_awaited_completion = MagicMock()
        agent._pending = MagicMock(cancel_all=MagicMock())
        agent.send_task_response = AsyncMock()
        agent._active_task_id = "task-123"
        agent._task_finished_status = "completed"
        agent._task_finished_message = "done"

        await agent._complete_task()

        end_messages = [
            call.args[0]
            for call in agent.send_message.await_args_list
            if call.args and isinstance(call.args[0], BusEndAgentMessage)
        ]
        assert len(end_messages) == 1
        assert end_messages[0].target == "byoa_ship-123"
        assert end_messages[0].reason == "task complete"
        assert agent._idle_teardown_handle is None


# ── VoiceAgent side ──────────────────────────────────────────────────


def _make_voice_agent() -> VoiceAgent:
    mock_game_client = MagicMock()
    mock_game_client.corporation_id = "corp-1"
    mock_game_client.current_task_id = None
    mock_game_client.set_event_polling_scope = MagicMock()
    mock_game_client.task_lifecycle = AsyncMock(return_value={"success": True})
    mock_game_client.task_cancel = AsyncMock(return_value={"success": True})

    mock_rtvi = MagicMock()
    mock_rtvi.push_frame = AsyncMock()

    return VoiceAgent(
        "player",
        bus=MagicMock(),
        game_client=mock_game_client,
        character_id="char-123",
        rtvi_processor=mock_rtvi,
    )


@pytest.mark.unit
class TestVoiceAgentHelloSender:
    @pytest.mark.asyncio
    async def test_send_hello_resolves_on_ready_response(self):
        agent = _make_voice_agent()
        agent.send_message = AsyncMock()

        # Capture the correlation_id used by the request so we can
        # construct the matching response.
        async def _capture_and_respond(message):
            if isinstance(message, BusAgentHelloRequest):
                response = BusAgentHelloResponse(
                    source="task_target",
                    target=agent.name,
                    correlation_id=message.correlation_id,
                    ready=True,
                )
                asyncio.create_task(agent.on_bus_message(response))

        agent.send_message.side_effect = _capture_and_respond
        # Tight timeout so we fail fast if the wiring is broken.
        agent._byoa_config = type(agent._byoa_config)(
            tool_call_timeout_seconds=30.0,
            agent_wake_timeout_seconds=2.0,
            agent_idle_teardown_seconds=300.0,
        )

        response = await agent._send_hello_and_wait("task_target")
        assert isinstance(response, BusAgentHelloResponse)
        assert response.ready is True

    @pytest.mark.asyncio
    async def test_send_hello_times_out_when_no_response(self):
        agent = _make_voice_agent()
        agent.send_message = AsyncMock()  # never resolves the future
        agent._byoa_config = type(agent._byoa_config)(
            tool_call_timeout_seconds=30.0,
            agent_wake_timeout_seconds=0.05,
            agent_idle_teardown_seconds=300.0,
        )

        with pytest.raises(asyncio.TimeoutError):
            await agent._send_hello_and_wait("ghost_agent")

    @pytest.mark.asyncio
    async def test_unready_response_rejects_with_error(self):
        agent = _make_voice_agent()
        agent.send_message = AsyncMock()

        async def _capture_and_respond(message):
            if isinstance(message, BusAgentHelloRequest):
                response = BusAgentHelloResponse(
                    source="task_target",
                    target=agent.name,
                    correlation_id=message.correlation_id,
                    ready=False,
                    error="cold start failed",
                )
                asyncio.create_task(agent.on_bus_message(response))

        agent.send_message.side_effect = _capture_and_respond
        agent._byoa_config = type(agent._byoa_config)(
            tool_call_timeout_seconds=30.0,
            agent_wake_timeout_seconds=2.0,
            agent_idle_teardown_seconds=300.0,
        )

        with pytest.raises(RuntimeError, match="cold start failed"):
            await agent._send_hello_and_wait("task_target")


@pytest.mark.unit
class TestRollbackOnHandshakeTimeout:
    @pytest.mark.asyncio
    async def test_rollback_releases_lock_and_ends_agent(self):
        agent = _make_voice_agent()
        agent.send_message = AsyncMock()
        agent._task_groups = {}

        # Pretend the spawn already happened: child + lock map populated.
        child = MagicMock(spec=TaskAgent)
        child.name = "task_abc"
        child._character_id = "corp-ship-1"
        child._is_corp_ship = True
        agent._children = [child]
        agent._locked_ships = {"corp-ship-1": "framework-task-1"}

        await agent._rollback_failed_spawn(
            agent_name="task_abc",
            framework_task_id="framework-task-1",
            reason="handshake timeout",
        )

        # Local lock cleared.
        assert agent._locked_ships == {}
        # Server-side release called.
        agent._game_client.task_cancel.assert_awaited_once_with(
            task_id="framework-task-1",
            character_id="char-123",
        )
        # BusEndAgentMessage sent to the child.
        from pipecat_subagents.bus import BusEndAgentMessage

        sent_types = [
            type(call.args[0]) for call in agent.send_message.await_args_list if call.args
        ]
        assert BusEndAgentMessage in sent_types
        # Child removed from _children.
        assert all(c.name != "task_abc" for c in agent._children)
