"""Bus messages and request correlation for runtime agents.

TaskAgents, including external BYOA runners, perform game operations over
typed request/response messages on the subagent bus instead of calling
``AsyncGameClient`` directly. All payload fields are plain JSON-serializable
so the same messages travel over the in-process ``AsyncQueueBus`` and the
remote ``PgmqBus``.

Correlation pattern: caller generates a unique ``correlation_id`` per
request, sends the message, and awaits the matching response via
``PendingRequests``. Responses carry the same ``correlation_id``. Errors
are surfaced as ``error: str`` on the response rather than raising.

Bus-message protocol version (used by ``BusAgentHelloResponse``) starts
at 1. Bump only when an existing message changes shape in a way an older
agent can't tolerate.
"""

import asyncio
from dataclasses import dataclass, field
from typing import Any, Dict, Literal, Optional

from pipecat.bus import BusDataMessage


BUS_PROTOCOL_VERSION = 1


class PendingRequestsClosedError(RuntimeError):
    """Raised when issuing after ``cancel_all`` has fired."""


class PendingRequests:
    """Track ``correlation_id`` futures for async bus responses."""

    def __init__(self) -> None:
        self._pending: Dict[str, asyncio.Future[Any]] = {}
        self._closed: bool = False
        self._closed_reason: Optional[str] = None

    async def issue(self, correlation_id: str, timeout: float) -> Any:
        """Register a pending request and await the matching response."""
        if self._closed:
            raise PendingRequestsClosedError(
                self._closed_reason or "PendingRequests is closed"
            )
        if correlation_id in self._pending:
            raise RuntimeError(f"correlation_id {correlation_id!r} already in flight")

        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        self._pending[correlation_id] = future
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._pending.pop(correlation_id, None)

    def resolve(self, correlation_id: str, result: Any) -> bool:
        """Resolve a pending future. Returns False for late or unknown responses."""
        future = self._pending.get(correlation_id)
        if future is None or future.done():
            return False
        future.set_result(result)
        return True

    def reject(self, correlation_id: str, error: str) -> bool:
        """Reject a pending future. Returns False for late or unknown responses."""
        future = self._pending.get(correlation_id)
        if future is None or future.done():
            return False
        future.set_exception(RuntimeError(error))
        return True

    def cancel_all(self, reason: str = "cancelled") -> int:
        """Cancel all pending futures and prevent new requests."""
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


@dataclass
class BusGameEventMessage(BusDataMessage):
    """Broadcasts a game event to the bus for TaskAgents.

    Sent by Orchestrator when a game event arrives on the game_client.
    TaskAgents filter by their own task_id or character_id.
    Broadcast (no target) so all TaskAgent children receive it.

    Parameters:
        event: The game event dict (has event_name, payload, etc.).
        voice_agent_originated: True if the event was triggered by a player
            voice tool call (request_id is in Orchestrator's recent request_id cache).
            TaskAgents use this to ignore errors from direct player-tool calls
            so they don't affect TaskAgent completion tracking or error counts.
    """

    event: Dict[str, Any] = field(default_factory=dict)
    voice_agent_originated: bool = False


@dataclass
class BusSteerTaskMessage(BusDataMessage):
    """Steering instruction for a running task agent.

    Sent by Orchestrator to redirect a TaskAgent mid-execution.

    Parameters:
        task_id: The task identifier to steer.
        text: The steering instruction text.
    """

    task_id: str = ""
    text: str = ""


# ---------------------------------------------------------------------------
# Typed game RPCs over the bus
# ---------------------------------------------------------------------------
#
# Naming convention:
#   Bus<Domain>Request  — TaskAgent → Orchestrator broker
#   Bus<Domain>Response — Orchestrator broker → TaskAgent
#
# Every request/response pair carries ``correlation_id`` to match the
# awaiting future. Responses set exactly one of ``result`` / ``error``;
# never both, never neither.


@dataclass
class BusGameToolCallRequest(BusDataMessage):
    """Invoke a method on the player-bound ``AsyncGameClient``.

    Covers all ~31 TaskAgent game tools as a uniform ``tool_name + args``
    shape. The broker resolves ``tool_name`` to a method on its
    ``AsyncGameClient`` via ``getattr`` and dispatches with the args
    folded in. ``character_id`` and ``actor_character_id`` are applied
    per-call (overriding the client's bound identity) so a corp-ship
    TaskAgent's calls act on the corp ship pseudo-character with the
    player as actor.

    Parameters:
        correlation_id: Unique id matching the response.
        tool_name: Method name on ``AsyncGameClient`` (e.g. ``move``).
        args: Keyword arguments for the method (must be JSON-serializable).
        character_id: Character id to act on (corp-ship pseudo-char for
            corp tasks, player character for player tasks).
        actor_character_id: Character id of the player issuing the action.
            For corp-ship tasks this differs from ``character_id``.
        task_id: Active task id; broker tags the outbound RPC with this
            so the resulting game event carries the right task correlation.
    """

    correlation_id: str = ""
    tool_name: str = ""
    args: Dict[str, Any] = field(default_factory=dict)
    character_id: str = ""
    actor_character_id: str = ""
    task_id: str = ""


@dataclass
class BusGameToolCallResponse(BusDataMessage):
    """Result or error from a ``BusGameToolCallRequest``.

    Parameters:
        correlation_id: Echoes the request's id.
        result: Method return value (any JSON-serializable shape) on
            success. ``None`` when ``error`` is set.
        error: String error message on failure. ``None`` on success.
    """

    correlation_id: str = ""
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


