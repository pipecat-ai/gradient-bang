"""Agent base classes for the multi-agent framework.

This package provides the core agent hierarchy:

- `BaseAgent`: Base with bus integration, lifecycle, and optional bridged mode.
- `LLMAgent`: Agent with an LLM pipeline and tool registration.
- `FlowsAgent`: Agent that uses Pipecat Flows for structured conversation.
"""

from gradientbang.subagents.agents.base_agent import ActivationArgs, BaseAgent
from gradientbang.subagents.agents.flows_agent import FlowsAgent
from gradientbang.subagents.agents.llm_agent import LLMActivationArgs, LLMAgent
from gradientbang.subagents.agents.task_group import TaskGroupContext, TaskGroupError, TaskGroupEvent
from gradientbang.subagents.agents.tool import tool

__all__ = [
    "ActivationArgs",
    "BaseAgent",
    "FlowsAgent",
    "LLMActivationArgs",
    "LLMAgent",
    "TaskGroupContext",
    "TaskGroupError",
    "TaskGroupEvent",
    "tool",
]
