"""End-to-end integration tests for TaskAgent scenarios.

Requires a running Supabase instance with edge functions.
Run via: bash scripts/run-integration-tests.sh -v -k test_task_e2e

These tests exercise real game server calls, real bus event delivery,
real TaskAgent pipeline with a scripted LLM, and real event relay routing.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

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

    async def test_task_completion_triggers_single_inference(self):
        """REGRESSION: Task completion should trigger exactly one voice LLM inference.

        Before the fix, task completion caused duplicate inference because both:
        1. The bus protocol (on_task_response) injects task.completed with run_llm=True
        2. The task.finish game event via EventRelay also triggers run_llm=True

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
