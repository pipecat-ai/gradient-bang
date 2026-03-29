"""Tests for the TaskAgent."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pipecat.frames.frames import LLMRunFrame
from pipecat.services.llm_service import FunctionCallParams

from gradientbang.pipecat_server.subagents.task_agent import (
    ASYNC_TOOL_COMPLETIONS,
    PLAYER_ONLY_TOOLS,
    TaskAgent,
    _SPECIAL_HANDLERS,
)
from gradientbang.subagents.agents import TaskStatus
from gradientbang.subagents.bus import (
    BusTaskCancelMessage,
    BusTaskRequestMessage,
    BusTaskUpdateMessage,
)
from gradientbang.tools import TASK_TOOLS
from gradientbang.utils.prompt_loader import TaskOutputType
from gradientbang.utils.summary_formatters import event_query_summary


def _make_task_agent(**overrides):
    """Create a TaskAgent with mock dependencies."""
    bus = MagicMock()
    bus.send = AsyncMock()
    game_client = MagicMock()
    game_client.current_task_id = None
    kwargs = {
        "bus": bus,
        "game_client": game_client,
        "character_id": "char-123",
    }
    kwargs.update(overrides)
    return TaskAgent("test_task", **kwargs)


def _make_function_call_params(function_name: str, arguments: dict | None = None):
    params = MagicMock(spec=FunctionCallParams)
    params.function_name = function_name
    params.arguments = arguments or {}
    params.result_callback = AsyncMock()
    return params


EXPECTED_TASK_TOOL_NAMES = {t.name for t in TASK_TOOLS.standard_tools}


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

    def test_excludes_combat_tools(self):
        tool_names = {t.name for t in TASK_TOOLS.standard_tools}
        assert "combat_initiate" not in tool_names
        assert "combat_action" not in tool_names

    def test_excludes_meta_task_tools(self):
        tool_names = {t.name for t in TASK_TOOLS.standard_tools}
        for name in ("start_task", "stop_task", "steer_task", "query_task_progress"):
            assert name not in tool_names

    def test_no_combat_in_async_completions(self):
        assert "combat_initiate" not in ASYNC_TOOL_COMPLETIONS
        assert "combat_action" not in ASYNC_TOOL_COMPLETIONS

    @patch("gradientbang.pipecat_server.subagents.task_agent.create_llm_service")
    @patch("gradientbang.pipecat_server.subagents.task_agent.get_task_agent_llm_config")
    def test_create_llm_registers_catch_all(self, _mock_config, mock_create):
        mock_llm = MagicMock()
        mock_create.return_value = mock_llm
        agent = _make_task_agent()
        agent.create_llm()
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
            assert name in all_tool_names, f"PLAYER_ONLY_TOOLS has '{name}' which is not in TASK_TOOLS"


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
        from gradientbang.pipecat_server.subagents.bus_messages import BusGameEventMessage

        agent = _make_task_agent()
        agent._active_task_id = "task-uuid-123"
        agent._handle_event = AsyncMock()

        msg = BusGameEventMessage(
            source="player",
            event={"event_name": "trade.executed", "task_id": "task-uuid-123", "payload": {}},
        )
        await agent.on_bus_message(msg)
        agent._handle_event.assert_called_once()

    async def test_ignores_event_for_other_task(self):
        from gradientbang.pipecat_server.subagents.bus_messages import BusGameEventMessage

        agent = _make_task_agent()
        agent._active_task_id = "task-uuid-123"
        agent._handle_event = AsyncMock()

        msg = BusGameEventMessage(
            source="player",
            event={"event_name": "trade.executed", "task_id": "other-task", "payload": {}},
        )
        await agent.on_bus_message(msg)
        agent._handle_event.assert_not_called()

    async def test_processes_event_matching_character_id(self):
        from gradientbang.pipecat_server.subagents.bus_messages import BusGameEventMessage

        agent = _make_task_agent(character_id="ship-456")
        agent._active_task_id = "task-uuid-123"
        agent._handle_event = AsyncMock()

        msg = BusGameEventMessage(
            source="player",
            event={"event_name": "status.snapshot", "payload": {"player": {"id": "ship-456"}}},
        )
        await agent.on_bus_message(msg)
        agent._handle_event.assert_called_once()

    async def test_ignores_when_no_active_task(self):
        from gradientbang.pipecat_server.subagents.bus_messages import BusGameEventMessage

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
        from gradientbang.pipecat_server.subagents.bus_messages import BusGameEventMessage

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
        agent._handle_event.assert_called_once()

    async def test_ignores_unmatched_event_query_request_id(self):
        from gradientbang.pipecat_server.subagents.bus_messages import BusGameEventMessage

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
        agent._handle_event.assert_not_called()

    async def test_bus_event_query_uses_summary_not_raw_payload(self):
        from gradientbang.pipecat_server.subagents.bus_messages import BusGameEventMessage

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

        context_message = agent._llm_context.add_message.call_args.args[0]["content"]
        assert "Query returned 8 events." in context_message
        assert "blob" not in context_message

@pytest.mark.unit
class TestSteering:
    async def test_steering_injected_into_context(self):
        from gradientbang.pipecat_server.subagents.bus_messages import BusSteerTaskMessage

        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._llm_context = MagicMock()
        agent._llm_inflight = True

        msg = BusSteerTaskMessage(source="voice", target="test_task", task_id="task-1", text="Change direction")
        await agent.on_bus_message(msg)

        agent._llm_context.add_message.assert_called_once()
        assert "Change direction" in agent._llm_context.add_message.call_args[0][0]["content"]


@pytest.mark.unit
class TestCancellation:
    async def test_sets_cancelled_flag(self):
        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._game_client.task_lifecycle = AsyncMock()
        agent.send_task_response = AsyncMock()
        agent._task_id = "task-1"
        agent._task_requester = "parent"
        await agent.on_task_cancelled(BusTaskCancelMessage(source="parent", task_id="task-1", reason="test reason"))
        assert agent._cancelled is True


@pytest.mark.unit
class TestTaskIdTagging:
    async def test_player_task_request_does_not_set_shared_client_task_id(self):
        agent = _make_task_agent(tag_outbound_rpcs_with_task_id=False)
        agent._llm_context = MagicMock()
        agent.queue_frame = AsyncMock()
        agent._game_client.task_lifecycle = AsyncMock()
        agent._game_client.current_task_id = "shared-task"

        await agent.on_task_request(
            BusTaskRequestMessage(
                source="voice",
                task_id="task-1",
                payload={"task_description": "Check status"},
            )
        )

        assert agent._game_client.current_task_id == "shared-task"

    async def test_corp_task_request_sets_task_id_on_dedicated_client(self):
        agent = _make_task_agent(tag_outbound_rpcs_with_task_id=True)
        agent._llm_context = MagicMock()
        agent.queue_frame = AsyncMock()
        agent._game_client.task_lifecycle = AsyncMock()

        await agent.on_task_request(
            BusTaskRequestMessage(
                source="voice",
                task_id="task-1",
                payload={"task_description": "Check corp status"},
            )
        )

        assert agent._game_client.current_task_id == "task-1"

    async def test_player_task_completion_does_not_clear_unrelated_shared_client_task_id(self):
        agent = _make_task_agent(tag_outbound_rpcs_with_task_id=False)
        agent._active_task_id = "task-1"
        agent._task_finished_status = "completed"
        agent._task_finished_message = "Done"
        agent.send_task_response = AsyncMock()
        agent._game_client.current_task_id = "shared-task"

        await agent._complete_task()

        assert agent._game_client.current_task_id == "shared-task"

    async def test_player_task_cancel_does_not_clear_unrelated_shared_client_task_id(self):
        agent = _make_task_agent(tag_outbound_rpcs_with_task_id=False)
        agent._active_task_id = "task-1"
        agent._game_client.task_lifecycle = AsyncMock()
        agent.send_task_response = AsyncMock()
        agent._task_id = "task-1"
        agent._task_requester = "parent"
        agent._game_client.current_task_id = "shared-task"

        await agent.on_task_cancelled(
            BusTaskCancelMessage(source="parent", task_id="task-1", reason="test reason")
        )

        assert agent._game_client.current_task_id == "shared-task"

    async def test_corp_task_completion_clears_matching_task_id(self):
        agent = _make_task_agent(tag_outbound_rpcs_with_task_id=True)
        agent._active_task_id = "task-1"
        agent._task_finished_status = "completed"
        agent._task_finished_message = "Done"
        agent.send_task_response = AsyncMock()
        agent._game_client.current_task_id = "task-1"

        await agent._complete_task()

        assert agent._game_client.current_task_id is None

    async def test_corp_task_completion_keeps_other_client_task_id(self):
        agent = _make_task_agent(tag_outbound_rpcs_with_task_id=True)
        agent._active_task_id = "task-1"
        agent._task_finished_status = "completed"
        agent._task_finished_message = "Done"
        agent.send_task_response = AsyncMock()
        agent._game_client.current_task_id = "other-task"

        await agent._complete_task()

        assert agent._game_client.current_task_id == "other-task"


@pytest.mark.unit
class TestTaskOutputDelivery:
    async def test_action_output_uses_captured_task_route(self):
        agent = _make_task_agent()
        agent._task_id = "framework-task"
        agent._task_requester = "voice_agent"
        agent.send_message = AsyncMock()

        agent._output("move({\"to_sector\": 5})", TaskOutputType.ACTION)
        agent._task_id = None
        agent._task_requester = None

        await agent._drain_pending_task_outputs()

        agent.send_message.assert_awaited_once()
        message = agent.send_message.call_args.args[0]
        assert isinstance(message, BusTaskUpdateMessage)
        assert message.task_id == "framework-task"
        assert message.target == "voice_agent"
        assert message.update == {
            "type": "output",
            "text": 'move({"to_sector": 5})',
            "message_type": "action",
        }

    async def test_complete_task_drains_pending_output_before_response(self):
        agent = _make_task_agent()
        agent._task_id = "framework-task"
        agent._task_requester = "voice_agent"
        agent._active_task_id = "task-1"
        agent._task_finished_status = "completed"
        agent._task_finished_message = "Done"
        call_order = []

        async def _send_message(message):
            call_order.append(("update", message.update["message_type"]))

        async def _send_task_response(*, response, status):
            call_order.append(("response", response["message"]))

        agent.send_message = AsyncMock(side_effect=_send_message)
        agent.send_task_response = AsyncMock(side_effect=_send_task_response)

        agent._output("my_status({})", TaskOutputType.ACTION)
        await agent._complete_task()

        assert call_order == [("update", "action"), ("response", "Done")]

    async def test_task_output_delivery_failure_is_logged_and_completion_continues(self):
        agent = _make_task_agent()
        agent._task_id = "framework-task"
        agent._task_requester = "voice_agent"
        agent._active_task_id = "task-1"
        agent._task_finished_status = "completed"
        agent._task_finished_message = "Done"
        agent.send_message = AsyncMock(side_effect=RuntimeError("boom"))
        agent.send_task_response = AsyncMock()

        agent._output("my_status({})", TaskOutputType.ACTION)

        with patch("gradientbang.pipecat_server.subagents.task_agent.logger.warning") as warn:
            await agent._complete_task()

        warn.assert_called()
        agent.send_task_response.assert_awaited_once()


@pytest.mark.unit
class TestSyntheticProgressMessages:
    async def test_task_start_does_not_emit_initial_progress_message(self):
        agent = _make_task_agent()
        agent._llm_context = MagicMock()
        agent.queue_frame = AsyncMock()
        agent._game_client.task_lifecycle = AsyncMock()

        await agent.on_task_request(
            BusTaskRequestMessage(
                source="voice",
                task_id="task-1",
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

    async def test_generic_event_completion_emits_reviewing_results_message(self):
        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent.queue_frame = AsyncMock()
        agent._record_inference_reason("movement.complete")

        await agent._schedule_pending_inference()

        assert agent.get_task_log()[-1] == "Reviewing latest results..."
        agent.queue_frame.assert_awaited_once()

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
        agent._task_id = "framework-task"
        agent._task_requester = "voice_agent"
        params = _make_function_call_params(
            "event_query",
            {"start": "2026-03-27T00:00:00Z", "end": "2026-03-28T00:00:00Z"},
        )
        handler = AsyncMock(return_value={"request_id": "req-123", "count": 0})

        with patch.object(agent, "_get_tool_handler", return_value=handler), patch.object(
            agent, "_on_tool_call_completed", AsyncMock()
        ):
            await agent._handle_function_call(params)

        assert agent._awaiting_completion_event == "event.query"
        assert agent._awaiting_completion_request_id == "req-123"
        agent._clear_awaited_completion()

    async def test_event_query_without_request_id_clears_await(self):
        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._task_id = "framework-task"
        agent._task_requester = "voice_agent"
        params = _make_function_call_params(
            "event_query",
            {"start": "2026-03-27T00:00:00Z", "end": "2026-03-28T00:00:00Z"},
        )
        handler = AsyncMock(return_value={"count": 0})

        with patch.object(agent, "_get_tool_handler", return_value=handler), patch.object(
            agent, "_on_tool_call_completed", AsyncMock()
        ), patch("gradientbang.pipecat_server.subagents.task_agent.logger.warning") as warn:
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

        with patch("gradientbang.pipecat_server.subagents.task_agent.logger.warning") as warn:
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
        agent._task_id = "framework-task"
        agent._task_requester = "voice_agent"
        agent._active_task_id = "task-1"
        agent._game_client.task_lifecycle = AsyncMock()
        agent.send_message = AsyncMock()
        agent.send_task_response = AsyncMock()

        await agent.on_error(
            "Error during completion: context_length_exceeded: input too long",
            fatal=False,
        )

        agent.send_task_response.assert_awaited_once()
        assert agent.send_task_response.call_args.kwargs["status"] == TaskStatus.FAILED
        assert (
            agent.send_task_response.call_args.kwargs["response"]["message"]
            == "Task stopped because the event query returned too much history "
            "to process at once. Narrow the time range or query a specific "
            "task or event type."
        )
        agent._game_client.task_lifecycle.assert_awaited_once()
        assert agent._active_task_id is None

    async def test_on_error_is_idempotent(self):
        agent = _make_task_agent()
        agent._active_task_id = "task-1"
        agent._game_client.task_lifecycle = AsyncMock()
        agent.send_task_response = AsyncMock()

        await agent.on_error("generic pipeline failure", fatal=False)
        await agent.on_error("generic pipeline failure", fatal=False)

        agent.send_task_response.assert_awaited_once()
        agent._game_client.task_lifecycle.assert_awaited_once()
