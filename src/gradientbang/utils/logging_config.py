"""Loguru configuration for the bot process.

Provides colored, per-agent log formatting. Call ``configure_logging()`` once
after pipecat's runner has installed its own loguru handlers.
"""

import sys

from loguru import logger

from gradientbang.config import settings

_AGENT_COLORS: dict[str, tuple[str, str]] = {
    # module leaf name → (color, short label)
    "voice_agent": ("cyan", "VOICE"),
    "event_relay": ("yellow", "EVENT"),
    "task_agent": ("green", "TASK"),
    "ui_agent": ("magenta", "UI"),
    "bot": ("blue", "BOT"),
}

_TASK_OUTPUT_COLORS: dict[str, str] = {
    "ACTION": "cyan",
    "EVENT": "white",
    "MESSAGE": "green",
    "ERROR": "red",
    "FINISHED": "yellow",
    "STEP": "dim",
    "INPUT": "magenta",
}


def _log_format(record: dict, instance_id: str | None = None) -> str:
    """Format log lines with per-agent color tags."""
    tag = f"[{instance_id}] " if instance_id else ""
    module = record["name"].rsplit(".", 1)[-1] if record["name"] else ""
    color, label = _AGENT_COLORS.get(module, ("white", module.upper()[:8]))

    # Task output type coloring (set via logger.bind(task_output_type=...) in TaskAgent)
    task_type = record["extra"].get("task_output_type")
    type_color = _TASK_OUTPUT_COLORS.get(task_type)
    type_prefix = f"<{type_color}>[{task_type}]</{type_color}> " if type_color else ""

    return (
        f"<level>{{level: <8}}</level> "
        f"{tag}"
        f"<{color}>[{label}]</{color}> "
        f"{type_prefix}"
        f"{{message}}\n{{exception}}"
    )


def configure_logging(instance_id: str | None = None):
    """Re-configure loguru after pipecat's runner sets its own DEBUG handler."""
    logger.remove()
    logger.add(
        sys.stderr,
        level=(settings.LOG_LEVEL or settings.LOGURU_LEVEL).upper(),
        format=lambda record: _log_format(record, instance_id=instance_id),
    )
