"""Prompt loading utilities for Gradient Bang LLM agents.

Loads markdown prompts from the prompts/ directory with caching.
Provides builder functions to assemble prompts for different agents.
"""

from datetime import datetime, timezone
from enum import Enum
from functools import lru_cache
from pathlib import Path
from typing import Optional


class TaskOutputType(Enum):
    """Types of output messages from the task agent."""

    STEP = "STEP"
    ACTION = "ACTION"
    INPUT = "INPUT"
    EVENT = "EVENT"
    MESSAGE = "MESSAGE"
    ERROR = "ERROR"
    FINISHED = "FINISHED"

    def __str__(self):
        return self.value

# Directory containing all prompt files
PROMPTS_DIR = Path(__file__).parent.parent / "prompts"

# Available topics for load_game_info tool
AVAILABLE_TOPICS = [
    "exploration",
    "trading",
    "combat",
    "corporations",
    "transfers",
    "ships",
    "event_logs",
]


@lru_cache(maxsize=32)
def load_prompt(relative_path: str) -> str:
    """Load a markdown prompt file from the prompts directory.

    Args:
        relative_path: Path relative to prompts/ directory (e.g., "base/game_overview.md")

    Returns:
        Contents of the prompt file

    Raises:
        FileNotFoundError: If the prompt file doesn't exist
    """
    file_path = PROMPTS_DIR / relative_path
    if not file_path.exists():
        raise FileNotFoundError(f"Prompt file not found: {file_path}")
    return file_path.read_text(encoding="utf-8").strip()


def load_fragment(topic: str) -> str:
    """Load a game mechanics fragment by topic name.

    Args:
        topic: One of the available topics (exploration, trading, combat, etc.)

    Returns:
        Contents of the fragment file

    Raises:
        ValueError: If topic is not in AVAILABLE_TOPICS
        FileNotFoundError: If the fragment file doesn't exist
    """
    if topic not in AVAILABLE_TOPICS:
        raise ValueError(
            f"Unknown topic: {topic}. Available topics: {', '.join(AVAILABLE_TOPICS)}"
        )
    return load_prompt(f"fragments/{topic}.md")


def build_voice_agent_prompt() -> str:
    """Build the complete system prompt for the voice agent.

    Combines:
    1. base/game_overview.md - Concise game basics
    2. base/how_to_load_info.md - How to use load_game_info
    3. agents/voice_agent.md - Voice-specific instructions

    Returns:
        Complete system prompt for voice agent
    """
    parts = [
        load_prompt("base/game_overview.md"),
        load_prompt("base/how_to_load_info.md"),
        load_prompt("agents/voice_agent.md"),
    ]
    return "\n\n".join(parts)


def build_task_agent_prompt() -> str:
    """Build the complete system prompt for the task agent.

    Combines:
    1. base/game_overview.md - Concise game basics
    2. base/how_to_load_info.md - How to use load_game_info
    3. agents/task_agent.md - Task execution instructions

    Returns:
        Complete system prompt for task agent
    """
    parts = [
        load_prompt("base/game_overview.md"),
        load_prompt("base/how_to_load_info.md"),
        load_prompt("agents/task_agent.md"),
    ]
    return "\n\n".join(parts)


def build_ui_agent_prompt() -> str:
    """Build the complete system prompt for the UI agent.

    Combines:
    1. base/game_overview.md - Concise game basics
    2. agents/ui_agent.md - UI agent instructions

    Returns:
        Complete system prompt for UI agent
    """
    parts = [
        load_prompt("base/game_overview_ui.md"),
        load_prompt("agents/ui_agent.md"),
    ]
    return "\n\n".join(parts)


def build_task_progress_prompt(log_lines: Optional[list[str]] = None) -> str:
    """Build the system prompt for task progress queries.

    Combines:
    1. base/game_overview.md - Concise game basics
    2. agents/task_progress.md - Query instructions

    If log_lines is provided, appends them as the task log.

    Args:
        log_lines: Optional list of task log lines to include

    Returns:
        Complete system prompt for task progress queries
    """
    parts = [
        load_prompt("base/game_overview.md"),
        load_prompt("agents/task_progress.md"),
    ]
    prompt = "\n\n".join(parts)

    if log_lines:
        log_text = "\n".join(log_lines)
        prompt = f"{prompt}\n\n# Task Log\n{log_text}"

    return prompt


def clear_cache() -> None:
    """Clear the prompt loading cache.

    Useful for development when prompt files are being edited.
    """
    load_prompt.cache_clear()


def create_task_instruction_user_message(task: str) -> str:
    """Create a task-specific user message for the LLM.

    Args:
        task: The task to be completed.

    Returns:
        Formatted prompt for the current decision point.
    """
    prompt_parts = [
        "# Agent Instructions",
        "",
        "You are an autonomous agent. Execute this task step by step. After each step, observe the results and react accordingly. Responses you generate from each inference call will be used only internally to complete the task. The only information that is returned to the user is the final result message that is passed to the `finished` tool call.",
        "",
        "When you have completed the task, call the `finished` tool with a message to be returned to the user who initiated the task.",
        "",
        "# Current time (UTC)",
        f"{datetime.now(timezone.utc).isoformat()}",
        "",
        "# Task Instructions",
        "",
        f"{task}",
        "",
    ]
    return "\n".join(prompt_parts)
