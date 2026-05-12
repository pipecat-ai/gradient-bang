"""Unit tests for ``BusJSONSerializer``.

The OpenAI Python SDK uses a singleton ``NotGiven`` sentinel for "arg
not provided". Pipecat's LLM frames carry that through to bus messages,
and upstream ``JSONMessageSerializer`` logs a "skipping field with
unserializable type _NotGiven" warning for every occurrence on a
pgmq-transport deployment. ``BusJSONSerializer`` short-circuits the
sentinel to ``None`` so the warning goes away while preserving the
on-wire shape (the field is absent either way).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional

import pytest

from gradientbang.adapters.bus.serializer import BusJSONSerializer
from pipecat_subagents.bus.messages import BusMessage


class _FakeNotGiven:
    """Stand-in for ``openai._types.NotGiven`` — class-name match is
    what the serializer keys on, so this is faithful to the wire path
    without pulling the openai SDK into the test."""

    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover
        return "NOT_GIVEN"


# Rename via class assignment so __name__ matches the upstream check.
_FakeNotGiven.__name__ = "NotGiven"
NOT_GIVEN = _FakeNotGiven()


@dataclass
class _FakeBusMessage(BusMessage):
    source: str = ""
    target: str = ""
    correlation_id: str = ""
    payload: Optional[str] = None
    not_given_field: object = field(default=None)


@pytest.mark.unit
class TestBusJSONSerializer:
    def test_not_given_field_is_silently_elided(self, caplog):
        serializer = BusJSONSerializer()
        msg = _FakeBusMessage(
            source="a", target="b", payload="ok", not_given_field=NOT_GIVEN
        )
        with caplog.at_level(logging.WARNING, logger="loguru"):
            data = serializer.serialize(msg)
        # Field absent from the JSON — not_given encoded as None drops it.
        assert b"not_given_field" not in data
        # And no warning about it.
        assert "skipping field" not in caplog.text

    def test_other_fields_round_trip_unchanged(self):
        serializer = BusJSONSerializer()
        msg = _FakeBusMessage(source="a", target="b", payload="hello")
        data = serializer.serialize(msg)
        restored = serializer.deserialize(data)
        assert restored is not None
        assert restored.source == "a"
        assert restored.target == "b"
        assert restored.payload == "hello"

    def test_alternate_class_name_underscore_prefix(self):
        """Older openai SDKs export the private ``_NotGiven`` spelling."""
        serializer = BusJSONSerializer()

        class _AltNotGiven:
            pass

        _AltNotGiven.__name__ = "_NotGiven"
        sentinel = _AltNotGiven()
        msg = _FakeBusMessage(source="a", target="b", not_given_field=sentinel)
        data = serializer.serialize(msg)
        assert b"not_given_field" not in data
