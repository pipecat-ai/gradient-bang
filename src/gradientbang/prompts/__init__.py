"""Prompt templates and fragments for Gradient Bang LLM agents.

This package contains markdown-based prompts organized into:
- base/: Core game overview and tool usage instructions
- agents/: Agent-specific prompts (voice, task, task_progress)
- fragments/: Detailed game mechanics loaded on-demand via load_game_info tool
"""

from gradientbang.utils.prompt_loader import (
    build_voice_agent_prompt,
    build_task_agent_prompt,
    build_task_progress_prompt,
    build_ui_agent_prompt,
    load_fragment,
    AVAILABLE_TOPICS,
)

__all__ = [
    "build_voice_agent_prompt",
    "build_task_agent_prompt",
    "build_task_progress_prompt",
    "build_ui_agent_prompt",
    "load_fragment",
    "AVAILABLE_TOPICS",
]
