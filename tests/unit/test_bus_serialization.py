"""Round-trip every gradient-bang custom ``BusMessage`` through ``JSONMessageSerializer``.

Precondition for Phase 2's PGMQ transport: any custom message added to
``bus_messages.py`` must serialize cleanly via the upstream serializer, since
PGMQ carries JSON bytes. If a field is typed as something non-JSON-safe (an
object reference, a callable, etc.) the serializer drops it with a warning
and the receiver gets a stripped message — exactly the silent breakage this
test guards against.
"""

import pytest
from pipecat_subagents.bus.serializers import JSONMessageSerializer

from gradientbang.pipecat_server.subagents.bus_messages import (
    BUS_PROTOCOL_VERSION,
    BusAgentHelloRequest,
    BusAgentHelloResponse,
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

SOURCE = "voice_agent"
TARGET = "task_alice"


def _samples():
    yield BusGameEventMessage(
        source=SOURCE,
        event={"event_name": "ship.move", "payload": {"sector_id": 42}},
        voice_agent_originated=True,
    )
    yield BusSteerTaskMessage(
        source=SOURCE,
        target=TARGET,
        task_id="t-1",
        text="head to 7,8",
    )
    yield BusGameToolCallRequest(
        source=TARGET,
        target=SOURCE,
        correlation_id="c-1",
        tool_name="move",
        args={"x": 7, "y": 8},
        character_id="char-1",
        actor_character_id="actor-1",
        task_id="t-1",
    )
    yield BusGameToolCallResponse(
        source=SOURCE,
        target=TARGET,
        correlation_id="c-1",
        result={"ok": True, "sector_id": 99},
        error=None,
    )
    yield BusGameToolCallResponse(
        source=SOURCE,
        target=TARGET,
        correlation_id="c-2",
        result=None,
        error="ship_busy",
    )
    yield BusCombatStrategyRequest(
        source=TARGET,
        target=SOURCE,
        correlation_id="c-3",
        character_id="char-1",
        ship_id="ship-1",
    )
    yield BusCombatStrategyResponse(
        source=SOURCE,
        target=TARGET,
        correlation_id="c-3",
        strategy={"posture": "aggressive"},
    )
    yield BusCorporationQueryRequest(
        source=TARGET,
        target=SOURCE,
        correlation_id="c-4",
        query_type="info",
        character_id="char-1",
        corp_id="corp-9",
    )
    yield BusCorporationQueryResponse(
        source=SOURCE,
        target=TARGET,
        correlation_id="c-4",
        result={"members": 3},
    )
    yield BusTaskFinishNotification(
        source=TARGET,
        target=SOURCE,
        character_id="char-1",
        actor_character_id="actor-1",
        task_id="t-1",
        status="completed",
        summary="moved + traded",
    )
    yield BusAgentHelloRequest(
        source=SOURCE,
        target=TARGET,
        correlation_id="c-5",
    )
    yield BusAgentHelloResponse(
        source=TARGET,
        target=SOURCE,
        correlation_id="c-5",
        ready=True,
        protocol_version=BUS_PROTOCOL_VERSION,
        capabilities={"tools": ["move", "trade"]},
    )


@pytest.mark.unit
@pytest.mark.parametrize("message", list(_samples()), ids=lambda m: type(m).__name__)
def test_custom_bus_message_round_trips(message):
    serializer = JSONMessageSerializer()
    restored = serializer.deserialize(serializer.serialize(message))

    assert type(restored) is type(message), (
        f"Expected {type(message).__name__}, got {type(restored).__name__}"
    )
    # Compare on the dataclass fields rather than __eq__ — Pipecat's
    # DataFrame base adds a non-deterministic id at construction, so two
    # equivalent messages aren't ``==``.
    from dataclasses import fields

    for f in fields(message):
        assert getattr(restored, f.name) == getattr(message, f.name), (
            f"{type(message).__name__}.{f.name} did not round-trip "
            f"(orig={getattr(message, f.name)!r}, restored={getattr(restored, f.name)!r})"
        )
