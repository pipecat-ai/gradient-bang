"""Task group types for structured concurrent task execution."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, ClassVar, Optional

from gradientbang.subagents.types import TaskStatus

if TYPE_CHECKING:
    from gradientbang.subagents.agents.base_agent import BaseAgent


class TaskGroupError(Exception):
    """Raised when a task group is cancelled due to a worker error or timeout."""

    pass


@dataclass
class TaskGroupResponse:
    """Collected results from a completed task group.

    Parameters:
        task_id: The shared task identifier.
        responses: Collected responses keyed by agent name.
    """

    task_id: str
    responses: dict[str, dict]


@dataclass
class TaskGroupEvent:
    """An event received from a worker during task group execution.

    Parameters:
        type: The event type.
        agent_name: The name of the agent that sent the event.
        data: Optional event payload.
    """

    UPDATE: ClassVar[str] = "update"
    STREAM_START: ClassVar[str] = "stream_start"
    STREAM_DATA: ClassVar[str] = "stream_data"
    STREAM_END: ClassVar[str] = "stream_end"

    type: str
    agent_name: str
    data: Optional[dict] = None


@dataclass
class TaskGroup:
    """Tracks a group of task agents launched together.

    Parameters:
        task_id: Shared identifier for all agents in this group.
        agent_names: Names of the agents in the group.
        responses: Collected responses keyed by agent name.
        timeout_task: Optional asyncio task that cancels the group on timeout.
        cancel_on_error: Whether to cancel the group if a worker errors.
        event_queue: Optional queue for streaming events to a
            ``TaskGroupContext`` async iterator.
    """

    task_id: str
    agent_names: set[str]
    responses: dict[str, dict] = field(default_factory=dict)
    timeout_task: Optional[asyncio.Task] = None
    cancel_on_error: bool = True
    event_queue: Optional[asyncio.Queue] = field(default=None, repr=False)
    _done: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    _error: Optional[str] = field(default=None, repr=False)

    @property
    def is_done(self) -> bool:
        """Whether the group has completed or failed."""
        return self._done.is_set()

    async def wait(self) -> None:
        """Wait for all agents in the group to respond.

        Raises:
            TaskGroupError: If the group was cancelled due to error or timeout.
        """
        await self._done.wait()
        if self._error:
            raise TaskGroupError(self._error)

    def complete(self) -> None:
        """Signal that all agents have responded."""
        self._done.set()
        if self.event_queue:
            self.event_queue.put_nowait(None)

    def fail(self, reason: Optional[str] = None) -> None:
        """Signal that the group was cancelled.

        Args:
            reason: Human-readable reason for the failure.
        """
        self._error = reason
        self._done.set()
        if self.event_queue:
            self.event_queue.put_nowait(None)


class TaskGroupContext:
    """Async context manager and iterator for structured task group execution.

    Sends task requests on enter, waits for all responses on exit.
    Supports ``async for`` to receive intermediate events (updates
    and streaming data) from workers while waiting for completion.

    On normal completion, results are available via ``responses``.
    On worker error (with ``cancel_on_error=True``) or timeout, raises
    ``TaskGroupError``. If the ``async with`` block raises, remaining
    tasks are cancelled.

    Example::

        async with self.request_task_group("w1", "w2", payload=data) as tg:
            async for event in tg:
                print(f"{event.agent_name} [{event.type}]: {event.data}")

        for name, result in tg.responses.items():
            print(name, result)
    """

    def __init__(
        self,
        agent: BaseAgent,
        agent_names: tuple[str, ...],
        *,
        payload: Optional[dict] = None,
        timeout: Optional[float] = None,
        cancel_on_error: bool = True,
    ):
        """Initialize the TaskGroupContext.

        Args:
            agent: The parent `BaseAgent` that owns this task group.
            agent_names: Names of the agents to send the task to.
            payload: Optional structured data describing the work.
            timeout: Optional timeout in seconds covering both the
                ready-wait and task execution.
            cancel_on_error: Whether to cancel the group if a worker
                errors. Defaults to True.
        """
        self._agent = agent
        self._agent_names = agent_names
        self._payload = payload
        self._timeout = timeout
        self._cancel_on_error = cancel_on_error
        self._group: Optional[TaskGroup] = None

    @property
    def task_id(self) -> str:
        """The shared task identifier for this group."""
        if not self._group:
            raise RuntimeError("Task group has not been started")
        return self._group.task_id

    @property
    def responses(self) -> dict[str, dict]:
        """Collected responses keyed by agent name."""
        if not self._group:
            raise RuntimeError("Task group has not been started")
        return self._group.responses

    def __aiter__(self):
        return self

    async def __anext__(self) -> TaskGroupEvent:
        if not self._group or not self._group.event_queue:
            raise StopAsyncIteration
        event = await self._group.event_queue.get()
        if event is None:
            raise StopAsyncIteration
        return event

    async def __aenter__(self) -> TaskGroupContext:
        self._group = await self._agent.create_task_group_and_request_task(
            list(self._agent_names),
            payload=self._payload,
            timeout=self._timeout,
            cancel_on_error=self._cancel_on_error,
        )
        self._group.event_queue = asyncio.Queue()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> bool:
        if exc_type is not None:
            if self._group and self._group.task_id in self._agent.task_groups:
                await self._agent.cancel_task(
                    self._group.task_id, reason="context exited with error"
                )
            return False

        await self._group.wait()
        return False
