"""Integration tests: real TaskAgent with mocked external boundaries.

Verifies task lifecycle, tool dispatch, async completion events, bus event
filtering, steering, cancellation, error accumulation, and corp ship
restrictions. External boundaries (game_client, bus, LLM pipeline) are mocked.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.services.llm_service import FunctionCallParams

from gradientbang.pipecat_server.subagents.bus_messages import (
    BusGameEventMessage,
    BusSteerTaskMessage,
)
from gradientbang.pipecat_server.subagents.task_agent import (
    ASYNC_TOOL_COMPLETIONS,
    PLAYER_ONLY_TOOLS,
    SYNC_TOOL_EVENTS,
    TaskAgent,
)
from gradientbang.subagents.bus import BusTaskCancelMessage, BusTaskRequestMessage


# ── Harness ───────────────────────────────────────────────────────────────


class TaskAgentHarness:
    """Wire a real TaskAgent with mocked external boundaries."""

    def __init__(self, character_id="char-test", is_corp_ship=False):
        self.character_id = character_id

        # Mock game client
        self.game_client = MagicMock()
        self.game_client.task_lifecycle = AsyncMock()
        self.game_client.current_task_id = None
        # Default: game methods return {"status": "Executed."}
        for method in (
            "move", "plot_course", "my_map", "my_status", "trade",
            "list_known_ports", "salvage_collect", "recharge_warp_power",
            "purchase_fighters", "local_map_region", "path_with_region",
            "transfer_warp_power", "transfer_credits", "deposit_to_bank",
            "withdraw_from_bank", "combat_leave_fighters", "combat_collect_fighters",
            "create_corporation", "leave_corporation", "kick_corporation_member",
            "purchase_ship", "sell_ship", "event_query", "leaderboard_resources",
            "dump_cargo",
        ):
            getattr(self.game_client, method).return_value = {"status": "Executed."}

        bus = MagicMock()
        bus.send_message = AsyncMock()

        self.agent = TaskAgent(
            "test_task",
            bus=bus,
            game_client=self.game_client,
            character_id=character_id,
            is_corp_ship=is_corp_ship,
        )

        # Set up LLM context manually (normally done in build_pipeline)
        self.agent._llm_context = LLMContext(messages=[], tools=ToolsSchema(self.agent.build_tools()))

        # Capture inference scheduling
        self.queued_frames = []
        self.agent.queue_frame = AsyncMock(side_effect=lambda f: self.queued_frames.append(f))
        self.agent.send_task_update = AsyncMock()
        self.agent.send_task_response = AsyncMock()

    async def start_task(self, task_id="task-001", description="Test task"):
        """Simulate receiving a task request."""
        self.agent._task_id = task_id
        self.agent._task_requester = "voice_agent"
        await self.agent.on_task_request(
            BusTaskRequestMessage(
                source="voice_agent",
                task_id=task_id,
                payload={"task_description": description},
            )
        )

    def make_function_call_params(self, tool_name: str, arguments: dict) -> FunctionCallParams:
        """Create a FunctionCallParams with a mock result callback."""
        params = MagicMock(spec=FunctionCallParams)
        params.function_name = tool_name
        params.arguments = arguments
        params.result_callback = AsyncMock()
        return params

    async def send_game_event(self, event_name: str, payload: dict = None, task_id: str = None):
        """Send a game event through the bus."""
        event = {"event_name": event_name, "payload": payload or {}}
        if task_id:
            event["task_id"] = task_id
        msg = BusGameEventMessage(source="relay", event=event)
        await self.agent.on_bus_message(msg)

    async def send_steering(self, text: str, task_id: str = "task-001"):
        """Send a steering instruction through the bus."""
        msg = BusSteerTaskMessage(
            source="voice", target="test_task", task_id=task_id, text=text,
        )
        await self.agent.on_bus_message(msg)


# ── Tests ─────────────────────────────────────────────────────────────────


@pytest.mark.unit
class TestTaskLifecycle:
    async def test_task_request_sets_up_context_and_triggers_inference(self):
        h = TaskAgentHarness()
        await h.start_task(task_id="task-abc", description="Go trade at sector 5")

        # Context should have system + user messages
        messages = h.agent._llm_context.get_messages()
        assert len(messages) == 2
        assert messages[0]["role"] == "system"
        assert messages[1]["role"] == "user"
        assert "Go trade at sector 5" in messages[1]["content"]

        # First inference triggered
        assert len(h.queued_frames) > 0

        # Game client notified of task start
        h.game_client.task_lifecycle.assert_called_once()
        call_kwargs = h.game_client.task_lifecycle.call_args[1]
        assert call_kwargs["task_id"] == "task-abc"
        assert call_kwargs["event_type"] == "start"

    async def test_task_request_sets_game_client_task_id(self):
        h = TaskAgentHarness()
        await h.start_task(task_id="task-xyz")
        assert h.game_client.current_task_id == "task-xyz"


@pytest.mark.unit
class TestAsyncToolCompletion:
    async def test_tool_defers_inference_until_completion_event(self):
        h = TaskAgentHarness()
        await h.start_task()
        h.agent._llm_inflight = False
        h.queued_frames.clear()

        # Call list_known_ports (async tool expecting "ports.list" event)
        params = h.make_function_call_params("list_known_ports", {})
        await h.agent._handle_function_call(params)

        # Tool was executed
        h.game_client.list_known_ports.assert_called_once()

        # Result callback was called with run_llm=False
        params.result_callback.assert_called_once()

        # Should be awaiting completion event
        assert h.agent._awaiting_completion_event == "ports.list"

    async def test_completion_event_clears_await_and_triggers_inference(self):
        h = TaskAgentHarness()
        await h.start_task()
        h.agent._llm_inflight = False
        h.queued_frames.clear()

        # Execute async tool
        params = h.make_function_call_params("list_known_ports", {})
        await h.agent._handle_function_call(params)
        assert h.agent._awaiting_completion_event == "ports.list"

        # Send the completion event
        await h.send_game_event("ports.list", {"ports": [1, 2, 3]}, task_id="task-001")

        # Await cleared
        assert h.agent._awaiting_completion_event is None

        # Event should be in LLM context
        messages = h.agent._llm_context.get_messages()
        event_messages = [m for m in messages if "<event name=ports.list>" in m.get("content", "")]
        assert len(event_messages) == 1

    async def test_move_defers_until_movement_complete(self):
        h = TaskAgentHarness()
        await h.start_task()
        h.agent._llm_inflight = False

        params = h.make_function_call_params("move", {"to_sector": 5})
        await h.agent._handle_function_call(params)

        h.game_client.move.assert_called_once_with(character_id="char-test", to_sector=5)
        assert h.agent._awaiting_completion_event == "movement.complete"


@pytest.mark.unit
class TestSyncToolEventSkipping:
    async def test_sync_tool_event_not_added_to_context(self):
        h = TaskAgentHarness()
        await h.start_task()
        h.agent._llm_inflight = False

        # plot_course is in SYNC_TOOL_EVENTS: its "course.plot" event should be skipped
        params = h.make_function_call_params("plot_course", {"to_sector": 10})
        await h.agent._handle_function_call(params)

        msg_count_before = len(h.agent._llm_context.get_messages())

        # Send the course.plot event
        await h.send_game_event("course.plot", {"path": [1, 5, 10]}, task_id="task-001")

        # Event should NOT have been added to context (skip count was set)
        msg_count_after = len(h.agent._llm_context.get_messages())
        assert msg_count_after == msg_count_before


@pytest.mark.unit
class TestCorpShipRestriction:
    async def test_corp_ship_tool_returns_error(self):
        h = TaskAgentHarness(is_corp_ship=True)
        await h.start_task()
        h.agent._llm_inflight = False

        params = h.make_function_call_params("bank_withdraw", {"amount": 100})
        await h.agent._handle_function_call(params)

        # Should have returned error, not called game client
        h.game_client.withdraw_from_bank.assert_not_called()
        result = params.result_callback.call_args[0][0]
        assert "error" in result
        assert "corporation ships" in result["error"]

    async def test_corp_ship_can_use_unrestricted_tools(self):
        h = TaskAgentHarness(is_corp_ship=True)
        await h.start_task()
        h.agent._llm_inflight = False

        params = h.make_function_call_params("move", {"to_sector": 5})
        await h.agent._handle_function_call(params)

        h.game_client.move.assert_called_once()


@pytest.mark.unit
class TestBusEventFiltering:
    async def test_event_with_matching_task_id_processed(self):
        h = TaskAgentHarness()
        await h.start_task(task_id="task-001")
        msg_count_before = len(h.agent._llm_context.get_messages())

        await h.send_game_event("trade.executed", {"profit": 100}, task_id="task-001")

        msg_count_after = len(h.agent._llm_context.get_messages())
        assert msg_count_after > msg_count_before

    async def test_event_with_different_task_id_ignored(self):
        h = TaskAgentHarness()
        await h.start_task(task_id="task-001")
        msg_count_before = len(h.agent._llm_context.get_messages())

        await h.send_game_event("trade.executed", {"profit": 100}, task_id="other-task")

        msg_count_after = len(h.agent._llm_context.get_messages())
        assert msg_count_after == msg_count_before

    async def test_character_event_processed(self):
        h = TaskAgentHarness(character_id="ship-456")
        await h.start_task()
        msg_count_before = len(h.agent._llm_context.get_messages())

        await h.send_game_event(
            "status.snapshot",
            {"player": {"id": "ship-456"}, "sector": 10},
        )

        msg_count_after = len(h.agent._llm_context.get_messages())
        assert msg_count_after > msg_count_before

    async def test_ambient_error_event_processed(self):
        h = TaskAgentHarness()
        await h.start_task()
        msg_count_before = len(h.agent._llm_context.get_messages())

        await h.send_game_event("error", {"message": "Something failed"})

        msg_count_after = len(h.agent._llm_context.get_messages())
        assert msg_count_after > msg_count_before

    async def test_unrelated_event_ignored(self):
        h = TaskAgentHarness()
        await h.start_task()
        msg_count_before = len(h.agent._llm_context.get_messages())

        # No task_id, no matching character_id, not an ambient event
        await h.send_game_event("map.update", {"sector": 99})

        msg_count_after = len(h.agent._llm_context.get_messages())
        assert msg_count_after == msg_count_before


@pytest.mark.unit
class TestSteeringIntegration:
    async def test_steering_adds_to_context_and_records_reason(self):
        h = TaskAgentHarness()
        await h.start_task()
        h.agent._llm_inflight = True
        msg_count_before = len(h.agent._llm_context.get_messages())

        await h.send_steering("Change course to sector 10")

        messages = h.agent._llm_context.get_messages()
        assert len(messages) > msg_count_before
        last_user_msg = [m for m in messages if m["role"] == "user"][-1]
        assert "Change course to sector 10" in last_user_msg["content"]
        assert "steering" in h.agent._inference_reasons

    async def test_steering_for_wrong_task_ignored(self):
        h = TaskAgentHarness()
        await h.start_task(task_id="task-001")
        msg_count_before = len(h.agent._llm_context.get_messages())

        await h.send_steering("Wrong task", task_id="task-other")

        assert len(h.agent._llm_context.get_messages()) == msg_count_before


@pytest.mark.unit
class TestCancellationIntegration:
    async def test_cancellation_emits_finish_and_quenches(self):
        h = TaskAgentHarness()
        await h.start_task(task_id="task-001")
        h.agent._llm_inflight = False

        await h.agent.on_task_cancelled(BusTaskCancelMessage(source="voice_agent", task_id="task-001", reason="User cancelled"))

        assert h.agent._cancelled is True
        # task.finish emitted
        lifecycle_calls = h.game_client.task_lifecycle.call_args_list
        finish_calls = [c for c in lifecycle_calls if c[1].get("event_type") == "finish"]
        assert len(finish_calls) == 1
        assert finish_calls[0][1]["task_status"] == "cancelled"

        # Inference state quenched
        assert h.agent._awaiting_completion_event is None
        assert len(h.agent._inference_reasons) == 0


@pytest.mark.unit
class TestErrorAccumulation:
    async def test_three_consecutive_errors_auto_finish(self):
        h = TaskAgentHarness()
        await h.start_task(task_id="task-001")
        h.agent._llm_inflight = False

        for i in range(3):
            await h.send_game_event("error", {"message": f"Error {i}"}, task_id="task-001")

        assert h.agent._task_finished is True
        assert h.agent._task_finished_status == "failed"

        # send_task_response should have been called with FAILED
        h.agent.send_task_response.assert_called_once()
        call_kwargs = h.agent.send_task_response.call_args[1]
        assert call_kwargs["status"].value == "failed"

    async def test_non_error_event_resets_error_count(self):
        h = TaskAgentHarness()
        await h.start_task(task_id="task-001")
        h.agent._llm_inflight = False

        # Two errors
        await h.send_game_event("error", {"message": "Error 1"}, task_id="task-001")
        await h.send_game_event("error", {"message": "Error 2"}, task_id="task-001")
        assert h.agent._consecutive_error_count == 2

        # A normal event resets the count
        await h.send_game_event("trade.executed", {"profit": 50}, task_id="task-001")
        assert h.agent._consecutive_error_count == 0


@pytest.mark.unit
class TestToolDispatchIntegration:
    """Verify that data-driven dispatch correctly calls game_client methods."""

    async def test_trade_dispatches_correctly(self):
        h = TaskAgentHarness()
        await h.start_task()
        h.agent._llm_inflight = False

        params = h.make_function_call_params(
            "trade", {"commodity": "ore", "quantity": 10, "trade_type": "buy"},
        )
        await h.agent._handle_function_call(params)

        h.game_client.trade.assert_called_once_with(
            character_id="char-test", commodity="ore", quantity=10, trade_type="buy",
        )

    async def test_optional_args_passed_when_present(self):
        h = TaskAgentHarness()
        await h.start_task()
        h.agent._llm_inflight = False

        params = h.make_function_call_params(
            "list_known_ports", {"from_sector": 5, "mega": True},
        )
        await h.agent._handle_function_call(params)

        h.game_client.list_known_ports.assert_called_once_with(
            character_id="char-test", from_sector=5, mega=True,
        )

    async def test_optional_args_omitted_when_absent(self):
        h = TaskAgentHarness()
        await h.start_task()
        h.agent._llm_inflight = False

        params = h.make_function_call_params("list_known_ports", {})
        await h.agent._handle_function_call(params)

        h.game_client.list_known_ports.assert_called_once_with(character_id="char-test")

    async def test_sell_ship_no_confirmation_required(self):
        """TaskAgent is autonomous — sell_ship should execute directly."""
        h = TaskAgentHarness()
        await h.start_task()
        h.agent._llm_inflight = False

        params = h.make_function_call_params("sell_ship", {"ship_id": "ship-99"})
        await h.agent._handle_function_call(params)

        h.game_client.sell_ship.assert_called_once_with(
            character_id="char-test", ship_id="ship-99",
        )
