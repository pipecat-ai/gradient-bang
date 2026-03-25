"""E2E tests for corp ship tasks, garrison combat isolation, and ship lifecycle events.

Requires a running Supabase instance with edge functions.
Run via: bash scripts/run-integration-tests.sh -v -k test_corp_garrison_ship

Tests the Python agent pipeline: EventRelay routing, bus delivery, context
isolation, and RTVI output. Game server mechanics are already covered by Deno tests.
"""

import asyncio
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from pipecat.services.llm_service import FunctionCallParams

from gradientbang.utils.legacy_ids import canonicalize_character_id

from .e2e_harness import (
    E2EHarness,
    EdgeAPI,
    create_corp_ship_direct,
    create_corporation_direct,
)

# Edge function cold starts can be slow
pytestmark = pytest.mark.timeout(120)


# ── Fixtures ──────────────────────────────────────────────────────────────


@pytest.fixture
async def edge_api(supabase_url, supabase_service_role_key):
    api = EdgeAPI(supabase_url, supabase_service_role_key)
    yield api
    await api.close()


# ── Corp ship task isolation ──────────────────────────────────────────────


@pytest.mark.integration
class TestCorpShipTaskIsolation:
    """Corp ship events reach TaskAgent but don't bleed into VoiceAgent LLM."""

    @pytest.fixture(autouse=True)
    async def setup(self, reset_db_with_characters, edge_api, make_game_client,
                    supabase_url, supabase_service_role_key):
        await reset_db_with_characters(["test_corp_task_p1"])
        self.character_id = canonicalize_character_id("test_corp_task_p1")
        self.api = edge_api
        self.make_game_client = make_game_client

        # Create a real corporation and corp ship in the DB
        self.corp_id = await create_corporation_direct(
            supabase_url, supabase_service_role_key, self.character_id, "Test Corp"
        )
        self.corp_ship_id = await create_corp_ship_direct(
            supabase_url, supabase_service_role_key, self.corp_id, sector=0,
            ship_name="Corp Scout",
        )

    async def test_corp_ship_event_does_not_reach_voice_llm(self):
        """Corp ship movement events are broadcast to bus but suppressed from voice LLM."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # Long script so task stays alive
            h.set_task_script([("my_status", {})] * 5)
            result = await h.start_corp_ship_task(self.corp_ship_id)
            assert result["success"] is True, f"start_task failed: {result}"

            # Let task agent start
            await asyncio.sleep(1.0)

            # Clear frames from join/setup
            h.llm_frames.clear()
            h.bus_events.clear()

            # Inject a movement event for the corp ship.
            # The event is direct-scoped to the corp ship, not the player.
            # Use recipient_ids/recipient_reasons so the relay correctly
            # resolves the player as a non-direct recipient.
            await h.relay._relay_event({
                "event_name": "movement.complete",
                "payload": {
                    "player": {"id": self.corp_ship_id},
                    "sector": 5,
                    "__event_context": {
                        "scope": "direct",
                        "character_id": self.corp_ship_id,
                        "recipient_ids": [self.corp_ship_id],
                        "recipient_reasons": ["direct"],
                    },
                },
            })

            # Bus should have received the broadcast
            movement_bus = [
                e for e in h.bus_events if e.get("event_name") == "movement.complete"
            ]
            assert len(movement_bus) >= 1, (
                f"Expected movement.complete on bus. Got: {[e.get('event_name') for e in h.bus_events]}"
            )

            # VoiceAgent LLM should NOT have the movement event
            # (DIRECT scope, character_id != player character_id)
            movement_llm = [
                c for c, _ in h.llm_messages if "movement.complete" in c
            ]
            assert len(movement_llm) == 0, (
                f"Corp ship movement should NOT appear in voice LLM. "
                f"Got: {[c[:80] for c, _ in h.llm_messages]}"
            )
        finally:
            await h.stop()

    async def test_corp_ship_task_completion_notifies_voice_and_rtvi(self):
        """Corp ship task completion injects into VoiceAgent LLM and RTVI with task_type='corp_ship'."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # Short script: one tool call then auto-finish
            h.set_task_script([("my_status", {})])
            result = await h.start_corp_ship_task(self.corp_ship_id)
            assert result["success"] is True, f"start_task failed: {result}"

            completed = await h.wait_for_task_complete(timeout=30.0)
            assert completed, "Corp ship task did not complete within timeout"

            # VoiceAgent LLM should have task.completed with corp_ship type
            completion_msgs = [
                c for c, _ in h.llm_messages
                if "task.completed" in c and 'task_type="corp_ship"' in c
            ]
            assert len(completion_msgs) >= 1, (
                f"Expected task.completed with task_type='corp_ship' in voice LLM. "
                f"Got: {[c[:100] for c, _ in h.llm_messages]}"
            )

            # RTVI should have task_output with task_type=corp_ship
            task_outputs = h.rtvi_events_of_type("task_output")
            corp_outputs = [
                t for t in task_outputs if t.get("task_type") == "corp_ship"
            ]
            assert len(corp_outputs) >= 1, (
                f"Expected RTVI task_output with task_type='corp_ship'. "
                f"Got: {task_outputs}"
            )
        finally:
            await h.stop()

    async def test_corp_ship_task_cancellation_notifies_voice(self):
        """Cancelling a corp ship task injects task.cancelled into VoiceAgent LLM."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # Use a gate to pause the ScriptedLLM so the task stays alive.
            # Gate starts CLOSED — LLM blocks before its first tool call.
            h._task_llm_gate = asyncio.Event()
            h.set_task_script([("my_status", {})] * 10)
            result = await h.start_corp_ship_task(self.corp_ship_id)
            assert result["success"] is True, f"start_task failed: {result}"

            # Poll until task group appears (pipeline build is async)
            for _ in range(40):
                if h.voice_agent._task_groups:
                    break
                await asyncio.sleep(0.05)
            assert len(h.voice_agent._task_groups) > 0, "Task should be active"

            # Cancel the task while it's blocked on the gate.
            # _find_task_agent_by_prefix prepends "task_", so pass just the hex suffix.
            task_prefix = result["task_id"].removeprefix("task_")
            params = MagicMock(spec=FunctionCallParams)
            params.arguments = {"task_id": task_prefix}
            params.result_callback = AsyncMock()
            stop_result = await h.voice_agent._handle_stop_task(params)
            assert stop_result.get("success") is True, f"stop_task failed: {stop_result}"

            # Open the gate so cleanup can proceed
            h._task_llm_gate.set()
            await asyncio.sleep(1.0)

            # VoiceAgent LLM should have task.cancelled
            cancelled_msgs = [
                c for c, _ in h.llm_messages if "task.cancelled" in c
            ]
            assert len(cancelled_msgs) >= 1, (
                f"Expected task.cancelled in voice LLM. "
                f"Got: {[c[:80] for c, _ in h.llm_messages]}"
            )

            # RTVI should have cancellation output
            task_outputs = h.rtvi_events_of_type("task_output")
            cancelled_outputs = [
                t for t in task_outputs
                if t.get("payload", {}).get("task_message_type") == "cancelled"
            ]
            assert len(cancelled_outputs) >= 1, (
                f"Expected RTVI task_output with cancelled type. Got: {task_outputs}"
            )
        finally:
            # Ensure gate is open so stop() doesn't hang
            if h._task_llm_gate:
                h._task_llm_gate.set()
            await h.stop()


# ── Garrison combat isolation ─────────────────────────────────────────────


@pytest.mark.integration
class TestGarrisonCombatIsolation:
    """Corp ship combat must NOT put the player into combat state."""

    @pytest.fixture(autouse=True)
    async def setup(self, reset_db_with_characters, edge_api, make_game_client):
        await reset_db_with_characters(["test_garrison_p1"])
        self.character_id = canonicalize_character_id("test_garrison_p1")
        self.api = edge_api
        self.make_game_client = make_game_client

    async def test_corp_ship_combat_does_not_cancel_player_task(self):
        """REGRESSION: Corp ship garrison encounter must not cancel player tasks."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # Start a player task (long-running)
            h.set_task_script([("my_status", {})] * 10)
            result = await h.start_player_task("Long running player task")
            assert result["success"] is True

            await asyncio.sleep(1.0)
            await h.poll_and_feed_events()
            assert len(h.voice_agent._task_groups) > 0, "Player task should be active"

            # Inject combat event for a CORP SHIP (not the player)
            corp_ship_id = str(uuid.uuid4())
            await h.inject_combat_event(
                "cbt-garrison-corp",
                [{"id": corp_ship_id}, {"id": "garrison-npc-001"}],
            )

            await asyncio.sleep(0.5)

            # Player task should STILL be active
            assert len(h.voice_agent._task_groups) > 0, (
                f"Player task should NOT be cancelled by corp ship combat. "
                f"Active groups: {list(h.voice_agent._task_groups.keys())}"
            )

            # Verify the check: player is NOT a participant
            assert h.voice_agent._is_player_combat_participant(
                {"participants": [{"id": corp_ship_id}, {"id": "garrison-npc-001"}]}
            ) is False
        finally:
            await h.stop()

    async def test_player_combat_still_cancels_player_task(self):
        """Counterpart: player combat still correctly cancels player tasks."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # Start a player task
            h.set_task_script([("my_status", {})] * 10)
            result = await h.start_player_task("Long running player task")
            assert result["success"] is True

            await asyncio.sleep(1.0)
            await h.poll_and_feed_events()
            assert len(h.voice_agent._task_groups) > 0, "Player task should be active"

            # Inject combat event with PLAYER as participant
            await h.inject_combat_event(
                "cbt-player",
                [{"id": self.character_id}, {"id": "enemy-npc-001"}],
            )

            await asyncio.sleep(0.5)

            # Player task should be cancelled
            assert len(h.voice_agent._task_groups) == 0, (
                f"Player task should be cancelled by player combat. "
                f"Active groups: {list(h.voice_agent._task_groups.keys())}"
            )

            # VoiceAgent LLM should have the combat event
            combat_msgs = [
                c for c, _ in h.llm_messages if "combat.round_waiting" in c
            ]
            assert len(combat_msgs) >= 1, (
                f"Expected combat.round_waiting in voice LLM. "
                f"Got: {[c[:80] for c, _ in h.llm_messages]}"
            )
        finally:
            await h.stop()


# ── Ship lifecycle events ─────────────────────────────────────────────────


@pytest.mark.integration
class TestShipLifecycleEvents:
    """Ship destruction and purchase events route correctly through the pipeline."""

    @pytest.fixture(autouse=True)
    async def setup(self, reset_db_with_characters, edge_api, make_game_client):
        await reset_db_with_characters(["test_ship_life_p1"])
        self.character_id = canonicalize_character_id("test_ship_life_p1")
        self.api = edge_api
        self.make_game_client = make_game_client

    async def test_ship_destroyed_event_reaches_rtvi_and_voice(self):
        """ship.destroyed events reach both RTVI and VoiceAgent LLM."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # Clear frames from join
            h.llm_frames.clear()

            # Inject ship.destroyed as a direct-scope event for the player
            await h.relay._relay_event({
                "event_name": "ship.destroyed",
                "payload": {
                    "ship_id": "some-destroyed-ship",
                    "ship_type": "kestrel_courier",
                    "player": {"id": self.character_id},
                    "__event_context": {
                        "scope": "direct",
                        "recipient_ids": [self.character_id],
                        "recipient_reasons": ["direct"],
                    },
                },
            })

            # RTVI should have received the event
            assert h.rtvi_push_count > 0, "RTVI should have received ship.destroyed"

            # VoiceAgent LLM should have the event (direct scope, matching character)
            destroyed_msgs = [
                c for c, _ in h.llm_messages if "ship.destroyed" in c
            ]
            assert len(destroyed_msgs) >= 1, (
                f"Expected ship.destroyed in voice LLM. "
                f"Got: {[c[:80] for c, _ in h.llm_messages]}"
            )

            # Bus should have the broadcast
            destroyed_bus = [
                e for e in h.bus_events if e.get("event_name") == "ship.destroyed"
            ]
            assert len(destroyed_bus) >= 1
        finally:
            await h.stop()

    async def test_corp_ship_purchased_only_with_tracked_request_id(self):
        """corporation.ship_purchased only appears in voice LLM when request_id is tracked."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()

            # Clear frames from join
            h.llm_frames.clear()
            initial_rtvi_count = h.rtvi_push_count

            # Inject corp event WITHOUT a tracked request_id
            await h.relay._relay_event({
                "event_name": "corporation.ship_purchased",
                "request_id": "unknown-req-001",
                "payload": {
                    "ship_id": "new-ship-aaa",
                    "ship_type": "kestrel_courier",
                    "__event_context": {"scope": "corp"},
                },
            })

            # Inject corp event WITH a tracked request_id
            h.voice_agent.track_request_id("tracked-req-002")
            await h.relay._relay_event({
                "event_name": "corporation.ship_purchased",
                "request_id": "tracked-req-002",
                "payload": {
                    "ship_id": "new-ship-bbb",
                    "ship_type": "sparrow_scout",
                    "__event_context": {"scope": "corp"},
                },
            })

            # Only the tracked event should appear in voice LLM
            purchased_msgs = [
                c for c, _ in h.llm_messages if "corporation.ship_purchased" in c
            ]
            assert len(purchased_msgs) == 1, (
                f"Expected exactly 1 corporation.ship_purchased in voice LLM (the tracked one). "
                f"Got {len(purchased_msgs)}: {[c[:100] for c, _ in h.llm_messages]}"
            )
            assert "new-ship-bbb" in purchased_msgs[0] or "sparrow_scout" in purchased_msgs[0], (
                f"The LLM message should be from the tracked request. Got: {purchased_msgs[0][:100]}"
            )

            # RTVI should have received BOTH events
            assert h.rtvi_push_count > initial_rtvi_count, "RTVI should receive corp events"
        finally:
            await h.stop()
