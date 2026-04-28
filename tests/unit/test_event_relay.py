"""Tests for EventRelay — event routing, combat priority, onboarding, voice summaries."""

from typing import Any, Dict, Optional
from unittest.mock import AsyncMock, MagicMock

import pytest

from gradientbang.utils.formatting import extract_display_name

from gradientbang.pipecat_server.subagents.event_relay import (
    EVENT_CONFIGS,
    EventRelay,
    Priority,
    _summarize_chat,
    _summarize_combat_action,
    _summarize_combat_ended,
    _summarize_combat_round,
    _summarize_combat_waiting,
    _summarize_event_query,
    _summarize_ships_list,
    _xml_attrs_combat_encounter,
    _xml_attrs_garrison_destroyed,
    _xml_attrs_ship_destroyed,
    _xml_escape_attr,
)


# ── Helpers ────────────────────────────────────────────────────────────────


class StubTaskState:
    """Minimal TaskStateProvider implementation for testing."""

    def __init__(self):
        self.our_task_ids: set[str] = set()
        self.recent_request_ids: set[str] = set()
        self.tool_call_inflight: bool = False
        self.deferred_events: list[tuple[str, bool]] = []
        self.broadcast_events: list[dict] = []
        # EventRelay gates onboarding injection on this. Default True so
        # tests don't have to opt in explicitly; individual tests can flip
        # it False to exercise the inactive path.
        self.active: bool = True

    async def broadcast_game_event(self, event: Dict[str, Any], *, voice_agent_originated: bool = False) -> None:
        self.broadcast_events.append(event)

    def is_our_task(self, task_id: str) -> bool:
        return task_id in self.our_task_ids

    def active_tasks_summary(self) -> str:
        return "Active tasks: 0/1 personal, 0/3 corp."

    def is_recent_request_id(self, request_id: str) -> bool:
        return request_id in self.recent_request_ids

    @property
    def tool_call_active(self) -> bool:
        return self.tool_call_inflight

    async def queue_frame(self, frame, direction=None) -> None:
        from pipecat.frames.frames import LLMMessagesAppendFrame

        if isinstance(frame, LLMMessagesAppendFrame):
            content = frame.messages[0]["content"] if frame.messages else ""
            self.deferred_events.append((content, frame.run_llm))
        else:
            self.deferred_events.append((str(frame), True))



def _make_relay(**overrides) -> tuple[EventRelay, StubTaskState, MagicMock, MagicMock]:
    """Create an EventRelay with mock game_client and rtvi_processor."""
    mock_client = MagicMock()
    mock_client.corporation_id = "corp-1"
    mock_client._canonical_character_id = None
    mock_client._get_summary = MagicMock(return_value=None)
    mock_client.on = MagicMock(return_value=lambda fn: fn)
    mock_client.join = AsyncMock(return_value={"request_id": "join-req"})
    mock_client.subscribe_my_messages = AsyncMock()
    mock_client.list_user_ships = AsyncMock()
    mock_client.quest_status = AsyncMock()
    mock_client.list_known_ports = AsyncMock(return_value={"request_id": "mega-req"})

    mock_rtvi = MagicMock()
    mock_rtvi.push_frame = AsyncMock()
    mock_rtvi.interrupt_bot = AsyncMock()

    task_state = StubTaskState()

    kwargs = {
        "game_client": mock_client,
        "rtvi_processor": mock_rtvi,
        "character_id": "char-123",
        "task_state": task_state,
    }
    kwargs.update(overrides)
    relay = EventRelay(**kwargs)
    return relay, task_state, mock_client, mock_rtvi


def _make_event(event_name: str, payload: dict = None, request_id: str = None) -> dict:
    """Build a game event dict."""
    ev = {"event_name": event_name, "payload": payload or {}}
    if request_id:
        ev["request_id"] = request_id
    return ev


# ── Tests ──────────────────────────────────────────────────────────────────


@pytest.mark.unit
class TestSessionLifecycle:
    @pytest.mark.asyncio
    async def test_join_records_session_start_time(self):
        relay, _, _, _ = _make_relay()
        assert relay.session_started_at is None

        await relay.join()

        assert relay.session_started_at is not None


@pytest.mark.unit
class TestExtractDisplayName:
    def test_from_player_mapping(self):
        assert extract_display_name({"player": {"name": "Alice"}}) == "Alice"

    def test_from_fallback(self):
        assert extract_display_name({"player_name": "Bob"}) == "Bob"

    def test_none_for_empty(self):
        assert extract_display_name({}) is None

    def test_none_for_non_mapping(self):
        assert extract_display_name("not a dict") is None

    def test_strips_whitespace(self):
        assert extract_display_name({"player": {"name": "  Alice  "}}) == "Alice"


@pytest.mark.unit
class TestEventRelayInit:
    def test_subscribes_to_events(self):
        relay, _, mock_client, _ = _make_relay()
        # on() should have been called for each event + task.cancel
        assert mock_client.on.call_count > 50

    def test_initial_state(self):
        relay, _, _, _ = _make_relay()
        assert relay.character_id == "char-123"
        assert relay.display_name == "char-123"
        assert relay._current_sector_id is None


@pytest.mark.unit
class TestPriorityMetadata:
    """Priority is metadata on EventConfig, not stateful mode."""

    def test_combat_events_have_high_priority(self):
        assert EVENT_CONFIGS["combat.round_waiting"].priority == Priority.HIGH
        assert EVENT_CONFIGS["combat.round_resolved"].priority == Priority.HIGH

    def test_combat_ended_has_low_priority(self):
        assert EVENT_CONFIGS["combat.ended"].priority == Priority.LOW

    def test_normal_events_have_normal_priority(self):
        assert EVENT_CONFIGS["sector.update"].priority == Priority.NORMAL
        assert EVENT_CONFIGS["chat.message"].priority == Priority.NORMAL


@pytest.mark.unit
class TestPayloadHelpers:
    def test_strip_internal_metadata(self):
        payload = {
            "data": "value",
            "__event_context": {"scope": "direct"},
            "event_context": {"scope": "direct"},
            "recipient_ids": ["a"],
            "recipient_reasons": ["direct"],
        }
        cleaned = EventRelay._strip_internal_event_metadata(payload)
        assert "data" in cleaned
        assert "__event_context" not in cleaned
        assert "event_context" not in cleaned
        assert "recipient_ids" not in cleaned
        assert "recipient_reasons" not in cleaned

    def test_strip_non_mapping(self):
        assert EventRelay._strip_internal_event_metadata("hello") == "hello"

    def test_extract_event_context(self):
        ctx = EventRelay._extract_event_context({"__event_context": {"scope": "direct"}})
        assert ctx == {"scope": "direct"}

    def test_extract_event_context_none(self):
        assert EventRelay._extract_event_context({}) is None

    def test_extract_sector_id_from_nested(self):
        assert EventRelay._extract_sector_id({"sector": {"id": 42}}) == 42

    def test_extract_sector_id_preserves_nested_zero(self):
        assert EventRelay._extract_sector_id({"sector": {"id": 0}}) == 0

    def test_extract_sector_id_from_flat(self):
        assert EventRelay._extract_sector_id({"sector_id": 7}) == 7

    def test_extract_sector_id_from_top_level_when_allowed(self):
        assert EventRelay._extract_sector_id({"id": 42}, allow_top_level_id=True) == 42

    def test_extract_sector_id_from_top_level_string_when_allowed(self):
        assert EventRelay._extract_sector_id({"id": "42"}, allow_top_level_id=True) == 42

    def test_extract_sector_id_preserves_top_level_zero_when_allowed(self):
        assert EventRelay._extract_sector_id({"id": 0}, allow_top_level_id=True) == 0

    def test_extract_sector_id_ignores_top_level_without_flag(self):
        assert EventRelay._extract_sector_id({"id": 42}) is None

    def test_extract_sector_id_rejects_top_level_bool(self):
        assert EventRelay._extract_sector_id({"id": True}, allow_top_level_id=True) is None

    def test_extract_sector_id_rejects_scalar_sector_bool(self):
        assert EventRelay._extract_sector_id({"sector": True}) is None

    def test_extract_combat_id(self):
        assert EventRelay._extract_combat_id({"combat_id": "cbt-99"}) == "cbt-99"

    def test_extract_combat_id_none(self):
        assert EventRelay._extract_combat_id({}) is None


@pytest.mark.unit
class TestResolveRecipientReason:
    def test_direct_reason(self):
        ctx = {"reason": "direct"}
        assert EventRelay._resolve_recipient_reason(ctx, "char-1") == "direct"

    def test_array_fallback(self):
        ctx = {
            "recipient_ids": ["char-1", "char-2"],
            "recipient_reasons": ["direct", "observer"],
        }
        assert EventRelay._resolve_recipient_reason(ctx, "char-1") == "direct"
        assert EventRelay._resolve_recipient_reason(ctx, "char-2") == "observer"

    def test_none_without_ctx(self):
        assert EventRelay._resolve_recipient_reason(None, "char-1") is None


@pytest.mark.unit
class TestIsDirectRecipientEvent:
    def test_direct_reason(self):
        relay, _, _, _ = _make_relay()
        ctx = {"reason": "direct"}
        assert relay._is_direct_recipient_event(ctx) is True

    def test_character_id_match(self):
        relay, _, _, _ = _make_relay()
        ctx = {"character_id": "char-123"}
        assert relay._is_direct_recipient_event(ctx) is True

    def test_no_match(self):
        relay, _, _, _ = _make_relay()
        ctx = {"reason": "observer", "character_id": "other"}
        assert relay._is_direct_recipient_event(ctx) is False


