"""Custom frame types for Gradient Bang voice pipeline."""

from dataclasses import dataclass

from pipecat.frames.frames import DataFrame, SystemFrame


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
class UserTextInputFrame(SystemFrame):
    """Frame indicating the client sent a text input message.

    This is a pipeline control signal, not cancellable payload. The client
    message handler queues it immediately before an InterruptionFrame so the
    mute strategy can unmute text input; keeping it off the non-system
    processing queue avoids racing Pipecat's interruption task reset.
    """

    text: str = ""
