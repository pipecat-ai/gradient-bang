"""Integration tests: real EventRelay + real VoiceAgent wired together.

Verifies that game events flow correctly through the full relay→voice pipeline,
with correct LLM frame content, run_llm flags, onboarding state, and combat routing.
External boundaries (game_client, RTVI transport, bus) are mocked.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pipecat.frames.frames import LLMMessagesAppendFrame
from pipecat.services.llm_service import FunctionCallParams

from gradientbang.pipecat_server.subagents.event_relay import EVENT_CONFIGS, EventRelay
from gradientbang.pipecat_server.subagents.voice_agent import VoiceAgent


# ── Harness ───────────────────────────────────────────────────────────────


class RelayVoiceHarness:
    """Wire real EventRelay + real VoiceAgent, mock external boundaries."""

    def __init__(self, character_id="char-test"):
        self.character_id = character_id

        # Mock external boundaries
        self.game_client = MagicMock()
        self.game_client.corporation_id = "corp-1"
        self.game_client.on = MagicMock(return_value=lambda fn: fn)
        self.game_client.join = AsyncMock(return_value={"request_id": "join-req"})
        self.game_client.subscribe_my_messages = AsyncMock()
        self.game_client.list_user_ships = AsyncMock()
        self.game_client.quest_status = AsyncMock()
        self.game_client.list_known_ports = AsyncMock(return_value={"request_id": "mega-req"})
        self.game_client.set_event_polling_scope = MagicMock()

        self.rtvi = MagicMock()
        self.rtvi.push_frame = AsyncMock()

        bus = MagicMock()
        bus.send_message = AsyncMock()

        # Real VoiceAgent
        self.voice_agent = VoiceAgent(
            "player",
            bus=bus,
            game_client=self.game_client,
            character_id=character_id,
            rtvi_processor=self.rtvi,
        )
        # VoiceAgent defaults to active=False (bridged-inactive until the
        # scripted tutorial flips it on). EventRelay now gates onboarding
        # injection on this; mark active so event flows reach the LLM.
        self.voice_agent._active = True
        # Capture LLM frames - EventRelay now calls queue_frame directly
        self.llm_frames: list[LLMMessagesAppendFrame] = []
        from pipecat.processors.frame_processor import FrameDirection as _FD
        _orig_queue_frame = self.voice_agent.queue_frame

        async def _capturing_queue_frame(frame, direction=_FD.DOWNSTREAM):
            if isinstance(frame, LLMMessagesAppendFrame):
                self.llm_frames.append(frame)
            await _orig_queue_frame(frame, direction)

        self.voice_agent.queue_frame = _capturing_queue_frame

        # Capture bus broadcasts
        self.bus_events: list[dict] = []
        original_broadcast = self.voice_agent.broadcast_game_event

        async def _capture_broadcast(event, *, voice_agent_originated: bool = False):
            self.bus_events.append(event)

        self.voice_agent.broadcast_game_event = _capture_broadcast

        # Real EventRelay, wired to real VoiceAgent
        self.relay = EventRelay(
            game_client=self.game_client,
            rtvi_processor=self.rtvi,
            character_id=character_id,
            task_state=self.voice_agent,
        )
        self.voice_agent._event_relay = self.relay

    async def feed_event(self, event_name, payload=None, request_id=None, **extra):
        """Feed a game event through the real relay→voice pipeline."""
        event = {"event_name": event_name, "payload": payload or {}}
        if request_id:
            event["request_id"] = request_id
        event.update(extra)
        await self.relay._relay_event(event)

    @property
    def llm_messages(self) -> list[tuple[str, bool]]:
        """Return (content, run_llm) pairs for all captured LLM frames."""
        return [(f.messages[0]["content"], f.run_llm) for f in self.llm_frames]

    @property
    def rtvi_push_count(self) -> int:
        return self.rtvi.push_frame.call_count


def _make_harness(**kwargs) -> RelayVoiceHarness:
    return RelayVoiceHarness(**kwargs)


def _llm_event_frames(h: RelayVoiceHarness, event_name: str) -> list[tuple[str, bool]]:
    opener = f'<event name="{event_name}"'
    return [(c, r) for c, r in h.llm_messages if opener in c]


# ── Onboarding ────────────────────────────────────────────────────────────


@pytest.mark.unit
class TestOnboardingNewPlayer:
    """New player: join → megaport check empty → status → onboarding prompt."""

    async def test_new_player_gets_onboarding_prompt(self):
        h = _make_harness()
        # Simulate join() having issued the megaport check
        h.relay._megaport_check_request_id = "mega-req"

        # Step 1: ports.list arrives with matching request_id, empty ports
        await h.feed_event(
            "ports.list",
            {"ports": [], "__event_context": {"scope": "direct", "reason": "direct"}},
            request_id="mega-req",
        )
        assert h.relay.is_new_player is True

        # Step 2: status.snapshot arrives → triggers onboarding injection
        await h.feed_event(
            "status.snapshot",
            {
                "player": {"id": "char-test", "name": "TestPlayer"},
                "sector": {"id": 1},
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )

        assert h.relay._onboarding_complete is True
        # Find the onboarding frame
        onboarding_frames = [
            (c, r) for c, r in h.llm_messages if '<event name="onboarding">' in c
        ]
        assert len(onboarding_frames) == 1
        content, run_llm = onboarding_frames[0]
        assert run_llm is True
        assert "new player" in content.lower() or "mega-port" in content.lower()


@pytest.mark.unit
class TestOnboardingVeteranPlayer:
    """Veteran player: join → megaport check has ports → status → session.start."""

    async def test_veteran_gets_session_start(self):
        h = _make_harness()
        h.relay._megaport_check_request_id = "mega-req"

        # Step 1: ports.list with mega-ports
        await h.feed_event(
            "ports.list",
            {
                "ports": [{"port_id": "p1", "mega": True}],
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
            request_id="mega-req",
        )
        assert h.relay.is_new_player is False

        # Step 2: status.snapshot
        await h.feed_event(
            "status.snapshot",
            {
                "player": {"id": "char-test", "name": "Veteran"},
                "sector": {"id": 1},
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )

        assert h.relay._onboarding_complete is True
        session_frames = [
            (c, r) for c, r in h.llm_messages if '<event name="session.start">' in c
        ]
        assert len(session_frames) == 1
        _, run_llm = session_frames[0]
        assert run_llm is True
        # Veteran must never receive the onboarding fragment
        onboarding_frames = [
            c for c, _ in h.llm_messages if '<event name="onboarding">' in c
        ]
        assert len(onboarding_frames) == 0


@pytest.mark.unit
class TestMegaportDiscovery:
    """New player discovers a megaport → flag flips to veteran."""

    async def test_megaport_discovery_flips_flag(self):
        h = _make_harness()
        # Pre-set as new player with onboarding already completed
        h.relay.is_new_player = True
        h.relay._onboarding_complete = True

        # Ports list arrives with mega-port data
        await h.feed_event(
            "ports.list",
            {
                "ports": [{"port_id": "p1", "mega": True}],
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        assert h.relay.is_new_player is False

    async def test_megaport_discovery_injects_onboarding_complete(self):
        """New player discovers megaport → onboarding.complete event injected."""
        h = _make_harness()
        h.relay.is_new_player = True
        h.relay._onboarding_complete = True

        await h.feed_event(
            "ports.list",
            {
                "ports": [{"port_id": "p1", "mega": True}],
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        complete_frames = [
            (c, r) for c, r in h.llm_messages if '<event name="onboarding.complete">' in c
        ]
        assert len(complete_frames) == 1
        content, run_llm = complete_frames[0]
        assert "disregard" in content.lower()
        assert run_llm is False

    async def test_empty_ports_does_not_flip_to_veteran(self):
        h = _make_harness()
        h.relay.is_new_player = True
        h.relay._onboarding_complete = True

        await h.feed_event(
            "ports.list",
            {"ports": [], "__event_context": {"scope": "direct", "reason": "direct"}},
        )
        assert h.relay.is_new_player is True


@pytest.mark.unit
class TestOnboardingRequiresBothConditions:
    """Onboarding waits for BOTH megaport check resolve AND first status."""

    async def test_status_first_then_ports(self):
        h = _make_harness()
        h.relay._megaport_check_request_id = "mega-req"

        # Status arrives first — onboarding NOT yet triggered
        await h.feed_event(
            "status.snapshot",
            {
                "player": {"id": "char-test", "name": "Test"},
                "sector": {"id": 1},
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        assert h.relay._first_status_delivered is True
        assert h.relay.is_new_player is None  # megaport check not resolved
        assert h.relay._onboarding_complete is False

        # Now ports.list resolves → onboarding fires
        await h.feed_event(
            "ports.list",
            {"ports": [], "__event_context": {"scope": "direct", "reason": "direct"}},
            request_id="mega-req",
        )
        assert h.relay.is_new_player is True
        assert h.relay._onboarding_complete is True
        onboarding = [c for c, _ in h.llm_messages if '<event name="onboarding">' in c]
        assert len(onboarding) == 1

    async def test_ports_first_then_status(self):
        h = _make_harness()
        h.relay._megaport_check_request_id = "mega-req"

        # Ports resolve first — onboarding NOT yet triggered
        await h.feed_event(
            "ports.list",
            {"ports": [], "__event_context": {"scope": "direct", "reason": "direct"}},
            request_id="mega-req",
        )
        assert h.relay.is_new_player is True
        assert h.relay._onboarding_complete is False  # no status yet

        # Status arrives → onboarding fires
        await h.feed_event(
            "status.snapshot",
            {
                "player": {"id": "char-test", "name": "Test"},
                "sector": {"id": 1},
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        assert h.relay._onboarding_complete is True
        onboarding = [c for c, _ in h.llm_messages if '<event name="onboarding">' in c]
        assert len(onboarding) == 1


@pytest.mark.unit
class TestStatusInferenceSuppressedDuringOnboarding:
    """Initial status.snapshot should NOT trigger LLM inference until onboarding resolves."""

    async def test_status_run_llm_false_before_onboarding(self):
        h = _make_harness()
        h.relay._megaport_check_request_id = "mega-req"
        # Track the join request_id so status would normally trigger inference
        h.voice_agent.track_request_id("join-req")

        await h.feed_event(
            "status.snapshot",
            {
                "player": {"id": "char-test", "name": "Test"},
                "sector": {"id": 1},
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
            request_id="join-req",
        )

        # Status frame should be appended but with run_llm=False
        status_frames = [
            (c, r) for c, r in h.llm_messages if "status.snapshot" in c
        ]
        assert len(status_frames) >= 1
        _, run_llm = status_frames[0]
        assert run_llm is False


# ── Combat ────────────────────────────────────────────────────────────────


@pytest.mark.unit
class TestCombatParticipant:
    """Combat events route to LLM when player is a participant."""

    async def test_round_waiting_reaches_llm_with_inference(self):
        h = _make_harness()
        await h.feed_event(
            "combat.round_waiting",
            {
                "combat_id": "cbt-1",
                "round": 1,
                "deadline": "2025-01-01T00:00:30Z",
                "participants": [{"id": "char-test"}],
            },
        )

        assert len(h.llm_messages) >= 1
        content, run_llm = h.llm_messages[0]
        assert 'name="combat.round_waiting"' in content
        assert 'combat_id="cbt-1"' in content
        assert run_llm is True
        # Voice summary should include combat context
        assert "combat" in content.lower()

    async def test_round_resolved_includes_damage_info(self):
        h = _make_harness()
        await h.feed_event(
            "combat.round_resolved",
            {
                "combat_id": "cbt-1",
                "round": 2,
                "result": "in_progress",
                "participants": [
                    {
                        "id": "char-test",
                        "ship": {"fighter_loss": 5, "shield_damage": 12.5},
                    },
                    {"id": "enemy-1", "ship": {"fighter_loss": 3, "shield_damage": 8.0}},
                ],
            },
        )

        assert len(h.llm_messages) >= 1
        content, run_llm = h.llm_messages[0]
        assert run_llm is True
        assert "fighters lost 5" in content
        assert "shield damage 12.5" in content

    async def test_combat_ended_reaches_llm(self):
        """combat.ended lands in LLM context for participants but does NOT
        trigger inference (InferenceRule.NEVER). round_resolved already
        carried the player-facing outcome; a second ended-triggered run
        would make the voice agent restate the same combat resolution.
        """
        h = _make_harness()
        await h.feed_event(
            "combat.ended",
            {
                "combat_id": "cbt-1",
                "participants": [{"id": "char-test"}],
            },
        )

        assert len(h.llm_messages) >= 1
        content, run_llm = h.llm_messages[0]
        assert run_llm is False
        assert "combat has ended" in content.lower()


@pytest.mark.unit
class TestCombatNonParticipant:
    """Combat events for non-participants get RTVI push but not LLM context."""

    async def test_round_waiting_rtvi_only_for_observer(self):
        h = _make_harness()
        await h.feed_event(
            "combat.round_waiting",
            {
                "combat_id": "cbt-1",
                "round": 1,
                "participants": [{"id": "other-player"}],
                "__event_context": {"scope": "local", "reason": "observer"},
            },
        )

        # RTVI push happened
        assert h.rtvi_push_count >= 1
        # No LLM frame (PARTICIPANT rule, not a participant)
        combat_frames = [
            c for c, _ in h.llm_messages if "combat.round_waiting" in c
        ]
        assert len(combat_frames) == 0

    async def test_round_resolved_rtvi_only_for_observer(self):
        h = _make_harness()
        await h.feed_event(
            "combat.round_resolved",
            {
                "combat_id": "cbt-1",
                "round": 1,
                "result": "in_progress",
                "participants": [{"id": "other-player"}],
                "__event_context": {"scope": "local", "reason": "observer"},
            },
        )

        assert h.rtvi_push_count >= 1
        combat_frames = [
            c for c, _ in h.llm_messages if "combat.round_resolved" in c
        ]
        assert len(combat_frames) == 0


# ── Combat lifecycle & state ──────────────────────────────────────────────


def _combat_waiting(combat_id, round_num, participants, deadline="2025-01-01T00:00:30Z"):
    return {
        "combat_id": combat_id,
        "round": round_num,
        "deadline": deadline,
        "participants": participants,
    }


def _combat_resolved(combat_id, round_num, participants, result="in_progress"):
    return {
        "combat_id": combat_id,
        "round": round_num,
        "result": result,
        "participants": participants,
    }


def _combat_ended(combat_id, participants, result="victory"):
    return {
        "combat_id": combat_id,
        "result": result,
        "participants": participants,
    }


def _combat_action_accepted(combat_id, round_num, action, commit=0, target_id=None):
    return {
        "combat_id": combat_id,
        "round": round_num,
        "action": action,
        "commit": commit,
        **({"target_id": target_id} if target_id else {}),
    }


@pytest.mark.unit
class TestCombatLifecycle:
    """Full combat lifecycle: waiting → action_accepted → resolved → ended."""

    async def test_full_lifecycle_produces_correct_frames(self):
        h = _make_harness()
        player = [{"id": "char-test"}]

        # Round 1: waiting
        await h.feed_event("combat.round_waiting", _combat_waiting("cbt-1", 1, player))
        # Round 1: action accepted
        await h.feed_event(
            "combat.action_accepted",
            _combat_action_accepted("cbt-1", 1, "attack", commit=50, target_id="enemy-1"),
        )
        # Round 1: resolved
        await h.feed_event(
            "combat.round_resolved",
            _combat_resolved(
                "cbt-1",
                1,
                [
                    {"id": "char-test", "ship": {"fighter_loss": 3, "shield_damage": 5.0}},
                    {"id": "enemy-1", "ship": {"fighter_loss": 8, "shield_damage": 0}},
                ],
            ),
        )
        # Combat ended
        await h.feed_event("combat.ended", _combat_ended("cbt-1", player))

        # Should have 4 LLM frames (one per event)
        assert len(h.llm_messages) == 4
        waiting_content, waiting_run = h.llm_messages[0]
        action_content, action_run = h.llm_messages[1]
        resolved_content, resolved_run = h.llm_messages[2]
        ended_content, ended_run = h.llm_messages[3]

        # Waiting: active combat context + submit prompt, runs inference
        # (InferenceRule.ON_PARTICIPANT, player is a participant).
        assert "you are currently in active combat" in waiting_content
        assert "Submit a combat action now" in waiting_content
        assert waiting_run is True

        # Action accepted: confirms the action, but does NOT trigger inference
        # (InferenceRule.NEVER — round_resolved/round_waiting speak for it).
        assert "attack" in action_content.lower()
        assert "round 1" in action_content.lower()
        assert action_run is False

        # Resolved: damage summary, runs inference (InferenceRule.ALWAYS).
        assert "fighters lost 3" in resolved_content
        assert "shield damage 5.0" in resolved_content
        assert resolved_run is True

        # Ended: lands in context but does NOT trigger inference
        # (InferenceRule.NEVER — round_resolved already carried the outcome).
        assert "combat has ended" in ended_content.lower()
        assert ended_run is False

    async def test_action_accepted_includes_commit_and_target(self):
        h = _make_harness()
        await h.feed_event(
            "combat.action_accepted",
            _combat_action_accepted("cbt-1", 2, "attack", commit=75, target_id="enemy-abc"),
        )

        assert len(h.llm_messages) >= 1
        content, _ = h.llm_messages[0]
        assert "commit 75" in content
        assert "target" in content.lower()  # target is short_id'd

    async def test_action_accepted_flee_no_commit(self):
        h = _make_harness()
        await h.feed_event(
            "combat.action_accepted",
            _combat_action_accepted("cbt-1", 3, "flee"),
        )

        assert len(h.llm_messages) >= 1
        content, _ = h.llm_messages[0]
        assert "flee" in content.lower()
        # No commit info for flee
        assert "commit" not in content.lower()

    async def test_brace_action(self):
        h = _make_harness()
        await h.feed_event(
            "combat.action_accepted",
            _combat_action_accepted("cbt-1", 2, "brace"),
        )

        content, _ = h.llm_messages[0]
        assert "brace" in content.lower()


@pytest.mark.unit
class TestCombatVoiceSummaries:
    """Verify voice summaries contain correct combat context for participant vs observer."""

    async def test_participant_gets_active_combat_context(self):
        h = _make_harness()
        await h.feed_event(
            "combat.round_waiting",
            _combat_waiting("cbt-1", 1, [{"id": "char-test"}]),
        )

        content, _ = h.llm_messages[0]
        assert "you are currently in active combat" in content
        assert "combat_id cbt-1" in content

    async def test_participant_round_resolved_includes_round_info(self):
        h = _make_harness()
        await h.feed_event(
            "combat.round_resolved",
            _combat_resolved(
                "cbt-2",
                3,
                [{"id": "char-test", "ship": {"fighter_loss": 0, "shield_damage": 0}}],
            ),
        )

        content, _ = h.llm_messages[0]
        assert "round 3" in content
        assert "no fighter losses" in content
        assert "no shield damage" in content

    async def test_combat_ended_participant_message(self):
        h = _make_harness()
        await h.feed_event(
            "combat.ended",
            _combat_ended("cbt-1", [{"id": "char-test"}]),
        )

        content, _ = h.llm_messages[0]
        assert "your combat has ended" in content.lower()

    async def test_combat_ended_observer_message_not_in_llm(self):
        """Observer combat.ended should NOT reach LLM (PARTICIPANT rule)."""
        h = _make_harness()
        await h.feed_event(
            "combat.ended",
            {
                "combat_id": "cbt-1",
                "participants": [{"id": "other-player"}],
                "__event_context": {"scope": "local", "reason": "observer"},
            },
        )

        combat_frames = [c for c, _ in h.llm_messages if "combat" in c.lower()]
        assert len(combat_frames) == 0
        # But RTVI still pushed
        assert h.rtvi_push_count >= 1


@pytest.mark.unit
class TestCorpShipCombat:
    """Corp ship in combat: player aware via RTVI/bus, not locked in LLM."""

    async def test_corp_combat_rtvi_push_but_no_llm(self):
        """Combat involving corp ship (not player) → RTVI + bus, no LLM append."""
        h = _make_harness()
        corp_ship_id = "corp-ship-abc"

        await h.feed_event(
            "combat.round_waiting",
            {
                **_combat_waiting("cbt-corp", 1, [{"id": corp_ship_id}, {"id": "enemy-2"}]),
                "__event_context": {"scope": "corp", "reason": "corp_scope"},
            },
        )

        # RTVI pushed (UI shows corp ship combat)
        assert h.rtvi_push_count >= 1
        # Bus broadcast happened (TaskAgent children notified)
        assert len(h.bus_events) >= 1
        # No LLM append (player not a participant)
        combat_frames = [c for c, _ in h.llm_messages if "combat" in c.lower()]
        assert len(combat_frames) == 0

    async def test_corp_combat_does_not_block_subsequent_player_events(self):
        """After corp combat events, player events still flow normally to LLM."""
        h = _make_harness()
        h.relay._onboarding_complete = True

        # Corp ship combat event (should NOT reach LLM)
        await h.feed_event(
            "combat.round_waiting",
            {
                **_combat_waiting("cbt-corp", 1, [{"id": "corp-ship-1"}]),
                "__event_context": {"scope": "corp", "reason": "corp_scope"},
            },
        )

        # Player's own status event (should still reach LLM)
        await h.feed_event(
            "status.snapshot",
            {
                "player": {"id": "char-test", "name": "Test"},
                "sector": {"id": 1},
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )

        # Only the status event should be in LLM
        combat_frames = [c for c, _ in h.llm_messages if "combat" in c.lower()]
        status_frames = [c for c, _ in h.llm_messages if "status.snapshot" in c]
        assert len(combat_frames) == 0
        assert len(status_frames) == 1

    async def test_corp_combat_full_lifecycle_never_reaches_llm(self):
        """Full corp ship combat lifecycle: none of the events reach LLM."""
        h = _make_harness()
        corp_participants = [{"id": "corp-ship-1"}, {"id": "enemy-1"}]
        ec = {"__event_context": {"scope": "corp", "reason": "corp_scope"}}

        await h.feed_event(
            "combat.round_waiting",
            {**_combat_waiting("cbt-corp", 1, corp_participants), **ec},
        )
        await h.feed_event(
            "combat.round_resolved",
            {**_combat_resolved("cbt-corp", 1, corp_participants), **ec},
        )
        await h.feed_event(
            "combat.ended",
            {**_combat_ended("cbt-corp", corp_participants), **ec},
        )

        # All 3 events pushed to RTVI
        assert h.rtvi_push_count == 3
        # All 3 broadcast to bus
        assert len(h.bus_events) == 3
        # Zero LLM frames
        assert len(h.llm_messages) == 0


@pytest.mark.unit
class TestMixedCombat:
    """Player in personal combat while corp ships also fight separately."""

    async def test_player_combat_reaches_llm_while_corp_combat_does_not(self):
        h = _make_harness()
        player_participants = [{"id": "char-test"}, {"id": "enemy-1"}]
        corp_participants = [{"id": "corp-ship-1"}, {"id": "enemy-2"}]
        ec_corp = {"__event_context": {"scope": "corp", "reason": "corp_scope"}}

        # Player combat round
        await h.feed_event(
            "combat.round_waiting",
            _combat_waiting("cbt-player", 1, player_participants),
        )
        # Corp combat round (same time, different combat)
        await h.feed_event(
            "combat.round_waiting",
            {**_combat_waiting("cbt-corp", 1, corp_participants), **ec_corp},
        )

        # Only player combat in LLM
        combat_llm = [(c, r) for c, r in h.llm_messages if "combat.round_waiting" in c]
        assert len(combat_llm) == 1
        content, run_llm = combat_llm[0]
        assert "cbt-player" in content
        assert "cbt-corp" not in content
        assert run_llm is True

        # Both pushed to RTVI
        assert h.rtvi_push_count == 2
        # Both broadcast to bus
        assert len(h.bus_events) == 2

    async def test_player_combat_ended_while_corp_combat_continues(self):
        """Player's combat ends, corp combat continues — LLM context reflects player state."""
        h = _make_harness()
        player_participants = [{"id": "char-test"}]
        corp_participants = [{"id": "corp-ship-1"}, {"id": "enemy-2"}]
        ec_corp = {"__event_context": {"scope": "corp", "reason": "corp_scope"}}

        # Player combat ends
        await h.feed_event(
            "combat.ended", _combat_ended("cbt-player", player_participants)
        )
        # Corp combat still going
        await h.feed_event(
            "combat.round_waiting",
            {**_combat_waiting("cbt-corp", 3, corp_participants), **ec_corp},
        )

        # Player combat ended in LLM
        ended_frames = [c for c, _ in h.llm_messages if "combat has ended" in c.lower()]
        assert len(ended_frames) == 1
        # Corp combat NOT in LLM
        corp_frames = [c for c, _ in h.llm_messages if "cbt-corp" in c]
        assert len(corp_frames) == 0


