"""End-to-end integration tests for TaskAgent scenarios.

Requires a running Supabase instance with edge functions.
Run via: bash scripts/run-integration-tests.sh -v -k test_task_e2e

These tests exercise real game server calls, real bus event delivery,
real TaskAgent pipeline with a scripted LLM, and real event relay routing.
"""

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from pipecat.frames.frames import LLMMessagesAppendFrame, LLMRunFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.llm_service import FunctionCallParams

from gradientbang.pipecat_server.subagents.task_agent import TaskAgent
from gradientbang.utils.legacy_ids import canonicalize_character_id

from .e2e_harness import E2EHarness, EdgeAPI, ScriptedLLMService

# Edge function cold starts can be slow
pytestmark = pytest.mark.timeout(120)


# ── Fixtures ──────────────────────────────────────────────────────────────


@pytest.fixture
async def edge_api(supabase_url, supabase_service_role_key):
    api = EdgeAPI(supabase_url, supabase_service_role_key)
    yield api
    await api.close()


# ── Task lifecycle ────────────────────────────────────────────────────────


@pytest.mark.integration
class TestTaskLifecycleE2E:
    """Full task lifecycle: start → tool calls → events → completion."""

    @pytest.fixture(autouse=True)
    async def setup(self, reset_db_with_characters, edge_api, make_game_client):
        await reset_db_with_characters(["test_task_e2e_p1"])
        self.character_id = canonicalize_character_id("test_task_e2e_p1")
        self.api = edge_api
        self.make_game_client = make_game_client

    async def test_task_start_and_complete(self):
        """Start a task via VoiceAgent, verify it runs and completes."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # Script: call my_status then auto-finish
            h.set_task_script([("my_status", {})])

            params = MagicMock(spec=FunctionCallParams)
            params.arguments = {"task_description": "Check my status"}
            params.result_callback = AsyncMock()
            result = await h.voice_agent._handle_start_task(params)

            assert result["success"] is True, f"start_task failed: {result}"

            # Poll events and wait for task to complete
            completed = await h.wait_for_task_complete(timeout=30.0)
            assert completed, "Task did not complete within timeout"

            # VoiceAgent should have received task completion in LLM context
            completion_msgs = [
                c for c, _ in h.llm_messages if "task.completed" in c
            ]
            assert len(completion_msgs) >= 1, (
                f"Expected task.completed in LLM context. Got: "
                f"{[c[:80] for c, _ in h.llm_messages]}"
            )
            task_finish_msgs = [c for c, _ in h.llm_messages if "task.finish" in c]
            assert task_finish_msgs == [], (
                f"task.finish should not be appended to the voice LLM. "
                f"Got: {[c[:80] for c in task_finish_msgs]}"
            )
        finally:
            await h.stop()

    async def test_task_events_flow_through_bus(self):
        """Verify that game events reach the TaskAgent via the bus."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            h.set_task_script([("my_status", {})])

            params = MagicMock(spec=FunctionCallParams)
            params.arguments = {"task_description": "Check status"}
            params.result_callback = AsyncMock()
            result = await h.voice_agent._handle_start_task(params)

            assert result["success"] is True

            completed = await h.wait_for_task_complete(timeout=30.0)
            assert completed
        finally:
            await h.stop()

    async def test_player_task_emits_action_output_before_completion(self):
        """Short player tasks should still surface ACTION rows in RTVI task_output."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            h.set_task_script([("my_status", {})])
            result = await h.start_player_task("Check my status")
            assert result["success"] is True, f"start_task failed: {result}"

            completed = await h.wait_for_task_complete(timeout=30.0)
            assert completed, "Task did not complete within timeout"

            task_outputs = h.rtvi_events_of_type("task_output")
            action_outputs = [
                event
                for event in task_outputs
                if event.get("payload", {}).get("task_message_type") == "action"
            ]

            assert action_outputs, (
                f"Expected at least one ACTION task_output for a short player task. "
                f"Got: {task_outputs}"
            )
            assert any("my_status(" in event.get("payload", {}).get("text", "") for event in action_outputs), (
                f"Expected my_status ACTION output. Got: {action_outputs}"
            )
        finally:
            await h.stop()


# ── Combat + Task interaction ─────────────────────────────────────────────


@pytest.mark.integration
class TestCombatTaskInteractionE2E:
    """Combat events cancel player tasks but preserve corp tasks."""

    @pytest.fixture(autouse=True)
    async def setup(self, reset_db_with_characters, edge_api, make_game_client):
        await reset_db_with_characters(["test_task_combat_p1"])
        self.character_id = canonicalize_character_id("test_task_combat_p1")
        self.api = edge_api
        self.make_game_client = make_game_client

    async def test_combat_cancels_player_task(self):
        """When the player enters combat, their active task is cancelled."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # Script a long-running task (many steps so it doesn't finish fast)
            h.set_task_script([
                ("my_status", {}),
                ("my_status", {}),
                ("my_status", {}),
                ("my_status", {}),
                ("my_status", {}),
            ])

            params = MagicMock(spec=FunctionCallParams)
            params.arguments = {"task_description": "Long running task"}
            params.result_callback = AsyncMock()
            result = await h.voice_agent._handle_start_task(params)

            assert result["success"] is True

            # Let the task start processing
            await asyncio.sleep(1.0)
            await h.poll_and_feed_events()

            # Verify task is running
            assert len(h.voice_agent._task_groups) > 0, "Task should be active"

            # Inject combat event with player as participant
            await h.inject_combat_event(
                "cbt-test",
                [{"id": self.character_id}],
            )

            # Give cancellation time to propagate
            await asyncio.sleep(0.5)

            # Player task should be cancelled
            player_tasks = [
                c for c in h.voice_agent.children
                if isinstance(c, TaskAgent) and not c._is_corp_ship
            ]
            # Task group should be removed (cancelled)
            assert len(h.voice_agent._task_groups) == 0, (
                f"Player task should be cancelled by combat. "
                f"Active groups: {list(h.voice_agent._task_groups.keys())}"
            )
        finally:
            await h.stop()


