"""Protocol shared by all ``AsyncGameClient`` event-delivery adapters.

Adapters are constructed with a back-reference to an ``AsyncGameClient`` and
deliver events into it via a small documented surface area:

- ``client._request(endpoint, payload, ...)`` — HTTP/RPC to edge functions
  (used by the polling adapter to call ``events_since``).
- ``client._process_event(name, payload, request_id=...)`` — the dispatch
  sink defined in :class:`gradientbang.utils.api_client.BaseAsyncGameClient`.
- ``client._maybe_update_sector_from_event(name, payload)`` — sector-cache
  update that respects the bound character's ownership guard.
- ``client._append_event_log(name, payload)`` — JSONL audit log.
- ``client._canonical_character_id`` — read for default scope filters.

Adapters MUST NOT touch any other private state on the client; the contract
above is the entire surface.
"""

from __future__ import annotations

from typing import Optional, Protocol, runtime_checkable


@runtime_checkable
class EventAdapter(Protocol):
    """Pluggable event-delivery transport for ``AsyncGameClient``."""

    async def purge_backlog(self) -> None:
        """Reset the per-character delivery backlog before ``start``.

        Sessions that build their LLM context inline from RPC responses
        call this before bootstrap to clear stale prior-session messages,
        then again before ``start`` to discard bootstrap RPC echoes that
        were already consumed inline. Effect is transport-specific:
        pubsub keeps the per-character pgmq queue present and purges its
        messages; polling resets its cursor to current head.
        """
        ...

    async def start(self) -> None:
        """Start delivering events. Idempotent — safe to call repeatedly."""
        ...

    async def stop(self) -> None:
        """Stop delivery and release any resources. Called from ``client.close()``."""
        ...

    def set_scope(
        self,
        *,
        character_ids: Optional[list[str]] = None,
        corp_id: Optional[str] = None,
        ship_ids: Optional[list[str]] = None,
    ) -> None:
        """Update the subscription scope.

        Each kwarg is independently applied:
        - ``character_ids`` replaces the character filter when non-empty after
          normalization. Passing an empty/whitespace-only list is a no-op.
        - ``ship_ids`` replaces the ship filter (corp pseudo-character ids).
        - ``corp_id`` is replaced unconditionally; ``None`` clears it.
        """
        ...