@pytest.mark.unit
class TestVoiceSummary:
    def test_chat_message_broadcast(self):
        relay, _, _, _ = _make_relay()
        event = {
            "payload": {
                "type": "broadcast",
                "from_name": "Alice",
                "content": "Hello everyone!",
            }
        }
        result = _summarize_chat(relay, event)
        assert "Alice (broadcast): Hello everyone!" == result

    def test_chat_message_direct(self):
        relay, _, _, _ = _make_relay()
        event = {
            "payload": {
                "type": "direct",
                "from_name": "Alice",
                "to_name": "Bob",
                "content": "Hey Bob",
            }
        }
        result = _summarize_chat(relay, event)
        assert "Alice → Bob: Hey Bob" == result

    def test_event_query(self):
        relay, _, _, _ = _make_relay()
        event = {
            "payload": {
                "count": 5,
                "has_more": True,
                "filters": {"filter_event_type": "trade.executed"},
            }
        }
        result = _summarize_event_query(relay, event)
        assert "Query returned 5 events (type=trade.executed). More available." == result

    def test_ships_list_empty(self):
        relay, _, _, _ = _make_relay()
        event = {"payload": {"ships": []}}
        assert _summarize_ships_list(relay, event) == "No ships available."

    def test_ships_list_active_only(self):
        relay, _, _, _ = _make_relay()
        event = {
            "payload": {
                "ships": [
                    {
                        "ship_id": "aaaaaaaa-1111-2222-3333-444444444444",
                        "ship_name": "Scout",
                        "ship_type": "autonomous_probe",
                        "sector": 7,
                        "owner_type": "corporation",
                        "destroyed_at": None,
                    },
                ],
            }
        }
        result = _summarize_ships_list(relay, event)
        assert result.startswith("Fleet: 1 active\n")
        assert "destroyed" not in result.lower()
        assert "Corporation ships (1):" in result
        assert "Scout" in result

    def test_ships_list_mixed_active_and_destroyed(self):
        relay, _, _, _ = _make_relay()
        event = {
            "payload": {
                "ships": [
                    {
                        "ship_id": "aaaaaaaa-1111-2222-3333-444444444444",
                        "ship_name": "Scout",
                        "ship_type": "autonomous_probe",
                        "sector": 7,
                        "owner_type": "corporation",
                        "destroyed_at": None,
                    },
                    {
                        "ship_id": "bbbbbbbb-1111-2222-3333-444444444444",
                        "ship_name": "Old Hauler",
                        "ship_type": "autonomous_light_hauler",
                        "sector": 12,
                        "owner_type": "corporation",
                        "destroyed_at": "2026-04-01T00:00:00Z",
                    },
                ],
            }
        }
        result = _summarize_ships_list(relay, event)
        assert result.startswith("Fleet: 1 active, 1 destroyed\n")
        assert "Corporation ships (1):" in result
        assert "Destroyed ships (1):" in result
        # [DESTROYED] tag must be on the destroyed line only
        destroyed_lines = [
            line for line in result.splitlines() if "[DESTROYED]" in line
        ]
        assert len(destroyed_lines) == 1
        assert "Old Hauler" in destroyed_lines[0]
        assert "last seen sector 12" in destroyed_lines[0]
        # Active ship must not be tagged
        assert "[DESTROYED] Scout" not in result

    def test_ships_list_all_destroyed(self):
        relay, _, _, _ = _make_relay()
        event = {
            "payload": {
                "ships": [
                    {
                        "ship_id": "bbbbbbbb-1111-2222-3333-444444444444",
                        "ship_name": "Old Hauler",
                        "ship_type": "autonomous_light_hauler",
                        "sector": 12,
                        "owner_type": "corporation",
                        "destroyed_at": "2026-04-01T00:00:00Z",
                    },
                ],
            }
        }
        result = _summarize_ships_list(relay, event)
        assert result.startswith("Fleet: 0 active, 1 destroyed\n")
        assert "Corporation ships" not in result
        assert "Destroyed ships (1):" in result
        assert "[DESTROYED] Old Hauler" in result

    def test_combat_action_accepted(self):
        relay, _, _, _ = _make_relay()
        event = {"payload": {"round": 2, "action": "Attack", "commit": 10}}
        result = _summarize_combat_action(relay, event)
        assert "round 2" in result
        assert "attack" in result
        assert "commit 10" in result

    def test_combat_round_resolved(self):
        relay, _, _, _ = _make_relay()
        event = {
            "payload": {
                "round": 3,
                "result": "in_progress",
                "participants": [
                    {
                        "id": "char-123",
                        "name": "You",
                        "fighters": 45,
                        "ship": {"fighter_loss": 5, "shield_damage": 12.5},
                    }
                ],
            }
        }
        result = _summarize_combat_round(relay, event)
        assert "round 3" in result
        assert "lost 5 this round" in result
        assert "took 12.5% shield damage" in result
        assert "Combat state:" in result

    def test_fallback_to_summary(self):
        """Events without a voice_summary config fall back to event.summary."""
        cfg = EVENT_CONFIGS.get("some.unknown.event")
        assert cfg is None  # Unknown events use default config (no voice_summary)