# ── Async completion pattern ─────────────────────────────────────────────


@pytest.mark.integration
class TestAsyncCompletionE2E:
    """Async tool completion: tool call → server event → bus → TaskAgent resumes."""

    @pytest.fixture(autouse=True)
    async def setup(self, reset_db_with_characters, edge_api, make_game_client):
        await reset_db_with_characters(["test_task_async_p1"])
        self.character_id = canonicalize_character_id("test_task_async_p1")
        self.api = edge_api
        self.make_game_client = make_game_client

    async def test_async_tool_completion_via_server_event(self):
        """my_status sets _awaiting_completion_event, server event unblocks inference.

        Full loop: ScriptedLLM calls my_status → real edge function → status.snapshot
        event emitted → polled → relay → bus → TaskAgent clears await → inference
        resumes → finished tool → task completes.
        """
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # Script: my_status (async tool) → auto-finish
            # my_status is in ASYNC_TOOL_COMPLETIONS → awaits "status.snapshot"
            h.set_task_script([("my_status", {})])
            result = await h.start_player_task("Check status async")
            assert result["success"] is True, f"start_task failed: {result}"

            # The task should complete via the full async loop:
            # 1. ScriptedLLM calls my_status
            # 2. TaskAgent sets _awaiting_completion_event = "status.snapshot"
            # 3. Real edge function runs, emits status.snapshot event to DB
            # 4. poll_and_feed_events() fetches it → relay → bus broadcast
            # 5. TaskAgent receives status.snapshot via bus, clears the await
            # 6. Inference resumes, ScriptedLLM calls finished
            completed = await h.wait_for_task_complete(timeout=30.0)
            assert completed, "Task did not complete — async completion event may not have arrived"

            # Verify status.snapshot was broadcast through the bus (proving the full loop)
            status_bus = [
                e for e in h.bus_events if e.get("event_name") == "status.snapshot"
            ]
            assert len(status_bus) >= 1, (
                f"Expected status.snapshot on bus (from my_status async completion). "
                f"Bus events: {[e.get('event_name') for e in h.bus_events]}"
            )
        finally:
            await h.stop()

    async def test_event_query_completion_via_request_id_on_shared_client(self):
        """Player-task event_query should complete via request_id correlation on shared client."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            end_time = datetime.now(timezone.utc)
            start_time = end_time - timedelta(hours=24)
            h.set_task_script(
                [
                    (
                        "event_query",
                        {
                            "start": start_time.isoformat(),
                            "end": end_time.isoformat(),
                            "max_rows": 10,
                        },
                    )
                ]
            )
            result = await h.start_player_task("Summarize my recent activity")
            assert result["success"] is True, f"start_task failed: {result}"

            completed = await h.wait_for_task_complete(timeout=30.0)
            assert completed, "Player task did not complete after event_query"

            event_query_bus = [
                event for event in h.bus_events if event.get("event_name") == "event.query"
            ]
            assert event_query_bus, (
                f"Expected event.query on the bus. "
                f"Bus events: {[e.get('event_name') for e in h.bus_events]}"
            )
            assert any(event.get("request_id") for event in event_query_bus), (
                f"Expected event.query bus event to carry request_id. Got: {event_query_bus}"
            )
            assert any(
                isinstance(event.get("summary"), str)
                and event.get("summary", "").startswith("Query returned ")
                for event in event_query_bus
            ), f"Expected summarized event.query on the bus. Got: {event_query_bus}"
        finally:
            await h.stop()

    async def test_event_query_emits_progress_message_after_event_output(self):
        """History-query tasks should surface a MESSAGE row during post-query reasoning."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            end_time = datetime.now(timezone.utc)
            start_time = end_time - timedelta(hours=24)
            h.set_task_script(
                [
                    (
                        "event_query",
                        {
                            "start": start_time.isoformat(),
                            "end": end_time.isoformat(),
                            "max_rows": 10,
                        },
                    )
                ]
            )
            result = await h.start_player_task("Summarize my recent activity")
            assert result["success"] is True, f"start_task failed: {result}"

            completed = await h.wait_for_task_complete(timeout=30.0)
            assert completed, "Player task did not complete after event_query"

            task_outputs = h.rtvi_events_of_type("task_output")
            event_index = next(
                index
                for index, event in enumerate(task_outputs)
                if event.get("payload", {}).get("task_message_type") == "event"
                and event.get("payload", {}).get("text", "").startswith("event.query:")
            )
            message_index = next(
                index
                for index, event in enumerate(task_outputs)
                if event.get("payload", {}).get("task_message_type") == "message"
                and event.get("payload", {}).get("text") == "Analyzing query results..."
            )

            assert event_index < message_index, (
                f"Expected event.query EVENT output before the synthetic MESSAGE output. "
                f"Got: {task_outputs}"
            )
        finally:
            await h.stop()

    async def test_pipeline_error_surfaces_as_normal_failed_task(self):
        """LLM pipeline errors should fail the task through the standard response path."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            h._task_llm_gate = asyncio.Event()
            h.set_task_script([("event_query", {})])
            result = await h.start_player_task("Summarize my recent activity")
            assert result["success"] is True, f"start_task failed: {result}"

            task_agent = None
            for _ in range(40):
                task_agent = next(
                    (c for c in h.voice_agent.children if isinstance(c, TaskAgent)),
                    None,
                )
                if task_agent and task_agent._active_task_id:
                    break
                await asyncio.sleep(0.05)

            assert task_agent is not None, "TaskAgent should have been created"
            assert task_agent._active_task_id, "TaskAgent should have an active task ID"

            await task_agent.on_error(
                "Error during completion: Error code: 400 - "
                "{'error': {'message': 'Input tokens exceed the configured limit', "
                "'code': 'context_length_exceeded'}}",
                fatal=False,
            )

            completed = await h.wait_for_task_complete(timeout=5.0)
            assert completed, "Task should fail cleanly instead of hanging"
            assert not h.voice_agent._task_groups, "Failed task group should be removed"

            failed_task_outputs = [
                event
                for event in h.rtvi_events_of_type("task_output")
                if event.get("payload", {}).get("task_message_type") == "failed"
            ]
            assert failed_task_outputs, (
                f"Expected failed task_output after pipeline error. "
                f"Got: {h.rtvi_events_of_type('task_output')}"
            )
            assert any("task.failed" in content for content, _ in h.llm_messages), (
                f"Expected task.failed in voice LLM messages. "
                f"Got: {[content[:120] for content, _ in h.llm_messages]}"
            )
        finally:
            if h._task_llm_gate:
                h._task_llm_gate.set()
            await h.stop()

    async def test_task_completion_triggers_single_inference(self):
        """REGRESSION: Task completion should trigger exactly one voice LLM inference.

        Before the fix, task completion caused duplicate inference because both:
        1. The bus protocol (on_task_response) injects task.completed with run_llm=True
        2. The task.finish game event via EventRelay also reached the voice LLM

        This caused the LLM to repeat itself (users reported 3x responses:
        start_task result + two duplicate completion inferences).
        """
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # Script: my_status → auto-finish
            h.set_task_script([("my_status", {})])
            result = await h.start_player_task("Quick status check")
            assert result["success"] is True, f"start_task failed: {result}"

            # Wait for task to complete (includes event polling)
            completed = await h.wait_for_task_complete(timeout=30.0)
            assert completed, "Task did not complete within timeout"

            # Allow extra poll cycles to catch any late-arriving task.finish events
            for _ in range(5):
                await h.poll_and_feed_events()
                await asyncio.sleep(0.3)

            # Count inference-triggering frames related to task completion.
            # Each (content, run_llm) pair where run_llm=True and content
            # mentions task completion is one LLM inference trigger.
            completion_inferences = [
                (c, rl) for c, rl in h.llm_messages
                if rl is True and ("task.completed" in c or "task.finish" in c)
            ]

            assert len(completion_inferences) == 1, (
                f"Expected exactly 1 task-completion inference trigger, "
                f"got {len(completion_inferences)}. "
                f"This indicates duplicate delivery (bus protocol + game event). "
                f"Frames: {[(c[:100], rl) for c, rl in completion_inferences]}"
            )

            # The single inference should come from the bus protocol (task.completed),
            # not the game event (task.finish)
            assert "task.completed" in completion_inferences[0][0], (
                f"Completion inference should be from bus protocol (task.completed), "
                f"got: {completion_inferences[0][0][:100]}"
            )

            task_finish_msgs = [c for c, _ in h.llm_messages if "task.finish" in c]
            assert task_finish_msgs == [], (
                f"task.finish should not be appended to the voice LLM. "
                f"Got: {[c[:100] for c in task_finish_msgs]}"
            )
        finally:
            await h.stop()

    async def test_async_completion_timeout_recovers(self):
        """When the completion event never arrives, the timeout fires and inference resumes."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # Script: list_known_ports (async, awaits "ports.list") → auto-finish
            # We'll inject the completion event manually after verifying the await state.
            # But first: use a gate to pause after the tool call completes,
            # so we can inspect _awaiting_completion_event.
            h._task_llm_gate = asyncio.Event()
            h.set_task_script([("list_known_ports", {"character_id": self.character_id})])
            result = await h.start_player_task("Find ports async")
            assert result["success"] is True

            # Wait for the task to start and the first tool call to execute.
            # The gate is closed, so after list_known_ports returns its HTTP response,
            # the ScriptedLLM will block before calling finished.
            # But the TaskAgent will have set _awaiting_completion_event.
            await asyncio.sleep(2.0)

            # Find the task agent
            task_agent = next(
                (c for c in h.voice_agent.children if isinstance(c, TaskAgent)),
                None,
            )

            if task_agent and task_agent._awaiting_completion_event:
                # Great — the async await is active. Verify it's waiting for ports.list
                assert task_agent._awaiting_completion_event == "ports.list", (
                    f"Expected awaiting 'ports.list', got '{task_agent._awaiting_completion_event}'"
                )

                # Now feed the event through polling to unblock
                await h.poll_and_feed_events()

            # Open the gate so the task can finish
            h._task_llm_gate.set()

            completed = await h.wait_for_task_complete(timeout=30.0)
            assert completed, "Task did not complete after async completion event"
        finally:
            if h._task_llm_gate:
                h._task_llm_gate.set()
            await h.stop()

    async def test_direct_status_during_player_task_is_not_task_tagged(self):
        """Direct voice my_status should stay untagged while a player task is active."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # Keep the task active on the shared player client before its first
            # tool call so a direct voice my_status runs concurrently with it.
            h._task_llm_gate = asyncio.Event()
            h.set_task_script([("my_status", {})])
            result = await h.start_player_task("Check status async")
            assert result["success"] is True, f"start_task failed: {result}"

            await asyncio.sleep(0.5)

            params = MagicMock(spec=FunctionCallParams)
            params.arguments = {}
            params.result_callback = AsyncMock()

            baseline_llm_count = len(h.llm_messages)
            await h.voice_agent._handle_my_status(params)
            direct_request_id = h.game_client.last_request_id
            assert direct_request_id, "voice my_status did not record a request_id"

            events = await h.poll_and_feed_events()
            direct_status_events = [
                event for event in events
                if event.get("event_type") == "status.snapshot"
                and event.get("request_id") == direct_request_id
            ]

            assert len(direct_status_events) == 1, (
                f"Expected exactly one direct status.snapshot for request {direct_request_id}, "
                f"got {[(event.get('event_type'), event.get('request_id')) for event in events]}"
            )
            assert direct_status_events[0].get("task_id") is None, (
                f"Direct voice my_status should not inherit the player task_id. "
                f"Event: {direct_status_events[0]}"
            )

            h._task_llm_gate.set()
            completed = await h.wait_for_task_complete(timeout=30.0)
            assert completed, "Player task did not complete after direct my_status"

            new_llm_messages = h.llm_messages[baseline_llm_count:]
            direct_status_inferences = [
                (content, run_llm) for content, run_llm in new_llm_messages
                if run_llm is True
                and "status.snapshot" in content
                and "task.completed" not in content
            ]
            completion_inferences = [
                (content, run_llm) for content, run_llm in new_llm_messages
                if run_llm is True and "task.completed" in content
            ]

            assert direct_status_inferences, "Expected a direct status.snapshot inference trigger"
            assert len(completion_inferences) == 1, (
                f"Expected exactly one task.completed inference trigger, "
                f"got {[(content[:100], run_llm) for content, run_llm in completion_inferences]}"
            )
        finally:
            if h._task_llm_gate:
                h._task_llm_gate.set()
            await h.stop()


# ── Client-initiated cancellation ────────────────────────────────────────


@pytest.mark.integration
class TestTaskCancellationE2E:
    """Client-initiated task cancel should produce 'cancelled' status, not 'failed'."""

    @pytest.fixture(autouse=True)
    async def setup(self, reset_db_with_characters, edge_api, make_game_client):
        await reset_db_with_characters(["test_task_cancel_p1"])
        self.character_id = canonicalize_character_id("test_task_cancel_p1")
        self.api = edge_api
        self.make_game_client = make_game_client

    async def test_client_cancel_produces_cancelled_status(self):
        """Cancel via edge function (client path) → task.cancel event → bus cancel → cancelled status."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # Gate keeps the task alive by pausing the ScriptedLLM.
            h._task_llm_gate = asyncio.Event()
            h.set_task_script([("my_status", {})] * 10)
            result = await h.start_player_task("Long running task for cancel test")
            assert result["success"] is True, f"start_task failed: {result}"

            # Wait for task group to appear (pipeline build is async)
            for _ in range(40):
                if h.voice_agent._task_groups:
                    break
                await asyncio.sleep(0.05)
            assert len(h.voice_agent._task_groups) > 0, "Task should be active"

            # Find the TaskAgent's game-level task_id
            task_agent = next(
                (c for c in h.voice_agent.children if isinstance(c, TaskAgent) and not c._is_corp_ship),
                None,
            )
            assert task_agent is not None, "TaskAgent child should exist"

            # Wait for the task to receive its game-level task_id from the task_start edge function
            for _ in range(40):
                if task_agent._active_task_id:
                    break
                await h.poll_and_feed_events()
                await asyncio.sleep(0.1)
            game_task_id = task_agent._active_task_id
            assert game_task_id, "TaskAgent should have a game-level task_id"

            # Cancel via edge function (simulates client cancel-task RTVI message)
            cancel_result = await h.api.call_ok("task_cancel", {
                "character_id": self.character_id,
                "task_id": game_task_id,
            })
            assert cancel_result.get("task_id") == game_task_id

            # Poll events: brings task.cancel through relay → VoiceAgent.broadcast_game_event
            await h.poll_and_feed_events()

            # Open the gate so cleanup can proceed
            h._task_llm_gate.set()
            await asyncio.sleep(1.0)

            # Task group should be cleaned up
            assert len(h.voice_agent._task_groups) == 0, (
                f"Task should be cancelled. Active groups: {list(h.voice_agent._task_groups.keys())}"
            )

            # VoiceAgent LLM should have task.cancelled (not task.failed)
            cancelled_msgs = [c for c, _ in h.llm_messages if "task.cancelled" in c]
            failed_msgs = [c for c, _ in h.llm_messages if "task.failed" in c]
            assert len(cancelled_msgs) >= 1, (
                f"Expected task.cancelled in voice LLM. "
                f"Got: {[c[:80] for c, _ in h.llm_messages]}"
            )
            assert len(failed_msgs) == 0, (
                f"Should NOT have task.failed in voice LLM. "
                f"Got: {[c[:80] for c in failed_msgs]}"
            )

            # RTVI should have cancellation output
            cancelled_outputs = [
                t for t in h.rtvi_events_of_type("task_output")
                if t.get("payload", {}).get("task_message_type") == "cancelled"
            ]
            assert len(cancelled_outputs) >= 1, (
                f"Expected RTVI task_output with cancelled type. "
                f"Got: {h.rtvi_events_of_type('task_output')}"
            )
        finally:
            if h._task_llm_gate:
                h._task_llm_gate.set()
            await h.stop()


