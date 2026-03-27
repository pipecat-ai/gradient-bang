"""Custom bus messages for the gradient-bang agent system."""

from dataclasses import dataclass, field
from typing import Any, Dict

from gradientbang.subagents.bus.messages import BusDataMessage


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