@pytest.mark.unit
class TestCombatPOVSummaries:
    """Snapshot tests for the per-POV combat summary lines.

    Locks the catalog-defined wording so refactors of the POV-line
    helpers cannot silently drift the LLM-context strings. One snapshot
    per (event, POV) combination — extending or rewording these lines
    is intentional, so a failure here means update the snapshot AND the
    catalog together.
    """

    @staticmethod
    def _payload(
        *,
        round_num: int = 1,
        viewer_is_participant: bool = False,
        corp_ship_participant: bool = False,
        garrison: Optional[dict] = None,
        sector_id: int = 42,
        combat_id: str = "cbt-1",
        result: Optional[str] = None,
        include_round_losses: bool = True,
    ) -> dict:
        # Per-round losses (fighter_loss / shield_damage) live on
        # round_resolved payloads only; round_waiting payloads carry the
        # same participants list but without these fields. Set
        # include_round_losses=False to mirror that shape.
        def _ship(ship_name: str, fighter_loss: int, shield_damage: float) -> dict:
            ship: dict = {"ship_name": ship_name}
            if include_round_losses:
                ship["fighter_loss"] = fighter_loss
                ship["shield_damage"] = shield_damage
            return ship

        participants: list[dict] = []
        if viewer_is_participant:
            participants.append(
                {
                    "id": "char-123",
                    "name": "You",
                    "player_type": "human",
                    "ship_id": "ship-self",
                    "ship": _ship("Valkyrie", 2, 14.5),
                    "fighters": 48,
                    "destroyed": False,
                    "corp_id": "corp-1",
                }
            )
        if corp_ship_participant:
            participants.append(
                {
                    "id": "corp-ship-pseudo",
                    "name": "Probe-1",
                    "player_type": "corporation_ship",
                    "ship_id": "ship-probe",
                    "ship": _ship("Probe-1", 1, 0.0),
                    "fighters": 19,
                    "destroyed": False,
                    "corp_id": "corp-1",
                }
            )
        # Always add an opponent so observers have someone to "observe"
        participants.append(
            {
                "id": "char-foe",
                "name": "Foe",
                "player_type": "human",
                "ship_id": "ship-foe",
                "ship": _ship("Bandit", 0, 0.0),
                "fighters": 50,
                "destroyed": False,
                "corp_id": "corp-foe",
            }
        )
        payload: dict = {
            "combat_id": combat_id,
            "sector": {"id": sector_id},
            "round": round_num,
            "participants": participants,
        }
        if garrison is not None:
            payload["garrison"] = garrison
        if result is not None:
            payload["result"] = result
        return payload

    # ── round_waiting ───────────────────────────────────────────────

    def test_waiting_direct_round1(self):
        relay, _, _, _ = _make_relay()
        event = {
            "payload": self._payload(
                round_num=1,
                viewer_is_participant=True,
                include_round_losses=False,
            )
        }
        result = _summarize_combat_waiting(relay, event)
        assert result == (
            "A new combat has begun. You are a participant. (round 1)\n"
            "Participants:\n"
            "- You [you, no corp]: 48 fighters\n"
            "- Foe [opponent, no corp]: 50 fighters\n"
            "Submit a combat action now."
        )

    def test_waiting_direct_round2(self):
        relay, _, _, _ = _make_relay()
        event = {
            "payload": self._payload(
                round_num=2,
                viewer_is_participant=True,
                include_round_losses=False,
            )
        }
        result = _summarize_combat_waiting(relay, event)
        assert result == (
            "Combat state: you are currently in active combat. (round 2)\n"
            "Participants:\n"
            "- You [you, no corp]: 48 fighters\n"
            "- Foe [opponent, no corp]: 50 fighters\n"
            "Submit a combat action now."
        )

    def test_waiting_observed_corp_ship_round1(self):
        relay, _, _, _ = _make_relay()
        event = {
            "payload": self._payload(
                round_num=1,
                corp_ship_participant=True,
                include_round_losses=False,
            )
        }
        result = _summarize_combat_waiting(relay, event)
        assert result == (
            'A new combat has begun. Your corp\'s "Probe-1" '
            "has entered combat in sector 42. (round 1)\n"
            "Participants:\n"
            "- Probe-1 [your corp, no corp]: 19 fighters\n"
            "- Foe [opponent, no corp]: 50 fighters"
        )

    def test_waiting_observed_garrison_own_round1(self):
        relay, _, _, _ = _make_relay()
        garrison = {
            "id": "garrison:42:char-123",
            "name": "You Garrison",
            "owner_character_id": "char-123",
            "owner_corp_id": None,
            "owner_name": "You",
            "mode": "offensive",
            "fighters": 30,
        }
        event = {
            "payload": self._payload(
                round_num=1, garrison=garrison, include_round_losses=False
            )
        }
        result = _summarize_combat_waiting(relay, event)
        assert result == (
            "A new combat has begun. Your garrison in sector 42 has engaged. "
            "It is currently in offensive mode. (round 1)\n"
            "Participants:\n"
            "- Foe [opponent, no corp]: 50 fighters\n"
            "- You Garrison "
            "[target_id=garrison:42:char-123, owner You, no corp, offensive mode]: "
            "30 fighters"
        )

    def test_waiting_observed_garrison_corpmate_round1(self):
        relay, _, _, _ = _make_relay()
        garrison = {
            "id": "garrison:42:char-other",
            "name": "Carla Garrison",
            "owner_character_id": "char-other",
            "owner_corp_id": "corp-1",
            "owner_name": "Carla",
            "mode": "toll",
            "fighters": 30,
        }
        event = {
            "payload": self._payload(
                round_num=1, garrison=garrison, include_round_losses=False
            )
        }
        result = _summarize_combat_waiting(relay, event)
        assert result == (
            "A new combat has begun. Your corp's garrison in sector 42 has engaged. "
            "It is currently in toll mode. (round 1)\n"
            "Participants:\n"
            "- Foe [opponent, no corp]: 50 fighters\n"
            "- Carla Garrison "
            "[target_id=garrison:42:char-other, owner Carla, toll mode]: "
            "30 fighters"
        )

    def test_waiting_observed_sector_only_round1(self):
        relay, _, _, _ = _make_relay()
        event = {
            "payload": self._payload(round_num=1, include_round_losses=False)
        }
        result = _summarize_combat_waiting(relay, event)
        assert result == (
            "A new combat has begun in sector 42. (round 1)\n"
            "Participants:\n"
            "- Foe [opponent, no corp]: 50 fighters"
        )

    # ── round_resolved ──────────────────────────────────────────────

    def test_resolved_direct_includes_round_summary(self):
        relay, _, _, _ = _make_relay()
        payload = self._payload(
            round_num=1, viewer_is_participant=True, result="in_progress"
        )
        payload["actions"] = {
            "You": {"action": "attack", "commit": 25, "target_id": "char-foe"},
        }
        event = {"payload": payload}
        result = _summarize_combat_round(relay, event)
        assert result == (
            "Combat state: you are currently in active combat. (round 1)\n"
            "Round resolved: in_progress.\n"
            "Your action: attack target char-f commit 25.\n"
            "Participants:\n"
            "- You [you, no corp]: 48 fighters, "
            "lost 2 this round; took 14.5% shield damage\n"
            "- Foe [opponent, no corp]: 50 fighters"
        )

    def test_resolved_observed_corp_ship_includes_action_and_participants(self):
        relay, _, _, _ = _make_relay()
        payload = self._payload(
            round_num=1, corp_ship_participant=True, result="in_progress"
        )
        payload["actions"] = {
            "Probe-1": {"action": "brace", "commit": 0},
        }
        event = {"payload": payload}
        result = _summarize_combat_round(relay, event)
        assert result == (
            'Combat state: your corp\'s "Probe-1" is engaged in combat. (round 1)\n'
            "Round resolved: in_progress.\n"
            "Your ship's action: brace.\n"
            "Participants:\n"
            "- Probe-1 [your corp, no corp]: 19 fighters, lost 1 this round\n"
            "- Foe [opponent, no corp]: 50 fighters"
        )

    def test_resolved_observed_sector_only_no_action_line(self):
        relay, _, _, _ = _make_relay()
        event = {"payload": self._payload(round_num=1, result="in_progress")}
        result = _summarize_combat_round(relay, event)
        assert result == (
            "Combat state: this combat event is not your fight. (round 1)\n"
            "Round resolved: in_progress.\n"
            "Participants:\n"
            "- Foe [opponent, no corp]: 50 fighters"
        )

    def test_resolved_corp_name_renders_in_participant_line(self):
        relay, _, _, _ = _make_relay()
        payload = self._payload(
            round_num=1, corp_ship_participant=True, result="in_progress"
        )
        # Tag the corp ship with its corp name (server-side payload now
        # surfaces this from combat_participants metadata).
        for participant in payload["participants"]:
            if participant["id"] == "corp-ship-pseudo":
                participant["corp_name"] = "Probe Crew"
        event = {"payload": payload}
        result = _summarize_combat_round(relay, event)
        assert "Probe-1 [your corp, Probe Crew]" in result

    # ── combat.ended ────────────────────────────────────────────────

    def test_ended_direct(self):
        relay, _, _, _ = _make_relay()
        event = {
            "payload": self._payload(
                round_num=2, viewer_is_participant=True, result="mutual_destruction"
            )
        }
        result = _summarize_combat_ended(relay, event)
        assert result == "Your combat has ended. Result: mutual_destruction."

    def test_ended_observed_corp_ship(self):
        relay, _, _, _ = _make_relay()
        event = {
            "payload": self._payload(
                round_num=2, corp_ship_participant=True, result="mutual_destruction"
            )
        }
        result = _summarize_combat_ended(relay, event)
        assert result == (
            'Your corp\'s "Probe-1" combat in sector 42 has ended. '
            "Result: mutual_destruction."
        )

    def test_ended_observed_garrison_own(self):
        relay, _, _, _ = _make_relay()
        garrison = {
            "id": "garrison:42:char-123",
            "owner_character_id": "char-123",
            "owner_corp_id": None,
            "owner_name": "You",
            "mode": "offensive",
            "fighters": 0,
        }
        event = {
            "payload": self._payload(round_num=2, garrison=garrison, result="one_side_destroyed")
        }
        result = _summarize_combat_ended(relay, event)
        assert result == (
            "Your garrison in sector 42 (garrison_id=garrison:42:char-123) "
            "combat has ended. Result: one_side_destroyed."
        )

    def test_ended_observed_sector_only(self):
        relay, _, _, _ = _make_relay()
        event = {"payload": self._payload(round_num=2, result="stalemate")}
        result = _summarize_combat_ended(relay, event)
        assert result == "Observed combat in sector 42 has ended. Result: stalemate."

    # ── garrison.destroyed ──────────────────────────────────────────

    def test_garrison_destroyed_owner(self):
        from gradientbang.pipecat_server.subagents.event_relay import (
            _summarize_garrison_destroyed,
        )

        relay, _, _, _ = _make_relay()
        event = {
            "payload": {
                "combat_id": "cbt-1",
                "garrison_id": "garrison:42:char-123",
                "owner_character_id": "char-123",
                "owner_name": "You",
                "sector": {"id": 42},
                "mode": "offensive",
            }
        }
        result = _summarize_garrison_destroyed(relay, event)
        assert result == (
            "Your garrison was destroyed in sector 42 "
            "garrison_id=garrison:42:char-123, mode=offensive."
        )

    def test_garrison_destroyed_observer(self):
        from gradientbang.pipecat_server.subagents.event_relay import (
            _summarize_garrison_destroyed,
        )

        relay, _, _, _ = _make_relay()
        event = {
            "payload": {
                "combat_id": "cbt-1",
                "garrison_id": "garrison:42:char-other",
                "owner_character_id": "char-other",
                "owner_name": "Bob",
                "sector": {"id": 42},
                "mode": "toll",
            }
        }
        result = _summarize_garrison_destroyed(relay, event)
        assert result == (
            "Garrison destroyed in sector 42 "
            "garrison_id=garrison:42:char-other, mode=toll (owner: Bob)."
        )