@pytest.mark.unit
class TestTaskSpawningDuringCombat:
    """Verify task spawning behavior when combat events are flowing."""

    async def test_start_task_works_during_corp_combat(self):
        """Corp ship combat events don't prevent task spawning."""
        h = _make_harness()
        ec_corp = {"__event_context": {"scope": "corp", "reason": "corp_scope"}}

        # Corp combat happening
        await h.feed_event(
            "combat.round_waiting",
            {
                **_combat_waiting("cbt-corp", 1, [{"id": "corp-ship-1"}]),
                **ec_corp,
            },
        )

        # Task spawning should still work — mock add_agent to avoid framework calls
        with patch.object(h.voice_agent, "add_agent", new_callable=AsyncMock) as mock_add:
            params = MagicMock(spec=FunctionCallParams)
            params.arguments = {"task_description": "trade at port"}
            params.result_callback = AsyncMock()
            result = await h.voice_agent._handle_start_task(params)

        assert result["success"] is True
        assert mock_add.called

    async def test_start_task_available_after_player_combat_ends(self):
        """After player's combat ends, task spawning works normally."""
        h = _make_harness()

        # Player combat lifecycle
        await h.feed_event(
            "combat.round_waiting",
            _combat_waiting("cbt-1", 1, [{"id": "char-test"}]),
        )
        await h.feed_event(
            "combat.ended", _combat_ended("cbt-1", [{"id": "char-test"}])
        )

        # Task spawning works
        with patch.object(h.voice_agent, "add_agent", new_callable=AsyncMock) as mock_add:
            params = MagicMock(spec=FunctionCallParams)
            params.arguments = {"task_description": "explore sector 5"}
            params.result_callback = AsyncMock()
            result = await h.voice_agent._handle_start_task(params)

        assert result["success"] is True


