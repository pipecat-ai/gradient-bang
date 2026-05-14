"""Correlation helper for one-way bus messages.

Bus messages are one-way (the underlying ``AgentBus`` doesn't model
request/response pairs natively). TaskAgent game RPCs use typed
request/response pairs that share a ``correlation_id``; the helper here
tracks the in-flight ``Future`` for each id so callers can ``await`` the
matching response.

The helper is intentionally small. There's no RPC abstraction, no client/
server framework — each call site builds its specific typed request,
sends it, awaits its specific typed response Future. See
``task_agent.py`` (consumer) and ``voice_agent.py`` (broker) for usage.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, Optional


class PendingRequestsClosedError(RuntimeError):
    """Raised when calling ``issue`` after ``cancel_all`` has fired.

    Indicates the owning agent is tearing down; the caller should not
    re-attempt the request. Distinct from ``asyncio.CancelledError`` so
    callers can decide whether to log or swallow.
    """


class PendingRequests:
    """Tracks ``correlation_id → Future`` for matching async responses.

    Single-owner: each TaskAgent / broker constructs one instance for its
    own lifetime. Not thread-safe (asyncio single-threaded by design).
    """

    def __init__(self) -> None:
        self._pending: Dict[str, asyncio.Future[Any]] = {}
        self._closed: bool = False
        self._closed_reason: Optional[str] = None

    async def issue(self, correlation_id: str, timeout: float) -> Any:
        """Register a pending request and await the matching response.

        Args:
            correlation_id: Unique id linking the outbound request to its
                response. Caller is responsible for generating + using the
                same id when sending the request and resolving here.
            timeout: Seconds before the future raises ``asyncio.TimeoutError``.
                On timeout, the entry is removed from the pending map.

        Returns:
            Whatever value was passed to ``resolve(correlation_id, value)``.

        Raises:
            PendingRequestsClosedError: If ``cancel_all`` already fired —
                the agent is shutting down; the request will never be
                serviced.
            asyncio.CancelledError: If ``cancel_all`` fires while this
                call is awaiting. The cancellation reason is attached as
                ``.args[0]`` for callers that want to surface it.
            RuntimeError: If ``reject(correlation_id, error)`` is called.
                The error string is the message.
            asyncio.TimeoutError: If no resolve/reject lands within
                ``timeout`` seconds.
        """
        if self._closed:
            raise PendingRequestsClosedError(
                self._closed_reason or "PendingRequests is closed"
            )
        if correlation_id in self._pending:
            raise RuntimeError(
                f"correlation_id {correlation_id!r} already in flight"
            )

        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        self._pending[correlation_id] = future
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            # Always remove the entry whether we resolved, rejected, timed out,
            # or were cancelled. cancel_all sets _closed before clearing the
            # map, so a concurrent issue can't race past the closed check.
            self._pending.pop(correlation_id, None)

    def resolve(self, correlation_id: str, result: Any) -> bool:
        """Resolve a pending future with ``result``.

        Returns:
            True if a future was found and resolved; False if no pending
            future matched (late response, mismatched id, etc.). Late
            responses are common and not errors — log and move on.
        """
        future = self._pending.get(correlation_id)
        if future is None or future.done():
            return False
        future.set_result(result)
        return True

    def reject(self, correlation_id: str, error: str) -> bool:
        """Reject a pending future with a ``RuntimeError(error)``.

        Returns:
            True if a future was found and rejected; False if no pending
            future matched.
        """
        future = self._pending.get(correlation_id)
        if future is None or future.done():
            return False
        future.set_exception(RuntimeError(error))
        return True

    def cancel_all(self, reason: str = "cancelled") -> int:
        """Cancel every pending future and prevent new issues.

        Idempotent — calling twice is a no-op on the second call.

        Args:
            reason: Surfaced via ``CancelledError(reason)`` to each awaiter.

        Returns:
            Count of futures that were live at cancel time.
        """
        if self._closed:
            return 0
        self._closed = True
        self._closed_reason = reason
        cancelled = 0
        for future in list(self._pending.values()):
            if not future.done():
                future.cancel(msg=reason) if hasattr(future, "cancel") else future.cancel()
                cancelled += 1
        return cancelled

    def __len__(self) -> int:
        return len(self._pending)
