"""Tests for VoiceAgent framework wiring and task management."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pipecat.services.llm_service import FunctionCallParams

from gradientbang.pipecat_server.subagents.voice_agent import VoiceAgent
from gradientbang.utils.formatting import summarize_corporation_info, summarize_leaderboard


def _make_voice_agent(**overrides):
    """Create a VoiceAgent with mock dependencies."""
    mock_game_client = MagicMock()
    mock_game_client.corporation_id = "corp-1"
    mock_game_client.set_event_polling_scope = MagicMock()

    mock_rtvi = MagicMock()
    mock_rtvi.push_frame = AsyncMock()

    kwargs = {
        "bus": MagicMock(),
        "game_client": mock_game_client,
        "character_id": "char-123",
        "rtvi_processor": mock_rtvi,
    }
    kwargs.update(overrides)
    return VoiceAgent("player", **kwargs)


def _make_function_call_params(
    *,
    function_name: str = "test_tool",
    arguments: dict | None = None,
    result_callback=None,
) -> FunctionCallParams:
    return FunctionCallParams(
        function_name=function_name,
        tool_call_id="tool-call-1",
        arguments=arguments or {},
        llm=MagicMock(),
        context=MagicMock(),
        result_callback=result_callback or AsyncMock(),
    )


EXPECTED_TOOLS = {
    "my_status", "plot_course", "list_known_ports", "rename_ship",
    "rename_corporation", "create_corporation", "corporation_info",
    "leave_corporation",
    "leaderboard_resources", "ship_definitions", "send_message",
    "combat_initiate", "combat_action", "load_game_info",
    "start_task", "stop_task", "steer_task", "query_task_progress",
}


# ── LLM + Tool setup ─────────────────────────────────────────────────


@pytest.mark.unit
class TestLLMSetup:
    @patch("gradientbang.pipecat_server.subagents.voice_agent.create_llm_service")
    @patch("gradientbang.pipecat_server.subagents.voice_agent.get_voice_llm_config")
    def test_build_llm_returns_llm(self, _mock_config, mock_create):
        mock_llm = MagicMock()
        mock_create.return_value = mock_llm
        agent = _make_voice_agent()
        assert agent.build_llm() is mock_llm

    def test_build_tools_returns_expected_schemas(self):
        agent = _make_voice_agent()
        tool_names = {t.name for t in agent.build_tools()}
        assert tool_names == EXPECTED_TOOLS

    @patch("gradientbang.pipecat_server.subagents.voice_agent.create_llm_service")
    @patch("gradientbang.pipecat_server.subagents.voice_agent.get_voice_llm_config")
    def test_build_llm_registers_all_tools(self, _mock_config, mock_create):
        mock_llm = MagicMock()
        mock_create.return_value = mock_llm
        agent = _make_voice_agent()
        agent.build_llm()
        registered = {call.args[0] for call in mock_llm.register_function.call_args_list}
        assert registered == EXPECTED_TOOLS


# ── Request ID + finished task caches ─────────────────────────────────


@pytest.mark.unit
class TestRequestIdTracking:
    def test_track_and_check(self):
        agent = _make_voice_agent()
        agent.track_request_id("req-1")
        assert agent.is_recent_request_id("req-1") is True

    def test_unknown_returns_false(self):
        agent = _make_voice_agent()
        assert agent.is_recent_request_id("unknown") is False

    def test_empty_ignored(self):
        agent = _make_voice_agent()
        agent.track_request_id("")
        agent.track_request_id(None)
        assert agent.is_recent_request_id("") is False

    def test_track_from_result(self):
        agent = _make_voice_agent()
        agent._track_request_id_from_result({"request_id": "req-2"})
        assert agent.is_recent_request_id("req-2") is True


# ── Framework-based task queries ──────────────────────────────────────


@pytest.mark.unit
class TestFrameworkTaskQueries:
    def test_is_our_task(self):
        from gradientbang.subagents.agents.base_agent import TaskGroup

        agent = _make_voice_agent()
        agent._task_groups = {"tid-1": TaskGroup(task_id="tid-1", agent_names={"task_abc"})}
        assert agent.is_our_task("tid-1") is True
        assert agent.is_our_task("tid-unknown") is False

    def test_find_task_agent_by_task_id(self):
        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent
        from gradientbang.subagents.agents.base_agent import TaskGroup

        agent = _make_voice_agent()
        mock_child = MagicMock(spec=TaskAgent)
        mock_child.name = "task_abc123"
        agent._children = [mock_child]
        full_id = "ff3fa419-1234-5678-9abc-def012345678"
        agent._task_groups = {
            full_id: TaskGroup(task_id=full_id, agent_names={"task_abc123"})
        }

        # Full UUID
        assert agent._find_task_agent_by_task_id(full_id) == (full_id, mock_child)
        # 8-char short prefix (what the LLM commonly receives in events)
        assert agent._find_task_agent_by_task_id("ff3fa419") == (full_id, mock_child)
        # Even shorter prefix
        assert agent._find_task_agent_by_task_id("ff") == (full_id, mock_child)
        # Negatives
        assert agent._find_task_agent_by_task_id("deadbeef") is None
        assert agent._find_task_agent_by_task_id("") is None
        assert agent._find_task_agent_by_task_id("   ") is None

    def test_find_task_agent_by_task_id_prefers_exact_match(self):
        """When two tasks share a prefix, exact match wins over prefix match."""
        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent
        from gradientbang.subagents.agents.base_agent import TaskGroup

        agent = _make_voice_agent()
        c1 = MagicMock(spec=TaskAgent)
        c1.name = "task_aaa"
        c2 = MagicMock(spec=TaskAgent)
        c2.name = "task_bbb"
        agent._children = [c1, c2]
        agent._task_groups = {
            "ff": TaskGroup(task_id="ff", agent_names={"task_aaa"}),
            "ff3fa419": TaskGroup(task_id="ff3fa419", agent_names={"task_bbb"}),
        }
        # Exact match on the short id resolves to its child, not the longer one.
        assert agent._find_task_agent_by_task_id("ff") == ("ff", c1)
        # Prefix-only resolves to the matching longer id.
        assert agent._find_task_agent_by_task_id("ff3fa") == ("ff3fa419", c2)

    def test_count_active_corp_tasks(self):
        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent

        agent = _make_voice_agent()
        corp = MagicMock(spec=TaskAgent)
        corp._is_corp_ship = True
        player = MagicMock(spec=TaskAgent)
        player._is_corp_ship = False
        agent._children = [corp, player]
        assert agent._count_active_corp_tasks() == 1

    def test_update_polling_scope(self):
        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent

        agent = _make_voice_agent()
        corp = MagicMock(spec=TaskAgent)
        corp._is_corp_ship = True
        corp._character_id = "ship-1"
        agent._children = [corp]
        agent._update_polling_scope()
        agent._game_client.set_event_polling_scope.assert_called_once_with(
            character_ids=["char-123"], corp_id="corp-1", ship_ids=["ship-1"],
        )

    def test_update_polling_scope_no_children(self):
        agent = _make_voice_agent()
        agent._children = []
        agent._update_polling_scope()
        agent._game_client.set_event_polling_scope.assert_called_once_with(
            character_ids=["char-123"], corp_id="corp-1", ship_ids=[],
        )


# ── Deferred event batching ──────────────────────────────────────────


@pytest.mark.unit
class TestDeferredEventBatching:
    def test_tool_call_active_property(self):
        agent = _make_voice_agent()
        assert agent.tool_call_active is False
        agent._tool_call_inflight = 1
        assert agent.tool_call_active is True

    async def test_defers_when_tool_active(self):
        from pipecat.frames.frames import LLMMessagesAppendFrame

        agent = _make_voice_agent()
        agent._tool_call_inflight = 1
        frame = LLMMessagesAppendFrame(
            messages=[{"role": "user", "content": "<event>test</event>"}], run_llm=True,
        )
        await agent.queue_frame(frame)
        assert len(agent._deferred_frames) == 1

    async def test_flush_deferred(self):
        """Deferred frames keep one coalesced LLMRunFrame when needed."""
        from pipecat.frames.frames import LLMMessagesAppendFrame, LLMRunFrame
        from pipecat.processors.frame_processor import FrameDirection

        agent = _make_voice_agent()
        frames = [
            (LLMMessagesAppendFrame(messages=[{"role": "user", "content": "a"}], run_llm=True), FrameDirection.DOWNSTREAM),
            (LLMMessagesAppendFrame(messages=[{"role": "user", "content": "b"}], run_llm=False), FrameDirection.DOWNSTREAM),
        ]
        result = await agent.process_deferred_tool_frames(frames)
        appends = [f for f, _ in result if isinstance(f, LLMMessagesAppendFrame)]
        runs = [f for f, _ in result if isinstance(f, LLMRunFrame)]
        assert len(appends) == 2
        assert len(runs) == 1

    async def test_flush_coalesces_run_llm(self):
        """Multiple deferred run_llm=True frames produce one coalesced run."""
        from pipecat.frames.frames import LLMMessagesAppendFrame, LLMRunFrame
        from pipecat.processors.frame_processor import FrameDirection

        agent = _make_voice_agent()
        frames = [
            (LLMMessagesAppendFrame(messages=[{"role": "user", "content": c}], run_llm=True), FrameDirection.DOWNSTREAM)
            for c in ("event_a", "event_b", "event_c")
        ]
        result = await agent.process_deferred_tool_frames(frames)

        appends = [f for f, _ in result if isinstance(f, LLMMessagesAppendFrame)]
        runs = [f for f, _ in result if isinstance(f, LLMRunFrame)]
        assert all(f.run_llm is False for f in appends)
        assert len(runs) == 1
        assert [f.messages[0]["content"] for f in appends] == ["event_a", "event_b", "event_c"]

    async def test_flush_single_frame_adds_one_run(self):
        """A single deferred run_llm=True frame becomes one append plus one run."""
        from pipecat.frames.frames import LLMMessagesAppendFrame, LLMRunFrame
        from pipecat.processors.frame_processor import FrameDirection

        agent = _make_voice_agent()
        frames = [
            (LLMMessagesAppendFrame(messages=[{"role": "user", "content": "only"}], run_llm=True), FrameDirection.DOWNSTREAM)
        ]
        result = await agent.process_deferred_tool_frames(frames)

        appends = [f for f, _ in result if isinstance(f, LLMMessagesAppendFrame)]
        runs = [f for f, _ in result if isinstance(f, LLMRunFrame)]
        assert len(appends) == 1
        assert appends[0].run_llm is False
        assert len(runs) == 1

    async def test_flush_no_run_llm_skips_run_frame(self):
        """Deferred frames with run_llm=False don't produce an LLMRunFrame."""
        from pipecat.frames.frames import LLMMessagesAppendFrame, LLMRunFrame
        from pipecat.processors.frame_processor import FrameDirection

        agent = _make_voice_agent()
        frames = [
            (LLMMessagesAppendFrame(messages=[{"role": "user", "content": "a"}], run_llm=False), FrameDirection.DOWNSTREAM)
        ]
        result = await agent.process_deferred_tool_frames(frames)

        appends = [f for f, _ in result if isinstance(f, LLMMessagesAppendFrame)]
        runs = [f for f, _ in result if isinstance(f, LLMRunFrame)]
        assert len(appends) == 1
        assert not any(isinstance(f, LLMRunFrame) for f in runs)

    async def test_concurrent_inject_context_coalesces_to_one_run(self):
        """N deferred run_llm=True frames -> 1 coalesced LLMRunFrame.

        Deferred events are appended with run_llm stripped, then the voice agent
        runs once on the flushed real data.
        """
        from pipecat.frames.frames import LLMMessagesAppendFrame, LLMRunFrame
        from pipecat.processors.frame_processor import FrameDirection

        agent = _make_voice_agent()
        frames = [
            (LLMMessagesAppendFrame(messages=[{"role": "user", "content": f"task{i}"}], run_llm=True), FrameDirection.DOWNSTREAM)
            for i in range(3)
        ]
        result = await agent.process_deferred_tool_frames(frames)

        appends = [f for f, _ in result if isinstance(f, LLMMessagesAppendFrame)]
        runs = [f for f, _ in result if isinstance(f, LLMRunFrame)]
        assert len(appends) == 3
        assert all(f.run_llm is False for f in appends)
        assert len(runs) == 1, f"Expected 1 LLMRunFrame but got {len(runs)}"

    async def test_queue_frame_after_tools_coalesces_mixed_sources(self):
        """Mixed deferred frames still collapse to one follow-up run.

        Verifies silent append when frames come from different sources (EventRelay +
        bus protocol) but are both deferred during a tool call.
        """
        from pipecat.frames.frames import LLMMessagesAppendFrame, LLMRunFrame
        from pipecat.processors.frame_processor import FrameDirection

        agent = _make_voice_agent()
        frames = [
            (LLMMessagesAppendFrame(messages=[{"role": "user", "content": "<event name=\"status.snapshot\">...</event>"}], run_llm=True), FrameDirection.DOWNSTREAM),
            (LLMMessagesAppendFrame(messages=[{"role": "user", "content": "<event name=\"task.completed\">...</event>"}], run_llm=True), FrameDirection.DOWNSTREAM),
        ]
        result = await agent.process_deferred_tool_frames(frames)

        appends = [f for f, _ in result if isinstance(f, LLMMessagesAppendFrame)]
        runs = [f for f, _ in result if isinstance(f, LLMRunFrame)]
        assert len(appends) == 2
        assert all(f.run_llm is False for f in appends)
        assert len(runs) == 1, f"Expected 1 LLMRunFrame but got {len(runs)}"

    async def test_process_deferred_tool_frames_hook(self):
        """process_deferred_tool_frames strips run_llm and appends one LLMRunFrame."""
        from pipecat.frames.frames import LLMMessagesAppendFrame, LLMRunFrame
        from pipecat.processors.frame_processor import FrameDirection

        agent = _make_voice_agent()
        frames = [
            (LLMMessagesAppendFrame(messages=[{"role": "user", "content": "a"}], run_llm=True), FrameDirection.DOWNSTREAM),
            (LLMMessagesAppendFrame(messages=[{"role": "user", "content": "b"}], run_llm=True), FrameDirection.DOWNSTREAM),
            (LLMMessagesAppendFrame(messages=[{"role": "user", "content": "c"}], run_llm=False), FrameDirection.DOWNSTREAM),
        ]
        result = await agent.process_deferred_tool_frames(frames)
        appends = [f for f, _ in result if isinstance(f, LLMMessagesAppendFrame)]
        runs = [f for f, _ in result if isinstance(f, LLMRunFrame)]
        assert all(f.run_llm is False for f in appends)
        assert len(runs) == 1
        assert len(result) == 4  # 3 appends, 1 run frame

    async def test_queue_frame_defers_when_tool_inflight(self):
        """Frames are deferred when a tool call is in-flight."""
        from pipecat.frames.frames import LLMMessagesAppendFrame
        from pipecat.processors.frame_processor import FrameDirection

        agent = _make_voice_agent()
        agent._tool_call_inflight = 1
        frame = LLMMessagesAppendFrame(messages=[{"role": "user", "content": "task.completed"}], run_llm=True)
        await agent.queue_frame(frame)

        assert len(agent._deferred_frames) == 1
        deferred_frame, direction = agent._deferred_frames[0]
        assert deferred_frame is frame
        assert direction == FrameDirection.DOWNSTREAM

    async def test_process_deferred_frames_strip_run_llm(self):
        """Deferred run_llm=True frame -> one coalesced LLMRunFrame."""
        from pipecat.frames.frames import LLMMessagesAppendFrame, LLMRunFrame
        from pipecat.processors.frame_processor import FrameDirection

        agent = _make_voice_agent()
        frames = [
            (LLMMessagesAppendFrame(messages=[{"role": "user", "content": "status.snapshot"}], run_llm=True), FrameDirection.DOWNSTREAM)
        ]
        result = await agent.process_deferred_tool_frames(frames)

        runs = [f for f, _ in result if isinstance(f, LLMRunFrame)]
        assert len(runs) == 1

    async def test_process_deferred_frames_deferred_only_no_status_snapshot(self):
        """Empty deferred frames → no LLMRunFrame added by process_deferred_tool_frames."""
        from pipecat.frames.frames import LLMRunFrame

        agent = _make_voice_agent()
        result = await agent.process_deferred_tool_frames([])
        runs = [f for f, _ in result if isinstance(f, LLMRunFrame)]
        assert len(runs) == 0