@pytest.mark.unit
class TestCombatInferenceRules:
    """Verify inference (run_llm) flags follow combat-specific rules."""

    async def test_round_waiting_inference_on_participant_only(self):
        """combat.round_waiting uses ON_PARTICIPANT: run_llm only if player fights."""
        h = _make_harness()

        # Player is participant → run_llm=True
        await h.feed_event(
            "combat.round_waiting",
            _combat_waiting("cbt-1", 1, [{"id": "char-test"}]),
        )
        assert h.llm_messages[0][1] is True

    async def test_round_resolved_always_runs_inference(self):
        """combat.round_resolved uses ALWAYS: run_llm=True when appended."""
        h = _make_harness()
        await h.feed_event(
            "combat.round_resolved",
            _combat_resolved("cbt-1", 1, [
                {"id": "char-test", "ship": {"fighter_loss": 0, "shield_damage": 0}},
            ]),
        )
        assert h.llm_messages[0][1] is True

    async def test_combat_ended_never_runs_inference(self):
        """combat.ended uses NEVER: event lands in context but run_llm=False.
        round_resolved already carried the player-facing outcome, so an
        ended-triggered run would just restate the same combat resolution.
        """
        h = _make_harness()
        await h.feed_event(
            "combat.ended",
            _combat_ended("cbt-1", [{"id": "char-test"}]),
        )
        assert h.llm_messages[0][1] is False

    async def test_action_accepted_never_runs_inference(self):
        """combat.action_accepted uses NEVER: event lands in context but
        run_llm=False. The user-facing update should come from
        round_resolved / round_waiting, not from action confirmation.
        """
        h = _make_harness()
        await h.feed_event(
            "combat.action_accepted",
            _combat_action_accepted("cbt-1", 1, "attack", commit=10),
        )
        assert h.llm_messages[0][1] is False


