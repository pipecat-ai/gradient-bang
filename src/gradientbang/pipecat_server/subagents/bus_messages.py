"""Custom bus messages for the gradient-bang agent system.

The Phase 1 BYOA migration introduces typed request/response pairs so a
TaskAgent (in-process or, eventually, a remote BYOA agent) can perform
every game operation over the bus instead of calling ``AsyncGameClient``
directly. All payload fields are plain JSON-serializable so the same
messages travel over the in-process ``AsyncQueueBus`` today and the
remote ``PgmqBus`` in Phase 2.

Correlation pattern: caller generates a unique ``correlation_id`` per
request, sends the message, and awaits the matching response via
``PendingRequests`` (see ``bus_correlation.py``). Responses carry the
same ``correlation_id``. Errors are surfaced as ``error: str`` on the
response rather than raising — broker handlers never re-raise.

Bus-message protocol version (used by ``BusAgentHelloResponse``) starts
at 1. Bump only when an existing message changes shape in a way an older
agent can't tolerate.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, Literal, Optional

from pipecat_subagents.bus.messages import BusDataMessage


BUS_PROTOCOL_VERSION = 1


@dataclass
class BusGameEventMessage(BusDataMessage):
    """Broadcasts a game event to the bus for TaskAgents.

    Sent by VoiceAgent when a game event arrives on the game_client.
    TaskAgents filter by their own task_id or character_id.
    Broadcast (no target) so all TaskAgent children receive it.

    Parameters:
        event: The game event dict (has event_name, payload, etc.).
        voice_agent_originated: True if the event was triggered by a VoiceAgent
            tool call (request_id is in VoiceAgent's recent request_id cache).
            TaskAgents use this to ignore errors from the VoiceAgent's own calls
            so they don't affect TaskAgent completion tracking or error counts.
    """

    event: Dict[str, Any] = field(default_factory=dict)
    voice_agent_originated: bool = False


@dataclass
class BusSteerTaskMessage(BusDataMessage):
    """Steering instruction for a running task agent.

    Sent by VoiceAgent to redirect a TaskAgent mid-execution.

    Parameters:
        task_id: The task identifier to steer.
        text: The steering instruction text.
    """

    task_id: str = ""
    text: str = ""


# ---------------------------------------------------------------------------
# Phase 1: typed game RPCs over the bus
# ---------------------------------------------------------------------------
#
# Naming convention:
#   Bus<Domain>Request  — TaskAgent → VoiceAgent broker
#   Bus<Domain>Response — VoiceAgent broker → TaskAgent
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
    combat preamble path (today: ``task_agent.py:751``).

    Parameters:
        correlation_id: Unique id matching the response.
        character_id: Character whose strategy should be fetched (the
            corp-ship pseudo-char for corp tasks, the player otherwise).
        ship_id: Ship id (the strategy is keyed on ship, not character —
            so this is the canonical lookup key). Optional only for
            backwards-compat with broker handlers that haven't been updated.
    """

    correlation_id: str = ""
    character_id: str = ""
    ship_id: Optional[str] = None


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
    """

    correlation_id: str = ""
    query_type: CorpQueryType = "my"
    character_id: str = ""
    corp_id: Optional[str] = None


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

    Triggers the server-side lock release inside the broker, which calls
    ``task_lifecycle event_type=finish`` on behalf of the TaskAgent.
    No response — the broker logs and moves on.

    Parameters:
        character_id: Character whose task ended (corp-ship pseudo-char
            or player).
        task_id: The framework task id.
        status: How the task ended.
        summary: Optional human-readable summary for the finish event.
    """

    character_id: str = ""
    task_id: str = ""
    status: Literal["completed", "failed", "cancelled"] = "completed"
    summary: Optional[str] = None


# ---------------------------------------------------------------------------
# Agent lifecycle handshake — see "Agent lifecycle & wake-up" in docs/byoa.md
# ---------------------------------------------------------------------------


@dataclass
class BusAgentHelloRequest(BusDataMessage):
    """Liveness probe sent by VoiceAgent before delivering a task.

    A target agent that is alive and ready responds with
    ``BusAgentHelloResponse(ready=true, ...)``. An agent that is still
    warming up does not respond yet (or responds with ``ready=false``).
    VoiceAgent times out after ``ByoaAgentConfig.agent_wake_timeout_seconds``
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
        protocol_version: Bus-message protocol the agent speaks. VoiceAgent
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