@pytest.mark.unit
class TestInjectContextManagedTask:
    """Verify _inject_context uses create_asyncio_task (managed) rather than bare asyncio tasks."""

    async def test_inject_context_uses_managed_task(self):
        """_inject_context with run_llm=True creates a managed task via create_asyncio_task."""
        agent = _make_voice_agent()

        # Provide a mock pipeline_task so queue_frame doesn't no-op.
        agent._pipeline_task = MagicMock()
        agent._pipeline_task.queue_frame = AsyncMock()

        # Provide a mock task manager so create_asyncio_task works.
        created_tasks = []

        def fake_create_task(coro, name):
            task = asyncio.get_event_loop().create_task(coro)
            created_tasks.append((task, name))
            return task

        mock_tm = MagicMock()
        mock_tm.create_task = fake_create_task
        agent._task_manager = mock_tm

        await agent._inject_context(
            [{"role": "user", "content": "test idle report"}],
            run_llm=True,
        )

        # Should have created a managed task for the coalesced run.
        assert len(created_tasks) == 1
        _, name = created_tasks[0]
        assert "inject_coalesced_run" in name

        # Let the coalesced run task complete.
        await asyncio.sleep(0)

    async def test_inject_context_no_duplicate_tasks(self):
        """Multiple rapid _inject_context calls create only one coalesced task."""
        agent = _make_voice_agent()
        agent._pipeline_task = MagicMock()
        agent._pipeline_task.queue_frame = AsyncMock()

        created_tasks = []

        def fake_create_task(coro, name):
            task = asyncio.get_event_loop().create_task(coro)
            created_tasks.append((task, name))
            return task

        mock_tm = MagicMock()
        mock_tm.create_task = fake_create_task
        agent._task_manager = mock_tm

        # Call twice rapidly — second should reuse the pending flag.
        await agent._inject_context(
            [{"role": "user", "content": "event1"}], run_llm=True
        )
        await agent._inject_context(
            [{"role": "user", "content": "event2"}], run_llm=True
        )

        assert len(created_tasks) == 1, (
            f"Expected 1 managed task but got {len(created_tasks)}"
        )

        await asyncio.sleep(0)


