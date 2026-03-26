"""Bus message types for inter-agent communication.

Defines the message hierarchy used by the `AgentBus` for pub/sub messaging
between agents, the session, and the runner.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional

from pipecat.frames.frames import DataFrame, Frame
from pipecat.processors.frame_processor import FrameDirection

from gradientbang.subagents.types import TaskStatus

if TYPE_CHECKING:
    from gradientbang.subagents.agents.base_agent import BaseAgent


class BusLocalMixin:
    """Mixin: message stays on the local bus, never forwarded to remote buses."""

    pass


@dataclass(kw_only=True)
class BusMessage(DataFrame):
    """Base class for all messages transported over the AgentBus.

    Every bus message carries metadata about its source and optional target.
    If target is None, the message is broadcast to all agents.
    If target is set, only that named agent receives it.

    Parameters:
        source: Name of the agent or component that sent this message.
        target: Name of the intended recipient agent, or None for broadcast.
    """

    source: str
    target: Optional[str] = None

    def __str__(self):
        return f"{self.name} (source={self.source}, target={self.target})"


@dataclass
class BusFrameMessage(BusMessage):
    """Wraps a Pipecat `Frame` for transport over the bus.

    Parameters:
        frame: The Pipecat frame to transport.
        direction: Direction the frame should travel in the recipient's pipeline.
        bridge: Optional bridge name for routing in multi-bridge setups.
    """

    frame: Frame
    direction: FrameDirection
    bridge: Optional[str] = None


@dataclass
class BusAgentRegistryMessage(BusMessage):
    """Snapshot of root agents managed by a runner.

    Sent by the runner on startup to announce its root agents so that
    remote runners can discover each other's agents.

    Parameters:
        runner: Name of the runner that owns these agents.
        agents: List of root agent names.
    """

    runner: str
    agents: list[str]


@dataclass
class BusActivateAgentMessage(BusMessage):
    """Tells a targeted agent to become active and start processing.

    Parameters:
        args: Optional activation arguments forwarded to ``on_activated``.
    """

    args: Optional[dict] = None


@dataclass
class BusDeactivateAgentMessage(BusMessage):
    """Tells a targeted agent to become inactive and stop processing."""

    pass


@dataclass
class BusAgentErrorMessage(BusMessage):
    """Reports an error from a root agent.

    Sent over the network so remote agents can react. For child agent
    errors, see ``BusAgentLocalErrorMessage``.

    Parameters:
        error: Description of the error.
    """

    error: str


@dataclass
class BusAgentLocalErrorMessage(BusMessage, BusLocalMixin):
    """Reports an error from a child agent to its parent.

    Local-only: never crosses the network. The parent receives it
    via ``on_agent_error()``.

    Parameters:
        error: Description of the error.
    """

    error: str


@dataclass
class BusCancelMessage(BusMessage):
    """Request a hard cancel of the session.

    Sent by an agent to the runner, which responds by sending
    `BusCancelAgentMessage` to each agent.

    Parameters:
        reason: Optional human-readable reason for the cancellation.
    """

    reason: Optional[str] = None


@dataclass
class BusCancelAgentMessage(BusMessage):
    """Tells a targeted agent to cancel its pipeline task.

    Sent by the runner to individual agents during cancellation.

    Parameters:
        reason: Optional human-readable reason for the cancellation.
    """

    reason: Optional[str] = None


@dataclass
class BusEndMessage(BusMessage):
    """Request a graceful end of the session.

    Sent by an agent to the runner, which responds by sending
    `BusEndAgentMessage` to each agent.

    Parameters:
        reason: Optional human-readable reason for ending.
    """

    reason: Optional[str] = None


@dataclass
class BusEndAgentMessage(BusMessage):
    """Tells a targeted agent to end its pipeline gracefully.

    Sent by the runner to individual agents during shutdown.

    Parameters:
        reason: Optional human-readable reason for ending.
    """

    reason: Optional[str] = None


@dataclass
class BusAddAgentMessage(BusMessage, BusLocalMixin):
    """Request to add an agent to the local runner.

    Local-only: carries an in-memory agent reference that cannot be
    serialized over the network.

    Parameters:
        agent: The agent instance to add.
    """

    agent: BaseAgent


@dataclass
class BusTaskRequestMessage(BusMessage):
    """Requests a task agent to start work.

    Parameters:
        task_id: Unique identifier for this task.
        payload: Optional structured data describing the work.
    """

    task_id: str
    payload: Optional[dict] = None


@dataclass
class BusTaskResponseMessage(BusMessage):
    """Response from a task agent when it completes.

    Parameters:
        task_id: The task identifier.
        response: Optional result data.
        status: Completion status.
    """

    task_id: str
    response: Optional[dict] = None
    status: TaskStatus = TaskStatus.COMPLETED


@dataclass
class BusTaskUpdateMessage(BusMessage):
    """Progress update from a task agent.

    Parameters:
        task_id: The task identifier.
        update: Optional progress data.
    """

    task_id: str
    update: Optional[dict] = None


@dataclass
class BusTaskUpdateRequestMessage(BusMessage):
    """Request a progress update from a task agent.

    Parameters:
        task_id: The task identifier.
    """

    task_id: str


@dataclass
class BusTaskCancelMessage(BusMessage):
    """Cancel a running task.

    Parameters:
        task_id: The task identifier.
        reason: Optional human-readable reason for cancellation.
    """

    task_id: str
    reason: Optional[str] = None


@dataclass
class BusTaskStreamStartMessage(BusMessage):
    """Signals the start of a streaming task response.

    Parameters:
        task_id: The task identifier.
        data: Optional metadata (e.g. content type).
    """

    task_id: str
    data: Optional[dict] = None


@dataclass
class BusTaskStreamDataMessage(BusMessage):
    """A chunk of streaming task data.

    Parameters:
        task_id: The task identifier.
        data: The chunk payload.
    """

    task_id: str
    data: Optional[dict] = None


@dataclass
class BusTaskStreamEndMessage(BusMessage):
    """Signals the end of a streaming task response.

    Parameters:
        task_id: The task identifier.
        data: Optional final metadata.
    """

    task_id: str
    data: Optional[dict] = None