@pytest.mark.unit
class TestCombatXmlEnvelope:
    """XML envelope attr selection per POV (catalog Appendix A) and the
    user-content escape applied to attr values."""

    @staticmethod
    def _attrs(pairs: list[tuple[str, str]]) -> dict[str, str]:
        return dict(pairs)

    # ── _xml_attrs_combat_encounter ─────────────────────────────────

    def test_encounter_envelope_direct_only_combat_id(self):
        relay, _, _, _ = _make_relay()
        payload = {
            "combat_id": "cbt-1",
            "sector": {"id": 42},
            "round": 1,
            "participants": [
                {"id": "char-123", "name": "You", "player_type": "human", "corp_id": "corp-1"},
                {"id": "char-foe", "name": "Foe", "player_type": "human", "corp_id": "corp-foe"},
            ],
        }
        attrs = self._attrs(_xml_attrs_combat_encounter(relay, payload))
        # DIRECT viewer (in participants): combat_id + combat_pov="direct".
        assert attrs == {"combat_id": "cbt-1", "combat_pov": "direct"}

    def test_encounter_envelope_corp_ship_observer_adds_ship_attrs(self):
        relay, _, _, _ = _make_relay()
        payload = {
            "combat_id": "cbt-1",
            "sector": {"id": 42},
            "round": 1,
            "participants": [
                {
                    "id": "corp-ship-pseudo",
                    "name": "Probe-1",
                    "player_type": "corporation_ship",
                    "ship_id": "ship-probe",
                    "ship": {"ship_name": "Probe-1"},
                    "corp_id": "corp-1",
                },
                {"id": "char-foe", "name": "Foe", "player_type": "human", "corp_id": "corp-foe"},
            ],
        }
        attrs = self._attrs(_xml_attrs_combat_encounter(relay, payload))
        # ship_id is shortened (6-char prefix) for compactness; the full
        # UUID is in the body/payload when needed for tool calls.
        assert attrs == {
            "combat_id": "cbt-1",
            "combat_pov": "observed_via_corp_ship",
            "ship_id": "ship-p",
            "ship_name": "Probe-1",
        }

    def test_encounter_envelope_garrison_observer_adds_garrison_attrs(self):
        relay, _, _, _ = _make_relay()
        payload = {
            "combat_id": "cbt-1",
            "sector": {"id": 42},
            "round": 1,
            "participants": [
                {"id": "char-foe", "name": "Foe", "player_type": "human", "corp_id": "corp-foe"},
            ],
            "garrison": {
                "id": "garrison:42:char-123",
                "owner_character_id": "char-123",
                "owner_corp_id": None,
                "owner_name": "You",
                "mode": "offensive",
                "fighters": 30,
            },
        }
        attrs = self._attrs(_xml_attrs_combat_encounter(relay, payload))
        assert attrs == {
            "combat_id": "cbt-1",
            "combat_pov": "observed_via_garrison",
            "garrison_id": "garrison:42:char-123",
            "garrison_owner": "char-123",
        }

    def test_encounter_envelope_sector_only_observer(self):
        relay, _, _, _ = _make_relay()
        payload = {
            "combat_id": "cbt-1",
            "sector": {"id": 42},
            "round": 1,
            # Viewer not a participant; no garrison stake.
            "participants": [
                {"id": "char-foe", "name": "Foe", "player_type": "human", "corp_id": "corp-foe"},
            ],
        }
        attrs = self._attrs(_xml_attrs_combat_encounter(relay, payload))
        assert attrs == {"combat_id": "cbt-1", "combat_pov": "observed_sector_only"}

    # ── _xml_attrs_ship_destroyed (subject-scoped, always same shape) ──

    def test_ship_destroyed_envelope_full_attrs(self):
        relay, _, _, _ = _make_relay()
        payload = {
            "combat_id": "cbt-1",
            "ship_id": "ship-probe",
            "ship_name": "Probe-1",
            "owner_character_id": "char-other",
            "corp_id": "corp-1",
        }
        attrs = self._attrs(_xml_attrs_ship_destroyed(relay, payload))
        assert attrs == {
            "combat_id": "cbt-1",
            "ship_id": "ship-probe",
            "ship_name": "Probe-1",
        }

    def test_ship_destroyed_envelope_skips_missing_ship_name(self):
        relay, _, _, _ = _make_relay()
        payload = {"combat_id": "cbt-1", "ship_id": "ship-x"}
        attrs = self._attrs(_xml_attrs_ship_destroyed(relay, payload))
        assert attrs == {"combat_id": "cbt-1", "ship_id": "ship-x"}

    # ── _xml_attrs_garrison_destroyed ───────────────────────────────

    def test_garrison_destroyed_envelope_full_attrs(self):
        relay, _, _, _ = _make_relay()
        payload = {
            "combat_id": "cbt-1",
            "garrison_id": "garrison:42:char-123",
            "owner_character_id": "char-123",
        }
        attrs = self._attrs(_xml_attrs_garrison_destroyed(relay, payload))
        assert attrs == {
            "combat_id": "cbt-1",
            "garrison_id": "garrison:42:char-123",
            "garrison_owner": "char-123",
        }

    # ── _xml_escape_attr ────────────────────────────────────────────

    def test_xml_escape_handles_quotes_brackets_amp(self):
        # The literal ship_name a player could set; without escaping, the
        # double-quote would close the attribute and corrupt the envelope.
        raw = 'Probe & Co "<flagship>"'
        escaped = _xml_escape_attr(raw)
        assert escaped == "Probe &amp; Co &quot;&lt;flagship&gt;&quot;"
        # Round-trip-safe: re-applying produces the same string (idempotent
        # only at the final escaped form, but no double-encoding hazards
        # at this stage).
        assert "&" in escaped and '"' not in escaped