@pytest.mark.unit
class TestTaskCompletionCooldown:
    @staticmethod
    def _make_task_response(agent: VoiceAgent):
        from gradientbang.subagents.agents import TaskStatus
        from gradientbang.subagents.bus.messages import BusTaskResponseMessage

        child = MagicMock()
        child.name = "task_abc123"
        child._is_corp_ship = False
        child._game_client = agent._game_client
        agent._children = [child]

        message = BusTaskResponseMessage(
            source=child.name,
            task_id="tid-1",
            status=TaskStatus.COMPLETED,
            response={"message": "Task done"},
        )
        return child, message

    @staticmethod
    def _stub_task_completion(agent: VoiceAgent) -> AsyncMock:
        agent._task_output_handler = AsyncMock()
        agent.send_message = AsyncMock()
        agent._update_polling_scope = MagicMock()
        agent._queue_task_completion_event = AsyncMock()
        return agent._queue_task_completion_event

    async def test_waits_through_llm_end_to_speech_start_gap(self, monkeypatch):
        import gradientbang.pipecat_server.subagents.voice_agent as voice_agent_module

        monkeypatch.setattr(voice_agent_module, "TASK_RESPONSE_COOLDOWN_SECONDS", 0.0)
        monkeypatch.setattr(
            voice_agent_module,
            "TASK_RESPONSE_SPEECH_START_GRACE_SECONDS",
            1.0,
        )

        agent = _make_voice_agent()
        queue_completion = self._stub_task_completion(agent)
        _, message = self._make_task_response(agent)

        agent._handle_llm_response_started()
        agent._handle_llm_response_ended()

        response_task = asyncio.create_task(agent.on_task_response(message))
        await asyncio.sleep(0)
        queue_completion.assert_not_awaited()

        agent._handle_bot_started_speaking()
        await asyncio.sleep(0)
        queue_completion.assert_not_awaited()

        agent._handle_bot_stopped_speaking()
        await asyncio.wait_for(response_task, timeout=0.5)
        queue_completion.assert_awaited_once()

    async def test_speech_start_grace_releases_silent_response_cycle(self, monkeypatch):
        import gradientbang.pipecat_server.subagents.voice_agent as voice_agent_module

        monkeypatch.setattr(voice_agent_module, "TASK_RESPONSE_COOLDOWN_SECONDS", 0.0)
        monkeypatch.setattr(
            voice_agent_module,
            "TASK_RESPONSE_SPEECH_START_GRACE_SECONDS",
            0.01,
        )

        agent = _make_voice_agent()
        queue_completion = self._stub_task_completion(agent)
        _, message = self._make_task_response(agent)

        agent._handle_llm_response_started()
        agent._handle_llm_response_ended()

        response_task = asyncio.create_task(agent.on_task_response(message))
        await asyncio.sleep(0)
        queue_completion.assert_not_awaited()

        await asyncio.wait_for(response_task, timeout=0.5)
        queue_completion.assert_awaited_once()
        assert agent._assistant_cycle_active is False

    async def test_cooldown_uses_actual_bot_stop_time(self, monkeypatch):
        import gradientbang.pipecat_server.subagents.voice_agent as voice_agent_module

        monkeypatch.setattr(voice_agent_module, "TASK_RESPONSE_COOLDOWN_SECONDS", 0.05)
        monkeypatch.setattr(
            voice_agent_module,
            "TASK_RESPONSE_SPEECH_START_GRACE_SECONDS",
            1.0,
        )

        agent = _make_voice_agent()
        queue_completion = self._stub_task_completion(agent)
        _, message = self._make_task_response(agent)

        agent._handle_llm_response_started()
        agent._handle_bot_started_speaking()
        agent._handle_llm_response_ended()

        response_task = asyncio.create_task(agent.on_task_response(message))
        await asyncio.sleep(0.01)
        queue_completion.assert_not_awaited()

        agent._handle_bot_stopped_speaking()
        await asyncio.sleep(0.02)
        queue_completion.assert_not_awaited()

        await asyncio.wait_for(response_task, timeout=0.5)
        queue_completion.assert_awaited_once()

