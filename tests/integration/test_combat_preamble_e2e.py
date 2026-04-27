"""E2E tests for the combat preamble — combat.md + ship doctrine in fixed
order ahead of the round-1 combat.round_waiting event.

Asserts the preamble injection logic for *both* the player voice agent
(EventRelay path) and corp-ship task agents (TaskAgent path), since both
must satisfy the same invariant: every ship in combat enters with full
mechanics + its authored doctrine in LLM context, in the order
``combat.md → doctrine → event XML``.

Requires a running Supabase instance with edge functions.
Run via: bash scripts/run-integration-tests.sh -v -k test_combat_preamble
"""

import asyncio
from unittest.mock import AsyncMock

import pytest

from gradientbang.pipecat_server.subagents.task_agent import TaskAgent
from gradientbang.utils.legacy_ids import canonicalize_character_id

from .e2e_harness import (
    E2EHarness,
    EdgeAPI,
    create_corp_ship_direct,
    create_corporation_direct,
    get_ship_id,
)

pytestmark = pytest.mark.timeout(120)


@pytest.fixture
async def edge_api(supabase_url, supabase_service_role_key):
    api = EdgeAPI(supabase_url, supabase_service_role_key)
    yield api
    await api.close()


def _find_index(contents: list[str], predicate) -> int:
    for i, c in enumerate(contents):
        if predicate(c):
            return i
    return -1


def _assert_preamble_order(
    contents: list[str], *, event_match: str
) -> tuple[int, int, int]:
    """Locate combat.md / doctrine / event indices and assert the fixed order.

    Returns (combat_md_idx, doctrine_idx, event_idx). All three must be
    present, and combat.md must precede doctrine, which must precede the
    round_waiting event. ``event_match`` is the substring identifying the
    round_waiting frame (the relay path renders the event as XML attrs
    while the task path uses ``<event name=combat.round_waiting>`` —
    callers pick the right needle for their pipeline).
    """
    combat_md_idx = _find_index(
        contents, lambda c: c.startswith("# Combat reference")
    )
    doctrine_idx = _find_index(
        contents, lambda c: c.startswith("# Your ship's combat strategy")
    )
    event_idx = _find_index(contents, lambda c: event_match in c)

    assert combat_md_idx >= 0, (
        f"combat.md preamble missing from context. Frames: "
        f"{[c[:80] for c in contents]}"
    )
    assert doctrine_idx >= 0, (
        f"Ship doctrine preamble missing. Frames: "
        f"{[c[:80] for c in contents]}"
    )
    assert event_idx >= 0, (
        f"combat.round_waiting event missing. Frames: "
        f"{[c[:80] for c in contents]}"
    )
    assert combat_md_idx < doctrine_idx < event_idx, (
        f"Preamble out of order: combat.md@{combat_md_idx}, "
        f"doctrine@{doctrine_idx}, event@{event_idx}. Order must be "
        f"combat.md → doctrine → event."
    )
    return combat_md_idx, doctrine_idx, event_idx


# ── Player voice agent (EventRelay path) ──────────────────────────────────


