"""Tests for VoiceAgent framework wiring and task management."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from gradientbang.pipecat_server.subagents.voice_agent import VoiceAgent
from gradientbang.utils.formatting import summarize_corporation_info


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


EXPECTED_TOOLS = {
    "my_status", "plot_course", "list_known_ports", "rename_ship",
    "rename_corporation", "corporation_info", "leaderboard_resources",
    "ship_definitions", "send_message", "combat_initiate", "combat_action",
    "load_game_info", "start_task", "stop_task", "steer_task", "query_task_progress",
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

    def test_find_task_agent_by_prefix(self):
        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent

        agent = _make_voice_agent()
        mock_child = MagicMock(spec=TaskAgent)
        mock_child.name = "task_abc123"
        agent._children = [mock_child]
        assert agent._find_task_agent_by_prefix("abc123") is mock_child
        assert agent._find_task_agent_by_prefix("abc") is mock_child
        assert agent._find_task_agent_by_prefix("xyz") is None
        assert agent._find_task_agent_by_prefix("") is None

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
        await agent.queue_frame_after_tools(frame)
        assert len(agent._deferred_frames) == 1

    async def test_flush_deferred(self):
        from pipecat.frames.frames import LLMMessagesAppendFrame

        agent = _make_voice_agent()
        agent.queue_frame = AsyncMock()
        agent._tool_call_inflight = 1
        await agent.queue_frame_after_tools(
            LLMMessagesAppendFrame(messages=[{"role": "user", "content": "a"}], run_llm=True)
        )
        await agent.queue_frame_after_tools(
            LLMMessagesAppendFrame(messages=[{"role": "user", "content": "b"}], run_llm=False)
        )
        agent._tool_call_inflight = 0
        await agent._flush_deferred_frames()
        assert len(agent._deferred_frames) == 0
        # 2 AppendFrames (run_llm suppressed) + 1 LLMRunFrame
        assert agent.queue_frame.call_count == 3

    async def test_flush_coalesces_run_llm(self):
        """Multiple deferred run_llm=True frames produce a single LLMRunFrame."""
        from pipecat.frames.frames import LLMMessagesAppendFrame, LLMRunFrame

        agent = _make_voice_agent()
        agent.queue_frame = AsyncMock()
        agent._tool_call_inflight = 1

        # Queue 3 frames with run_llm=True while tool is active
        for content in ("event_a", "event_b", "event_c"):
            await agent.queue_frame_after_tools(
                LLMMessagesAppendFrame(
                    messages=[{"role": "user", "content": content}], run_llm=True
                )
            )
        assert len(agent._deferred_frames) == 3

        agent._tool_call_inflight = 0
        await agent._flush_deferred_frames()

        # 3 AppendFrames (all run_llm=False) + 1 LLMRunFrame at the end
        assert agent.queue_frame.call_count == 4
        flushed = [call.args[0] for call in agent.queue_frame.call_args_list]
        appends = [f for f in flushed if isinstance(f, LLMMessagesAppendFrame)]
        runs = [f for f in flushed if isinstance(f, LLMRunFrame)]
        assert all(f.run_llm is False for f in appends)
        assert len(runs) == 1
        # All messages preserved in order
        assert [f.messages[0]["content"] for f in appends] == ["event_a", "event_b", "event_c"]

    async def test_flush_single_frame_sends_run_frame(self):
        """A single deferred frame with run_llm=True still produces an LLMRunFrame."""
        from pipecat.frames.frames import LLMMessagesAppendFrame, LLMRunFrame

        agent = _make_voice_agent()
        agent.queue_frame = AsyncMock()
        agent._tool_call_inflight = 1
        await agent.queue_frame_after_tools(
            LLMMessagesAppendFrame(messages=[{"role": "user", "content": "only"}], run_llm=True)
        )
        agent._tool_call_inflight = 0
        await agent._flush_deferred_frames()

        assert agent.queue_frame.call_count == 2
        flushed = [call.args[0] for call in agent.queue_frame.call_args_list]
        assert isinstance(flushed[0], LLMMessagesAppendFrame)
        assert flushed[0].run_llm is False
        assert isinstance(flushed[1], LLMRunFrame)

    async def test_flush_no_run_llm_skips_run_frame(self):
        """Deferred frames with run_llm=False don't produce an LLMRunFrame."""
        from pipecat.frames.frames import LLMMessagesAppendFrame, LLMRunFrame

        agent = _make_voice_agent()
        agent.queue_frame = AsyncMock()
        agent._tool_call_inflight = 1
        await agent.queue_frame_after_tools(
            LLMMessagesAppendFrame(messages=[{"role": "user", "content": "a"}], run_llm=False)
        )
        agent._tool_call_inflight = 0
        await agent._flush_deferred_frames()

        assert agent.queue_frame.call_count == 1
        flushed = [call.args[0] for call in agent.queue_frame.call_args_list]
        assert isinstance(flushed[0], LLMMessagesAppendFrame)
        assert not any(isinstance(f, LLMRunFrame) for f in flushed)

    async def test_process_deferred_tool_frames_hook(self):
        """process_deferred_tool_frames coalesces run_llm and appends LLMRunFrame."""
        from pipecat.frames.frames import LLMMessagesAppendFrame, LLMRunFrame

        agent = _make_voice_agent()
        frames = [
            LLMMessagesAppendFrame(messages=[{"role": "user", "content": "a"}], run_llm=True),
            LLMMessagesAppendFrame(messages=[{"role": "user", "content": "b"}], run_llm=True),
            LLMMessagesAppendFrame(messages=[{"role": "user", "content": "c"}], run_llm=False),
        ]
        result = await agent.process_deferred_tool_frames(frames)
        # All run_llm suppressed, single LLMRunFrame appended
        appends = [f for f in result if isinstance(f, LLMMessagesAppendFrame)]
        runs = [f for f in result if isinstance(f, LLMRunFrame)]
        assert all(f.run_llm is False for f in appends)
        assert len(runs) == 1
        assert len(result) == 4  # 3 appends + 1 run frame