# ── Event flow integrity ──────────────────────────────────────────────────


@pytest.mark.unit
class TestEventFlowIntegrity:
    """Every event always pushes to RTVI and broadcasts to bus."""

    async def test_rtvi_always_pushed(self):
        h = _make_harness()
        # map.update has AppendRule.NEVER — should still get RTVI push
        await h.feed_event("map.update", {"sectors": [1, 2, 3]})
        assert h.rtvi_push_count == 1
        # No LLM frame
        assert len(h.llm_messages) == 0

    async def test_bus_broadcast_always_happens(self):
        h = _make_harness()
        await h.feed_event("sector.update", {"sector": {"id": 5}})
        assert len(h.bus_events) == 1
        assert h.bus_events[0]["event_name"] == "sector.update"

    async def test_never_append_events_skip_llm(self):
        """Events with AppendRule.NEVER only go to RTVI, not LLM."""
        h = _make_harness()
        never_events = [
            name for name, cfg in EVENT_CONFIGS.items() if cfg.append.name == "NEVER"
        ]
        assert len(never_events) > 0, "Should have at least one NEVER event"
        for event_name in never_events:
            await h.feed_event(event_name, {})

        assert h.rtvi_push_count == len(never_events)
        assert len(h.llm_messages) == 0


# ── Voice LLM routing policy ──────────────────────────────────────────────


