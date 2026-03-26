"""Agent base classes for the multi-agent framework.

This package provides the core agent hierarchy:

- `BaseAgent`: Base with bus integration, lifecycle, and optional bridged mode.
- `LLMAgent`: Agent with an LLM pipeline and tool registration.
- `FlowsAgent`: Agent that uses Pipecat Flows for structured conversation.
"""

from gradientbang.subagents.agents.base_agent import AgentActivationArgs, BaseAgent
from gradientbang.subagents.agents.flows_agent import FlowsAgent
from gradientbang.subagents.agents.llm_agent import LLMAgent, LLMAgentActivationArgs
from gradientbang.subagents.agents.task_group import (
    TaskGroupContext,
    TaskGroupError,
    TaskGroupEvent,
    TaskGroupResponse,
)
from gradientbang.subagents.agents.tool import tool

__all__ = [
    "AgentActivationArgs",
    "BaseAgent",
    "FlowsAgent",
    "LLMAgentActivationArgs",
    "LLMAgent",
    "TaskGroupContext",
    "TaskGroupError",
    "TaskGroupEvent",
    "TaskGroupResponse",
    "tool",
]