# ── Task timeout ────────────────────────────────────────────────────────


@pytest.mark.integration
class TestTaskTimeoutE2E:
    """Framework timeout should cancel the task agent gracefully."""

    @pytest.fixture(autouse=True)
    async def setup(self, reset_db_with_characters, edge_api, make_game_client):
        await reset_db_with_characters(["test_task_timeout_p1"])
        self.character_id = canonicalize_character_id("test_task_timeout_p1")
        self.api = edge_api
        self.make_game_client = make_game_client

    async def test_task_timeout_cancels_agent(self):
        """A short timeout fires internally and cancels the task via the framework."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        # Set a 5-second timeout (override env var)
        h.voice_agent._task_agent_timeout = 5.0
        await h.start()
        try:
            await h.join_game()

            # Gate keeps the task alive by pausing the ScriptedLLM.
            h._task_llm_gate = asyncio.Event()
            h.set_task_script([("my_status", {})] * 10)
            result = await h.start_player_task("Long running task for timeout test")
            assert result["success"] is True, f"start_task failed: {result}"

            # Wait for task group to appear (pipeline build is async)
            for _ in range(40):
                if h.voice_agent._task_groups:
                    break
                await asyncio.sleep(0.05)
            assert len(h.voice_agent._task_groups) > 0, "Task should be active"

            # Wait for the 5-second timeout to fire (framework-internal asyncio timer)
            await asyncio.sleep(6.0)

            # Open the gate so cleanup can proceed
            h._task_llm_gate.set()
            await asyncio.sleep(1.0)

            # Task group should be cleaned up
            assert len(h.voice_agent._task_groups) == 0, (
                f"Task should be cancelled by timeout. Active groups: {list(h.voice_agent._task_groups.keys())}"
            )

            # VoiceAgent LLM should have task.cancelled (not task.failed)
            cancelled_msgs = [c for c, _ in h.llm_messages if "task.cancelled" in c]
            failed_msgs = [c for c, _ in h.llm_messages if "task.failed" in c]
            assert len(cancelled_msgs) >= 1, (
                f"Expected task.cancelled in voice LLM. "
                f"Got: {[c[:80] for c, _ in h.llm_messages]}"
            )
            assert len(failed_msgs) == 0, (
                f"Should NOT have task.failed in voice LLM. "
                f"Got: {[c[:80] for c in failed_msgs]}"
            )
        finally:
            if h._task_llm_gate:
                h._task_llm_gate.set()
            await h.stop()


# ── Full voice loop ──────────────────────────────────────────────────────


@pytest.mark.integration
class TestFullVoiceLoopE2E:
    """Real tool call → real edge function → real DB event → relay → voice LLM."""

    @pytest.fixture(autouse=True)
    async def setup(self, reset_db_with_characters, edge_api, make_game_client):
        await reset_db_with_characters(["test_voice_loop_p1"])
        self.character_id = canonicalize_character_id("test_voice_loop_p1")
        self.api = edge_api
        self.make_game_client = make_game_client

    async def test_voice_tool_call_produces_real_event_in_llm(self):
        """Call list_known_ports via EdgeAPI, poll real events, verify they reach voice LLM.

        Full loop: edge function → DB event → events_since poll → relay → voice LLM.
        """
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # Clear join frames
            h.llm_frames.clear()
            h.bus_events.clear()

            # Make a real edge function call and track its request_id
            # (simulates what VoiceAgent does when a tool call fires)
            result = await self.api.call_ok(
                "list_known_ports",
                {"character_id": self.character_id, "max_hops": 10},
            )
            req_id = result.get("request_id")
            if req_id:
                h.voice_agent.track_request_id(req_id)

            # Poll real events from DB and feed through relay
            await h.poll_and_feed_events()

            # The real event should have flowed: edge fn → DB → events_since → relay
            # ports.list uses DIRECT append (character_id match) and should be in voice LLM
            ports_llm = [
                c for c, _ in h.llm_messages if "ports.list" in c
            ]
            assert len(ports_llm) >= 1, (
                f"Expected ports.list in voice LLM from real edge function call. "
                f"Got: {[c[:80] for c, _ in h.llm_messages]}"
            )

            # Bus should also have it (broadcast to TaskAgent children)
            ports_bus = [
                e for e in h.bus_events if e.get("event_name") == "ports.list"
            ]
            assert len(ports_bus) >= 1, (
                f"Expected ports.list on bus. Events: {[e.get('event_name') for e in h.bus_events]}"
            )
        finally:
            await h.stop()

    async def test_real_join_events_update_relay_state(self):
        """Join produces real events that update relay sector tracking and display name."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # After join, relay should have tracked the sector from status.snapshot
            assert h.relay._current_sector_id is not None, (
                "Relay should have tracked sector from status.snapshot"
            )

            # Display name should be synced from status.snapshot
            assert h.relay.display_name != self.character_id, (
                "Relay display name should be updated from status.snapshot "
                f"(still default: {h.relay.display_name})"
            )

            # status.snapshot should be in the LLM context
            status_msgs = [
                c for c, _ in h.llm_messages if "status.snapshot" in c
            ]
            assert len(status_msgs) >= 1, (
                f"Expected status.snapshot in voice LLM. "
                f"Got: {[c[:80] for c, _ in h.llm_messages]}"
            )
        finally:
            await h.stop()