@pytest.mark.unit
class TestVoiceLlmRoutingPolicy:
    """Policy-level coverage through real EventRelay + VoiceAgent wiring."""

    def _direct_context(self):
        return {
            "scope": "direct",
            "reason": "direct",
            "character_id": "char-test",
            "recipient_ids": ["char-test"],
            "recipient_reasons": ["direct"],
        }

    async def test_corporation_data_with_corp_ship_subject_not_appended(self):
        h = _make_harness()

        await h.feed_event(
            "corporation.data",
            {
                "player": {"id": "ship-blue-hauler-uuid"},
                "corporation": {"id": "corp-1", "name": "Blue Haulers"},
                "__event_context": self._direct_context(),
            },
            request_id="some-corp-task-req",
        )

        assert len(_llm_event_frames(h, "corporation.data")) == 0
        assert len(h.bus_events) >= 1

    async def test_corporation_data_with_player_subject_appended(self):
        h = _make_harness()

        await h.feed_event(
            "corporation.data",
            {
                "player": {"id": "char-test"},
                "corporation": {"id": "corp-1", "name": "Blue Haulers"},
                "__event_context": self._direct_context(),
            },
        )

        assert len(_llm_event_frames(h, "corporation.data")) == 1

    async def test_port_update_for_non_local_sector_not_appended(self):
        h = _make_harness()
        h.relay._current_sector_id = 690

        await h.feed_event(
            "port.update",
            {"sector": {"id": 472}, "port": {"id": "port-472"}},
        )

        assert len(_llm_event_frames(h, "port.update")) == 0

    async def test_port_update_for_local_sector_appended(self):
        h = _make_harness()
        h.relay._current_sector_id = 472

        await h.feed_event(
            "port.update",
            {
                "sector": {"id": 472},
                "player": {"id": "char-test"},
                "port": {"id": "port-472"},
            },
        )

        assert len(_llm_event_frames(h, "port.update")) == 1

    async def test_port_update_local_corp_ship_subject_without_task_tag_appended(self):
        h = _make_harness()
        h.relay._current_sector_id = 472

        await h.feed_event(
            "port.update",
            {
                "sector": {"id": 472},
                "player": {"id": "ship-blue-hauler-uuid"},
                "port": {"id": "port-472"},
            },
        )

        assert len(_llm_event_frames(h, "port.update")) == 1

    async def test_port_update_local_corp_ship_task_event_not_appended(self):
        h = _make_harness()
        h.relay._current_sector_id = 472
        h.voice_agent.is_our_task = lambda task_id: task_id == "task-1"

        await h.feed_event(
            "port.update",
            {
                "sector": {"id": 472},
                "player": {"id": "ship-blue-hauler-uuid"},
                "port": {"id": "port-472"},
                "__task_id": "task-1",
            },
        )

        assert len(_llm_event_frames(h, "port.update")) == 0

    async def test_sector_update_uses_top_level_id_for_locality(self):
        non_local = _make_harness()
        non_local.relay._current_sector_id = 690

        await non_local.feed_event(
            "sector.update",
            {"id": 472, "name": "Remote sector", "ports": []},
        )

        assert len(_llm_event_frames(non_local, "sector.update")) == 0

        local = _make_harness()
        local.relay._current_sector_id = 472

        await local.feed_event(
            "sector.update",
            {"id": 472, "name": "Local sector", "ports": []},
        )

        assert len(_llm_event_frames(local, "sector.update")) == 1

    async def test_ship_destroyed_uses_locality(self):
        non_local = _make_harness()
        non_local.relay._current_sector_id = 690

        await non_local.feed_event(
            "ship.destroyed",
            {"sector": {"id": 472}, "ship": {"id": "ship-1"}},
        )

        assert len(_llm_event_frames(non_local, "ship.destroyed")) == 0

        local = _make_harness()
        local.relay._current_sector_id = 472

        await local.feed_event(
            "ship.destroyed",
            {"sector": {"id": 472}, "ship": {"id": "ship-1"}},
        )

        assert len(_llm_event_frames(local, "ship.destroyed")) == 1

    async def test_combat_round_resolved_with_non_player_subject_still_appended(self):
        h = _make_harness()

        await h.feed_event(
            "combat.round_resolved",
            {
                "player": {"id": "ship-blue-hauler-uuid"},
                "participants": [
                    {"id": "char-test", "ship": {"fighter_loss": 0, "shield_damage": 0}},
                    {"id": "opponent", "ship": {"fighter_loss": 2, "shield_damage": 10}},
                ],
                "combat_id": "c-1",
                "__event_context": {"scope": "local", "reason": "observer"},
            },
        )

        assert len(_llm_event_frames(h, "combat.round_resolved")) == 1