# ── Task tool handlers ────────────────────────────────────────────────


@pytest.mark.unit
class TestHandleStopTask:
    async def test_stop_specific_task(self):
        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent
        from gradientbang.subagents.agents.base_agent import TaskGroup

        agent = _make_voice_agent()
        agent.cancel_task = AsyncMock()
        child = MagicMock(spec=TaskAgent)
        child.name = "task_abc123"
        child._is_corp_ship = False
        agent._children = [child]
        agent._task_groups = {"tid-1": TaskGroup(task_id="tid-1", agent_names={"task_abc123"})}
        params = MagicMock()
        params.arguments = {"task_id": "abc123"}
        result = await agent._handle_stop_task(params)
        assert result["success"] is True
        agent.cancel_task.assert_called_once_with("tid-1", reason="Cancelled by user")

    async def test_stop_player_ship_default(self):
        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent
        from gradientbang.subagents.agents.base_agent import TaskGroup

        agent = _make_voice_agent()
        agent.cancel_task = AsyncMock()
        child = MagicMock(spec=TaskAgent)
        child.name = "task_abc123"
        child._is_corp_ship = False
        agent._children = [child]
        agent._task_groups = {"tid-1": TaskGroup(task_id="tid-1", agent_names={"task_abc123"})}
        params = MagicMock()
        params.arguments = {}
        result = await agent._handle_stop_task(params)
        assert result["success"] is True

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
        agent._children = [child]
        agent._task_groups = {"tid-1": TaskGroup(task_id="tid-1", agent_names={"task_abc123"})}
        params = MagicMock()
        params.arguments = {"task_id": "abc123", "message": "Change course"}
        result = await agent._handle_steer_task(params)
        assert result["success"] is True
        sent = agent.send_message.call_args[0][0]
        assert isinstance(sent, BusSteerTaskMessage)
        assert sent.target == "task_abc123"
        assert sent.task_id == "tid-1"

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


# ── Corp ship routing guard ───────────────────────────────────────────


@pytest.mark.unit
class TestCorpShipRouting:
    """Verify start_task correctly classifies personal vs corp ship tasks."""

    @pytest.mark.asyncio
    async def test_personal_ship_id_treated_as_player_task(self):
        """If the LLM passes a UUID that isn't a corp ship, treat as player task."""
        agent = _make_voice_agent()
        # _is_corp_ship_id returns False for an unknown ship
        agent._VoiceAgent__game_client._request = AsyncMock(
            return_value=_corp_api_response()
        )
        agent._VoiceAgent__game_client.base_url = "http://localhost"

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

    @pytest.mark.asyncio
    async def test_character_id_as_ship_id_treated_as_player_task(self):
        """If the LLM passes the player's own character_id as ship_id, treat as player task."""
        # Use a valid UUID as character_id so it passes _is_valid_uuid
        char_id = "11111111-1111-1111-1111-111111111111"
        agent = _make_voice_agent(character_id=char_id)
        agent._VoiceAgent__game_client.base_url = "http://localhost"

        params = MagicMock()
        params.arguments = {
            "task_description": "Go to sector 5",
            "ship_id": char_id,  # Same as the agent's character_id
        }

        agent.add_agent = AsyncMock()

        result = await agent._handle_start_task(params)
        assert result["success"] is True
        assert result["task_type"] == "player_ship"

    @pytest.mark.asyncio
    async def test_no_ship_id_is_player_task(self):
        """Default: no ship_id means player task."""
        agent = _make_voice_agent()
        agent._VoiceAgent__game_client.base_url = "http://localhost"

        params = MagicMock()
        params.arguments = {"task_description": "Go to sector 5"}

        agent.add_agent = AsyncMock()

        result = await agent._handle_start_task(params)
        assert result["success"] is True
        assert result["task_type"] == "player_ship"