# ── Task tool handlers ────────────────────────────────────────────────


@pytest.mark.unit
class TestHandleStopTask:
    async def test_stop_specific_task_full_uuid(self):
        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent
        from gradientbang.subagents.agents.base_agent import TaskGroup

        agent = _make_voice_agent()
        agent.cancel_task = AsyncMock()
        child = MagicMock(spec=TaskAgent)
        child.name = "task_abc123"
        child._is_corp_ship = False
        child._character_id = "corp-ship-1"
        agent._children = [child]
        agent._locked_ships.add("corp-ship-1")
        full_id = "ff3fa419-1234-5678-9abc-def012345678"
        agent._task_groups = {full_id: TaskGroup(task_id=full_id, agent_names={"task_abc123"})}
        params = MagicMock()
        params.arguments = {"task_id": full_id}
        result = await agent._handle_stop_task(params)
        assert result["success"] is True
        assert result["task_id"] == full_id
        agent.cancel_task.assert_called_once_with(full_id, reason="Cancelled by user")
        # Lock must be released synchronously so a follow-up start_task in
        # the same turn can succeed.
        assert "corp-ship-1" not in agent._locked_ships

    async def test_stop_specific_task_short_prefix(self):
        """Regression: the LLM passes the 8-char prefix it saw in an event."""
        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent
        from gradientbang.subagents.agents.base_agent import TaskGroup

        agent = _make_voice_agent()
        agent.cancel_task = AsyncMock()
        child = MagicMock(spec=TaskAgent)
        child.name = "task_abc123"
        child._is_corp_ship = False
        child._character_id = "corp-ship-1"
        agent._children = [child]
        agent._locked_ships.add("corp-ship-1")
        full_id = "ff3fa419-1234-5678-9abc-def012345678"
        agent._task_groups = {full_id: TaskGroup(task_id=full_id, agent_names={"task_abc123"})}
        params = MagicMock()
        params.arguments = {"task_id": "ff3fa419"}
        result = await agent._handle_stop_task(params)
        assert result["success"] is True
        assert result["task_id"] == full_id
        agent.cancel_task.assert_called_once_with(full_id, reason="Cancelled by user")
        assert "corp-ship-1" not in agent._locked_ships

    async def test_stop_player_ship_default(self):
        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent
        from gradientbang.subagents.agents.base_agent import TaskGroup

        agent = _make_voice_agent()
        agent.cancel_task = AsyncMock()
        child = MagicMock(spec=TaskAgent)
        child.name = "task_abc123"
        child._is_corp_ship = False
        child._character_id = agent._character_id
        agent._children = [child]
        agent._locked_ships.add(agent._character_id)
        agent._task_groups = {"tid-1": TaskGroup(task_id="tid-1", agent_names={"task_abc123"})}
        params = MagicMock()
        params.arguments = {}
        result = await agent._handle_stop_task(params)
        assert result["success"] is True
        agent.cancel_task.assert_called_once_with("tid-1", reason="Cancelled by user")
        assert agent._character_id not in agent._locked_ships

    async def test_stop_no_task(self):
        agent = _make_voice_agent()
        agent._children = []
        params = MagicMock()
        params.arguments = {}
        result = await agent._handle_stop_task(params)
        assert result["success"] is False

    async def test_stop_not_found(self):
        agent = _make_voice_agent()
        agent._children = []
        params = MagicMock()
        params.arguments = {"task_id": "nonexistent"}
        result = await agent._handle_stop_task(params)
        assert result["success"] is False


@pytest.mark.unit
class TestHandleSteerTask:
    async def test_steer_success(self):
        from gradientbang.pipecat_server.subagents.bus_messages import BusSteerTaskMessage
        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent
        from gradientbang.subagents.agents.base_agent import TaskGroup

        agent = _make_voice_agent()
        agent.send_message = AsyncMock()
        child = MagicMock(spec=TaskAgent)
        child.name = "task_abc123"
        child._is_corp_ship = False
        agent._children = [child]
        full_id = "ff3fa419-1234-5678-9abc-def012345678"
        agent._task_groups = {full_id: TaskGroup(task_id=full_id, agent_names={"task_abc123"})}
        params = MagicMock()
        # LLM passes the short prefix from a task event
        params.arguments = {"task_id": "ff3fa419", "message": "Change course"}
        result = await agent._handle_steer_task(params)
        assert result["success"] is True
        assert result["task_id"] == full_id
        assert result["task_type"] == "player_ship"
        assert result["steered"] is True
        sent = agent.send_message.call_args[0][0]
        assert isinstance(sent, BusSteerTaskMessage)
        assert sent.target == "task_abc123"
        assert sent.task_id == full_id
        assert sent.text.startswith("Steering instruction: ")

    async def test_steer_missing_args(self):
        agent = _make_voice_agent()
        params = MagicMock()
        params.arguments = {"task_id": "", "message": "test"}
        assert (await agent._handle_steer_task(params))["success"] is False
        params.arguments = {"task_id": "abc", "message": ""}
        assert (await agent._handle_steer_task(params))["success"] is False

    async def test_steer_not_found(self):
        agent = _make_voice_agent()
        agent._children = []
        params = MagicMock()
        params.arguments = {"task_id": "abc123", "message": "Go"}
        result = await agent._handle_steer_task(params)
        assert result["success"] is False
        assert "not found" in result["error"]


# ── Helpers ───────────────────────────────────────────────────────────


@pytest.mark.unit
class TestHelpers:
    def test_get_task_type(self):
        agent = _make_voice_agent()
        assert agent._get_task_type(None) == "player_ship"
        assert agent._get_task_type("char-123") == "player_ship"
        assert agent._get_task_type("other-ship") == "corp_ship"

    def test_is_valid_uuid(self):
        assert VoiceAgent._is_valid_uuid("550e8400-e29b-41d4-a716-446655440000")
        assert not VoiceAgent._is_valid_uuid("not-a-uuid")


# ── Corporation info summary ──────────────────────────────────────────


CORP_SHIP_ID = "550e8400-e29b-41d4-a716-446655440000"
PERSONAL_SHIP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


def _corp_api_response(ship_id=CORP_SHIP_ID, ship_name="Red Probe"):
    """Fake my_corporation API response with one corp ship."""
    return {
        "corporation": {
            "name": "TestCorp",
            "member_count": 2,
            "members": [{"name": "Alice"}, {"name": "Bob"}],
            "ships": [
                {
                    "ship_id": ship_id,
                    "ship_name": ship_name,
                    "ship_type": "fast_probe",
                    "sector": 42,
                    "cargo": {},
                    "cargo_capacity": 100,
                    "warp_power": 5,
                    "warp_power_capacity": 10,
                    "credits": 1000,
                    "current_task_id": None,
                    "fighters": 10,
                },
            ],
        },
    }