# ── Combat + Task interaction ────────────────────────────────────────────


def _make_voice_agent_with_tasks(character_id="char-test"):
    """Create a VoiceAgent with mock children and task groups for combat tests."""
    from gradientbang.subagents.agents.base_agent import TaskGroup

    from gradientbang.pipecat_server.subagents.task_agent import TaskAgent

    game_client = MagicMock()
    game_client.corporation_id = "corp-1"
    game_client.on = MagicMock(return_value=lambda fn: fn)
    game_client.set_event_polling_scope = MagicMock()

    bus = MagicMock()
    bus.send = AsyncMock()

    rtvi = MagicMock()
    rtvi.push_frame = AsyncMock()

    va = VoiceAgent(
        "player",
        bus=bus,
        game_client=game_client,
        character_id=character_id,
        rtvi_processor=rtvi,
    )

    # Create mock player task agent
    player_task = TaskAgent(
        "task_player1",
        bus=bus,
        game_client=game_client,
        character_id=character_id,
        is_corp_ship=False,
    )
    player_task._active_task_id = "player-task-001"

    # Create mock corp ship task agent
    corp_task = TaskAgent(
        "task_corp1",
        bus=bus,
        game_client=MagicMock(),
        character_id="corp-ship-abc",
        is_corp_ship=True,
    )
    corp_task._active_task_id = "corp-task-001"

    # Register as children
    va._children = [player_task, corp_task]

    # Register task groups (framework state)
    va._task_groups = {
        "player-task-001": TaskGroup(
            task_id="player-task-001",
            agent_names={"task_player1"},
        ),
        "corp-task-001": TaskGroup(
            task_id="corp-task-001",
            agent_names={"task_corp1"},
        ),
    }

    return va, player_task, corp_task


