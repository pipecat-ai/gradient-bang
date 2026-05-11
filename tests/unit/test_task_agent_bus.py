"""Phase 1 regression tests: TaskAgent over the bus.

The other TaskAgent test files (``test_task_agent.py``,
``test_task_agent_integration.py``) cover real behavior through a
simulated broker — i.e. they assert "calling tool X eventually invokes
``game_client.X`` somehow." That's the right shape for behavioural
coverage, but it doesn't pin the *contract* the Phase 1 migration
established.

These tests pin the contract directly:

  - TaskAgent never touches ``AsyncGameClient`` (no ``_game_client``
    attribute, no import).
  - ``_call_game`` emits a ``BusGameToolCallRequest`` with the expected
    shape (tool_name, args, character_id, actor_character_id, task_id).
  - ``_tool_corporation_info`` translates each branch to the right
    ``BusCorporationQueryRequest.query_type``.
  - The combat preamble emits ``BusCombatStrategyRequest`` carrying
    ``ship_id``.
  - ``task.finish`` is sent as ``BusTaskFinishNotification`` (no direct
    ``task_lifecycle`` call from TaskAgent).
  - ``BusGameToolCallResponse``/``error`` round-trips through
    ``PendingRequests`` to resolve / reject the awaiting future.
  - Cancelling a task fails fast on any in-flight bus RPCs.
"""

import asyncio
import inspect
from unittest.mock import AsyncMock, MagicMock

import pytest

from gradientbang.pipecat_server.subagents.bus_correlation import PendingRequests
from gradientbang.pipecat_server.subagents.bus_messages import (
    BusCombatStrategyRequest,
    BusCombatStrategyResponse,
    BusCorporationQueryRequest,
    BusCorporationQueryResponse,
    BusGameToolCallRequest,
    BusGameToolCallResponse,
    BusTaskFinishNotification,
)
from gradientbang.pipecat_server.subagents.task_agent import TaskAgent


def _make_agent(**overrides) -> TaskAgent:
    bus = MagicMock()
    bus.send_message = AsyncMock()
    kwargs = {"bus": bus, "character_id": "char-123"}
    kwargs.update(overrides)
    agent = TaskAgent("task_test", **kwargs)
    # Common test scaffolding — the agent needs a task_requester to know
    # where to send its outbound RPCs. Overrides the inherited send_message
    # with an AsyncMock so we can assert the typed outbound shapes.
    agent._task_requester = "voice_agent"
    agent._active_task_id = "active-task-uuid"
    agent.send_message = AsyncMock()
    return agent


def _captured(agent: TaskAgent) -> list:
    return [call.args[0] for call in agent.send_message.await_args_list]


# ── Construction guarantees ──────────────────────────────────────────


@pytest.mark.unit
class TestNoGameClient:
    def test_no_game_client_attribute(self):
        agent = _make_agent()
        assert not hasattr(agent, "_game_client")

    def test_constructor_does_not_accept_game_client(self):
        bus = MagicMock()
        with pytest.raises(TypeError):
            TaskAgent(
                "task_test",
                bus=bus,
                character_id="char-123",
                game_client=MagicMock(),
            )

    def test_no_async_game_client_import_in_module(self):
        """Phase 1 deletes the AsyncGameClient import from task_agent.py."""
        from gradientbang.pipecat_server.subagents import task_agent

        source = inspect.getsource(task_agent)
        # The only mention permitted is the explanatory comment inside
        # ``_tool_ship_definitions``. Anything else means we re-added a
        # direct dependency.
        offending_lines = [
            line.strip()
            for line in source.splitlines()
            if "AsyncGameClient" in line
            and not line.lstrip().startswith("#")
            and "AsyncGameClient on AsyncGameClient" not in line
        ]
        assert offending_lines == [], (
            "TaskAgent must not reference AsyncGameClient outside comments; "
            f"found: {offending_lines}"
        )


# ── Outbound message shapes ──────────────────────────────────────────


@pytest.mark.unit
class TestCallGameMessage:
    @pytest.mark.asyncio
    async def test_emits_bus_game_tool_call_request(self):
        agent = _make_agent(is_corp_ship=True, tag_outbound_rpcs_with_task_id=True)
        agent._task_metadata = {"actor_character_id": "player-1"}

        async def _fire_and_drain():
            return await agent._call_game(
                "move",
                to_sector=5,
                via="warp",
            )

        # Auto-respond with a fixed result so the awaiting future resolves.
        async def _broker(message):
            asyncio.create_task(
                agent.on_bus_message(
                    BusGameToolCallResponse(
                        source="voice_agent",
                        target=agent.name,
                        correlation_id=message.correlation_id,
                        result={"new_sector": 5},
                    )
                )
            )

        agent.send_message.side_effect = _broker
        result = await _fire_and_drain()
        assert result == {"new_sector": 5}

        sent = _captured(agent)
        assert len(sent) == 1
        msg = sent[0]
        assert isinstance(msg, BusGameToolCallRequest)
        assert msg.tool_name == "move"
        assert msg.args == {"to_sector": 5, "via": "warp"}
        assert msg.character_id == "char-123"
        assert msg.actor_character_id == "player-1"
        # task_id propagated because tag_outbound_rpcs_with_task_id=True
        assert msg.task_id == "active-task-uuid"
        assert msg.target == "voice_agent"
        # correlation_id is a non-empty string we just don't pin the value
        assert msg.correlation_id and isinstance(msg.correlation_id, str)

    @pytest.mark.asyncio
    async def test_player_task_omits_task_id_tag(self):
        agent = _make_agent(is_corp_ship=False, tag_outbound_rpcs_with_task_id=False)

        async def _broker(message):
            asyncio.create_task(
                agent.on_bus_message(
                    BusGameToolCallResponse(
                        source="voice_agent",
                        target=agent.name,
                        correlation_id=message.correlation_id,
                        result={"ok": True},
                    )
                )
            )

        agent.send_message.side_effect = _broker
        await agent._call_game("my_status")

        msg = _captured(agent)[0]
        assert isinstance(msg, BusGameToolCallRequest)
        # tag_outbound_rpcs_with_task_id=False → empty task_id field
        assert msg.task_id == ""

    @pytest.mark.asyncio
    async def test_no_task_requester_raises(self):
        agent = _make_agent()
        agent._task_requester = None
        with pytest.raises(RuntimeError, match="no broker target"):
            await agent._call_game("move")

    @pytest.mark.asyncio
    async def test_response_error_rejects_the_future(self):
        agent = _make_agent()

        async def _broker(message):
            asyncio.create_task(
                agent.on_bus_message(
                    BusGameToolCallResponse(
                        source="voice_agent",
                        target=agent.name,
                        correlation_id=message.correlation_id,
                        error="ship in hyperspace",
                    )
                )
            )

        agent.send_message.side_effect = _broker
        with pytest.raises(RuntimeError, match="ship in hyperspace"):
            await agent._call_game("move")