@dataclass
class BusCombatStrategyRequest(BusDataMessage):
    """Fetch the combat doctrine for a character before initiating combat.

    Replaces the direct ``combat_get_strategy()`` call in TaskAgent's
    combat preamble path.

    Parameters:
        correlation_id: Unique id matching the response.
        character_id: Character whose strategy should be fetched (the
            corp-ship pseudo-char for corp tasks, the player otherwise).
        ship_id: Ship id (the strategy is keyed on ship, not character —
            so this is the canonical lookup key). Optional only for
            backwards-compat with broker handlers that haven't been updated.
        task_id: Active task id. Required for remote BYOA broker
            authorization; optional for older in-process callers.
    """

    correlation_id: str = ""
    character_id: str = ""
    ship_id: Optional[str] = None
    task_id: str = ""


@dataclass
class BusCombatStrategyResponse(BusDataMessage):
    """Strategy doctrine or error from a ``BusCombatStrategyRequest``.

    Parameters:
        correlation_id: Echoes the request's id.
        strategy: The strategy payload on success, ``None`` on error.
        error: String error message on failure, ``None`` on success.
    """

    correlation_id: str = ""
    strategy: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


# Three TaskAgent corp-query paths today (in ``_tool_corporation_info``):
#   - ``list_all=True``  → ``_request("corporation.list", ...)``
#   - ``corp_id`` given  → ``_request("corporation.info", ...)``
#   - default            → ``_request("my_corporation", ...)``
CorpQueryType = Literal["list", "info", "my"]


@dataclass
class BusCorporationQueryRequest(BusDataMessage):
    """Corporation query — list, info, or my-corp.

    Discriminated by ``query_type``. ``corp_id`` is only meaningful for
    ``query_type="info"``.

    Parameters:
        correlation_id: Unique id matching the response.
        query_type: Which corp query to run.
        character_id: Character issuing the query (used for access checks
            on ``my`` and to log the actor on the others).
        corp_id: Corporation id for ``query_type="info"``; ignored for
            ``list`` and ``my``.
        task_id: Active task id. Required for remote BYOA broker
            authorization; optional for older in-process callers.
    """

    correlation_id: str = ""
    query_type: CorpQueryType = "my"
    character_id: str = ""
    corp_id: Optional[str] = None
    task_id: str = ""


@dataclass
class BusCorporationQueryResponse(BusDataMessage):
    """Corp query result or error.

    Parameters:
        correlation_id: Echoes the request's id.
        result: Query payload (shape varies by query_type) on success.
        error: String error message on failure.
    """

    correlation_id: str = ""
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


@dataclass
class BusTaskFinishNotification(BusDataMessage):
    """Fire-and-forget signal that a task is done.

    The broker emits ``task_lifecycle event_type=finish`` on behalf of the
    TaskAgent. No response — errors are logged.

    Parameters:
        character_id: Character whose task ended (corp-ship pseudo-char
            or player).
        actor_character_id: Character that issued the original task (the
            player). For corp-ship tasks this differs from
            ``character_id`` and is the BYOA owner / corp member who
            initiated the work — the edge function's BYOA owner check
            authorises the finish against this field, not against
            ``character_id``.
        task_id: The framework task id.
        status: How the task ended.
        summary: Optional human-readable summary for the finish event.
    """

    character_id: str = ""
    actor_character_id: str = ""
    task_id: str = ""
    status: Literal["completed", "failed", "cancelled"] = "completed"
    summary: Optional[str] = None


# ---------------------------------------------------------------------------
# Agent lifecycle handshake — see docs/setup-byoa.md.
# ---------------------------------------------------------------------------


@dataclass
class BusAgentHelloRequest(BusDataMessage):
    """Liveness probe sent by Orchestrator before delivering a task.

    A target agent that is alive and ready responds with
    ``BusAgentHelloResponse(ready=true, ...)``. An agent that is still
    warming up does not respond yet (or responds with ``ready=false``).
    Orchestrator times out after ``ByoaAgentConfig.agent_wake_timeout_seconds``
    and releases the server-side lock.

    The protocol is universal — in-process TaskAgents respond instantly;
    remote BYOA agents respond after cold start.

    Parameters:
        correlation_id: Unique id matching the response.
    """

    correlation_id: str = ""


@dataclass
class BusAgentHelloResponse(BusDataMessage):
    """Liveness reply.

    Parameters:
        correlation_id: Echoes the request's id.
        ready: True if the agent is alive and accepting work.
        protocol_version: Bus-message protocol the agent speaks. Orchestrator
            compares against ``BUS_PROTOCOL_VERSION``; mismatch is logged
            but not fatal (forward-compat).
        capabilities: Free-form agent capability hints (tool versions,
            feature flags). Empty dict today; reserved for future use.
        error: Optional error string if ``ready=false``.
    """

    correlation_id: str = ""
    ready: bool = False
    protocol_version: int = BUS_PROTOCOL_VERSION
    capabilities: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None


@dataclass
class BusByoaPresenceMessage(BusDataMessage):
    """BYOA runner process presence heartbeat.

    Sent by an external BYOA agent while its process is connected to the
    subagent bus. The bot uses this for UI/process liveness only; task
    dispatch still uses the registry + hello handshake.
    """

    ship_id: str = ""
    online: bool = False
    status: Literal["online", "offline"] = "offline"
    last_seen_at: Optional[str] = None
    protocol_version: int = BUS_PROTOCOL_VERSION