def _leaderboard_api_response():
    return {
        "wealth": [
            {
                "player_id": "human-1",
                "player_name": "Alice Explorer",
                "player_type": "human",
                "total_wealth": 400000,
            },
            {
                "player_id": "char-123",
                "player_name": "Player One",
                "player_type": "human",
                "total_wealth": 300000,
            },
            {
                "player_id": "human-5",
                "player_name": "Eve Miner",
                "player_type": "human",
                "total_wealth": 250000,
            },
            {
                "player_id": "npc-1",
                "player_name": "NPC Rich",
                "player_type": "npc",
                "total_wealth": 999999,
            },
        ],
        "trading": [
            {
                "player_id": "human-2",
                "player_name": "Bob Trader",
                "player_type": "human",
                "total_trade_volume": 75000,
            },
            {
                "player_id": "char-123",
                "player_name": "Player One",
                "player_type": "human",
                "total_trade_volume": 70000,
            },
            {
                "player_id": "human-6",
                "player_name": "Finn Broker",
                "player_type": "human",
                "total_trade_volume": 65000,
            },
        ],
        "exploration": [
            {
                "player_id": "human-3",
                "player_name": "Cara Scout",
                "player_type": "human",
                "sectors_visited": 88,
            },
            {
                "player_id": "char-123",
                "player_name": "Player One",
                "player_type": "human",
                "sectors_visited": 72,
            },
            {
                "player_id": "human-7",
                "player_name": "Gale Surveyor",
                "player_type": "human",
                "sectors_visited": 66,
            }
        ],
        "territory": [
            {
                "player_id": "human-4",
                "player_name": "Dax Warden",
                "player_type": "human",
                "sectors_controlled": 12,
            },
            {
                "player_id": "char-123",
                "player_name": "Player One",
                "player_type": "human",
                "sectors_controlled": 8,
            },
            {
                "player_id": "human-8",
                "player_name": "Hale Sentinel",
                "player_type": "human",
                "sectors_controlled": 6,
            },
        ],
    }


@pytest.mark.unit
class TestCorporationInfoSummary:
    """Verify corporation_info returns a curated summary, not raw JSON."""

    @pytest.mark.asyncio
    async def test_returns_summary_string(self):
        agent = _make_voice_agent()
        agent._VoiceAgent__game_client._request = AsyncMock(return_value=_corp_api_response())
        callback = AsyncMock()
        params = MagicMock()
        params.arguments = {}
        params.result_callback = callback
        await agent._handle_corporation_info(params)

        callback.assert_awaited_once()
        result = callback.call_args[0][0]
        assert "summary" in result
        assert isinstance(result["summary"], str)
        # Should NOT contain raw UUIDs — only short prefixes
        assert CORP_SHIP_ID not in result["summary"]
        # Should contain the corp name and ship name
        assert "TestCorp" in result["summary"]
        assert "Red Probe" in result["summary"]

    def test_summarize_includes_short_ship_id(self):
        summary = summarize_corporation_info(_corp_api_response())
        # Short prefix should appear in brackets
        assert f"[{CORP_SHIP_ID[:6]}]" in summary

    def test_summarize_no_corporation(self):
        summary = summarize_corporation_info({"corporation": None})
        assert "not in a corporation" in summary.lower()

    def test_summarize_list_response(self):
        result = {
            "corporations": [
                {"name": "Alpha Corp", "member_count": 3},
                {"name": "Beta Corp", "member_count": 5},
            ]
        }
        summary = summarize_corporation_info(result)
        assert "2 total" in summary
        assert "Alpha Corp" in summary


@pytest.mark.unit
class TestVoiceToolErrorWrapping:
    @pytest.mark.asyncio
    async def test_wrap_tool_errors_resolves_uncaught_exception(self):
        agent = _make_voice_agent()
        params = _make_function_call_params(result_callback=AsyncMock())

        async def boom(_params):
            raise RuntimeError("boom")

        wrapped = agent._wrap_tool_errors("test_tool", boom)
        await wrapped(params)

        params.result_callback.assert_awaited_once()
        assert params.result_callback.await_args.args[0] == {"error": "boom"}
        properties = params.result_callback.await_args.kwargs["properties"]
        assert properties.run_llm is True
        assert agent._assistant_cycle_active is True

    @pytest.mark.asyncio
    async def test_wrap_tool_errors_does_not_resolve_twice(self):
        agent = _make_voice_agent()
        params = _make_function_call_params(result_callback=AsyncMock())

        async def resolve_then_fail(call_params):
            await call_params.result_callback({"ok": True})
            raise RuntimeError("boom after callback")

        wrapped = agent._wrap_tool_errors("test_tool", resolve_then_fail)
        await wrapped(params)

        params.result_callback.assert_awaited_once_with({"ok": True})

    @pytest.mark.asyncio
    async def test_leaderboard_failure_resolves_cleanly(self):
        agent = _make_voice_agent()
        agent._game_client.leaderboard_resources = AsyncMock(side_effect=RuntimeError("bad rpc"))
        params = _make_function_call_params(
            function_name="leaderboard_resources",
            result_callback=AsyncMock(),
        )

        wrapped = agent._wrap_tool_errors("leaderboard_resources", agent._handle_leaderboard_resources)
        await wrapped(params)

        params.result_callback.assert_awaited_once()
        assert params.result_callback.await_args.args[0] == {"error": "bad rpc"}
        properties = params.result_callback.await_args.kwargs["properties"]
        assert properties.run_llm is True


@pytest.mark.unit
class TestTaskToolWrappers:
    @pytest.mark.asyncio
    async def test_start_task_tool_success_queues_started_event(self):
        from pipecat.frames.frames import LLMMessagesAppendFrame
        from pipecat.processors.frame_processor import FrameDirection

        agent = _make_voice_agent()
        agent._tool_call_inflight = 1
        result = {
            "success": True,
            "message": "Task started",
            "task_id": "task_abc123",
            "task_type": "player_ship",
        }
        agent._handle_start_task = AsyncMock(return_value=result)
        params = _make_function_call_params(function_name="start_task", result_callback=AsyncMock())

        await agent._handle_start_task_tool(params)

        params.result_callback.assert_awaited_once()
        assert params.result_callback.await_args.args[0] == {"result": result}
        properties = params.result_callback.await_args.kwargs["properties"]
        assert properties.run_llm is False

        assert len(agent._deferred_frames) == 1
        deferred_frame, direction = agent._deferred_frames[0]
        assert direction == FrameDirection.DOWNSTREAM
        assert isinstance(deferred_frame, LLMMessagesAppendFrame)
        assert deferred_frame.run_llm is True
        assert deferred_frame.messages[0]["role"] == "user"
        assert '<event name="task.started" task_id="task_abc123" task_type="player_ship">' in (
            deferred_frame.messages[0]["content"]
        )
        assert "Task started" in deferred_frame.messages[0]["content"]

    @pytest.mark.asyncio
    async def test_start_task_tool_failure_stays_quiet(self):
        agent = _make_voice_agent()
        result = {"success": False, "error": "already running"}
        agent._handle_start_task = AsyncMock(return_value=result)
        params = _make_function_call_params(function_name="start_task", result_callback=AsyncMock())

        await agent._handle_start_task_tool(params)

        params.result_callback.assert_awaited_once()
        assert params.result_callback.await_args.args[0] == {"result": result}
        properties = params.result_callback.await_args.kwargs["properties"]
        assert properties.run_llm is False
        assert agent._assistant_cycle_active is False
        assert len(agent._deferred_frames) == 0

    @pytest.mark.asyncio
    async def test_start_task_tool_steered_result_queues_steered_event(self):
        from pipecat.frames.frames import LLMMessagesAppendFrame
        from pipecat.processors.frame_processor import FrameDirection

        agent = _make_voice_agent()
        agent._tool_call_inflight = 1
        result = {
            "success": True,
            "summary": "Task already running; steered with new instructions.",
            "task_id": "task_abc123",
            "task_type": "player_ship",
            "steered": True,
        }
        agent._handle_start_task = AsyncMock(return_value=result)
        params = _make_function_call_params(function_name="start_task", result_callback=AsyncMock())

        await agent._handle_start_task_tool(params)

        agent._handle_start_task.assert_awaited_once()
        params.result_callback.assert_awaited_once()
        assert params.result_callback.await_args.args[0] == {"result": result}
        properties = params.result_callback.await_args.kwargs["properties"]
        assert properties.run_llm is False

        assert len(agent._deferred_frames) == 1
        deferred_frame, direction = agent._deferred_frames[0]
        assert direction == FrameDirection.DOWNSTREAM
        assert isinstance(deferred_frame, LLMMessagesAppendFrame)
        # Steered path must NOT trigger a second inference — the model
        # already narrated the steer in the same turn as the tool call.
        # A fresh inference here produces a duplicate ack.
        assert deferred_frame.run_llm is False
        assert deferred_frame.messages[0]["role"] == "user"
        assert '<event name="task.steered" task_id="task_abc123" task_type="player_ship">' in (
            deferred_frame.messages[0]["content"]
        )
        assert "steered with new instructions" in deferred_frame.messages[0]["content"]