@pytest.mark.integration
class TestPlayerCombatPreambleE2E:
    """When the player enters combat, EventRelay injects combat.md +
    doctrine ahead of the round-1 combat.round_waiting event in the
    VoiceAgent's LLM context."""

    @pytest.fixture(autouse=True)
    async def setup(
        self,
        reset_db_with_characters,
        edge_api,
        make_game_client,
        supabase_url,
        supabase_service_role_key,
    ):
        await reset_db_with_characters(["test_combat_preamble_p1"])
        self.character_id = canonicalize_character_id("test_combat_preamble_p1")
        self.api = edge_api
        self.make_game_client = make_game_client
        self.supabase_url = supabase_url
        self.service_key = supabase_service_role_key

    async def test_player_round1_preamble_lands_before_event(self):
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()
            ship_id = await get_ship_id(
                self.supabase_url, self.service_key, self.character_id
            )

            # Clear setup frames so we only assert on the combat sequence.
            h.llm_frames.clear()

            # Round-1 combat.round_waiting where the player is a participant.
            await h.relay._relay_event(
                {
                    "event_name": "combat.round_waiting",
                    "payload": {
                        "combat_id": "cbt-preamble-1",
                        "round": 1,
                        "deadline": "2099-01-01T00:00:30Z",
                        "sector": {"id": 0},
                        "participants": [
                            {
                                "id": self.character_id,
                                "ship_id": ship_id,
                                "ship": {"ship_name": "Test Ship"},
                            },
                            {"id": "char-foe", "ship_id": "ship-foe"},
                        ],
                        "__event_context": {"scope": "direct", "reason": "direct"},
                    },
                }
            )

            contents = [c for c, _ in h.llm_messages]
            md_idx, doctrine_idx, event_idx = _assert_preamble_order(
                contents, event_match='name="combat.round_waiting"'
            )

            # combat.md and doctrine are silent context — only the event
            # frame triggers inference.
            assert h.llm_messages[md_idx][1] is False, (
                "combat.md preamble should not trigger inference"
            )
            assert h.llm_messages[doctrine_idx][1] is False, (
                "doctrine preamble should not trigger inference"
            )

            # Doctrine references the default 'balanced' template since
            # the test character has no authored strategy.
            assert "default 'balanced' combat strategy" in contents[doctrine_idx]
        finally:
            await h.stop()

    async def test_player_combat_md_loads_only_once_per_session(self):
        """combat.md is gated on _combat_md_loaded — re-entering combat
        in the same session should not re-inject the mechanics block,
        but doctrine still re-fetches (strategy may have changed)."""
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start()
        try:
            await h.join_game()
            ship_id = await get_ship_id(
                self.supabase_url, self.service_key, self.character_id
            )

            payload = {
                "combat_id": "cbt-preamble-2",
                "round": 1,
                "deadline": "2099-01-01T00:00:30Z",
                "sector": {"id": 0},
                "participants": [
                    {
                        "id": self.character_id,
                        "ship_id": ship_id,
                        "ship": {"ship_name": "Test Ship"},
                    },
                    {"id": "char-foe", "ship_id": "ship-foe"},
                ],
                "__event_context": {"scope": "direct", "reason": "direct"},
            }

            await h.relay._relay_event(
                {"event_name": "combat.round_waiting", "payload": payload}
            )
            h.llm_frames.clear()

            # Second combat — combat.md must NOT re-appear.
            second_payload = dict(payload)
            second_payload["combat_id"] = "cbt-preamble-3"
            await h.relay._relay_event(
                {"event_name": "combat.round_waiting", "payload": second_payload}
            )

            second_contents = [c for c, _ in h.llm_messages]
            assert not any(
                c.startswith("# Combat reference") for c in second_contents
            ), (
                "combat.md should only inject once per session. Second-combat "
                f"frames: {[c[:80] for c in second_contents]}"
            )
            # Doctrine still fires every combat.
            assert any(
                c.startswith("# Your ship's combat strategy") for c in second_contents
            ), "Doctrine should re-inject on every combat entry"
        finally:
            await h.stop()


# ── Corp ship task agent (TaskAgent path) ─────────────────────────────────