@pytest.mark.unit
class TestCorporationQueryMessage:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "args,expected_query_type,expected_corp_id",
        [
            ({"list_all": True}, "list", None),
            ({"corp_id": "corp-1"}, "info", "corp-1"),
            ({}, "my", None),
            # Empty args also default to "my".
            ({"corp_id": ""}, "my", None),
        ],
    )
    async def test_args_map_to_query_type(self, args, expected_query_type, expected_corp_id):
        agent = _make_agent()

        async def _broker(message):
            asyncio.create_task(
                agent.on_bus_message(
                    BusCorporationQueryResponse(
                        source="voice_agent",
                        target=agent.name,
                        correlation_id=message.correlation_id,
                        result={"ok": True},
                    )
                )
            )

        agent.send_message.side_effect = _broker
        await agent._tool_corporation_info(args)

        msg = _captured(agent)[0]
        assert isinstance(msg, BusCorporationQueryRequest)
        assert msg.query_type == expected_query_type
        assert msg.corp_id == expected_corp_id
        assert msg.character_id == "char-123"


@pytest.mark.unit
class TestCombatStrategyMessage:
    @pytest.mark.asyncio
    async def test_carries_ship_id(self):
        agent = _make_agent()

        async def _broker(message):
            asyncio.create_task(
                agent.on_bus_message(
                    BusCombatStrategyResponse(
                        source="voice_agent",
                        target=agent.name,
                        correlation_id=message.correlation_id,
                        strategy={"strategy": {"template": "balanced"}},
                    )
                )
            )

        agent.send_message.side_effect = _broker
        result = await agent._send_combat_strategy_request(ship_id="ship-probe")

        msg = _captured(agent)[0]
        assert isinstance(msg, BusCombatStrategyRequest)
        assert msg.ship_id == "ship-probe"
        assert msg.character_id == "char-123"
        assert result == {"strategy": {"template": "balanced"}}


@pytest.mark.unit
class TestTaskFinishMessage:
    @pytest.mark.asyncio
    async def test_sends_fire_and_forget_notification(self):
        agent = _make_agent()
        await agent._send_task_finish_notification(
            status="completed", summary="reached sector 5"
        )

        msg = _captured(agent)[0]
        assert isinstance(msg, BusTaskFinishNotification)
        assert msg.character_id == "char-123"
        assert msg.task_id == "active-task-uuid"
        assert msg.status == "completed"
        assert msg.summary == "reached sector 5"
        assert msg.target == "voice_agent"

    @pytest.mark.asyncio
    async def test_skips_when_no_task_or_requester(self):
        agent = _make_agent()
        agent._task_requester = None
        await agent._send_task_finish_notification(status="completed", summary=None)
        # No send_message call — silent skip when there's no broker.
        assert agent.send_message.await_count == 0


# ── Cancellation hygiene ─────────────────────────────────────────────


@pytest.mark.unit
class TestPendingRequestsLifecycle:
    @pytest.mark.asyncio
    async def test_cancel_all_runs_on_task_cancel(self):
        """Any in-flight bus RPCs must fail fast on cancel."""
        from pipecat_subagents.bus import BusTaskCancelMessage

        agent = _make_agent()
        agent.send_task_response = AsyncMock()
        agent._send_task_output = AsyncMock()
        agent._drain_pending_task_outputs = AsyncMock()
        agent._upload_context_snapshot = MagicMock()

        # Pin a pending future on the correlation map.
        pending: PendingRequests = agent._pending
        future_task = asyncio.create_task(pending.issue("hold-1", timeout=10.0))
        await asyncio.sleep(0)  # let it register

        await agent.on_task_cancelled(
            BusTaskCancelMessage(
                source="voice", task_id="active-task-uuid", reason="user cancel"
            )
        )

        # Pending future was cancelled.
        with pytest.raises(asyncio.CancelledError):
            await future_task

    @pytest.mark.asyncio
    async def test_reset_replaces_pending_for_next_task(self):
        """A new task gets a fresh PendingRequests; old futures don't leak."""
        agent = _make_agent()
        old_pending = agent._pending
        agent._reset_task_state()
        assert agent._pending is not old_pending