@pytest.mark.unit
class TestCombatTaskCancellation:
    """When the player enters combat, player ship tasks are cancelled but corp ship tasks continue."""

    async def test_player_combat_cancels_player_task(self):
        va, player_task, corp_task = _make_voice_agent_with_tasks()

        event = {
            "event_name": "combat.round_waiting",
            "payload": {
                "combat_id": "cbt-1",
                "round": 1,
                "participants": [{"id": "char-test"}],
            },
        }
        await va.broadcast_game_event(event)

        # Player task group should be cancelled
        assert "player-task-001" not in va._task_groups

    async def test_player_combat_preserves_corp_task(self):
        va, player_task, corp_task = _make_voice_agent_with_tasks()

        event = {
            "event_name": "combat.round_waiting",
            "payload": {
                "combat_id": "cbt-1",
                "round": 1,
                "participants": [{"id": "char-test"}],
            },
        }
        await va.broadcast_game_event(event)

        # Corp task should still be active
        assert "corp-task-001" in va._task_groups

    async def test_corp_combat_does_not_cancel_any_tasks(self):
        """Combat involving only a corp ship should not cancel anything."""
        va, player_task, corp_task = _make_voice_agent_with_tasks()

        event = {
            "event_name": "combat.round_waiting",
            "payload": {
                "combat_id": "cbt-corp",
                "round": 1,
                "participants": [{"id": "corp-ship-abc"}],
            },
        }
        await va.broadcast_game_event(event)

        # Both tasks should still be active
        assert "player-task-001" in va._task_groups
        assert "corp-task-001" in va._task_groups

    async def test_combat_ended_does_not_cancel_tasks(self):
        """combat.ended should NOT trigger task cancellation."""
        va, player_task, corp_task = _make_voice_agent_with_tasks()

        event = {
            "event_name": "combat.ended",
            "payload": {
                "combat_id": "cbt-1",
                "participants": [{"id": "char-test"}],
            },
        }
        await va.broadcast_game_event(event)

        # Both tasks still active (only round_waiting triggers cancellation)
        assert "player-task-001" in va._task_groups
        assert "corp-task-001" in va._task_groups

    async def test_no_tasks_running_combat_is_safe(self):
        """Combat with no active tasks doesn't error."""
        from gradientbang.subagents.agents.base_agent import TaskGroup

        game_client = MagicMock()
        game_client.corporation_id = "corp-1"
        game_client.on = MagicMock(return_value=lambda fn: fn)
        game_client.set_event_polling_scope = MagicMock()
        bus = MagicMock()
        bus.send = AsyncMock()
        rtvi = MagicMock()
        rtvi.push_frame = AsyncMock()

        va = VoiceAgent(
            "player", bus=bus, game_client=game_client,
            character_id="char-test", rtvi_processor=rtvi,
        )

        event = {
            "event_name": "combat.round_waiting",
            "payload": {
                "combat_id": "cbt-1",
                "round": 1,
                "participants": [{"id": "char-test"}],
            },
        }
        # Should not raise
        await va.broadcast_game_event(event)


