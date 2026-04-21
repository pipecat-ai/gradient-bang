"""LLM agent with tool registration.

Provides the `LLMAgent` class that extends `BaseAgent` with an LLM
pipeline and automatic tool registration.
"""

import asyncio
import dataclasses
import functools
from abc import abstractmethod
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Optional, Sequence

from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import (
    ControlFrame,
    Frame,
    FunctionCallResultProperties,
    LLMMessagesAppendFrame,
    LLMSetToolsFrame,
    UninterruptibleFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineTask
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.llm_service import LLMService

from gradientbang.subagents.agents.base_agent import AgentActivationArgs, BaseAgent
from gradientbang.subagents.agents.tool import _collect_tools
from gradientbang.subagents.bus import AgentBus

FunctionCallResultCallback = Callable[..., Any]


@dataclass
class PipelineFlushFrame(ControlFrame, UninterruptibleFrame):
    """Probe frame used to flush all in-flight frames from the pipeline."""

    pass


@dataclass
class LLMAgentActivationArgs(AgentActivationArgs):
    """Activation arguments for LLM agents.

    Attributes:
        messages: LLM context messages to inject on activation.
        run_llm: Whether to run the LLM after appending messages.
            Defaults to True when ``messages`` is set.
    """

    messages: Optional[list] = None
    run_llm: Optional[bool] = None


class LLMAgent(BaseAgent):
    """Agent with an LLM pipeline and automatic tool registration.

    Subclasses provide an LLM service via ``build_llm()`` and define tools
    with the ``@tool`` decorator. Pass ``bridged=()`` for agents that
    receive frames from a ``BusBridgeProcessor`` in another agent.

    Example::

        class MyAgent(LLMAgent):
            def build_llm(self) -> LLMService:
                return OpenAILLMService(
                    api_key="...",
                    system_instruction="You are a helpful assistant.",
                )

            @tool
            async def my_function(self, params, arg: str):
                ...
    """

    def __init__(
        self,
        name: str,
        *,
        bus: AgentBus,
        active: bool = False,
        bridged: Optional[tuple[str, ...]] = None,
        defer_tool_frames: bool = True,
    ):
        """Initialize the LLMAgent.

        Args:
            name: Unique name for this agent.
            bus: The `AgentBus` for inter-agent communication.
            active: Whether the agent starts active. Defaults to False.
            bridged: Bridge configuration. See ``BaseAgent`` for details.
            defer_tool_frames: Whether to defer frames queued during
                tool execution until all tools complete. Defaults to True.
        """
        super().__init__(
            name,
            bus=bus,
            active=active,
            bridged=bridged,
            exclude_frames=(PipelineFlushFrame,),
        )
        # LLM service, created in build_pipeline via create_llm().
        self._llm: Optional[LLMService] = None

        # Pipeline flush. Signaled when a PipelineFlushFrame completes
        # its round-trip, used to ensure function call results are
        # fully processed before proceeding.
        self._flush_done: asyncio.Event = asyncio.Event()

        # Tool call deferral. When defer_tool_frames is True, frames
        # queued during tool execution are held until all tools complete.
        self._defer_tool_frames = defer_tool_frames
        self._tool_call_inflight: int = 0
        self._deferred_frames: deque[tuple[Frame, FrameDirection]] = deque()

        # Batch tracking. The LLM service fires on_function_calls_started
        # with the full list of tool calls before any handler runs. We use
        # this to defer flushing until the entire batch is done, and to
        # suppress run_llm on non-final tool result callbacks so the
        # aggregator's built-in batch tracking handles inference timing.
        self._tool_batch_id: int = 0
        self._tool_batch_remaining: int = 0

    async def on_activated(self, args: Optional[dict]) -> None:
        """Configure the LLM with tools and activation messages.

        Args:
            args: Optional activation arguments with messages to append.
        """
        await super().on_activated(args)

        activation = LLMAgentActivationArgs.from_dict(args) if args else LLMAgentActivationArgs()

        tools = self.build_tools()
        if tools:
            await self.queue_frame(LLMSetToolsFrame(tools=ToolsSchema(standard_tools=tools)))

        if activation.messages:
            run_llm = activation.run_llm if activation.run_llm is not None else True
            await self.queue_frame(
                LLMMessagesAppendFrame(messages=activation.messages, run_llm=run_llm)
            )

    @property
    def tool_call_active(self) -> bool:
        """True when one or more ``@tool`` methods are executing."""
        return self._tool_call_inflight > 0

    async def _on_tool_batch_started(
        self, llm_service: LLMService, function_calls: Sequence
    ) -> None:
        """Track expected tool count when a batch of tool calls begins."""
        self._tool_batch_id += 1
        self._tool_batch_remaining = len(function_calls)

    async def queue_frame(
        self, frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM
    ) -> None:
        """Queue a frame, deferring delivery until all tools complete (if any).

        When tool calls are in progress, the frame is held in an internal
        queue and delivered automatically once the last tool finishes.
        When no tools are active, the frame is queued immediately.

        Args:
            frame: Any ``Frame`` to deliver.
            direction: Direction the frame should travel. Defaults to
                ``FrameDirection.DOWNSTREAM``.
        """
        if self._defer_tool_frames and self._tool_call_inflight > 0:
            self._deferred_frames.append((frame, direction))
        else:
            await super().queue_frame(frame, direction)

    def build_tools(self) -> list:
        """Return the tools for this agent's LLM.

        By default, returns all methods decorated with ``@tool``.
        Override to provide additional or different tools.

        Returns:
            List of tool functions.
        """
        return _collect_tools(self)

    @abstractmethod
    def build_llm(self) -> LLMService:
        """Return the LLM service for this agent.

        Subclasses must implement this to provide a configured `LLMService`
        (e.g. ``OpenAILLMService``, ``AnthropicLLMService``). Tool
        registration is handled automatically; do not register ``@tool``
        methods here.

        Returns:
            An `LLMService` instance.
        """
        pass

    def create_llm(self) -> LLMService:
        """Create the LLM with tools registered.

        Calls ``build_llm()`` and registers all ``@tool`` decorated methods.
        Each tool is automatically wrapped with inflight tracking so that
        ``queue_frame_after_tools`` can defer frames during tool execution.
        Override to customize the LLM setup.

        Returns:
            The configured `LLMService`.
        """
        llm = self.build_llm()
        for method in _collect_tools(self):
            tracked = self._track_tool_call(method)
            llm.register_direct_function(
                tracked,
                cancel_on_interruption=method.cancel_on_interruption,
            )
        llm.add_event_handler("on_function_calls_started", self._on_tool_batch_started)
        return llm

    async def build_pipeline(self) -> Pipeline:
        """Build the agent's LLM pipeline.

        Returns:
            The agent's ``Pipeline``.
        """
        self._llm = self.create_llm()
        return Pipeline([self._llm])

    async def create_pipeline_task(self) -> PipelineTask:
        """Create the agent's pipeline task.

        Called by the runner.

        Returns:
            The configured ``PipelineTask``.
        """
        task = await super().create_pipeline_task()

        task.add_reached_upstream_filter((PipelineFlushFrame,))
        task.add_reached_downstream_filter((PipelineFlushFrame,))

        @task.event_handler("on_frame_reached_upstream")
        async def _on_flush_upstream(task, frame):
            if isinstance(frame, PipelineFlushFrame):
                await task.queue_frame(PipelineFlushFrame())

        @task.event_handler("on_frame_reached_downstream")
        async def _on_flush_downstream(task, frame):
            if isinstance(frame, PipelineFlushFrame):
                self._flush_done.set()

        return task

    async def end(
        self,
        *,
        reason: Optional[str] = None,
        result_callback: Optional[FunctionCallResultCallback] = None,
    ) -> None:
        """Request a graceful end of the session.

        When called from a ``@tool`` handler, pass ``params.result_callback`` to
        ensure any pending LLM output is fully delivered before ending.

        Args:
            reason: Optional human-readable reason for ending.
            result_callback: The ``result_callback`` from
                `FunctionCallParams`.
        """
        await self._close_function_call(result_callback)
        await super().end(reason=reason)

    async def handoff_to(
        self,
        agent_name: str,
        *,
        args: Optional[AgentActivationArgs] = None,
        result_callback: Optional[FunctionCallResultCallback] = None,
    ) -> None:
        """Hand off to another agent.

        When called from a ``@tool`` handler, pass ``params.result_callback`` to
        ensure any pending LLM output is fully delivered before handing off.

        Args:
            agent_name: The name of the agent to hand off to.
            args: Optional arguments forwarded to the target agent's
                ``on_activated`` handler.
            result_callback: The ``result_callback`` from `FunctionCallParams`.
        """
        await self._close_function_call(result_callback)
        await super().handoff_to(agent_name, args=args)

    async def process_deferred_tool_frames(
        self, frames: list[tuple[Frame, FrameDirection]]
    ) -> list[tuple[Frame, FrameDirection]]:
        """Process deferred frames before they are flushed.

        Called after all in-flight tools complete, before the deferred
        frames are queued into the pipeline. Override to inspect, modify,
        reorder, or filter the frames.

        Args:
            frames: The deferred frames collected during tool execution.

        Returns:
            The frames to queue. Return the list as-is for default behavior.
        """
        return frames

    def _track_tool_call(self, method: Callable) -> Callable:
        @functools.wraps(method)
        async def wrapper(params, *args, **kwargs):
            batch_id = self._tool_batch_id
            self._tool_call_inflight += 1

            # For non-final tools in a batch, suppress explicit run_llm=True
            # so the Pipecat aggregator's built-in batch tracking decides
            # when to trigger inference (only after the last tool completes).
            original_cb = params.result_callback

            async def _batched_result_cb(result, *, properties=None):
                if (
                    self._tool_batch_remaining > 1
                    and properties is not None
                    and properties.run_llm
                ):
                    properties = dataclasses.replace(properties, run_llm=None)
                await original_cb(result, properties=properties)

            params = dataclasses.replace(params, result_callback=_batched_result_cb)

            try:
                return await method(params, *args, **kwargs)
            finally:
                self._tool_call_inflight = max(0, self._tool_call_inflight - 1)
                if batch_id == self._tool_batch_id:
                    self._tool_batch_remaining = max(0, self._tool_batch_remaining - 1)
                if self._tool_call_inflight == 0 and self._tool_batch_remaining == 0:
                    await self._flush_deferred_frames()

        return wrapper

    async def _flush_deferred_frames(self) -> None:
        # Wait unti the function result frame is really processed.
        await self._flush_pipeline()

        frames = list(self._deferred_frames)
        self._deferred_frames.clear()
        for frame, direction in await self.process_deferred_tool_frames(frames):
            await super().queue_frame(frame, direction)

    async def _flush_pipeline(self) -> None:
        self._flush_done.clear()
        await self.pipeline_task.queue_frame(PipelineFlushFrame(), FrameDirection.UPSTREAM)
        await self._flush_done.wait()

    async def _close_function_call(
        self, result_callback: Optional[FunctionCallResultCallback]
    ) -> None:
        """Close out an in-progress function call before taking action.

        Sends a `PipelineFlushFrame` probe upstream through the pipeline.
        When it reaches the top it is bounced back downstream. When it
        arrives at the bottom, all preceding in-order frames have been
        flushed, and it is safe to transfer or end.

        Args:
            result_callback: The callback from `FunctionCallParams`, or None.
        """
        if not result_callback:
            return

        await result_callback(None, properties=FunctionCallResultProperties(run_llm=False))

        # Wait unti the function result frame is really processed.
        await self._flush_pipeline()
