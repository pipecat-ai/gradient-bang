"""Custom bus messages for the gradient-bang agent system."""

from dataclasses import dataclass, field
from typing import Any, Dict

from gradientbang.subagents.bus.messages import BusMessage


@dataclass
class BusGameEventMessage(BusMessage):
    """Broadcasts a game event to the bus for TaskAgents.

    Sent by VoiceAgent when a game event arrives on the game_client.
    TaskAgents filter by their own task_id or character_id.
    Broadcast (no target) so all TaskAgent children receive it.

    Parameters:
        event: The game event dict (has event_name, payload, etc.).
    """

    event: Dict[str, Any] = field(default_factory=dict)


@dataclass
class BusSteerTaskMessage(BusMessage):
    """Steering instruction for a running task agent.

    Sent by VoiceAgent to redirect a TaskAgent mid-execution.

    Parameters:
        task_id: The task identifier to steer.
        text: The steering instruction text.
    """

    task_id: str = ""
    text: str = ""