@pytest.mark.integration
class TestCorpShipCombatPreambleE2E:
    """When a corp ship enters combat, its TaskAgent injects combat.md +
    doctrine ahead of the round-1 combat.round_waiting event in its own
    LLM context — same fixed order as the player path."""

    @pytest.fixture(autouse=True)
    async def setup(
        self,
        reset_db_with_characters,
        edge_api,
        make_game_client,
        supabase_url,
        supabase_service_role_key,
    ):
        await reset_db_with_characters(["test_combat_preamble_corp_p1"])
        self.character_id = canonicalize_character_id(
            "test_combat_preamble_corp_p1"
        )
        self.api = edge_api
        self.make_game_client = make_game_client

        self.corp_id = await create_corporation_direct(
            supabase_url, supabase_service_role_key, self.character_id, "Preamble Corp"
        )
        self.corp_ship_id = await create_corp_ship_direct(
            supabase_url,
            supabase_service_role_key,
            self.corp_id,
            sector=0,
            ship_name="Preamble Scout",
        )

    async def test_corp_ship_round1_preamble_lands_before_event(self):
        h = E2EHarness(self.character_id, self.api, self.make_game_client)
        await h.start(with_task_agents=True)
        try:
            await h.join_game()

            # Long-running script keeps the corp-ship task agent active so
            # the bus event finds an attached task_id when we inject below.
            h.set_task_script([("my_status", {})] * 10)
            result = await h.start_corp_ship_task(self.corp_ship_id)
            assert result["success"] is True, f"start_task failed: {result}"

            # Wait for the TaskAgent pipeline to be live and its LLM
            # context to exist before inspecting it.
            corp_task = None
            for _ in range(40):  # up to ~4s
                corp_task = next(
                    (
                        c
                        for c in h.voice_agent.children
                        if isinstance(c, TaskAgent) and c._is_corp_ship
                    ),
                    None,
                )
                if (
                    corp_task is not None
                    and corp_task._llm_context is not None
                    and corp_task._active_task_id
                ):
                    break
                await asyncio.sleep(0.1)
            assert corp_task is not None, "corp ship TaskAgent never spawned"
            assert corp_task._llm_context is not None, "TaskAgent context missing"
            assert corp_task._active_task_id, "TaskAgent has no active task"

            # Patch combat_get_strategy on the corp ship's task client.
            # In production the player is authorized for their own corp
            # ships, but the integration test env doesn't wire that
            # `actor_character_id` permission fully — combat.get_strategy
            # would 403, the doctrine block would be skipped, and we'd
            # only see combat.md + event. Patching just this method keeps
            # the rest of the real flow (bus, prompt loading, ordering).
            corp_task._game_client.combat_get_strategy = AsyncMock(
                return_value={
                    "strategy": {"template": "balanced", "custom_prompt": None}
                }
            )

            # Inject a round-1 combat.round_waiting tagged with the
            # corp-ship task id (mirrors the real flow where the corp
            # ship's combat_initiate request_id propagates through the
            # event's task_id, letting the bus filter route it back).
            await h.relay._relay_event(
                {
                    "event_name": "combat.round_waiting",
                    "task_id": corp_task._active_task_id,
                    "payload": {
                        "combat_id": "cbt-corp-preamble",
                        "round": 1,
                        "deadline": "2099-01-01T00:00:30Z",
                        "sector": {"id": 0},
                        "task_id": corp_task._active_task_id,
                        "participants": [
                            {
                                "id": self.corp_ship_id,
                                "ship_id": self.corp_ship_id,
                                "ship": {"ship_name": "Preamble Scout"},
                                "player_type": "corporation_ship",
                            },
                            {"id": "char-foe", "ship_id": "ship-foe"},
                        ],
                        "__event_context": {
                            "scope": "direct",
                            "reason": "direct",
                            "character_id": self.corp_ship_id,
                            "recipient_ids": [self.corp_ship_id],
                            "recipient_reasons": ["direct"],
                        },
                    },
                }
            )

            # Give the bus a moment to deliver to the task agent.
            await asyncio.sleep(0.3)

            messages = corp_task._llm_context.get_messages()
            contents = [
                m["content"]
                for m in messages
                if isinstance(m, dict) and isinstance(m.get("content"), str)
            ]
            _assert_preamble_order(
                contents, event_match="<event name=combat.round_waiting>"
            )

            # combat.md flag should now be set so a second combat in the
            # same agent lifetime won't re-inject the mechanics reference.
            assert corp_task._combat_md_loaded is True
        finally:
            await h.stop()
