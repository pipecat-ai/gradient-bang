"""Shared types for the pipecat-subagents framework."""

from dataclasses import dataclass
from enum import Enum


class TaskStatus(str, Enum):
    """Status of a completed task.

    Inherits from ``str`` so values compare naturally with plain strings
    and serialize without extra handling.

    Attributes:
        COMPLETED: The task finished successfully.
        CANCELLED: The task was cancelled by the requester.
        FAILED: The task failed due to a logical or business error.
        ERROR: The task encountered an unexpected runtime error.
    """

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
