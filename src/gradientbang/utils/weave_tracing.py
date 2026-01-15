"""Optional W&B Weave tracing for task execution.

Weave provides observability for AI applications. When enabled, it traces:
- Function calls decorated with @traced (or @weave.op)
- LLM API calls (OpenAI, Anthropic, Google) via autopatch

Session types tracked:
- voice_session: Character connected to VoiceTaskManager
- player_task: Task running on the player's own ship
- corp_ship_task: Task running on a corporation ship

To enable:
1. Install weave: `uv add weave`
2. Set WANDB_API_KEY environment variable
3. Traces appear at https://wandb.ai/<username>/<project>/weave
"""

import os
from contextlib import contextmanager
from typing import Any, Callable, Dict, Generator, Optional

from loguru import logger

# Check if Weave is available
try:
    import weave

    WEAVE_AVAILABLE = True
except ImportError:
    weave = None  # type: ignore
    WEAVE_AVAILABLE = False

_weave_initialized = False


def is_weave_available() -> bool:
    """Check if Weave package is installed."""
    return WEAVE_AVAILABLE


def is_weave_enabled() -> bool:
    """Check if Weave is available and initialized."""
    return _weave_initialized


def init_weave(project_name: str = "gradientbang") -> bool:
    """Initialize Weave if available and WANDB_API_KEY is set.

    Args:
        project_name: W&B project name for traces

    Returns:
        True if Weave was initialized, False otherwise
    """
    global _weave_initialized
    if not WEAVE_AVAILABLE:
        logger.debug("Weave tracing disabled: weave package not installed")
        return False
    if not os.getenv("WANDB_API_KEY"):
        logger.debug("Weave tracing disabled: WANDB_API_KEY not set")
        return False
    if _weave_initialized:
        return True
    try:
        weave.init(project_name)
        _weave_initialized = True
        logger.info(f"Weave tracing enabled: project={project_name}")
        return True
    except Exception as e:
        logger.warning(f"Weave tracing failed to initialize: {e}")
        return False


def traced(func: Callable) -> Callable:
    """Decorator that applies @weave.op if Weave is available.

    Usage:
        @traced
        async def my_function(arg1, arg2):
            ...

    If Weave is not installed or not configured, this is a no-op.
    """
    if not WEAVE_AVAILABLE:
        return func
    return weave.op(func)


@contextmanager
def trace_attributes(attributes: Dict[str, Any]) -> Generator[None, None, None]:
    """Context manager to set attributes on the current trace and its children.

    Usage:
        with trace_attributes({'session_type': 'voice_session', 'character_id': '...'}):
            # All traces within this block inherit these attributes
            await some_traced_function()

    If Weave is not available, this is a no-op.
    """
    if not WEAVE_AVAILABLE or not _weave_initialized:
        yield
        return
    with weave.attributes(attributes):
        yield


def voice_session_attributes(
    character_id: str,
    display_name: Optional[str] = None,
) -> Dict[str, Any]:
    """Create attributes for a voice agent session.

    Args:
        character_id: The player's character ID
        display_name: The player's display name (optional)

    Returns:
        Dict of attributes for tracing
    """
    attrs = {
        "session_type": "voice_session",
        "character_id": character_id,
    }
    if display_name:
        attrs["display_name"] = display_name
    return attrs


def task_attributes(
    task_id: str,
    task_type: str,
    ship_id: str,
    actor_id: Optional[str] = None,
    task_description: Optional[str] = None,
) -> Dict[str, Any]:
    """Create attributes for a task session (player ship or corp ship).

    Args:
        task_id: The 4-digit task ID (e.g., "0001")
        task_type: Either "player_ship" or "corp_ship"
        ship_id: The entity being controlled (character_id for player ship,
                 or ship UUID for corp ship). Ideally this would always be
                 the actual ship UUID, but we don't always have it available.
        actor_id: The player commanding this task (always set when started
                  from VoiceTaskManager)
        task_description: The natural language task command (e.g., "Fly to
                         sector 0 and recharge warp power")

    Returns:
        Dict of attributes for tracing
    """
    attrs = {
        "session_type": f"{task_type}_task",
        "task_id": task_id,
        "task_type": task_type,
        "ship_id": ship_id,
    }
    if actor_id:
        attrs["actor_id"] = actor_id
    if task_description:
        # Truncate long descriptions
        attrs["task_description"] = task_description[:100]
    return attrs
