"""Agent bus package -- pub/sub messaging between agents and the runner.

Provides the pub/sub infrastructure that connects agents to each other and to
the runner. Key components:

- `AgentBus` -- abstract base class defining the send/receive interface.
- `AsyncQueueBus` -- in-process implementation backed by ``asyncio.Queue``.
- `BusBridgeProcessor` -- bidirectional mid-pipeline bridge for
  transport/session agents that exchanges frames with other agents
  through the bus.
- `BusMessage` and its subclasses -- the typed message hierarchy used for
  agent lifecycle events (activation, cancellation, shutdown), task
  coordination, and frame transport.
"""

from gradientbang.subagents.bus.bridge_processor import BusBridgeProcessor
from gradientbang.subagents.bus.bus import AgentBus
from gradientbang.subagents.bus.local import AsyncQueueBus
from gradientbang.subagents.bus.messages import (
    BusActivateAgentMessage,
    BusAddAgentMessage,
    BusAgentErrorMessage,
    BusAgentLocalErrorMessage,
    BusAgentRegistryMessage,
    BusCancelAgentMessage,
    BusCancelMessage,
    BusDeactivateAgentMessage,
    BusEndAgentMessage,
    BusEndMessage,
    BusFrameMessage,
    BusLocalMixin,
    BusMessage,
    BusTaskCancelMessage,
    BusTaskRequestMessage,
    BusTaskResponseMessage,
    BusTaskStreamDataMessage,
    BusTaskStreamEndMessage,
    BusTaskStreamStartMessage,
    BusTaskUpdateMessage,
    BusTaskUpdateRequestMessage,
    TaskStatus,
)
from gradientbang.subagents.bus.subscriber import BusSubscriber

__all__ = [
    "AgentBus",
    "AsyncQueueBus",
    "BusActivateAgentMessage",
    "BusAddAgentMessage",
    "BusAgentErrorMessage",
    "BusAgentLocalErrorMessage",
    "BusAgentRegistryMessage",
    "BusBridgeProcessor",
    "BusCancelAgentMessage",
    "BusCancelMessage",
    "BusDeactivateAgentMessage",
    "BusEndAgentMessage",
    "BusEndMessage",
    "BusFrameMessage",
    "BusLocalMixin",
    "BusMessage",
    "BusSubscriber",
    "BusTaskCancelMessage",
    "BusTaskRequestMessage",
    "BusTaskResponseMessage",
    "BusTaskStreamDataMessage",
    "TaskStatus",
    "BusTaskStreamEndMessage",
    "BusTaskStreamStartMessage",
    "BusTaskUpdateMessage",
    "BusTaskUpdateRequestMessage",
]
