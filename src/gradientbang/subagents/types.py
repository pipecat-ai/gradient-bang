"""Shared types for the pipecat-subagents framework."""

from dataclasses import dataclass
from enum import Enum


class TaskStatus(str, Enum):
    """Status of a completed task."""

    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"
    ERROR = "error"


@dataclass
class AgentReadyData:
    """Information about a registered agent.

    Parameters:
        agent_name: The name of the agent.
        runner: The name of the runner managing this agent.
    """

    agent_name: str
    runner: str


@dataclass
class AgentErrorData:
    """Information about an agent error.

    Parameters:
        agent_name: The name of the agent that errored.
        error: Description of the error.
    """

    agent_name: str
    error: str
