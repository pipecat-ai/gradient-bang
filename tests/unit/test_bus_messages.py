"""Tests for Phase 1 typed bus messages.

The Phase 2 PGMQ adapter uses upstream ``JSONMessageSerializer``, which
serializes dataclasses by fully qualified type name + ``asdict``. So
the contract these tests pin down is: every Gradient Bang custom bus
message must round-trip cleanly through ``dataclasses.asdict`` and a
matching constructor invocation. Anything that breaks this (e.g. a
non-JSON-serializable field type) breaks Phase 2 silently.
"""

import json
from dataclasses import asdict, fields

import pytest
from pipecat.bus import BusDataMessage

from gradientbang.runtime.bus import (
    BUS_PROTOCOL_VERSION,
    BusAgentHelloRequest,
    BusAgentHelloResponse,
    BusByoaPresenceMessage,
    BusCombatStrategyRequest,
    BusCombatStrategyResponse,
    BusCorporationQueryRequest,
    BusCorporationQueryResponse,
    BusGameEventMessage,
    BusGameToolCallRequest,
    BusGameToolCallResponse,
    BusSteerTaskMessage,
    BusTaskFinishNotification,
)


# Pipecat's DataFrame contributes envelope fields (``id``, ``name``, ``pts``,
# ``metadata``, ``transport_*``, ``broadcast_sibling_id``) plus the bus
# envelope (``source``, ``target``). These are pure transport plumbing,
# not part of the BYOA payload contract — we only pin the business fields.
ENVELOPE_FIELDS = {f.name for f in fields(BusDataMessage)}


def _business_dict(msg) -> dict:
    return {k: v for k, v in asdict(msg).items() if k not in ENVELOPE_FIELDS}


def _round_trip(msg) -> None:
    """Verify the business fields survive a JSON round-trip.

    We don't assert full instance equality because ``DataFrame`` assigns
    a fresh auto-incrementing ``id`` per instance; instead we pin the
    subclass-defined fields, which is what Phase 2's PGMQ transport
    will actually carry over the wire.
    """
    raw = asdict(msg)
    encoded = json.dumps(raw)
    decoded = json.loads(encoded)
    # Reconstruct using only the subclass's own fields so the new
    # instance picks up DataFrame defaults for the envelope. The
    # business fields must match the original exactly.
    business = {k: v for k, v in decoded.items() if k not in ENVELOPE_FIELDS}
    rebuilt = type(msg)(source=msg.source, target=msg.target, **business)
    assert _business_dict(rebuilt) == _business_dict(msg), (
        f"round-trip mismatch for {type(msg).__name__}:\n"
        f"  before: {_business_dict(msg)}\n"
        f"  after:  {_business_dict(rebuilt)}"
    )
    # Envelope source/target also survives.
    assert rebuilt.source == msg.source
    assert rebuilt.target == msg.target


@pytest.mark.unit
class TestExistingMessagesUnchanged:
    """Regression: pre-existing custom messages still round-trip."""

    def test_game_event_round_trip(self):
        _round_trip(
            BusGameEventMessage(
                source="va",
                target=None,
                event={"event_name": "movement.complete", "payload": {}},
                voice_agent_originated=True,
            )
        )

    def test_steer_task_round_trip(self):
        _round_trip(
            BusSteerTaskMessage(
                source="va",
                target="task_abc",
                task_id="t1",
                text="go to sector 5",
            )
        )


@pytest.mark.unit
class TestGameToolCall:
    def test_request_round_trip(self):
        _round_trip(
            BusGameToolCallRequest(
                source="task_abc",
                target="player",
                correlation_id="r1",
                tool_name="move",
                args={"to_sector": 5, "via": "warp"},
                character_id="char-123",
                actor_character_id="char-actor",
                task_id="task-uuid",
            )
        )

    def test_response_success_shape(self):
        _round_trip(
            BusGameToolCallResponse(
                source="player",
                target="task_abc",
                correlation_id="r1",
                result={"new_sector": 5},
                error=None,
            )
        )

    def test_response_error_shape(self):
        _round_trip(
            BusGameToolCallResponse(
                source="player",
                target="task_abc",
                correlation_id="r1",
                result=None,
                error="ship in hyperspace",
            )
        )


@pytest.mark.unit
class TestCombatStrategy:
    def test_request_round_trip(self):
        _round_trip(
            BusCombatStrategyRequest(
                source="task_abc",
                target="player",
                correlation_id="r2",
                character_id="char-corp-ship",
                task_id="task-uuid",
            )
        )

    def test_response_round_trip(self):
        _round_trip(
            BusCombatStrategyResponse(
                source="player",
                target="task_abc",
                correlation_id="r2",
                strategy={"doctrine": "aggressive", "actions": ["attack"]},
            )
        )


@pytest.mark.unit
class TestCorporationQuery:
    @pytest.mark.parametrize("qtype", ["list", "info", "my"])
    def test_request_round_trip(self, qtype):
        _round_trip(
            BusCorporationQueryRequest(
                source="task_abc",
                target="player",
                correlation_id="r3",
                query_type=qtype,
                character_id="char-123",
                corp_id="corp-1" if qtype == "info" else None,
                task_id="task-uuid",
            )
        )

    def test_response_round_trip(self):
        _round_trip(
            BusCorporationQueryResponse(
                source="player",
                target="task_abc",
                correlation_id="r3",
                result={"corp_id": "corp-1", "members": []},
            )
        )


@pytest.mark.unit
class TestTaskFinishNotification:
    @pytest.mark.parametrize("status", ["completed", "failed", "cancelled"])
    def test_round_trip(self, status):
        _round_trip(
            BusTaskFinishNotification(
                source="task_abc",
                target="player",
                character_id="char-corp-ship",
                actor_character_id="player-123",
                task_id="task-uuid",
                status=status,
                summary="reached sector 5",
            )
        )

    def test_summary_optional(self):
        _round_trip(
            BusTaskFinishNotification(
                source="task_abc",
                target="player",
                character_id="char-123",
                task_id="task-uuid",
                status="completed",
                summary=None,
            )
        )


@pytest.mark.unit
class TestAgentHello:
    def test_request_round_trip(self):
        _round_trip(
            BusAgentHelloRequest(
                source="player",
                target="task_abc",
                correlation_id="hello-1",
            )
        )

    def test_response_ready_round_trip(self):
        _round_trip(
            BusAgentHelloResponse(
                source="task_abc",
                target="player",
                correlation_id="hello-1",
                ready=True,
                protocol_version=BUS_PROTOCOL_VERSION,
                capabilities={"tools": ["move", "trade"]},
                error=None,
            )
        )

    def test_response_unready_round_trip(self):
        _round_trip(
            BusAgentHelloResponse(
                source="task_abc",
                target="player",
                correlation_id="hello-1",
                ready=False,
                protocol_version=BUS_PROTOCOL_VERSION,
                capabilities={},
                error="still warming up",
            )
        )

    def test_byoa_presence_round_trip(self):
        _round_trip(
            BusByoaPresenceMessage(
                source="byoa_ship-1",
                target=None,
                ship_id="ship-1",
                online=True,
                status="online",
                last_seen_at="2026-05-12T12:00:00+00:00",
                protocol_version=BUS_PROTOCOL_VERSION,
            )
        )
