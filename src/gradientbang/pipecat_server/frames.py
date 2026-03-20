"""Custom frame types for Gradient Bang voice pipeline."""

from dataclasses import dataclass

from pipecat.frames.frames import DataFrame


@dataclass
class TaskActivityFrame(DataFrame):
    """Frame to signal task activity and reset idle timeout.

    Push this frame when task activity occurs (output, events, progress)
    to prevent the main pipeline from timing out during long-running tasks.

    Attributes:
        task_id: Identifier of the active task
        activity_type: Type of activity ("output", "event", "progress")
    """

    task_id: str
    activity_type: str  # "output", "event", "progress"


@dataclass
class UserTextInputFrame(DataFrame):
    """Frame indicating the client sent a text input message."""

    text: str = ""
