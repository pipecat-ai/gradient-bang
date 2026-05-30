"""Tests for the TaskAgent."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pipecat.frames.frames import LLMRunFrame
from pipecat.services.llm_service import FunctionCallParams

from gradientbang.runtime.subagents.task_agent import (
    ASYNC_TOOL_COMPLETIONS,
    PLAYER_ONLY_TOOLS,
    TaskAgent,
)
from gradientbang.runtime.bus import BusByoaPresenceMessage
from pipecat.pipeline.job_context import JobStatus
from pipecat.bus import (
    BusJobCancelMessage,
    BusJobRequestMessage,
    BusJobUpdateMessage,
)
from gradientbang.runtime.tool_schema import TASK_TOOLS
from gradientbang.utils.prompt_loader import TaskOutputType
from gradientbang.utils.summary_formatters import event_query_summary


def _make_task_agent(**overrides):
    """Create a TaskAgent with mock dependencies.

    Phase 1: TaskAgent no longer takes ``game_client`` — every game RPC
    goes over the bus to Orchestrator's broker. For test ergonomics we
    attach a ``_game_client`` MagicMock to the returned agent and
    install a simulated broker on ``agent.send_message`` that dispatches
    outbound Phase 1 bus RPCs against that mock. So tests can keep
    writing ``agent._game_client.foo.assert_awaited_once_with(...)``
    and it Just Works.
    """
    import asyncio as _asyncio

    from gradientbang.runtime.bus import (
        BusCombatStrategyRequest,
        BusCombatStrategyResponse,
        BusCorporationQueryRequest,
        BusCorporationQueryResponse,
        BusGameToolCallRequest,
        BusGameToolCallResponse,
        BusTaskFinishNotification,
    )

    bus = MagicMock()
    bus.send = AsyncMock()
    bus.send_bus_message = AsyncMock()
    legacy_game_client = overrides.pop("game_client", None)
    name = overrides.pop("name", "test_task")
    kwargs = {
        
        "character_id": "char-123",
    }
    kwargs.update(overrides)
    agent = TaskAgent(name, **kwargs)
    if legacy_game_client is None:
        legacy_game_client = MagicMock()
        legacy_game_client.current_task_id = None
    agent._game_client = legacy_game_client  # type: ignore[attr-defined]

    async def _broker_dispatch(message):
        if isinstance(message, BusGameToolCallRequest):
            method = getattr(agent._game_client, message.tool_name, None)
            if method is None or not callable(method):
                response = BusGameToolCallResponse(
                    source="orchestrator",
                    target=agent.name,
                    correlation_id=message.correlation_id,
                    error=f"unknown tool: {message.tool_name!r}",
                )
            else:
                try:
                    call_kwargs = dict(message.args)
                    if message.character_id:
                        call_kwargs.setdefault("character_id", message.character_id)
                    if message.actor_character_id:
                        call_kwargs.setdefault("actor_character_id", message.actor_character_id)
                    raw = await method(**call_kwargs)
                    result = raw if isinstance(raw, dict) else {"result": raw}
                    response = BusGameToolCallResponse(
                        source="orchestrator",
                        target=agent.name,
                        correlation_id=message.correlation_id,
                        result=result,
                    )
                except Exception as exc:
                    response = BusGameToolCallResponse(
                        source="orchestrator",
                        target=agent.name,
                        correlation_id=message.correlation_id,
                        error=str(exc),
                    )
        elif isinstance(message, BusCombatStrategyRequest):
            try:
                call_kwargs = {"character_id": message.character_id}
                if message.ship_id:
                    call_kwargs["ship_id"] = message.ship_id
                raw = await agent._game_client.combat_get_strategy(**call_kwargs)
                response = BusCombatStrategyResponse(
                    source="orchestrator",
                    target=agent.name,
                    correlation_id=message.correlation_id,
                    strategy=raw if isinstance(raw, dict) else {"strategy": raw},
                )
            except Exception as exc:
                response = BusCombatStrategyResponse(
                    source="orchestrator",
                    target=agent.name,
                    correlation_id=message.correlation_id,
                    error=str(exc),
                )
        elif isinstance(message, BusCorporationQueryRequest):
            try:
                if message.query_type == "list":
                    raw = await agent._game_client._request("corporation.list", {})
                elif message.query_type == "info":
                    raw = await agent._game_client._request(
                        "corporation.info",
                        {
                            "character_id": message.character_id,
                            "corp_id": message.corp_id,
                        },
                    )
                else:
                    raw = await agent._game_client._request(
                        "my_corporation",
                        {"character_id": message.character_id},
                    )
                response = BusCorporationQueryResponse(
                    source="orchestrator",
                    target=agent.name,
                    correlation_id=message.correlation_id,
                    result=raw if isinstance(raw, dict) else {"result": raw},
                )
            except Exception as exc:
                response = BusCorporationQueryResponse(
                    source="orchestrator",
                    target=agent.name,
                    correlation_id=message.correlation_id,
                    error=str(exc),
                )
        elif isinstance(message, BusTaskFinishNotification):
            await agent._game_client.task_lifecycle(
                event_type="finish",
                character_id=message.character_id,
                task_id=message.task_id,
                task_status=message.status,
                task_summary=message.summary,
            )
            return
        else:
            return
        _asyncio.create_task(agent.on_bus_message(response))

    agent.send_bus_message = AsyncMock(side_effect=_broker_dispatch)
    return agent


def _make_function_call_params(function_name: str, arguments: dict | None = None):
    params = MagicMock(spec=FunctionCallParams)
    params.function_name = function_name
    params.arguments = arguments or {}
    params.result_callback = AsyncMock()
    return params


EXPECTED_TASK_TOOL_NAMES = {t.name for t in TASK_TOOLS.standard_tools}


@pytest.mark.unit
class TestByoaPresence:
    async def test_on_ready_sends_online_presence_and_starts_heartbeat(self):
        agent = _make_task_agent(name="byoa_ship-123", character_id="ship-123")
        agent.send_bus_message = AsyncMock()
        created_task = MagicMock()

        def _capture_task(coro, name):
            coro.close()
            return created_task

        agent.create_task = MagicMock(side_effect=_capture_task)

        await agent._on_pipeline_started()

        sent = agent.send_bus_message.await_args.args[0]
        assert isinstance(sent, BusByoaPresenceMessage)
        assert sent.source == "byoa_ship-123"
        assert sent.ship_id == "ship-123"
        assert sent.online is True
        assert sent.status == "online"
        agent.create_task.assert_called_once()

    async def test_on_finished_sends_offline_presence(self):
        agent = _make_task_agent(name="byoa_ship-123", character_id="ship-123")
        agent.send_bus_message = AsyncMock()
        agent.cancel_task = AsyncMock()
        agent._byoa_presence_task = MagicMock(done=MagicMock(return_value=False))

        await agent._on_pipeline_finished()

        sent = agent.send_bus_message.await_args.args[0]
        assert isinstance(sent, BusByoaPresenceMessage)
        assert sent.online is False
        assert sent.status == "offline"
        agent.cancel_task.assert_awaited_once()

    async def test_non_byoa_agent_does_not_emit_presence(self):
        agent = _make_task_agent(name="task_abc", character_id="ship-123")
        agent.send_bus_message = AsyncMock()
        agent.create_task = MagicMock()

        await agent._on_pipeline_started()

        agent.send_bus_message.assert_not_awaited()
        agent.create_task.assert_not_called()


@pytest.mark.unit
class TestTaskAgentConstruction:
    def test_creates_with_required_params(self):
        agent = _make_task_agent()
        assert agent.name == "test_task"
        assert agent._character_id == "char-123"
        assert agent._is_corp_ship is False

    def test_creates_as_corp_ship(self):
        agent = _make_task_agent(is_corp_ship=True)
        assert agent._is_corp_ship is True

    def test_no_game_client_event_subscriptions(self):
        """Events come via bus, not game_client."""
        gc = MagicMock()
        _make_task_agent(game_client=gc)
        gc.add_event_handler.assert_not_called()


@pytest.mark.unit
class TestTaskAgentTools:
    def test_build_tools_returns_task_schemas(self):
        agent = _make_task_agent()
        tool_names = {t.name for t in agent.build_tools()}
        assert tool_names == EXPECTED_TASK_TOOL_NAMES

    def test_all_tools_have_handlers(self):
        agent = _make_task_agent()
        for schema in TASK_TOOLS.standard_tools:
            if schema.name == "finished":
                continue
            assert agent._get_tool_handler(schema.name) is not None, f"No handler for {schema.name}"

    def test_dispatch_covers_all_non_special_tools(self):
        """Every TASK_TOOLS tool has either a schema-driven dispatch or a special handler."""
        agent = _make_task_agent()
        for schema in TASK_TOOLS.standard_tools:
            if schema.name == "finished":
                continue
            handler = agent._get_tool_handler(schema.name)
            assert handler is not None, f"No handler for {schema.name}"

    def test_includes_combat_tools(self):
        # Combat tools are deliberately part of the TaskAgent toolset so an
        # autonomous task can engage / submit actions during combat. Inference
        # is deferred via ASYNC_TOOL_COMPLETIONS until the matching event
        # arrives (see test_combat_in_async_completions).
        tool_names = {t.name for t in TASK_TOOLS.standard_tools}
        assert "combat_initiate" in tool_names
        assert "combat_action" in tool_names

    def test_excludes_meta_task_tools(self):
        tool_names = {t.name for t in TASK_TOOLS.standard_tools}
        for name in ("start_task", "stop_task", "steer_task", "query_task_progress"):
            assert name not in tool_names

    def test_combat_in_async_completions(self):
        # Combat tool calls return immediately at the API layer but the
        # player-facing outcome arrives asynchronously via combat events.
        # Map them so inference is deferred until the right event lands.
        assert ASYNC_TOOL_COMPLETIONS["combat_initiate"] == "combat.round_waiting"
        assert ASYNC_TOOL_COMPLETIONS["combat_action"] == "combat.action_accepted"

    @patch("gradientbang.runtime.subagents.task_agent.create_llm_service")
    @patch("gradientbang.runtime.subagents.task_agent.get_task_agent_llm_config")
    def test_create_llm_registers_catch_all(self, _mock_config, mock_create):
        mock_llm = MagicMock()
        mock_create.return_value = mock_llm
        # LLM is built eagerly in TaskAgent.__init__ (via build_llm), which then
        # registers the catch-all function handler before super().__init__ wires
        # the pipeline. We just need to construct the agent and inspect the mock.
        _make_task_agent()
        mock_llm.register_function.assert_called_once()
        assert mock_llm.register_function.call_args[0][0] is None


@pytest.mark.unit
class TestCorpShipToolFiltering:
    def test_player_agent_gets_all_tools(self):
        agent = _make_task_agent(is_corp_ship=False)
        tool_names = {t.name for t in agent.build_tools()}
        assert tool_names == EXPECTED_TASK_TOOL_NAMES

    def test_corp_ship_excludes_player_only_tools(self):
        agent = _make_task_agent(is_corp_ship=True)
        tool_names = {t.name for t in agent.build_tools()}
        for restricted in PLAYER_ONLY_TOOLS:
            assert restricted not in tool_names, f"{restricted} should be excluded for corp ships"

    def test_corp_ship_keeps_other_tools(self):
        agent = _make_task_agent(is_corp_ship=True)
        tool_names = {t.name for t in agent.build_tools()}
        expected_remaining = EXPECTED_TASK_TOOL_NAMES - PLAYER_ONLY_TOOLS
        assert tool_names == expected_remaining

    def test_player_only_tools_are_valid_task_tools(self):
        """All PLAYER_ONLY_TOOLS actually exist in TASK_TOOLS."""
        all_tool_names = {t.name for t in TASK_TOOLS.standard_tools}
        for name in PLAYER_ONLY_TOOLS:
            assert name in all_tool_names, (
                f"PLAYER_ONLY_TOOLS has '{name}' which is not in TASK_TOOLS"
            )


@pytest.mark.unit
class TestTaskAgentState:
    def test_initial_state(self):
        agent = _make_task_agent()
        assert agent._task_finished is False
        assert agent._cancelled is False
        assert agent._active_task_id is None

    def test_reset_clears_all(self):
        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._task_finished = True
        agent._cancelled = True
        agent._awaiting_completion_request_id = "req-123"
        agent._consecutive_error_count = 5
        agent._step_counter = 42
        agent._reset_task_state()
        assert agent._active_task_id is None
        assert agent._task_finished is False
        assert agent._awaiting_completion_request_id is None
        assert agent._consecutive_error_count == 0
        assert agent._step_counter == 0

    def test_task_log(self):
        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._output("line 1")
        agent._output("line 2")
        assert agent.get_task_log() == ["line 1", "line 2"]

    def test_archive_clears_log(self):
        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._output("log entry")
        agent._archive_task_log()
        assert agent.get_task_log() == []


@pytest.mark.unit
class TestBusEventReception:
    """TaskAgent receives game events via BusGameEventMessage."""

    async def test_processes_event_matching_task_id(self):
        from gradientbang.runtime.bus import BusGameEventMessage

        agent = _make_task_agent()
        agent._active_task_id = "task-uuid-123"
        agent._handle_event = AsyncMock()

        msg = BusGameEventMessage(
            source="player",
            event={"event_name": "trade.executed", "task_id": "task-uuid-123", "payload": {}},
        )
        await agent.on_bus_message(msg)
        await agent._game_event_queue.join()
        agent._handle_event.assert_called_once()

    async def test_event_with_event_id_is_processed_without_blocking(self):
        from gradientbang.runtime.bus import BusGameEventMessage

        agent = _make_task_agent()
        agent._active_task_id = "task-uuid-123"
        agent._handle_event = AsyncMock()

        msg = BusGameEventMessage(
            source="player",
            event={
                "event_name": "trade.executed",
                "task_id": "task-uuid-123",
                "event_context": {"event_id": 101},
                "payload": {},
            },
        )
        await agent.on_bus_message(msg)
        await asyncio.wait_for(agent._game_event_queue.join(), timeout=0.5)
        agent._handle_event.assert_called_once()

    def test_sorts_ready_events_by_event_id_without_requiring_contiguous_ids(self):
        ready = [
            ({"event_name": "later", "event_context": {"event_id": 103}, "payload": {}}, False),
            ({"event_name": "earlier", "event_context": {"event_id": 101}, "payload": {}}, False),
        ]

        ordered = TaskAgent._sort_ready_game_events(ready)

        assert [event["event_name"] for event, _originated in ordered] == [
            "earlier",
            "later",
        ]

    def test_sorts_ready_events_preserves_arrival_order_for_no_id_events(self):
        ready = [
            ({"event_name": "no-id-A", "payload": {}}, False),
            ({"event_name": "id-105", "event_context": {"event_id": 105}, "payload": {}}, False),
            ({"event_name": "no-id-B", "payload": {}}, False),
            ({"event_name": "id-101", "event_context": {"event_id": 101}, "payload": {}}, False),
        ]

        ordered = TaskAgent._sort_ready_game_events(ready)

        assert [event["event_name"] for event, _originated in ordered] == [
            "no-id-A",
            "id-101",
            "no-id-B",
            "id-105",
        ]

    def test_extract_event_id_reads_top_level_event_context(self):
        event = {"event_name": "x", "event_context": {"event_id": 42}, "payload": {}}
        assert TaskAgent._extract_event_id(event) == 42

    def test_extract_event_id_falls_back_to_payload_event_context(self):
        event = {"event_name": "x", "payload": {"__event_context": {"event_id": 7}}}
        assert TaskAgent._extract_event_id(event) == 7

    def test_event_query_does_not_pollute_handled_high_water_mark(self):
        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._last_handled_event_id = 100

        agent._record_handled_event_order(
            {"event_name": "event.query", "event_context": {"event_id": 50}, "payload": {}}
        )
        assert agent._last_handled_event_id == 100

        agent._record_handled_event_order(
            {"event_name": "trade.executed", "event_context": {"event_id": 110}, "payload": {}}
        )
        assert agent._last_handled_event_id == 110

    async def test_bus_event_with_no_summary_does_not_leak_internal_metadata(self):
        from gradientbang.runtime.bus import BusGameEventMessage

        agent = _make_task_agent(character_id="char-123")
        agent._active_task_id = "task-uuid-123"
        agent._llm_context = MagicMock()
        agent._output = MagicMock()

        msg = BusGameEventMessage(
            source="player",
            event={
                "event_name": "trade.executed",
                "task_id": "task-uuid-123",
                "event_context": {"event_id": 200, "scope": "direct"},
                "payload": {"trade": {"price": 42}},
            },
        )
        await agent.on_bus_message(msg)
        await agent._game_event_queue.join()

        appended = agent._llm_context.add_message.call_args.args[0]["content"]
        assert "__event_context" not in appended
        assert "recipient_ids" not in appended
        assert "recipient_reasons" not in appended

        output_text = agent._output.call_args.args[0]
        assert "__event_context" not in output_text
        assert "recipient_ids" not in output_text

    async def test_ignores_event_for_other_task(self):
        from gradientbang.runtime.bus import BusGameEventMessage

        agent = _make_task_agent()
        agent._active_task_id = "task-uuid-123"
        agent._handle_event = AsyncMock()

        msg = BusGameEventMessage(
            source="player",
            event={"event_name": "trade.executed", "task_id": "other-task", "payload": {}},
        )
        await agent.on_bus_message(msg)
        await agent._game_event_queue.join()
        agent._handle_event.assert_not_called()

    async def test_processes_untagged_matching_character_event_when_awaited(self):
        from gradientbang.runtime.bus import BusGameEventMessage

        agent = _make_task_agent(character_id="ship-456")
        agent._active_task_id = "task-uuid-123"
        agent._awaiting_completion_event = "status.snapshot"
        agent._handle_event = AsyncMock()

        msg = BusGameEventMessage(
            source="player",
            event={"event_name": "status.snapshot", "payload": {"player": {"id": "ship-456"}}},
        )
        await agent.on_bus_message(msg)
        await agent._game_event_queue.join()
        agent._handle_event.assert_called_once()

    async def test_ignores_unscoped_character_event_when_not_awaited(self):
        from gradientbang.runtime.bus import BusGameEventMessage

        agent = _make_task_agent(character_id="ship-456")
        agent._active_task_id = "task-uuid-123"
        agent._awaiting_completion_event = "movement.complete"
        agent._handle_event = AsyncMock()

        msg = BusGameEventMessage(
            source="player",
            event={"event_name": "status.snapshot", "payload": {"player": {"id": "ship-456"}}},
        )
        await agent.on_bus_message(msg)
        await agent._game_event_queue.join()
        agent._handle_event.assert_not_called()

    async def test_ignores_combat_event_for_other_ship(self):
        from gradientbang.runtime.bus import BusGameEventMessage

        agent = _make_task_agent(character_id="ship-2")
        agent._active_task_id = "task-uuid-123"
        agent._handle_event = AsyncMock()

        msg = BusGameEventMessage(
            source="player",
            event={
                "event_name": "combat.round_waiting",
                "payload": {"participants": [{"id": "ship-1"}, {"id": "enemy-1"}]},
            },
        )
        await agent.on_bus_message(msg)
        await agent._game_event_queue.join()
        agent._handle_event.assert_not_called()

    async def test_processes_combat_event_for_own_ship(self):
        from gradientbang.runtime.bus import BusGameEventMessage

        agent = _make_task_agent(character_id="ship-2")
        agent._active_task_id = "task-uuid-123"
        agent._handle_event = AsyncMock()

        msg = BusGameEventMessage(
            source="player",
            event={
                "event_name": "combat.round_waiting",
                "payload": {"participants": [{"id": "ship-2"}, {"id": "enemy-1"}]},
            },
        )
        await agent.on_bus_message(msg)
        await agent._game_event_queue.join()
        agent._handle_event.assert_called_once()

    async def test_ignores_destroyed_event_for_other_ship(self):
        from gradientbang.runtime.bus import BusGameEventMessage

        agent = _make_task_agent(character_id="ship-2")
        agent._active_task_id = "task-uuid-123"
        agent._handle_event = AsyncMock()

        msg = BusGameEventMessage(
            source="player",
            event={
                "event_name": "garrison.destroyed",
                "payload": {
                    "ship_id": "ship-1",
                    "owner_character_id": "ship-1-owner",
                },
            },
        )
        await agent.on_bus_message(msg)
        await agent._game_event_queue.join()
        agent._handle_event.assert_not_called()

    async def test_ignores_when_no_active_task(self):
        from gradientbang.runtime.bus import BusGameEventMessage

        agent = _make_task_agent()
        agent._active_task_id = None
        agent._handle_event = AsyncMock()

        msg = BusGameEventMessage(
            source="player",
            event={"event_name": "error", "payload": {}},
        )
        await agent.on_bus_message(msg)
        agent._handle_event.assert_not_called()

    async def test_accepts_awaited_event_query_by_request_id(self):
        from gradientbang.runtime.bus import BusGameEventMessage

        agent = _make_task_agent()
        agent._active_task_id = "task-uuid-123"
        agent._awaiting_completion_event = "event.query"
        agent._awaiting_completion_request_id = "req-123"
        agent._handle_event = AsyncMock()

        msg = BusGameEventMessage(
            source="player",
            event={"event_name": "event.query", "request_id": "req-123", "payload": {"count": 0}},
        )
        await agent.on_bus_message(msg)
        await agent._game_event_queue.join()
        agent._handle_event.assert_called_once()

    async def test_ignores_unmatched_event_query_request_id(self):
        from gradientbang.runtime.bus import BusGameEventMessage

        agent = _make_task_agent()
        agent._active_task_id = "task-uuid-123"
        agent._awaiting_completion_event = "event.query"
        agent._awaiting_completion_request_id = "req-123"
        agent._handle_event = AsyncMock()

        msg = BusGameEventMessage(
            source="player",
            event={"event_name": "event.query", "request_id": "req-999", "payload": {"count": 0}},
        )
        await agent.on_bus_message(msg)
        await agent._game_event_queue.join()
        agent._handle_event.assert_not_called()

    async def test_bus_event_query_uses_summary_not_raw_payload(self):
        from gradientbang.runtime.bus import BusGameEventMessage

        agent = _make_task_agent()
        agent._active_task_id = "task-uuid-123"
        agent._awaiting_completion_event = "event.query"
        agent._awaiting_completion_request_id = "req-123"
        agent._llm_context = MagicMock()
        agent._llm_inflight = True

        msg = BusGameEventMessage(
            source="player",
            event={
                "event_name": "event.query",
                "request_id": "req-123",
                "summary": "Query returned 8 events.",
                "payload": {"events": [{"blob": "x" * 5000}]},
            },
        )
        await agent.on_bus_message(msg)
        await agent._game_event_queue.join()

        context_message = agent._llm_context.add_message.call_args.args[0]["content"]
        assert "Query returned 8 events." in context_message
        assert "blob" not in context_message


@pytest.mark.unit
class TestSteering:
    async def test_steering_injected_into_context(self):
        from gradientbang.runtime.bus import BusSteerTaskMessage

        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._llm_context = MagicMock()
        agent._llm_inflight = True

        msg = BusSteerTaskMessage(
            source="voice", target="test_task", task_id="task-1", text="Change direction"
        )
        await agent.on_bus_message(msg)

        agent._llm_context.add_message.assert_called_once()
        content = agent._llm_context.add_message.call_args[0][0]["content"]
        assert '<event name="task.steered">' in content
        assert "Change direction" in content

    async def test_steering_for_other_target_ignored(self):
        from gradientbang.runtime.bus import BusSteerTaskMessage

        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._llm_context = MagicMock()

        msg = BusSteerTaskMessage(
            source="voice",
            target="other_task",
            task_id="task-1",
            text="Change direction",
        )
        await agent.on_bus_message(msg)

        agent._llm_context.add_message.assert_not_called()


@pytest.mark.unit
class TestCancellation:
    async def test_sets_cancelled_flag(self):
        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._game_client.task_lifecycle = AsyncMock()
        agent.send_job_response = AsyncMock()
        agent._active_task_id = "task-1"
        agent._task_requester = "parent"
        await agent.on_job_cancelled(
            BusJobCancelMessage(source="parent", job_id="task-1", reason="test reason")
        )
        assert agent._cancelled is True


@pytest.mark.unit
class TestTaskIdTagging:
    async def test_player_task_request_does_not_set_shared_client_task_id(self):
        agent = _make_task_agent(tag_outbound_rpcs_with_task_id=False)
        agent._llm_context = MagicMock()
        agent.queue_frame = AsyncMock()
        agent._game_client.task_lifecycle = AsyncMock()
        agent._game_client.current_task_id = "shared-task"

        await agent.on_job_request(
            BusJobRequestMessage(
                source="voice",
                job_id="task-1",
                payload={"task_description": "Check status"},
            )
        )

        assert agent._game_client.current_task_id == "shared-task"

    async def test_corp_task_request_does_not_mutate_shared_client_task_id(self):
        """Phase 1: TaskAgent no longer mutates the broker's game_client.
        The broker tags current_task_id per-call from the inbound
        BusGameToolCallRequest's task_id — exercised in
        test_orchestrator_bus_broker.TestGameToolCallBroker.
        """
        agent = _make_task_agent(tag_outbound_rpcs_with_task_id=True)
        agent._llm_context = MagicMock()
        agent.queue_frame = AsyncMock()
        agent._game_client.task_lifecycle = AsyncMock()

        await agent.on_job_request(
            BusJobRequestMessage(
                source="voice",
                job_id="task-1",
                payload={"task_description": "Check corp status"},
            )
        )

        # No direct mutation — the broker handles task_id tagging.
        assert agent._game_client.current_task_id is None

    async def test_task_request_context_is_included_in_initial_prompt(self):
        agent = _make_task_agent(tag_outbound_rpcs_with_task_id=False)
        agent._llm_context = MagicMock()
        agent.queue_frame = AsyncMock()
        agent._game_client.task_lifecycle = AsyncMock()

        await agent.on_job_request(
            BusJobRequestMessage(
                source="voice",
                job_id="task-1",
                payload={
                    "task_description": "Summarize the last session",
                    "context": "Current session started at 2026-03-29T18:46:44+00:00.",
                },
            )
        )

        messages = agent._llm_context.set_messages.call_args.args[0]
        assert messages[1]["role"] == "user"
        assert "# Additional Context" in messages[1]["content"]
        assert "Current session started at 2026-03-29T18:46:44+00:00." in messages[1]["content"]
        assert "Summarize the last session" in messages[1]["content"]

    async def test_corp_task_request_includes_corporation_bootstrap_instruction(self):
        agent = _make_task_agent(is_corp_ship=True, tag_outbound_rpcs_with_task_id=True)
        agent._llm_context = MagicMock()
        agent.queue_frame = AsyncMock()
        agent._game_client.task_lifecycle = AsyncMock()

        await agent.on_job_request(
            BusJobRequestMessage(
                source="voice",
                job_id="task-1",
                payload={"task_description": "Check corporation ship status"},
            )
        )

        messages = agent._llm_context.set_messages.call_args.args[0]
        assert "This task is running on a corporation ship." in messages[1]["content"]
        assert "first call `my_status()`" in messages[1]["content"]
        assert "call `corporation_info()`" in messages[1]["content"]

    async def test_player_task_completion_does_not_clear_unrelated_shared_client_task_id(self):
        agent = _make_task_agent(tag_outbound_rpcs_with_task_id=False)
        agent._active_task_id = "task-1"
        agent._task_finished_status = "completed"
        agent._task_finished_message = "Done"
        agent.send_job_response = AsyncMock()
        agent._game_client.current_task_id = "shared-task"

        await agent._complete_task()

        assert agent._game_client.current_task_id == "shared-task"

    async def test_player_task_cancel_does_not_clear_unrelated_shared_client_task_id(self):
        agent = _make_task_agent(tag_outbound_rpcs_with_task_id=False)
        agent._active_task_id = "task-1"
        agent._game_client.task_lifecycle = AsyncMock()
        agent.send_job_response = AsyncMock()
        agent._active_task_id = "task-1"
        agent._task_requester = "parent"
        agent._game_client.current_task_id = "shared-task"

        await agent.on_job_cancelled(
            BusJobCancelMessage(source="parent", job_id="task-1", reason="test reason")
        )

        assert agent._game_client.current_task_id == "shared-task"

    async def test_corp_task_completion_does_not_mutate_shared_client(self):
        """Phase 1: TaskAgent never reaches into the shared game client.
        The broker (Orchestrator) is responsible for tagging
        current_task_id per outbound call. _complete_task should leave
        the field alone whatever its value was before.
        """
        agent = _make_task_agent(tag_outbound_rpcs_with_task_id=True)
        agent._active_task_id = "task-1"
        agent._task_finished_status = "completed"
        agent._task_finished_message = "Done"
        agent.send_job_response = AsyncMock()
        agent._game_client.current_task_id = "other-task"

        await agent._complete_task()

        assert agent._game_client.current_task_id == "other-task"


@pytest.mark.unit
class TestTaskOutputDelivery:
    async def test_action_output_uses_captured_task_route(self):
        agent = _make_task_agent()
        agent._active_task_id = "framework-task"
        agent._task_requester = "orchestrator"
        agent.send_bus_message = AsyncMock()

        agent._output('move({"to_sector": 5})', TaskOutputType.ACTION)
        agent._active_task_id = None
        agent._task_requester = None

        await agent._drain_pending_task_outputs()

        agent.send_bus_message.assert_awaited_once()
        message = agent.send_bus_message.call_args.args[0]
        assert isinstance(message, BusJobUpdateMessage)
        assert message.job_id == "framework-task"
        assert message.target == "orchestrator"
        assert message.update == {
            "type": "output",
            "text": 'move({"to_sector": 5})',
            "message_type": "action",
        }

    async def test_complete_task_drains_pending_output_before_response(self):
        agent = _make_task_agent()
        agent._active_task_id = "framework-task"
        agent._task_requester = "orchestrator"
        agent._active_task_id = "task-1"
        agent._task_finished_status = "completed"
        agent._task_finished_message = "Done"
        call_order = []

        async def _send_message(message):
            call_order.append(("update", message.update["message_type"]))

        async def _send_job_response(task_id, *, response, status):
            call_order.append(("response", response["message"]))

        agent.send_bus_message = AsyncMock(side_effect=_send_message)
        agent.send_job_response = AsyncMock(side_effect=_send_job_response)

        agent._output("my_status({})", TaskOutputType.ACTION)
        await agent._complete_task()

        assert call_order == [("update", "action"), ("response", "Done")]

    async def test_task_output_delivery_failure_is_logged_and_completion_continues(self):
        agent = _make_task_agent()
        agent._active_task_id = "framework-task"
        agent._task_requester = "orchestrator"
        agent._active_task_id = "task-1"
        agent._task_finished_status = "completed"
        agent._task_finished_message = "Done"
        agent.send_bus_message = AsyncMock(side_effect=RuntimeError("boom"))
        agent.send_job_response = AsyncMock()

        agent._output("my_status({})", TaskOutputType.ACTION)

        with patch("gradientbang.runtime.subagents.task_agent.logger.warning") as warn:
            await agent._complete_task()

        warn.assert_called()
        agent.send_job_response.assert_awaited_once()


@pytest.mark.unit
class TestSyntheticProgressMessages:
    async def test_task_start_does_not_emit_initial_progress_message(self):
        agent = _make_task_agent()
        agent._llm_context = MagicMock()
        agent.queue_frame = AsyncMock()
        agent._game_client.task_lifecycle = AsyncMock()

        await agent.on_job_request(
            BusJobRequestMessage(
                source="voice",
                job_id="task-1",
                payload={"task_description": "Check status"},
            )
        )

        assert agent.get_task_log() == []
        agent.queue_frame.assert_awaited_once()

    async def test_event_query_completion_emits_message_before_llm_run(self):
        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._llm_context = MagicMock()
        agent.queue_frame = AsyncMock()
        agent._awaiting_completion_event = "event.query"
        agent._awaiting_completion_request_id = "req-123"

        await agent._handle_event(
            {
                "event_name": "event.query",
                "request_id": "req-123",
                "summary": "Query returned 8 events.",
                "payload": {"count": 8},
            }
        )
        await asyncio.sleep(0)

        assert agent.get_task_log()[-2:] == [
            "event.query: Query returned 8 events.",
            "Analyzing query results...",
        ]
        assert agent._llm_context.add_message.call_count == 1
        agent.queue_frame.assert_awaited_once()
        assert isinstance(agent.queue_frame.call_args.args[0], LLMRunFrame)

    async def test_steering_emits_replanning_message(self):
        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._llm_context = MagicMock()
        agent.queue_frame = AsyncMock()

        await agent._inject_steering("Change direction")

        assert agent.get_task_log()[-2:] == [
            "Change direction",
            "Replanning with new instructions...",
        ]
        agent.queue_frame.assert_awaited_once()

        # Single user message: task.steered event with steer text inside.
        agent._llm_context.add_message.assert_called_once()
        injected = agent._llm_context.add_message.call_args.args[0]
        assert injected["role"] == "user"
        assert injected["content"].startswith('<event name="task.steered">')
        assert "Priority update: revise your plan now" in injected["content"]
        assert "Change direction" in injected["content"]
        assert injected["content"].endswith("Change direction\n</event>")

    async def test_duplicate_progress_message_is_suppressed_without_new_action_or_event(self):
        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent.queue_frame = AsyncMock()
        agent._record_inference_reason("event.query")

        await agent._schedule_pending_inference()
        agent._llm_inflight = False
        agent._record_inference_reason("event.query")

        await agent._schedule_pending_inference()

        assert agent.get_task_log().count("Analyzing query results...") == 1
        assert agent.queue_frame.await_count == 2


@pytest.mark.unit
class TestEventQueryCompletionCorrelation:
    async def test_event_query_tool_stores_request_id(self):
        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._active_task_id = "framework-task"
        agent._task_requester = "orchestrator"
        params = _make_function_call_params(
            "event_query",
            {"start": "2026-03-27T00:00:00Z", "end": "2026-03-28T00:00:00Z"},
        )
        handler = AsyncMock(return_value={"request_id": "req-123", "count": 0})

        with (
            patch.object(agent, "_get_tool_handler", return_value=handler),
            patch.object(agent, "_on_tool_call_completed", AsyncMock()),
        ):
            await agent._handle_function_call(params)

        assert agent._awaiting_completion_event == "event.query"
        assert agent._awaiting_completion_request_id == "req-123"
        agent._clear_awaited_completion()

    async def test_event_query_without_request_id_clears_await(self):
        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._active_task_id = "framework-task"
        agent._task_requester = "orchestrator"
        params = _make_function_call_params(
            "event_query",
            {"start": "2026-03-27T00:00:00Z", "end": "2026-03-28T00:00:00Z"},
        )
        handler = AsyncMock(return_value={"count": 0})

        with (
            patch.object(agent, "_get_tool_handler", return_value=handler),
            patch.object(agent, "_on_tool_call_completed", AsyncMock()),
            patch("gradientbang.runtime.subagents.task_agent.logger.warning") as warn,
        ):
            await agent._handle_function_call(params)

        assert agent._awaiting_completion_event is None
        assert agent._awaiting_completion_request_id is None
        warn.assert_called()

    async def test_matching_event_query_clears_wait(self):
        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._llm_context = MagicMock()
        agent._llm_inflight = True
        agent._awaiting_completion_event = "event.query"
        agent._awaiting_completion_request_id = "req-123"

        await agent._handle_event(
            {"event_name": "event.query", "request_id": "req-123", "payload": {"count": 0}}
        )

        assert agent._awaiting_completion_event is None
        assert agent._awaiting_completion_request_id is None

    async def test_mismatched_event_query_does_not_clear_wait(self):
        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._llm_context = MagicMock()
        agent._llm_inflight = True
        agent._awaiting_completion_event = "event.query"
        agent._awaiting_completion_request_id = "req-123"

        await agent._handle_event(
            {"event_name": "event.query", "request_id": "req-999", "payload": {"count": 0}}
        )

        assert agent._awaiting_completion_event == "event.query"
        assert agent._awaiting_completion_request_id == "req-123"
        agent._clear_awaited_completion()

    async def test_event_query_timeout_clears_request_id_and_recovers(self):
        agent = _make_task_agent()
        agent._awaiting_completion_event = "event.query"
        agent._awaiting_completion_request_id = "req-123"
        agent._schedule_pending_inference = AsyncMock()

        with patch("gradientbang.runtime.subagents.task_agent.logger.warning") as warn:
            await agent._on_completion_event_timeout()

        assert agent._awaiting_completion_event is None
        assert agent._awaiting_completion_request_id is None
        agent._schedule_pending_inference.assert_awaited_once()
        warn.assert_called()


@pytest.mark.unit
class TestEventQuerySummaryHandling:
    async def test_event_query_summary_is_bounded_in_output_and_context(self):
        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._llm_context = MagicMock()
        agent._llm_inflight = True

        events = [
            {
                "event": f"movement.complete.{idx}",
                "timestamp": f"2026-03-29T12:00:{idx:02d}Z",
                "payload": {"detail": "x" * 500},
            }
            for idx in range(25)
        ]
        summary = event_query_summary(
            {"events": events, "count": len(events), "has_more": True},
            lambda event_name, payload: f"{event_name} {payload.get('detail', '')}",
        )

        await agent._handle_event(
            {
                "event_name": "event.query",
                "summary": summary,
                "payload": {"events": events, "count": len(events), "has_more": True},
                "request_id": "req-123",
            }
        )

        assert "... 5 more events omitted." in agent.get_task_log()[-1]
        context_message = agent._llm_context.add_message.call_args.args[0]["content"]
        assert "... 5 more events omitted." in context_message
        assert "More events available" in context_message


@pytest.mark.unit
class TestPipelineErrorFailureHandling:
    async def test_on_error_fails_task_normally(self):
        agent = _make_task_agent()
        agent._active_task_id = "framework-task"
        agent._task_requester = "orchestrator"
        agent._active_task_id = "task-1"
        agent._game_client.task_lifecycle = AsyncMock()
        agent.send_job_response = AsyncMock()
        # Note: we deliberately do NOT replace agent.send_message —
        # the harness's simulated broker dispatches the outbound
        # BusTaskFinishNotification back to agent._game_client.task_lifecycle.

        await agent.on_error(
            "Error during completion: context_length_exceeded: input too long",
            fatal=False,
        )

        agent.send_job_response.assert_awaited_once()
        assert agent.send_job_response.call_args.kwargs["status"] == JobStatus.FAILED
        assert (
            agent.send_job_response.call_args.kwargs["response"]["message"]
            == "Task stopped because the event query returned too much history "
            "to process at once. Narrow the time range or query a specific "
            "task or event type."
        )
        agent._game_client.task_lifecycle.assert_awaited_once()
        assert agent._active_task_id is None

    async def test_on_error_is_idempotent(self):
        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._task_requester = "orchestrator"
        agent._game_client.task_lifecycle = AsyncMock()
        agent.send_job_response = AsyncMock()

        await agent.on_error("generic pipeline failure", fatal=False)
        await agent.on_error("generic pipeline failure", fatal=False)

        agent.send_job_response.assert_awaited_once()
        agent._game_client.task_lifecycle.assert_awaited_once()


@pytest.mark.unit
class TestCombatPreamble:
    """Round-1 combat.round_waiting prepends combat.md + ship doctrine to
    the TaskAgent's LLM context — same fixed order the player orchestrator
    uses in EventRelay (combat.md → doctrine → event XML). Applies to both
    corp ships and player ship task agents."""

    @staticmethod
    def _round_waiting(round_num: int = 1) -> dict:
        return {
            "event_name": "combat.round_waiting",
            "payload": {
                "combat_id": "cbt-1",
                "round": round_num,
                "sector": {"id": 42},
                "participants": [
                    {
                        "id": "ship-pseudo-char",
                        "ship_id": "ship-probe",
                        "ship": {"ship_name": "Probe-1"},
                        "player_type": "corporation_ship",
                    },
                    {"id": "char-foe", "player_type": "human"},
                ],
            },
        }

    @staticmethod
    def _agent_with_context(*, character_id: str = "ship-pseudo-char"):
        agent = _make_task_agent(character_id=character_id, is_corp_ship=True)
        agent._active_task_id = "task-uuid-1"
        # Phase 1: outbound bus RPCs need a known broker target.
        agent._task_requester = "orchestrator"
        agent._llm_context = MagicMock()
        # Default: an authored 'offensive' doctrine. Individual tests
        # override to exercise the unset → default-balanced fallback.
        agent._game_client.combat_get_strategy = AsyncMock(
            return_value={
                "strategy": {
                    "template": "offensive",
                    "custom_prompt": "Prefer alpha strikes.",
                }
            }
        )
        return agent

    async def test_round1_injects_combat_md_then_doctrine_then_event(self):
        agent = self._agent_with_context()
        await agent._handle_event(self._round_waiting(round_num=1))

        contents = [
            call.args[0]["content"] for call in agent._llm_context.add_message.call_args_list
        ]
        # Three messages, in fixed order.
        assert len(contents) == 3
        assert contents[0].startswith("# Combat reference")
        assert contents[1].startswith("# Your ship's combat strategy")
        assert "<event name=combat.round_waiting>" in contents[2]
        # Strategy fetched for the agent's own ship_id.
        agent._game_client.combat_get_strategy.assert_awaited_once_with(
            ship_id="ship-probe", character_id="ship-pseudo-char"
        )
        # Custom prompt rendered into the doctrine block.
        assert "Prefer alpha strikes." in contents[1]

    async def test_combat_md_loaded_only_once_per_agent(self):
        agent = self._agent_with_context()
        await agent._handle_event(self._round_waiting(round_num=1))
        # Wipe the call log to make the second-combat assertion clean.
        agent._llm_context.add_message.reset_mock()

        # Second combat in the same agent lifetime — combat.md is silent
        # but doctrine still re-fetches (strategy may have been edited).
        await agent._handle_event(self._round_waiting(round_num=1))
        contents = [
            call.args[0]["content"] for call in agent._llm_context.add_message.call_args_list
        ]
        assert len(contents) == 2
        assert contents[0].startswith("# Your ship's combat strategy")
        assert "<event name=combat.round_waiting>" in contents[1]
        assert agent._game_client.combat_get_strategy.await_count == 2

    async def test_round2_does_not_inject_preamble(self):
        agent = self._agent_with_context()
        await agent._handle_event(self._round_waiting(round_num=2))

        contents = [
            call.args[0]["content"] for call in agent._llm_context.add_message.call_args_list
        ]
        # Only the event XML — no preamble pieces.
        assert len(contents) == 1
        assert "<event name=combat.round_waiting>" in contents[0]
        agent._game_client.combat_get_strategy.assert_not_awaited()

    async def test_observer_does_not_inject_preamble(self):
        # This agent's character is NOT a participant — the corp ship in
        # the fight belongs to a different agent. Preamble is per-ship,
        # so this agent stays silent.
        agent = self._agent_with_context(character_id="other-ship-pseudo")
        await agent._handle_event(self._round_waiting(round_num=1))

        contents = [
            call.args[0]["content"] for call in agent._llm_context.add_message.call_args_list
        ]
        assert len(contents) == 1
        assert "<event name=combat.round_waiting>" in contents[0]
        agent._game_client.combat_get_strategy.assert_not_awaited()

    async def test_unset_strategy_falls_back_to_balanced_default(self):
        agent = self._agent_with_context()
        agent._game_client.combat_get_strategy = AsyncMock(return_value={"strategy": None})
        await agent._handle_event(self._round_waiting(round_num=1))

        contents = [
            call.args[0]["content"] for call in agent._llm_context.add_message.call_args_list
        ]
        assert len(contents) == 3
        doctrine_msg = contents[1]
        assert doctrine_msg.startswith("# Your ship's combat strategy")
        assert "default 'balanced' combat strategy" in doctrine_msg

    async def test_strategy_fetch_failure_skips_doctrine_but_keeps_combat_md(self):
        agent = self._agent_with_context()
        agent._game_client.combat_get_strategy = AsyncMock(side_effect=RuntimeError("network down"))
        await agent._handle_event(self._round_waiting(round_num=1))

        contents = [
            call.args[0]["content"] for call in agent._llm_context.add_message.call_args_list
        ]
        # combat.md still landed; doctrine got skipped; event still appended.
        # combat.md is now considered loaded — failed strategy fetch should
        # not force re-loading the mechanics reference next combat.
        assert len(contents) == 2
        assert contents[0].startswith("# Combat reference")
        assert "<event name=combat.round_waiting>" in contents[1]
        assert agent._combat_md_loaded is True