@pytest.mark.unit
class TestLeaderboardSummary:
    def test_summarize_leaderboard_multicategory_payload(self):
        summary = summarize_leaderboard(_leaderboard_api_response(), player_id="char-123")

        assert summary is not None
        assert "Alice Explorer" in summary
        assert "Bob Trader" in summary
        assert "Cara Scout" in summary
        assert "Dax Warden" in summary
        assert "Your wealth rank: Player One (#2)" in summary
        assert "Above you in wealth: Alice Explorer (#1)" in summary
        assert "Below you in wealth: Eve Miner (#3)" in summary
        assert "Your trading rank: Player One (#2)" in summary
        assert "Below you in territory: Hale Sentinel (#3)" in summary

    @pytest.mark.asyncio
    async def test_handle_leaderboard_resources_returns_summary_only(self):
        agent = _make_voice_agent()
        agent._game_client.leaderboard_resources = AsyncMock(return_value=_leaderboard_api_response())
        params = _make_function_call_params(
            function_name="leaderboard_resources",
            arguments={"force_refresh": True},
            result_callback=AsyncMock(),
        )

        await agent._handle_leaderboard_resources(params)

        agent._game_client.leaderboard_resources.assert_called_once_with(
            character_id="char-123",
            force_refresh=True,
        )
        params.result_callback.assert_awaited_once()
        payload = params.result_callback.await_args.args[0]
        assert set(payload.keys()) == {"summary"}
        assert "Alice Explorer" in payload["summary"]
        assert "Player One (#2)" in payload["summary"]

    @pytest.mark.asyncio
    async def test_handle_leaderboard_resources_returns_error_when_unsummarizable(self):
        agent = _make_voice_agent()
        agent._game_client.leaderboard_resources = AsyncMock(return_value={"cached": True})
        params = _make_function_call_params(
            function_name="leaderboard_resources",
            result_callback=AsyncMock(),
        )

        await agent._handle_leaderboard_resources(params)

        params.result_callback.assert_awaited_once()
        payload = params.result_callback.await_args.args[0]
        assert payload == {
            "error": "Leaderboard data is unavailable or too large to summarize safely."
        }


# ── Corporation direct tools ──────────────────────────────────────────


@pytest.mark.unit
class TestCorporationDirectTools:
    """Verify create_corporation and rename_corporation call game_client correctly."""

    @pytest.mark.asyncio
    async def test_create_corporation_calls_game_client(self):
        agent = _make_voice_agent()
        agent._game_client.create_corporation = AsyncMock(
            return_value={"request_id": "req-create"}
        )
        params = MagicMock()
        params.arguments = {"name": "Test Corp"}
        params.result_callback = AsyncMock()

        await agent._handle_create_corporation(params)

        agent._game_client.create_corporation.assert_called_once_with(
            name="Test Corp", character_id="char-123",
        )
        params.result_callback.assert_called_once()
        result = params.result_callback.call_args[0][0]
        assert result == {"success": True}
        assert agent.is_recent_request_id("req-create")

    @pytest.mark.asyncio
    async def test_rename_corporation_calls_game_client(self):
        agent = _make_voice_agent()
        agent._game_client.rename_corporation = AsyncMock(
            return_value={"request_id": "req-rename"}
        )
        params = MagicMock()
        params.arguments = {"name": "New Name"}
        params.result_callback = AsyncMock()

        await agent._handle_rename_corporation(params)

        agent._game_client.rename_corporation.assert_called_once_with(
            name="New Name", character_id="char-123",
        )
        params.result_callback.assert_called_once()
        result = params.result_callback.call_args[0][0]
        assert result == {"success": True}
        assert agent.is_recent_request_id("req-rename")


@pytest.mark.unit
class TestEventDrivenToolErrors:
    @pytest.mark.asyncio
    async def test_my_status_hyperspace_error_is_silent_during_active_player_task(self):
        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent

        agent = _make_voice_agent()
        agent._game_client.my_status = AsyncMock(
            side_effect=RuntimeError("my_status failed with status 409: in hyperspace")
        )
        active_task = MagicMock(spec=TaskAgent)
        active_task._is_corp_ship = False
        agent._children = [active_task]
        agent._locked_ships = {agent._character_id}  # Player task is active
        params = MagicMock()
        params.arguments = {}
        params.result_callback = AsyncMock()

        await agent._handle_my_status(params)

        params.result_callback.assert_awaited_once()
        assert params.result_callback.call_args.args[0] == {
            "error": "my_status failed with status 409: in hyperspace"
        }
        properties = params.result_callback.call_args.kwargs["properties"]
        assert properties.run_llm is False

    @pytest.mark.asyncio
    async def test_my_status_hyperspace_error_without_active_task_triggers_llm(self):
        agent = _make_voice_agent()
        agent._game_client.my_status = AsyncMock(
            side_effect=RuntimeError("my_status failed with status 409: in hyperspace")
        )
        params = MagicMock()
        params.arguments = {}
        params.result_callback = AsyncMock()

        await agent._handle_my_status(params)

        params.result_callback.assert_awaited_once()
        assert params.result_callback.call_args.args[0] == {
            "error": "my_status failed with status 409: in hyperspace"
        }
        properties = params.result_callback.call_args.kwargs["properties"]
        assert properties.run_llm is True
        assert agent._assistant_cycle_active is True

    @pytest.mark.asyncio
    async def test_send_message_error_triggers_llm(self):
        agent = _make_voice_agent()
        agent._game_client.send_message = AsyncMock(side_effect=RuntimeError("message failed"))
        params = MagicMock()
        params.arguments = {"content": "hello"}
        params.result_callback = AsyncMock()

        await agent._handle_send_message(params)

        params.result_callback.assert_awaited_once()
        assert params.result_callback.call_args.args[0] == {"error": "message failed"}
        properties = params.result_callback.call_args.kwargs["properties"]
        assert properties.run_llm is True
        assert agent._assistant_cycle_active is True


