"""Bus message serializer that handles OpenAI ``NOT_GIVEN`` sentinels.

The OpenAI Python SDK uses a singleton :class:`openai._types.NotGiven`
(``openai.NOT_GIVEN``) to distinguish "argument not provided" from
``None`` at API call sites. Pipecat's LLM frames carry that sentinel
through to the bus, and upstream :class:`JSONMessageSerializer` falls
through to its ``logger.warning('skipping field with unserializable
type _NotGiven')`` branch for every occurrence — noisy at startup and
on every LLM bridge frame once ``SUBAGENT_BUS_TRANSPORT=pgmq`` is on.

``BusJSONSerializer`` short-circuits ``NotGiven`` instances to ``None``
in :meth:`_serialize_value`. Upstream's dataclass-field loop already
treats ``None`` as "skip this field," so the on-wire result is the
same shape the upstream warning was producing: the field is absent.
No data is lost — "not given" and "field absent" are wire-equivalent.

Detection is by class-name string match so this module doesn't impose
an openai-package import on processes that don't need it (and degrades
to a no-op if the SDK is uninstalled).
"""

from __future__ import annotations

from typing import Any

from pipecat_subagents.bus.serializers import JSONMessageSerializer


class BusJSONSerializer(JSONMessageSerializer):
    """Drop-in :class:`JSONMessageSerializer` that silently elides
    OpenAI ``NOT_GIVEN`` sentinels.

    Used by :func:`build_pgmq_bus` for both bot and BYOA buses. Behavior
    is identical to the upstream serializer for every other type.
    """

    def _serialize_value(self, value: Any) -> Any:
        # The openai SDK exports a single `NOT_GIVEN` instance of the
        # private `_NotGiven` / `NotGiven` class. Either spelling has
        # shown up across SDK versions; match by class name to stay
        # version-agnostic and import-free.
        if type(value).__name__ in ("NotGiven", "_NotGiven"):
            return None
        return super()._serialize_value(value)


__all__ = ["BusJSONSerializer"]