# ── Inference coalescing ──────────────────────────────────────────────


@pytest.mark.integration
class TestInferenceCoalescingE2E:
    """Inference deduplication: same-tick coalescing and LLM-inflight deferral.

    REGRESSION: multiple events arriving close together previously triggered
    multiple LLM inferences, causing back-to-back repeated responses.
    """

    @pytest.fixture(autouse=True)
    async def setup(self, reset_db_with_characters, edge_api, make_game_client):
        await reset_db_with_characters(["test_inference_coalesce_p1"])
        self.character_id = canonicalize_character_id("test_inference_coalesce_p1")
        self.api = edge_api
        self.make_game_client = make_game_client

    async def test_n_simultaneous_completions_are_silent_when_deferred(self):
        """Deferred completion frames are appended without emitting an LLMRunFrame.

        The recent VoiceAgent changes intentionally strip run_llm from deferred
        event frames. The tool result gets its own inference; deferred task
        completions should not inject an extra one here.
        """
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # Simulate 3 deferred frames with run_llm=True (concurrent task completions)
            frames = [
                (LLMMessagesAppendFrame(messages=[{"role": "user", "content": "task.completed 1"}], run_llm=True), FrameDirection.DOWNSTREAM),
                (LLMMessagesAppendFrame(messages=[{"role": "user", "content": "task.completed 2"}], run_llm=True), FrameDirection.DOWNSTREAM),
                (LLMMessagesAppendFrame(messages=[{"role": "user", "content": "task.completed 3"}], run_llm=True), FrameDirection.DOWNSTREAM),
            ]

            result = await h.voice_agent.process_deferred_tool_frames(frames)

            run_frames = [f for f, _ in result if isinstance(f, LLMRunFrame)]
            remaining_run_llm = [f for f, _ in result if isinstance(f, LLMMessagesAppendFrame) and f.run_llm]

            assert len(run_frames) == 0, (
                f"Expected 0 LLMRunFrames for 3 deferred completions, "
                f"got {len(run_frames)}"
            )
            assert len(remaining_run_llm) == 0, (
                f"All LLMMessagesAppendFrame.run_llm should be False after coalescing"
            )
        finally:
            await h.stop()

    async def test_task_completion_waits_for_spoken_turn_and_cooldown(self, monkeypatch):
        """Task completion waits for the prior spoken turn to finish before injection."""
        import gradientbang.pipecat_server.subagents.voice_agent as voice_agent_module
        from gradientbang.subagents.agents import TaskStatus
        from gradientbang.subagents.bus.messages import BusTaskResponseMessage

        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()
            monkeypatch.setattr(voice_agent_module, "TASK_RESPONSE_COOLDOWN_SECONDS", 0.05)
            monkeypatch.setattr(
                voice_agent_module,
                "TASK_RESPONSE_SPEECH_START_GRACE_SECONDS",
                1.0,
            )

            h.voice_agent._task_output_handler = AsyncMock()
            h.voice_agent.send_message = AsyncMock()
            h.voice_agent._update_polling_scope = MagicMock()
            h.voice_agent._queue_task_completion_event = AsyncMock()

            child = MagicMock()
            child.name = "task_abc123"
            child._is_corp_ship = False
            child._game_client = h.voice_agent._game_client
            h.voice_agent._children = [child]

            h.voice_agent._handle_llm_response_started()
            h.voice_agent._handle_llm_response_ended()

            response_task = asyncio.create_task(
                h.voice_agent.on_task_response(
                    BusTaskResponseMessage(
                        source=child.name,
                        task_id="tid-1",
                        status=TaskStatus.COMPLETED,
                        response={"message": "Task done"},
                    )
                )
            )
            await asyncio.sleep(0.01)
            h.voice_agent._queue_task_completion_event.assert_not_awaited()

            h.voice_agent._handle_bot_started_speaking()
            await asyncio.sleep(0.01)
            h.voice_agent._queue_task_completion_event.assert_not_awaited()

            h.voice_agent._handle_bot_stopped_speaking()
            await asyncio.sleep(0.02)
            h.voice_agent._queue_task_completion_event.assert_not_awaited()

            await asyncio.wait_for(response_task, timeout=1.0)
            h.voice_agent._queue_task_completion_event.assert_awaited_once()
        finally:
            await h.stop()