# ── Corp ship routing guard ───────────────────────────────────────────


@pytest.mark.unit
class TestCorpShipRouting:
    """Verify start_task correctly classifies personal vs corp ship tasks."""

    @pytest.mark.asyncio
    @patch("gradientbang.pipecat_server.subagents.voice_agent.AsyncGameClient")
    async def test_personal_ship_id_treated_as_player_task(self, mock_client_cls):
        """If the LLM passes a UUID that isn't a corp ship, treat as player task."""
        agent = _make_voice_agent()
        # _is_corp_ship_id returns False for an unknown ship
        agent._VoiceAgent__game_client._request = AsyncMock(
            return_value=_corp_api_response()
        )
        agent._VoiceAgent__game_client.base_url = "http://localhost"
        mock_client_cls.return_value = MagicMock()

        params = MagicMock()
        params.arguments = {
            "task_description": "Go to sector 5",
            "ship_id": PERSONAL_SHIP_ID,  # Not in the corp ships list
        }

        # Patch add_agent to avoid framework setup
        agent.add_agent = AsyncMock()

        result = await agent._handle_start_task(params)
        assert result["success"] is True
        assert result["task_type"] == "player_ship"
        mock_client_cls.assert_not_called()
        task_agent = agent.add_agent.call_args.args[0]
        assert task_agent._game_client is agent._game_client
        assert task_agent._tag_outbound_rpcs_with_task_id is False

    @pytest.mark.asyncio
    @patch("gradientbang.pipecat_server.subagents.voice_agent.AsyncGameClient")
    async def test_corp_ship_id_treated_as_corp_task(self, mock_client_cls):
        """If the LLM passes a UUID that IS a corp ship, treat as corp task."""
        agent = _make_voice_agent()
        agent._VoiceAgent__game_client._request = AsyncMock(
            return_value=_corp_api_response()
        )
        agent._VoiceAgent__game_client.base_url = "http://localhost"

        # Mock the new AsyncGameClient constructor for corp ship tasks
        mock_client_cls.return_value = MagicMock()

        params = MagicMock()
        params.arguments = {
            "task_description": "Go to sector 5",
            "ship_id": CORP_SHIP_ID,
        }

        agent.add_agent = AsyncMock()

        result = await agent._handle_start_task(params)
        assert result["success"] is True
        assert result["task_type"] == "corp_ship"
        mock_client_cls.assert_called_once_with(
            base_url="http://localhost",
            character_id=CORP_SHIP_ID,
            actor_character_id="char-123",
            entity_type="corporation_ship",
            transport="supabase",
            enable_event_polling=False,
        )
        task_agent = agent.add_agent.call_args.args[0]
        assert task_agent._game_client is mock_client_cls.return_value
        assert task_agent._tag_outbound_rpcs_with_task_id is True

    @pytest.mark.asyncio
    @patch("gradientbang.pipecat_server.subagents.voice_agent.AsyncGameClient")
    async def test_character_id_as_ship_id_treated_as_player_task(self, mock_client_cls):
        """If the LLM passes the player's own character_id as ship_id, treat as player task."""
        # Use a valid UUID as character_id so it passes _is_valid_uuid
        char_id = "11111111-1111-1111-1111-111111111111"
        agent = _make_voice_agent(character_id=char_id)
        agent._VoiceAgent__game_client.base_url = "http://localhost"
        mock_client_cls.return_value = MagicMock()

        params = MagicMock()
        params.arguments = {
            "task_description": "Go to sector 5",
            "ship_id": char_id,  # Same as the agent's character_id
        }

        agent.add_agent = AsyncMock()

        result = await agent._handle_start_task(params)
        assert result["success"] is True
        assert result["task_type"] == "player_ship"
        mock_client_cls.assert_not_called()
        task_agent = agent.add_agent.call_args.args[0]
        assert task_agent._game_client is agent._game_client
        assert task_agent._tag_outbound_rpcs_with_task_id is False

    @pytest.mark.asyncio
    @patch("gradientbang.pipecat_server.subagents.voice_agent.AsyncGameClient")
    async def test_no_ship_id_is_player_task(self, mock_client_cls):
        """Default: no ship_id means player task."""
        agent = _make_voice_agent()
        agent._VoiceAgent__game_client.base_url = "http://localhost"
        mock_client_cls.return_value = MagicMock()

        params = MagicMock()
        params.arguments = {"task_description": "Go to sector 5"}

        agent.add_agent = AsyncMock()

        result = await agent._handle_start_task(params)
        assert result["success"] is True
        assert result["task_type"] == "player_ship"
        mock_client_cls.assert_not_called()
        task_agent = agent.add_agent.call_args.args[0]
        assert task_agent._game_client is agent._game_client
        assert task_agent._tag_outbound_rpcs_with_task_id is False

    @pytest.mark.asyncio
    @patch("gradientbang.pipecat_server.subagents.voice_agent.AsyncGameClient")
    async def test_explicit_context_is_forwarded_to_task_payload(self, mock_client_cls):
        agent = _make_voice_agent()
        agent._VoiceAgent__game_client.base_url = "http://localhost"
        mock_client_cls.return_value = MagicMock()

        params = MagicMock()
        params.arguments = {
            "task_description": "Check recent history",
            "context": "The commander asked about a sector visit.",
        }

        agent.add_agent = AsyncMock()

        result = await agent._handle_start_task(params)

        assert result["success"] is True
        _task_id, pending_payload = next(iter(agent._pending_tasks.values()))
        assert pending_payload["context"] == "The commander asked about a sector visit."

    @pytest.mark.asyncio
    @patch("gradientbang.pipecat_server.subagents.voice_agent.AsyncGameClient")
    async def test_session_task_gets_current_session_boundary_context(self, mock_client_cls):
        relay = MagicMock()
        relay.session_started_at = "2026-03-29T18:46:44+00:00"
        agent = _make_voice_agent(event_relay=relay)
        agent._VoiceAgent__game_client.base_url = "http://localhost"
        mock_client_cls.return_value = MagicMock()

        params = MagicMock()
        params.arguments = {"task_description": "Tell me what we did in the last session"}

        agent.add_agent = AsyncMock()

        result = await agent._handle_start_task(params)

        assert result["success"] is True
        _task_id, pending_payload = next(iter(agent._pending_tasks.values()))
        assert "Current session started at 2026-03-29T18:46:44+00:00." in pending_payload["context"]
        assert "last or previous session" in pending_payload["context"]

    @pytest.mark.asyncio
    async def test_concurrent_player_start_task_only_allows_one(self):
        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent

        agent = _make_voice_agent()
        agent._task_groups = {}
        agent._children = []

        async def add_agent(task_agent):
            await asyncio.sleep(0)
            agent._children.append(task_agent)

        agent.add_agent = AsyncMock(side_effect=add_agent)

        params_a = MagicMock()
        params_a.arguments = {"task_description": "Transfer 2000 credits"}
        params_b = MagicMock()
        params_b.arguments = {"task_description": "Transfer 2000 credits again"}

        result_a, result_b = await asyncio.gather(
            agent._handle_start_task(params_a),
            agent._handle_start_task(params_b),
        )

        successes = [result for result in (result_a, result_b) if result["success"]]
        failures = [result for result in (result_a, result_b) if not result["success"]]
        assert len(successes) == 1
        assert len(failures) == 1
        assert "already has a task running" in failures[0]["error"]
        assert len([child for child in agent._children if isinstance(child, TaskAgent)]) == 1
        assert agent._character_id in agent._locked_ships

    @pytest.mark.asyncio
    async def test_ship_lock_released_after_task_completes(self):
        """Ship lock is released; player agent stays in _children for reuse."""
        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent
        from gradientbang.subagents.bus.messages import BusTaskResponseMessage
        from gradientbang.subagents.agents.task_group import TaskStatus

        agent = _make_voice_agent()
        agent._task_groups = {}
        agent._children = []
        agent._inject_context = AsyncMock()
        agent._queue_task_completion_event = AsyncMock()

        async def add_agent(task_agent):
            await asyncio.sleep(0)
            agent._children.append(task_agent)

        agent.add_agent = AsyncMock(side_effect=add_agent)

        # Start a task — locks the ship
        params = MagicMock()
        params.arguments = {"task_description": "Mine resources"}
        result = await agent._handle_start_task(params)
        assert result["success"]
        assert agent._character_id in agent._locked_ships

        # Simulate on_task_response — unlocks the ship
        child = next(c for c in agent._children if isinstance(c, TaskAgent))
        msg = MagicMock(spec=BusTaskResponseMessage)
        msg.source = child.name
        msg.task_id = "framework-task-1"
        msg.status = TaskStatus.COMPLETED
        msg.response = {"message": "Done"}
        agent.send_message = AsyncMock()
        agent._tool_call_inflight = 0
        agent._assistant_cycle_active = False
        agent._assistant_cycle_idle_event.set()
        agent._bot_stopped_speaking_at = 0.0
        agent._update_polling_scope = MagicMock()

        await agent.on_task_response(msg)

        assert agent._character_id not in agent._locked_ships
        # Player agent stays in _children for reuse (not ended)
        assert any(c.name == child.name for c in agent._children)
        agent.send_message.assert_not_called()  # No BusEndAgentMessage sent

    @pytest.mark.asyncio
    async def test_error_after_add_agent_cleans_up_ship_lock(self):
        """If add_agent fails after appending child, both lock and orphan are cleaned up."""
        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent

        agent = _make_voice_agent()
        agent._task_groups = {}
        agent._children = []
        agent._VoiceAgent__game_client.base_url = "http://localhost"

        async def add_agent_that_fails(task_agent):
            agent._children.append(task_agent)
            raise RuntimeError("registry.watch failed")

        agent.add_agent = AsyncMock(side_effect=add_agent_that_fails)

        params = MagicMock()
        params.arguments = {"task_description": "Explore sector 5"}
        result = await agent._handle_start_task(params)

        assert not result["success"]
        assert agent._locked_ships == set()
        assert len(agent._children) == 0
        assert len(agent._pending_tasks) == 0

    @pytest.mark.asyncio
    async def test_player_agent_reused_across_tasks(self):
        """Second player task reuses the idle agent instead of creating a new one."""
        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent
        from gradientbang.subagents.bus.messages import BusTaskResponseMessage
        from gradientbang.subagents.agents.task_group import TaskStatus

        agent = _make_voice_agent()
        agent._task_groups = {}
        agent._children = []
        agent._inject_context = AsyncMock()
        agent._queue_task_completion_event = AsyncMock()

        async def add_agent(task_agent):
            await asyncio.sleep(0)
            agent._children.append(task_agent)

        agent.add_agent = AsyncMock(side_effect=add_agent)
        agent.request_task = AsyncMock(return_value="framework-task-uuid")

        # First task — creates a new agent
        params1 = MagicMock()
        params1.arguments = {"task_description": "Mine resources"}
        result1 = await agent._handle_start_task(params1)
        assert result1["success"]
        # First task is dispatched via on_agent_ready (deferred); task_id is the
        # pre-generated framework UUID stored in _pending_tasks.
        first_task_id = result1["task_id"]
        assert agent.add_agent.call_count == 1

        # Complete the first task
        child = next(c for c in agent._children if isinstance(c, TaskAgent))
        first_agent_name = child.name
        child._active_task_id = None  # Mark as idle
        agent._locked_ships.discard(agent._character_id)

        # Second task — should reuse the existing idle agent.
        # The reuse path returns request_task's return value as task_id.
        params2 = MagicMock()
        params2.arguments = {"task_description": "Trade goods"}
        result2 = await agent._handle_start_task(params2)
        assert result2["success"]
        assert result2["task_id"] == "framework-task-uuid"  # from request_task
        assert agent.add_agent.call_count == 1  # No new add_agent call
        agent.request_task.assert_called_once()
        # The reused agent name should still be the same internal bus name
        assert any(c.name == first_agent_name for c in agent._children)
        # And the pre-generated id from the first call should differ from the
        # reused-path id (different code paths, different sources)
        assert first_task_id != result2["task_id"]

    @pytest.mark.asyncio
    @patch("gradientbang.pipecat_server.subagents.voice_agent.AsyncGameClient")
    async def test_corp_agent_destroyed_after_task(self, mock_client_cls):
        """Corp ship agent is ended and removed from _children after task completes."""
        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent
        from gradientbang.subagents.bus.messages import BusTaskResponseMessage
        from gradientbang.subagents.agents.task_group import TaskStatus

        agent = _make_voice_agent()
        agent._task_groups = {}
        agent._children = []
        agent._inject_context = AsyncMock()
        agent._queue_task_completion_event = AsyncMock()
        agent._VoiceAgent__game_client.base_url = "http://localhost"
        mock_client_cls.return_value = MagicMock()

        async def add_agent(task_agent):
            await asyncio.sleep(0)
            agent._children.append(task_agent)

        agent.add_agent = AsyncMock(side_effect=add_agent)
        agent._is_corp_ship_id = AsyncMock(return_value=True)

        # Start corp task
        params = MagicMock()
        params.arguments = {"task_description": "Trade", "ship_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}
        result = await agent._handle_start_task(params)
        assert result["success"]
        assert len(agent._children) == 1

        # Simulate on_task_response
        child = agent._children[0]
        msg = MagicMock(spec=BusTaskResponseMessage)
        msg.source = child.name
        msg.task_id = "framework-task-1"
        msg.status = TaskStatus.COMPLETED
        msg.response = {"message": "Done"}
        agent.send_message = AsyncMock()
        agent._tool_call_inflight = 0
        agent._assistant_cycle_active = False
        agent._assistant_cycle_idle_event.set()
        agent._bot_stopped_speaking_at = 0.0
        agent._update_polling_scope = MagicMock()

        await agent.on_task_response(msg)

        # Corp agent should be removed
        assert len(agent._children) == 0
        # BusEndAgentMessage should have been sent
        agent.send_message.assert_called_once()

    @pytest.mark.asyncio
    async def test_close_tasks_ends_idle_player_agent(self):
        """close_tasks() ends all task agents including idle player agent."""
        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent

        agent = _make_voice_agent()
        agent._task_groups = {}
        agent._children = []
        agent._locked_ships = {"ship-1"}
        agent.send_message = AsyncMock()

        # Add an idle player task agent to children
        mock_task_agent = MagicMock(spec=TaskAgent)
        mock_task_agent.name = "task_abc123"
        mock_task_agent._is_corp_ship = False
        agent._children.append(mock_task_agent)

        await agent.close_tasks()

        assert agent._locked_ships == set()
        assert len(agent._children) == 0
        agent.send_message.assert_called_once()  # BusEndAgentMessage sent