@pytest.mark.unit
class TestRelayEventRouting:
    """Core _relay_event routing decisions."""

    async def test_map_update_not_appended_to_llm(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event("map.update", {"data": "update"})
        await relay._relay_event(event)
        # Should push RTVI but no LLMMessagesAppendFrame
        calls = mock_rtvi.push_frame.call_args_list
        assert any("map.update" in str(c) for c in calls)
        # Only one call (RTVIServerMessageFrame), no LLMMessagesAppendFrame
        assert len(calls) == 1

    async def test_direct_event_appended_to_llm(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event(
            "trade.executed",
            {
                "data": "trade",
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
            request_id="req-1",
        )
        task_state.recent_request_ids.add("req-1")
        await relay._relay_event(event)
        # RTVI push happens on rtvi, LLM delivery goes through task_state
        assert mock_rtvi.push_frame.call_count == 1  # RTVI only

    async def test_event_query_bus_event_gets_bounded_task_summary(self):
        relay, task_state, _, _ = _make_relay()
        payload = {
            "count": 25,
            "has_more": True,
            "filters": {"filter_event_type": "task.finish"},
            "events": [
                {
                    "event": f"movement.complete.{idx}",
                    "timestamp": f"2026-03-29T12:00:{idx:02d}Z",
                    "payload": {"detail": "x" * 500},
                }
                for idx in range(25)
            ],
            "__event_context": {"scope": "direct", "reason": "direct"},
        }
        await relay._relay_event(_make_event("event.query", payload))

        bus_event = task_state.broadcast_events[-1]
        assert bus_event["event_name"] == "event.query"
        assert "... 5 more events omitted." in bus_event["summary"]
        assert "More events available" in bus_event["summary"]

    async def test_existing_generic_summary_is_carried_through_bus(self):
        relay, task_state, mock_client, _ = _make_relay()
        mock_client._get_summary.return_value = "Status summary."
        event = _make_event(
            "status.snapshot",
            {
                "player": {"id": "char-123"},
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )

        await relay._relay_event(event)

        bus_event = task_state.broadcast_events[-1]
        assert bus_event["summary"] == "Status summary."

    async def test_rtvi_payload_remains_raw_when_bus_summary_exists(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        payload = {
            "count": 2,
            "has_more": False,
            "events": [
                {"event": "task.finish", "timestamp": "2026-03-29T12:00:00Z", "payload": {"x": 1}},
                {"event": "task.finish", "timestamp": "2026-03-29T12:00:01Z", "payload": {"x": 2}},
            ],
            "__event_context": {"scope": "direct", "reason": "direct"},
        }

        await relay._relay_event(_make_event("event.query", payload))

        frame = mock_rtvi.push_frame.call_args.args[0]
        assert frame.data["frame_type"] == "event"
        assert frame.data["event"] == "event.query"
        assert frame.data["payload"]["events"] == payload["events"]
        assert "summary" not in frame.data["payload"]
        assert len(task_state.deferred_events) == 1  # LLM event delivered via task_state

    async def test_combat_event_appended_for_participant(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event(
            "combat.round_waiting",
            {
                "combat_id": "cbt-1",
                "round": 1,
                "participants": [{"id": "char-123"}],
            },
        )
        await relay._relay_event(event)
        # RTVI push + LLM delivery via task_state
        assert mock_rtvi.push_frame.call_count == 1
        assert len(task_state.deferred_events) >= 1


@pytest.mark.unit
class TestCombatPOVRouting:
    """Combat append + run_llm decisions per POV.

    Direct: appended, run_llm=True, combat_pov="direct" — InferenceGate
        upgrades to combat_event priority.
    Observed corp-ship / garrison: append the full context stream; run_llm
        only on initiation and terminal resolution.
    Sector-only: appended (silent context), run_llm=False — never wakes
        the bot for a fight the viewer has no stake in.
    """

    @staticmethod
    def _payload(
        *,
        round_num: int = 1,
        viewer_is_participant: bool = False,
        corp_ship_participant: bool = False,
        garrison: Optional[dict] = None,
        result: Optional[str] = None,
    ) -> dict:
        participants: list[dict] = []
        if viewer_is_participant:
            participants.append(
                {"id": "char-123", "name": "You", "player_type": "human", "corp_id": "corp-1"}
            )
        if corp_ship_participant:
            participants.append(
                {
                    "id": "corp-ship-pseudo",
                    "name": "Probe-1",
                    "player_type": "corporation_ship",
                    "ship_id": "ship-probe",
                    "ship": {"ship_name": "Probe-1"},
                    "corp_id": "corp-1",
                }
            )
        participants.append(
            {"id": "char-foe", "name": "Foe", "player_type": "human", "corp_id": "corp-foe"}
        )
        # Direct viewers get reason="direct"; observers come in under the
        # broader sector/corp/garrison reasons. The relay's PARTICIPANT
        # append rule treats event_context=None as "deliver everywhere"
        # for safety, so always supply a context to exercise the real
        # observer codepath.
        if viewer_is_participant:
            event_context: dict = {"scope": "direct", "reason": "direct"}
        else:
            event_context = {"scope": "sector", "reason": "sector_snapshot"}
        payload: dict = {
            "combat_id": "cbt-1",
            "sector": {"id": 42},
            "round": round_num,
            "participants": participants,
            "__event_context": event_context,
        }
        if garrison is not None:
            payload["garrison"] = garrison
        if result is not None:
            payload["result"] = result
        return payload

    @staticmethod
    def _find_event_frame(task_state) -> tuple[str, bool]:
        """Locate the <event …> frame among deferred frames.

        Direct round-1 combat also queues combat.md preamble + strategy
        frames ahead of the event itself; tests want the event frame
        regardless of how many preamble frames preceded it."""
        for content, run_llm in task_state.deferred_events:
            if content.lstrip().startswith("<event"):
                return content, run_llm
        raise AssertionError(
            f"No <event> frame in deferred_events: {task_state.deferred_events}"
        )

    async def test_direct_round1_runs_llm_with_direct_pov(self):
        relay, task_state, _, _ = _make_relay()
        # Skip the combat.md preamble fetch (its strategy call hits the
        # mock client and isn't what this test is exercising).
        relay._combat_md_loaded = True
        await relay._relay_event(
            _make_event(
                "combat.round_waiting",
                self._payload(round_num=1, viewer_is_participant=True),
            )
        )
        content, run_llm = self._find_event_frame(task_state)
        assert run_llm is True
        assert 'combat_pov="direct"' in content

    async def test_observed_corp_ship_round1_runs_llm_with_normal_priority_pov(self):
        relay, task_state, _, _ = _make_relay()
        relay._combat_md_loaded = True
        await relay._relay_event(
            _make_event(
                "combat.round_waiting",
                self._payload(round_num=1, corp_ship_participant=True),
            )
        )
        content, run_llm = self._find_event_frame(task_state)
        # Observed corp ship: bot should speak the notification...
        assert run_llm is True
        # ...but the POV attr keeps InferenceGate on the normal `event` lane
        # so it cannot bypass cooldown / interrupt the bot mid-speech.
        assert 'combat_pov="observed_via_corp_ship"' in content

    async def test_observed_garrison_round1_runs_llm_with_normal_priority_pov(self):
        relay, task_state, _, _ = _make_relay()
        relay._combat_md_loaded = True
        garrison = {
            "id": "garrison:42:char-123",
            "owner_character_id": "char-123",
            "owner_corp_id": None,
            "owner_name": "You",
            "mode": "offensive",
            "fighters": 30,
        }
        await relay._relay_event(
            _make_event(
                "combat.round_waiting", self._payload(round_num=1, garrison=garrison)
            )
        )
        content, run_llm = self._find_event_frame(task_state)
        assert run_llm is True
        assert 'combat_pov="observed_via_garrison"' in content

    async def test_observed_sector_only_round1_appends_silently(self):
        relay, task_state, _, _ = _make_relay()
        relay._combat_md_loaded = True
        await relay._relay_event(
            _make_event("combat.round_waiting", self._payload(round_num=1))
        )
        # Sector-only viewer: appended for awareness but no inference.
        content, run_llm = self._find_event_frame(task_state)
        assert run_llm is False
        assert 'combat_pov="observed_sector_only"' in content

    async def test_observed_corp_ship_round2_appends_silently(self):
        relay, task_state, _, _ = _make_relay()
        relay._combat_md_loaded = True
        await relay._relay_event(
            _make_event(
                "combat.round_waiting",
                self._payload(round_num=2, corp_ship_participant=True),
            )
        )
        content, run_llm = self._find_event_frame(task_state)
        assert run_llm is False
        assert 'combat_pov="observed_via_corp_ship"' in content

    async def test_observed_corp_ship_round_resolved_continuing_appends_silently(self):
        relay, task_state, _, _ = _make_relay()
        relay._combat_md_loaded = True
        await relay._relay_event(
            _make_event(
                "combat.round_resolved",
                self._payload(
                    round_num=2,
                    corp_ship_participant=True,
                    result="in_progress",
                ),
            )
        )
        content, run_llm = self._find_event_frame(task_state)
        assert run_llm is False
        assert 'combat_pov="observed_via_corp_ship"' in content

    async def test_observed_corp_ship_terminal_round_resolved_runs_llm(self):
        relay, task_state, _, _ = _make_relay()
        relay._combat_md_loaded = True
        await relay._relay_event(
            _make_event(
                "combat.round_resolved",
                self._payload(
                    round_num=3,
                    corp_ship_participant=True,
                    result="no_hostiles",
                ),
            )
        )
        content, run_llm = self._find_event_frame(task_state)
        assert run_llm is True
        assert 'combat_pov="observed_via_corp_ship"' in content

    async def test_observed_garrison_round2_appends_silently(self):
        relay, task_state, _, _ = _make_relay()
        relay._combat_md_loaded = True
        garrison = {
            "id": "garrison:42:char-123",
            "owner_character_id": "char-123",
            "owner_corp_id": None,
            "owner_name": "You",
            "mode": "offensive",
            "fighters": 30,
        }
        await relay._relay_event(
            _make_event(
                "combat.round_waiting",
                self._payload(round_num=2, garrison=garrison),
            )
        )
        content, run_llm = self._find_event_frame(task_state)
        assert run_llm is False
        assert 'combat_pov="observed_via_garrison"' in content

    async def test_observed_garrison_terminal_round_resolved_runs_llm(self):
        relay, task_state, _, _ = _make_relay()
        relay._combat_md_loaded = True
        garrison = {
            "id": "garrison:42:char-123",
            "owner_character_id": "char-123",
            "owner_corp_id": None,
            "owner_name": "You",
            "mode": "offensive",
            "fighters": 0,
        }
        await relay._relay_event(
            _make_event(
                "combat.round_resolved",
                self._payload(
                    round_num=2,
                    garrison=garrison,
                    result="one_side_destroyed",
                ),
            )
        )
        content, run_llm = self._find_event_frame(task_state)
        assert run_llm is True
        assert 'combat_pov="observed_via_garrison"' in content

    async def test_other_player_departure_from_other_sector_rtvi_only(self):
        """Other-player departures from different sectors get RTVI push but no LLM append."""
        relay, task_state, _, mock_rtvi = _make_relay()
        relay._current_sector_id = 5
        event = _make_event(
            "character.moved",
            {
                "player": {"id": "other-player"},
                "movement": "depart",
                "sector_id": 10,
            },
        )
        await relay._relay_event(event)
        assert mock_rtvi.push_frame.call_count == 1  # RTVI push happens
        assert len(task_state.deferred_events) == 0  # No LLM (LOCAL rule, different sector)

    async def test_task_scoped_event_deferred_when_tool_inflight(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        task_state.tool_call_inflight = True
        # Mark the task as ours
        task_state.our_task_ids.add("full-uuid-1")
        event = _make_event(
            "trade.executed",
            {
                "__task_id": "full-uuid-1",
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        await relay._relay_event(event)
        # Event should be deferred, not delivered
        assert len(task_state.deferred_events) == 1
        # Only RTVI push, no LLM append
        llm_calls = [
            c for c in mock_rtvi.push_frame.call_args_list if "LLMMessagesAppend" in str(type(c))
        ]
        assert len(llm_calls) == 0

    async def test_event_context_missing_non_combat_returns_early(self):
        """Events without event_context (and not combat/task) are dropped after RTVI push."""
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event("some.event", {"data": "value"})
        await relay._relay_event(event)
        # Only RTVI push, no LLM append (event_context is None, not combat)
        assert mock_rtvi.push_frame.call_count == 1

    async def test_sector_tracking_from_status_snapshot(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        # Needs event_context for it to be appended; but sector tracking happens
        # regardless of append decision
        event = _make_event(
            "status.snapshot",
            {
                "sector": {"id": 42},
                "player": {"id": "char-123"},
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
            request_id="req-1",
        )
        task_state.recent_request_ids.add("req-1")
        await relay._relay_event(event)
        assert relay._current_sector_id == 42

    async def test_display_name_updated_from_status(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event(
            "status.update",
            {
                "player": {"id": "char-123", "name": "Captain Kirk"},
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        await relay._relay_event(event)
        assert relay.display_name == "Captain Kirk"


@pytest.mark.unit
class TestOnboarding:
    """Passive onboarding: observe ports.list for mega-ports, expose is_new_player flag."""

    def test_initial_state(self):
        relay, _, _, _ = _make_relay()
        assert relay.is_new_player is None
        assert relay._first_status_delivered is False
        assert relay._onboarding_complete is False

    async def test_new_player_detected_from_empty_ports(self):
        """Initial megaport check with empty ports → is_new_player=True."""
        relay, task_state, _, _ = _make_relay()
        relay._megaport_check_request_id = "mega-req"
        relay._first_status_delivered = True  # status already delivered
        event = _make_event(
            "ports.list",
            {"ports": [], "__event_context": {"scope": "direct", "reason": "direct"}},
            request_id="mega-req",
        )
        await relay._relay_event(event)
        assert relay.is_new_player is True
        assert relay._onboarding_complete is True
        # Should inject onboarding message
        onboarding_events = [e for e in task_state.deferred_events if "onboarding" in e[0]]
        assert len(onboarding_events) == 1

    async def test_onboarding_fragment_content_loaded(self):
        """New player onboarding injects the actual onboarding.md fragment content."""
        relay, task_state, _, _ = _make_relay()
        relay._megaport_check_request_id = "mega-req"
        relay._first_status_delivered = True
        relay.display_name = "TestPlayer"
        event = _make_event(
            "ports.list",
            {"ports": [], "__event_context": {"scope": "direct", "reason": "direct"}},
            request_id="mega-req",
        )
        await relay._relay_event(event)
        onboarding_events = [e for e in task_state.deferred_events if "onboarding" in e[0]]
        assert len(onboarding_events) == 1
        content, run_llm = onboarding_events[0]
        # Verify fragment was loaded (not empty/stub) and display_name was interpolated
        assert '<event name="onboarding">' in content
        assert "TestPlayer" in content
        # Key phrases from the onboarding.md fragment
        assert "Federation Space" in content
        assert "mega-port" in content
        assert run_llm is True

    async def test_veteran_detected_from_ports_with_mega(self):
        """Initial megaport check with ports → is_new_player=False."""
        relay, task_state, _, _ = _make_relay()
        relay._megaport_check_request_id = "mega-req"
        relay._first_status_delivered = True
        event = _make_event(
            "ports.list",
            {"ports": [{"id": "port-1"}], "__event_context": {"scope": "direct", "reason": "direct"}},
            request_id="mega-req",
        )
        await relay._relay_event(event)
        assert relay.is_new_player is False
        assert relay._onboarding_complete is True
        session_events = [e for e in task_state.deferred_events if "session.start" in e[0]]
        assert len(session_events) == 1

    async def test_waits_for_both_signals(self):
        """Onboarding injection waits for both status delivery and megaport check."""
        relay, task_state, _, _ = _make_relay()
        relay._megaport_check_request_id = "mega-req"
        # Megaport check resolves but status not delivered yet
        event = _make_event(
            "ports.list",
            {"ports": [], "__event_context": {"scope": "direct", "reason": "direct"}},
            request_id="mega-req",
        )
        await relay._relay_event(event)
        assert relay.is_new_player is True
        assert relay._onboarding_complete is False  # Waiting for status

    async def test_ongoing_observation_flips_flag(self):
        """Subsequent ports.list with mega-ports flips is_new_player True→False and injects onboarding.complete."""
        relay, task_state, _, _ = _make_relay()
        relay.is_new_player = True
        relay._onboarding_complete = True
        event = _make_event(
            "ports.list",
            {"ports": [{"id": "mega-1"}], "__event_context": {"scope": "direct", "reason": "direct"}},
            request_id="other-req",
        )
        await relay._relay_event(event)
        assert relay.is_new_player is False
        complete_events = [e for e in task_state.deferred_events if "onboarding.complete" in e[0]]
        assert len(complete_events) == 1
        content, run_llm = complete_events[0]
        assert "disregard" in content.lower()
        assert run_llm is False

    async def test_veteran_never_receives_onboarding_fragment(self):
        """Veteran player gets session.start only, never the onboarding fragment."""
        relay, task_state, _, _ = _make_relay()
        relay._megaport_check_request_id = "mega-req"
        relay._first_status_delivered = True
        event = _make_event(
            "ports.list",
            {"ports": [{"id": "port-1"}], "__event_context": {"scope": "direct", "reason": "direct"}},
            request_id="mega-req",
        )
        await relay._relay_event(event)
        assert relay.is_new_player is False
        # No onboarding fragment, no onboarding.complete — only session.start
        all_content = [e[0] for e in task_state.deferred_events]
        assert any("session.start" in c for c in all_content)
        assert not any("onboarding" in c and "session.start" not in c for c in all_content)

    async def test_ports_list_not_dropped(self):
        """ports.list events always flow through to RTVI (not dropped)."""
        relay, task_state, _, mock_rtvi = _make_relay()
        relay._megaport_check_request_id = "mega-req"
        event = _make_event(
            "ports.list",
            {"ports": [], "__event_context": {"scope": "direct", "reason": "direct"}},
            request_id="mega-req",
        )
        await relay._relay_event(event)
        assert mock_rtvi.push_frame.call_count == 1  # RTVI push happens

    async def test_status_snapshot_sets_first_delivered(self):
        relay, task_state, _, _ = _make_relay()
        event = _make_event(
            "status.snapshot",
            {
                "player": {"id": "char-123"},
                "sector": {"id": 1},
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        await relay._relay_event(event)
        assert relay._first_status_delivered is True


@pytest.mark.unit
class TestCombatEventRouting:
    async def test_combat_round_waiting_appended_for_participant(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event(
            "combat.round_waiting",
            {
                "combat_id": "cbt-1",
                "round": 1,
                "participants": [{"id": "char-123"}],
            },
        )
        await relay._relay_event(event)
        assert mock_rtvi.push_frame.call_count == 1
        assert len(task_state.deferred_events) >= 1

    async def test_combat_ended_appended_for_participant(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event(
            "combat.ended",
            {
                "combat_id": "cbt-1",
                "participants": [{"id": "char-123"}],
            },
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) >= 1
        _, run_llm = task_state.deferred_events[0]
        assert run_llm is False

    async def test_combat_round_waiting_triggers_inference_for_participant(self):
        """ON_PARTICIPANT rule: inference triggers when player is a participant."""
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event(
            "combat.round_waiting",
            {
                "combat_id": "cbt-1",
                "round": 2,  # Round 2+ skips the round-1 combat.md preamble injection
                "participants": [{"id": "char-123"}],
            },
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) >= 1
        # Filter to the actual combat.round_waiting XML frame (preamble injection
        # may queue earlier frames at round 1; we use round 2 to avoid it).
        combat_frames = [
            (c, r) for c, r in task_state.deferred_events
            if 'name="combat.round_waiting"' in c
        ]
        assert len(combat_frames) == 1
        _, run_llm = combat_frames[0]
        assert run_llm is True

    async def test_combat_round_waiting_no_inference_for_observer(self):
        """Round-1 fan-out appends for observers (silent context), but
        ON_PARTICIPANT inference still doesn't fire for non-participants."""
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event(
            "combat.round_waiting",
            {
                "combat_id": "cbt-1",
                "round": 1,
                "participants": [{"id": "other-player"}],
                "__event_context": {"scope": "local", "reason": "observer"},
            },
        )
        await relay._relay_event(event)
        # Round-1 broadcast: silent append for every recipient.
        assert len(task_state.deferred_events) >= 1
        _, run_llm = task_state.deferred_events[0]
        assert run_llm is False  # ON_PARTICIPANT — observer gets no inference

    async def test_combat_round_waiting_observer_no_append_after_round_1(self):
        """Round 2+ drops non-participants entirely (the round-1 fan-out is
        a one-shot broadcast; subsequent rounds stay participant-only)."""
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event(
            "combat.round_waiting",
            {
                "combat_id": "cbt-1",
                "round": 2,
                "participants": [{"id": "other-player"}],
                "__event_context": {"scope": "local", "reason": "observer"},
            },
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 0


@pytest.mark.unit
class TestPortsListAlwaysFlows:
    async def test_ports_list_always_gets_rtvi_push(self):
        """ports.list events are never dropped — always flow to RTVI."""
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event(
            "ports.list",
            {"ports": [], "__event_context": {"scope": "direct", "reason": "direct"}},
            request_id="any-req",
        )
        await relay._relay_event(event)
        assert mock_rtvi.push_frame.call_count == 1


@pytest.mark.unit
class TestTaskCancelEvent:
    async def test_cancel_broadcasts_event(self):
        relay, task_state, _, _ = _make_relay()
        event = {"payload": {"task_id": "full-uuid-1"}}
        await relay._handle_task_cancel_event(event)
        # Should broadcast the cancel event to the bus
        assert len(task_state.broadcast_events) == 1
        assert task_state.broadcast_events[0] is event

    async def test_cancel_no_match(self):
        relay, task_state, _, _ = _make_relay()
        event = {"payload": {"task_id": "nonexistent"}}
        await relay._handle_task_cancel_event(event)
        # No error, just returns

    async def test_cancel_empty_task_id_skipped(self):
        relay, task_state, _, _ = _make_relay()
        event = {"payload": {}}
        await relay._handle_task_cancel_event(event)
        # No task_id in payload, so broadcast should not be called
        assert len(task_state.broadcast_events) == 0


@pytest.mark.unit
class TestCorpShipMovement:
    async def test_corp_ship_movement_not_appended_to_llm(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        relay._current_sector_id = 5

        # Mark the task as ours so is_our_task resolves to True
        task_state.our_task_ids.add("full-uuid-1")

        # character.moved uses LOCAL append rule — corp ship in same sector
        # should be suppressed because is_other_player and is_our_task
        event = _make_event(
            "character.moved",
            {
                "player": {"id": "corp-ship-1"},
                "sector_id": 5,
                "__task_id": "full-uuid-1",
                "__event_context": {"scope": "corp"},
            },
        )
        await relay._relay_event(event)
        # Should push RTVI but NOT append to LLM (corp ship movement handled by task agent)
        assert mock_rtvi.push_frame.call_count == 1  # Only RTVI push
        assert len(task_state.deferred_events) == 0


@pytest.mark.unit
class TestInferenceTriggeringLogic:
    async def test_chat_message_always_triggers(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event(
            "chat.message",
            {
                "type": "broadcast",
                "from_name": "Alice",
                "content": "Hello!",
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        await relay._relay_event(event)
        # RTVI push on rtvi, LLM delivery via task_state with run_llm=True
        assert mock_rtvi.push_frame.call_count == 1
        assert len(task_state.deferred_events) == 1
        _, run_llm = task_state.deferred_events[0]
        assert run_llm is True

    async def test_status_snapshot_needs_request_id(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        relay._onboarding_pending = False  # skip onboarding
        event = _make_event(
            "status.snapshot",
            {
                "player": {"id": "char-123"},
                "sector": {"id": 1},
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
            request_id="req-1",
        )
        # Without request_id in recent set, no inference
        await relay._relay_event(event)
        calls = mock_rtvi.push_frame.call_args_list
        llm_calls = [c for c in calls if hasattr(c[0][0], "run_llm")]
        if llm_calls:
            assert llm_calls[0][0][0].run_llm is False

    async def test_voice_agent_inference_triggers_with_request_id(self):
        """VOICE_AGENT rule triggers inference when request_id matches and onboarding complete."""
        relay, task_state, _, mock_rtvi = _make_relay()
        relay._onboarding_complete = True  # onboarding done, inference allowed
        task_state.recent_request_ids.add("req-1")

        event = _make_event(
            "status.snapshot",
            {
                "player": {"id": "char-123"},
                "sector": {"id": 1},
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
            request_id="req-1",
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 1
        _, run_llm = task_state.deferred_events[0]
        assert run_llm is True


# ── Phase 0: Comprehensive coverage for current behavior ─────────────────


@pytest.mark.unit
class TestAppendRuleNever:
    """AppendRule.NEVER — RTVI push only, no LLM delivery."""

    async def test_map_update_rtvi_only(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event("map.update", {"sectors": [1, 2, 3]})
        await relay._relay_event(event)
        assert mock_rtvi.push_frame.call_count == 1
        assert len(task_state.deferred_events) == 0


@pytest.mark.unit
class TestAppendRuleParticipant:
    """AppendRule.PARTICIPANT — appended only when character is in participants."""

    async def test_appended_when_participant(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event(
            "combat.action_accepted",
            {
                "combat_id": "cbt-1",
                "round": 1,
                "action": "Attack",
                "commit": 5,
                "participants": [{"id": "char-123"}],
                # combat.action_accepted is now actor-scoped (only the row's
                # recipient sees it admitted) so the event_context must
                # carry character_id matching the viewer.
                "__event_context": {
                    "scope": "direct",
                    "reason": "direct",
                    "character_id": "char-123",
                },
            },
        )
        await relay._relay_event(event)
        assert mock_rtvi.push_frame.call_count == 1
        assert len(task_state.deferred_events) == 1
        _, run_llm = task_state.deferred_events[0]
        assert run_llm is False

    async def test_not_appended_when_not_participant(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event(
            "combat.action_accepted",
            {
                "combat_id": "cbt-1",
                "round": 1,
                "action": "Attack",
                "participants": [{"id": "other-player"}],
                "__event_context": {"scope": "local", "reason": "observer"},
            },
        )
        await relay._relay_event(event)
        assert mock_rtvi.push_frame.call_count == 1  # RTVI always
        assert len(task_state.deferred_events) == 0  # No LLM

    async def test_appended_when_event_context_missing(self):
        """PARTICIPANT with missing event_context allows through (safety fallback)."""
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event(
            "combat.round_resolved",
            {
                "combat_id": "cbt-1",
                "round": 1,
                "result": "in_progress",
            },
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) >= 1


@pytest.mark.unit
class TestAppendRuleOwnedTask:
    """AppendRule.OWNED_TASK — appended when task_id belongs to us."""

    async def test_appended_when_our_task(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        task_state.our_task_ids.add("task-abc")
        event = _make_event(
            "task.start",
            {
                "__task_id": "task-abc",
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        await relay._relay_event(event)
        assert mock_rtvi.push_frame.call_count == 1
        assert len(task_state.deferred_events) == 0

    async def test_not_appended_when_not_our_task(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event(
            "task.start",
            {
                "__task_id": "task-xyz",
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        await relay._relay_event(event)
        assert mock_rtvi.push_frame.call_count == 1  # RTVI always
        assert len(task_state.deferred_events) == 0  # No LLM

@pytest.mark.unit
class TestAppendRuleDirect:
    """AppendRule.DIRECT — appended for direct scope + direct recipient."""

    async def test_appended_for_direct_recipient(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event(
            "path.region",
            {
                "data": "sector info",
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        await relay._relay_event(event)
        assert mock_rtvi.push_frame.call_count == 1
        assert len(task_state.deferred_events) == 1

    async def test_not_appended_for_corp_scope(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event(
            "path.region",
            {
                "data": "sector info",
                "__event_context": {"scope": "corp"},
            },
        )
        await relay._relay_event(event)
        assert mock_rtvi.push_frame.call_count == 1
        assert len(task_state.deferred_events) == 0

    async def test_not_appended_without_event_context(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event("path.region", {"data": "sector info"})
        await relay._relay_event(event)
        assert mock_rtvi.push_frame.call_count == 1
        assert len(task_state.deferred_events) == 0

    async def test_task_scoped_direct_needs_allowlist_or_voice(self):
        """Direct event with task_id only appended if task_scoped_allowlisted or voice agent."""
        relay, task_state, _, mock_rtvi = _make_relay()
        # path.region has task_scoped_allowlisted=False
        event = _make_event(
            "path.region",
            {
                "__task_id": "task-1",
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 0  # Blocked: not allowlisted, not voice

    async def test_task_scoped_allowlisted_passes_through(self):
        """Direct event with task_id passes if task_scoped_allowlisted=True."""
        relay, task_state, _, mock_rtvi = _make_relay()
        # trade.executed has task_scoped_allowlisted=True
        event = _make_event(
            "trade.executed",
            {
                "__task_id": "task-1",
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 1

    async def test_task_scoped_voice_agent_passes_through(self):
        """Direct event with task_id passes if request_id is from voice agent."""
        relay, task_state, _, mock_rtvi = _make_relay()
        task_state.recent_request_ids.add("req-voice")
        # path.region is NOT task_scoped_allowlisted but voice agent request passes
        event = _make_event(
            "path.region",
            {
                "__task_id": "task-1",
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
            request_id="req-voice",
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 1

    async def test_corp_scope_with_own_action_and_voice(self):
        """Corp-scoped event appended when corp_scope_if_own_action=True and voice agent."""
        relay, task_state, _, mock_rtvi = _make_relay()
        task_state.recent_request_ids.add("req-voice")
        event = _make_event(
            "corporation.created",
            {
                "corp_data": "new corp",
                "__event_context": {"scope": "corp"},
            },
            request_id="req-voice",
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 1

    async def test_corp_scope_without_voice_not_appended(self):
        """Corp-scoped event NOT appended when corp_scope_if_own_action=True but not voice."""
        relay, task_state, _, mock_rtvi = _make_relay()
        event = _make_event(
            "corporation.created",
            {
                "corp_data": "new corp",
                "__event_context": {"scope": "corp"},
            },
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 0

    async def test_canonical_character_id_used_for_other_player_guard(self):
        relay, task_state, mock_client, _ = _make_relay(character_id="legacy-name")
        mock_client._canonical_character_id = "canonical-char-id"
        event = _make_event(
            "path.region",
            {
                "player": {"id": "canonical-char-id"},
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )

        await relay._relay_event(event)

        assert len(task_state.deferred_events) == 1


@pytest.mark.unit
class TestAppendRuleLocal:
    """AppendRule.LOCAL — appended when same sector, not when different."""

    async def test_appended_when_same_sector(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        relay._current_sector_id = 5
        event = _make_event(
            "character.moved",
            {
                "player": {"id": "other-player"},
                "sector_id": 5,
                "__event_context": {"scope": "local"},
            },
        )
        await relay._relay_event(event)
        assert mock_rtvi.push_frame.call_count == 1
        assert len(task_state.deferred_events) == 1

    async def test_not_appended_when_different_sector(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        relay._current_sector_id = 5
        event = _make_event(
            "character.moved",
            {
                "player": {"id": "other-player"},
                "sector_id": 10,
                "__event_context": {"scope": "local"},
            },
        )
        await relay._relay_event(event)
        # RTVI push still happens (event is not a departure so no early return)
        assert mock_rtvi.push_frame.call_count == 1
        assert len(task_state.deferred_events) == 0

    async def test_not_appended_when_sector_unknown(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        # _current_sector_id is None
        event = _make_event(
            "character.moved",
            {
                "player": {"id": "other-player"},
                "sector_id": 5,
                "__event_context": {"scope": "local"},
            },
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 0

    async def test_own_movement_appended(self):
        relay, task_state, _, mock_rtvi = _make_relay()
        relay._current_sector_id = 5
        event = _make_event(
            "character.moved",
            {
                "player": {"id": "char-123"},
                "sector_id": 5,
                "__event_context": {"scope": "local"},
            },
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 1


@pytest.mark.unit
class TestInferenceRules:
    """Systematic coverage of each InferenceRule."""

    async def test_never_no_inference(self):
        """InferenceRule.NEVER — run_llm is False even when appended."""
        relay, task_state, _, _ = _make_relay()
        # map.update is NEVER append, use a DIRECT+NEVER combo
        # path.region has DIRECT append + NEVER inference
        event = _make_event(
            "path.region",
            {"data": "info", "__event_context": {"scope": "direct", "reason": "direct"}},
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 1
        _, run_llm = task_state.deferred_events[0]
        assert run_llm is False

    async def test_always_triggers(self):
        """InferenceRule.ALWAYS — run_llm is True (chat.message)."""
        relay, task_state, _, _ = _make_relay()
        event = _make_event(
            "chat.message",
            {"content": "hello", "__event_context": {"scope": "direct", "reason": "direct"}},
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 1
        _, run_llm = task_state.deferred_events[0]
        assert run_llm is True

    async def test_quest_uses_voice_agent_inference(self):
        """quest.step_completed uses VOICE_AGENT — no inference without request_id."""
        relay, task_state, _, _ = _make_relay()
        event = _make_event(
            "quest.step_completed",
            {"quest": "q1", "__event_context": {"scope": "direct", "reason": "direct"}},
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 1
        _, run_llm = task_state.deferred_events[0]
        assert run_llm is False

    async def test_quest_triggers_with_voice_request_id(self):
        """quest.step_completed triggers inference when voice agent request_id matches."""
        relay, task_state, _, _ = _make_relay()
        task_state.recent_request_ids.add("req-quest")
        event = _make_event(
            "quest.step_completed",
            {"quest": "q1", "__event_context": {"scope": "direct", "reason": "direct"}},
            request_id="req-quest",
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 1
        _, run_llm = task_state.deferred_events[0]
        assert run_llm is True

    async def test_ports_list_never_appended_with_matching_request(self):
        """ports.list is AppendRule.NEVER — voice agent gets data via the direct-response
        tool result, so the follow-up event must not duplicate it in LLM context."""
        relay, task_state, _, _ = _make_relay()
        relay._onboarding_pending = False
        task_state.recent_request_ids.add("req-1")
        event = _make_event(
            "ports.list",
            {"ports": [], "__event_context": {"scope": "direct", "reason": "direct"}},
            request_id="req-1",
        )
        await relay._relay_event(event)
        assert task_state.deferred_events == []

    async def test_course_plot_with_matching_request(self):
        """course.plot stays inference-triggering for matching voice requests."""
        relay, task_state, _, _ = _make_relay()
        relay._onboarding_pending = False
        task_state.recent_request_ids.add("req-course")
        event = _make_event(
            "course.plot",
            {
                "path": [1, 5, 10],
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
            request_id="req-course",
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 1
        _, run_llm = task_state.deferred_events[0]
        assert run_llm is True

    async def test_ports_list_never_appended_without_matching_request(self):
        """ports.list stays out of voice LLM context regardless of request_id match."""
        relay, task_state, _, _ = _make_relay()
        relay._onboarding_pending = False
        event = _make_event(
            "ports.list",
            {"ports": [], "__event_context": {"scope": "direct", "reason": "direct"}},
            request_id="unknown-req",
        )
        await relay._relay_event(event)
        assert task_state.deferred_events == []

    async def test_voice_agent_without_matching_request(self):
        """InferenceRule.VOICE_AGENT — False when request_id doesn't match.

        course.plot still exercises this rule; ports.list switched to NEVER.
        """
        relay, task_state, _, _ = _make_relay()
        relay._onboarding_pending = False
        event = _make_event(
            "course.plot",
            {
                "path": [1, 5, 10],
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
            request_id="unknown-req",
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 1
        _, run_llm = task_state.deferred_events[0]
        assert run_llm is False

    async def test_owned_task_finish_skips_voice_llm(self):
        """task.finish stays off the voice LLM entirely.

        Bus protocol (on_task_response) already injects task.completed. Adding
        task.finish as a second completion message makes the assistant repeat
        the same result.
        """
        relay, task_state, _, _ = _make_relay()
        task_state.our_task_ids.add("task-1")
        event = _make_event(
            "task.finish",
            {
                "__task_id": "task-1",
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        await relay._relay_event(event)
        assert task_state.deferred_events == []

    async def test_owned_no_trigger_for_other_task(self):
        """InferenceRule.OWNED — False when task is not ours."""
        relay, task_state, _, _ = _make_relay()
        # task.finish is skipped for the voice LLM even when task-scoped.
        event = _make_event(
            "task.finish",
            {
                "__task_id": "task-other",
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        await relay._relay_event(event)
        # Not our task — should not be appended
        assert len(task_state.deferred_events) == 0


@pytest.mark.unit
class TestEventFlowIntegrity:
    """Every event gets RTVI push. Bus broadcast happens for all events."""

    async def test_all_configured_events_get_rtvi_push(self):
        """Every event type in EVENT_CONFIGS gets an RTVI push."""
        for event_name in EVENT_CONFIGS:
            relay, task_state, _, mock_rtvi = _make_relay()
            relay._onboarding_pending = False
            event = _make_event(
                event_name,
                {"__event_context": {"scope": "direct", "reason": "direct"}},
            )
            await relay._relay_event(event)
            assert mock_rtvi.push_frame.call_count >= 1, (
                f"Event {event_name} did not get RTVI push"
            )

    async def test_all_events_broadcast_to_bus(self):
        """Every event routed through _relay_event is broadcast to bus."""
        for event_name in EVENT_CONFIGS:
            relay, task_state, _, mock_rtvi = _make_relay()
            relay._onboarding_pending = False
            event = _make_event(
                event_name,
                {"__event_context": {"scope": "direct", "reason": "direct"}},
            )
            await relay._relay_event(event)
            assert len(task_state.broadcast_events) >= 1, (
                f"Event {event_name} was not broadcast to bus"
            )


@pytest.mark.unit
class TestNoEventsDropped:
    """Verify no events are dropped — everything gets RTVI push."""

    async def test_character_moved_departure_other_sector_not_dropped(self):
        """character.moved departure from other sector still gets RTVI push."""
        relay, task_state, _, mock_rtvi = _make_relay()
        relay._current_sector_id = 5
        event = _make_event(
            "character.moved",
            {"player": {"id": "other-player"}, "movement": "depart", "sector_id": 10},
        )
        await relay._relay_event(event)
        assert mock_rtvi.push_frame.call_count == 1  # Not dropped


@pytest.mark.unit
class TestXmlFormat:
    """Verify the XML structure of events delivered to LLM."""

    async def test_basic_event_xml(self):
        relay, task_state, _, _ = _make_relay()
        event = _make_event(
            "path.region",
            {"data": "info", "__event_context": {"scope": "direct", "reason": "direct"}},
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 1
        content, _ = task_state.deferred_events[0]
        assert content.startswith('<event name="path.region">')
        assert content.endswith("</event>")

    async def test_task_id_in_xml(self):
        relay, task_state, _, _ = _make_relay()
        task_state.our_task_ids.add("task-abc")
        event = _make_event(
            "task.start",
            {
                "__task_id": "task-abc",
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        await relay._relay_event(event)
        assert task_state.deferred_events == []

    async def test_combat_id_in_xml(self):
        relay, task_state, _, _ = _make_relay()
        event = _make_event(
            "combat.action_accepted",
            {
                "combat_id": "cbt-99",
                "round": 1,
                "action": "Flee",
                "participants": [{"id": "char-123"}],
                # combat.action_accepted is actor-scoped: must match viewer.
                "__event_context": {
                    "scope": "direct",
                    "reason": "direct",
                    "character_id": "char-123",
                },
            },
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 1
        content, _ = task_state.deferred_events[0]
        assert 'combat_id="cbt-99"' in content

    async def test_voice_summary_replaces_payload_in_xml(self):
        relay, task_state, _, _ = _make_relay()
        event = _make_event(
            "chat.message",
            {
                "type": "broadcast",
                "from_name": "Alice",
                "content": "Hello everyone!",
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 1
        content, _ = task_state.deferred_events[0]
        assert "Alice (broadcast): Hello everyone!" in content

    async def test_event_query_uses_voice_summary_in_xml_but_task_summary_on_bus(self):
        relay, task_state, _, _ = _make_relay()
        payload = {
            "count": 25,
            "has_more": True,
            "filters": {"filter_event_type": "task.finish"},
            "events": [
                {
                    "event": f"task.finish.{idx}",
                    "timestamp": f"2026-03-29T12:00:{idx:02d}Z",
                    "payload": {"task_summary": "x" * 500},
                }
                for idx in range(25)
            ],
            "__event_context": {"scope": "direct", "reason": "direct"},
        }

        await relay._relay_event(_make_event("event.query", payload))

        bus_event = task_state.broadcast_events[-1]
        assert "... 5 more events omitted." in bus_event["summary"]

        content, _ = task_state.deferred_events[0]
        assert "Query returned 25 events (type=task.finish). More available." in content
        assert "... 5 more events omitted." not in content

    async def test_internal_metadata_stripped_from_xml(self):
        relay, task_state, _, _ = _make_relay()
        event = _make_event(
            "path.region",
            {
                "data": "info",
                "__event_context": {"scope": "direct", "reason": "direct"},
                "recipient_ids": ["char-123"],
                "recipient_reasons": ["direct"],
            },
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 1
        content, _ = task_state.deferred_events[0]
        assert "__event_context" not in content
        assert "recipient_ids" not in content
        assert "recipient_reasons" not in content


@pytest.mark.unit
class TestDeferredBatching:
    """Task-scoped events deferred when tool calls are inflight."""

    async def test_task_finish_deferred_is_not_queued(self):
        """task.finish is never queued into the voice LLM, even during tool calls."""
        relay, task_state, _, _ = _make_relay()
        task_state.tool_call_inflight = True
        task_state.our_task_ids.add("task-1")
        event = _make_event(
            "task.finish",
            {
                "__task_id": "task-1",
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        await relay._relay_event(event)
        assert task_state.deferred_events == []

    async def test_non_task_event_not_deferred(self):
        """Events without task_id are delivered immediately even with tool inflight."""
        relay, task_state, _, _ = _make_relay()
        task_state.tool_call_inflight = True
        event = _make_event(
            "chat.message",
            {
                "type": "broadcast",
                "from_name": "Alice",
                "content": "Hi!",
                "__event_context": {"scope": "direct", "reason": "direct"},
            },
        )
        await relay._relay_event(event)
        assert len(task_state.deferred_events) == 1
        _, run_llm = task_state.deferred_events[0]
        assert run_llm is True  # chat.message always triggers