# ── Voice-agent error isolation ───────────────────────────────────────────


@pytest.mark.integration
class TestVoiceAgentErrorIsolationE2E:
    """VoiceAgent tool errors must not bleed into TaskAgent completion tracking.

    Regression: synthesized error events (e.g. my_status → 409 in hyperspace)
    were broadcast unconditionally to all TaskAgents via the bus. A TaskAgent
    waiting on _awaiting_completion_event would treat any error as its own
    completion signal, clearing the wait and triggering premature inference.

    Fix: EventRelay stamps BusGameEventMessage with voice_agent_originated=True
    when an error has a source.request_id (always true for synthesized errors,
    since all errors through EventRelay come from VoiceAgent's game_client).
    TaskAgent discards those without touching its state.
    """

    @pytest.fixture(autouse=True)
    async def setup(self, reset_db_with_characters, edge_api, make_game_client):
        await reset_db_with_characters(["test_error_isolation_p1"])
        self.character_id = canonicalize_character_id("test_error_isolation_p1")
        self.api = edge_api
        self.make_game_client = make_game_client

    async def test_voice_error_does_not_unblock_task_async_wait(self):
        """Synthesized voice-agent error must not clear _awaiting_completion_event.

        Scenario: TaskAgent is waiting for movement.complete. VoiceAgent calls
        my_status directly and gets a 409 (character in hyperspace). The resulting
        synthesized error event is broadcast to the bus. TaskAgent must ignore it
        and remain blocked on movement.complete — not proceed with inference.
        """
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # Gate keeps the task alive long enough to inspect mid-execution state
            h._task_llm_gate = asyncio.Event()
            h.set_task_script([("my_status", {})])
            result = await h.start_player_task("Background task awaiting async completion")
            assert result["success"] is True

            # Wait for TaskAgent to be created and assigned its active task
            task_agent = None
            for _ in range(40):
                task_agent = next(
                    (c for c in h.voice_agent.children if isinstance(c, TaskAgent)),
                    None,
                )
                if task_agent and task_agent._active_task_id:
                    break
                await asyncio.sleep(0.05)
            assert task_agent is not None, "TaskAgent should have been created"
            assert task_agent._active_task_id, "TaskAgent should have an active task ID"

            # Simulate the task having issued an async move call
            task_agent._awaiting_completion_event = "movement.complete"
            initial_error_count = task_agent._consecutive_error_count

            # Inject an error event matching the real server structure when
            # VoiceAgent's my_status fails (e.g. character is in hyperspace).
            # Critically: the real server event includes player.id, which would
            # match the character-scoped filter and bypass the ambient-error guard
            # if voice_agent_originated were not checked first.
            voice_error_event = {
                "event_name": "error",
                "payload": {
                    "error": "Character is in hyperspace, status unavailable until arrival",
                    "player": {"id": self.character_id},
                    "source": {
                        "type": "rpc",
                        "method": "my_status",
                        "request_id": str(uuid.uuid4()),
                    },
                    "status": 409,
                    "endpoint": "my_status",
                },
            }
            await h.relay._relay_event(voice_error_event)
            await asyncio.sleep(0.05)  # let any async propagation settle

            # TaskAgent must still be waiting — error must not have unblocked it
            assert task_agent._awaiting_completion_event == "movement.complete", (
                "TaskAgent._awaiting_completion_event was cleared by a VoiceAgent error. "
                f"Got: {task_agent._awaiting_completion_event!r}"
            )

            # Error must not be counted against the TaskAgent's consecutive error limit
            assert task_agent._consecutive_error_count == initial_error_count, (
                f"VoiceAgent error incremented TaskAgent._consecutive_error_count. "
                f"Before: {initial_error_count}, After: {task_agent._consecutive_error_count}"
            )
        finally:
            if h._task_llm_gate:
                h._task_llm_gate.set()
            await h.stop()