# ── Deferred frame coalescing ─────────────────────────────────────────────


@pytest.mark.unit
class TestDeferredFlushCoalescing:
    """Multiple events deferred during a tool call should coalesce into
    exactly one follow-up inference, not one per event."""

    async def test_multiple_events_during_tool_call_coalesce_to_one_inference(self):
        """Simulate travel generating multiple events while a tool is in-flight.

        After flush, all AppendFrames should have run_llm stripped, and
        exactly one LLMRunFrame should be appended — a single coalesced
        follow-up inference that picks up all the accumulated context.
        This prevents per-event duplicate readouts from the voice agent.
        """
        from pipecat.frames.frames import LLMRunFrame

        h = _make_harness()

        # Skip onboarding so it doesn't interfere
        h.relay._onboarding_complete = True

        # Track a request_id so EventRelay treats these as voice-agent events
        h.voice_agent.track_request_id("travel-req")

        # Simulate tool in-flight
        h.voice_agent._tool_call_inflight = 1

        # Feed multiple course.plot events through the real EventRelay while tool is active.
        # (ports.list is AppendRule.NEVER now that it's a direct-response tool, so we
        # use course.plot — still InferenceRule.VOICE_AGENT — to exercise the deferral path.)
        # These go through _deliver_llm_event → queue_frame → deferred (tool inflight).
        await h.feed_event(
            "course.plot",
            {
                "path": [1, 2, 3],
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
            request_id="travel-req",
        )
        await h.feed_event(
            "course.plot",
            {
                "path": [4, 5, 6],
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
            request_id="travel-req",
        )

        assert len(h.voice_agent._deferred_frames) == 2

        # Verify: process_deferred_tool_frames strips run_llm from both
        # append frames and coalesces into exactly one LLMRunFrame.
        deferred = list(h.voice_agent._deferred_frames)
        result = await h.voice_agent.process_deferred_tool_frames(deferred)
        appends = [f for f, _ in result if isinstance(f, LLMMessagesAppendFrame)]
        runs = [f for f, _ in result if isinstance(f, LLMRunFrame)]
        assert len(appends) == 2
        assert all(f.run_llm is False for f in appends)
        assert len(runs) == 1  # coalesced: one follow-up inference for all deferred events
