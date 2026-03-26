"""Tests for the TaskAgent."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from gradientbang.pipecat_server.subagents.task_agent import (
    ASYNC_TOOL_COMPLETIONS,
    PLAYER_ONLY_TOOLS,
    TaskAgent,
    _SPECIAL_HANDLERS,
)
from gradientbang.subagents.bus import BusTaskCancelMessage
from gradientbang.tools import TASK_TOOLS


def _make_task_agent(**overrides):
    """Create a TaskAgent with mock dependencies."""
    bus = MagicMock()
    bus.send = AsyncMock()
    kwargs = {
        "bus": bus,
        "game_client": MagicMock(),
        "character_id": "char-123",
    }
    kwargs.update(overrides)
    return TaskAgent("test_task", **kwargs)


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
        agent._consecutive_error_count = 5
        agent._step_counter = 42
        agent._reset_task_state()
        assert agent._active_task_id is None
        assert agent._task_finished is False
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
