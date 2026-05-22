"""Bus message serializer that handles OpenAI ``NOT_GIVEN`` sentinels.

The OpenAI SDK's ``NOT_GIVEN`` singleton survives into pipecat LLM
frames and triggers a per-occurrence warning in upstream
:class:`JSONMessageSerializer`. This subclass elides it to ``None``
so the field is dropped on wire — wire-equivalent to "field absent".
"""

from __future__ import annotations

from typing import Any

from pipecat.bus.serializers import JSONMessageSerializer


class BusJSONSerializer(JSONMessageSerializer):
    """Drop-in :class:`JSONMessageSerializer` that silently elides
    OpenAI ``NOT_GIVEN`` sentinels.

    Used by :func:`build_pgmq_bus` for both bot and BYOA buses. Behavior
    is identical to the upstream serializer for every other type.
    """

    def _serialize_value(self, value: Any) -> Any:
        # Match by class name to avoid importing openai and to cover both
        # `NotGiven` / `_NotGiven` spellings across SDK versions.
        if type(value).__name__ in ("NotGiven", "_NotGiven"):
            return None
        return super()._serialize_value(value)


__all__ = ["BusJSONSerializer"]
