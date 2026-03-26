"""Flows agent that integrates Pipecat Flows into the multi-agent framework.

Provides the `FlowsAgent` class that extends `BaseAgent` with a
FlowManager for structured conversation flows (nodes, functions, transitions,
actions).
"""

from abc import abstractmethod
from typing import Any, List, Optional

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineTask
from pipecat.services.llm_service import LLMService
from pipecat_flows import ContextStrategyConfig, FlowManager, FlowsFunctionSchema, NodeConfig
from pipecat_flows.types import FlowsDirectFunction

from gradientbang.subagents.agents.base_agent import BaseAgent
from gradientbang.subagents.agents.tool import _collect_tools
from gradientbang.subagents.bus import AgentBus


class FlowsAgent(BaseAgent):
    """Agent that uses Pipecat Flows for structured conversation.

    Manages a ``FlowManager`` for node-based conversation flows with
    functions, transitions, and actions. On first activation the flow
    starts at ``build_initial_node()``; subsequent activations resume
    from ``build_resume_node()``.

    Example::

        class MyFlowsAgent(FlowsAgent):
            def build_llm(self):
                return OpenAILLMService(api_key="...")

            def build_initial_node(self):
                return {"name": "start", ...}
    """

    def __init__(
        self,
        name: str,
        *,
        bus: AgentBus,
        context_aggregator: Any,
        context_strategy: Optional[ContextStrategyConfig] = None,
        global_functions: Optional[List[FlowsFunctionSchema | FlowsDirectFunction]] = None,
        active: bool = False,
        bridged: Optional[tuple[str, ...]] = (),
    ):
        """Initialize the FlowsAgent.

        Args:
            name: Unique name for this agent.
            bus: The `AgentBus` for inter-agent communication.
            context_aggregator: The context aggregator pair for managing
                LLM conversation context, forwarded to `FlowManager`.
            context_strategy: Optional context strategy forwarded to
                `FlowManager`.
            global_functions: Optional list of functions available at every
                node, forwarded to `FlowManager`.
            active: Whether the agent starts active. Defaults to False.
            bridged: Bridge configuration. See ``BaseAgent`` for details.
        """
        super().__init__(
            name,
            bus=bus,
            active=active,
            bridged=bridged,
        )
        self._context_aggregator = context_aggregator
        self._context_strategy = context_strategy
        self._global_functions = global_functions or []
        self._llm: Optional[LLMService] = None
        self._flow_manager: Optional[FlowManager] = None
        self._flow_initialized = False

    async def on_activated(self, args: Optional[dict]) -> None:
        """Initialize or resume the flow on handoff.

        Args:
            args: Optional handoff arguments.
        """
        await super().on_activated(args)

        if not self._flow_initialized:
            self._flow_initialized = True
            await self._flow_manager.initialize(self.build_initial_node())
        else:
            await self._flow_manager.set_node_from_config(self.build_resume_node())

    @property
    def flow_manager(self) -> Optional[FlowManager]:
        """The FlowManager instance, available after the pipeline task is created."""
        return self._flow_manager

    @abstractmethod
    def build_llm(self) -> LLMService:
        """Return the LLM service for this agent.

        Returns:
            An `LLMService` instance.
        """
        pass

    @abstractmethod
    def build_initial_node(self) -> NodeConfig:
        """Return the initial flow node configuration.

        Returns:
            A `NodeConfig` describing the first node of the flow.
        """
        pass

    def build_resume_node(self) -> NodeConfig:
        """Return the node to resume from when re-entering this agent.

        Called on subsequent activations (after the first). Override to
        resume from a specific point in the flow based on ``flow_manager.state``.
        Defaults to restarting the flow from the initial node.

        Returns:
            A `NodeConfig` for the resumption point.
        """
        return self.build_initial_node()

    def _build_global_functions(self) -> list:
        """Merge explicit global functions with ``@tool`` decorated methods."""
        return self._global_functions + _collect_tools(self)

    async def build_pipeline(self) -> Pipeline:
        """Build the agent's LLM pipeline.

        Returns:
            The agent's ``Pipeline``.
        """
        self._llm = self.build_llm()

        return Pipeline([self._llm])

    async def create_pipeline_task(self) -> PipelineTask:
        """Create the pipeline task with flow management support.

        Returns:
            The configured `PipelineTask`.
        """
        task = await super().create_pipeline_task()

        self._flow_manager = FlowManager(
            task=task,
            llm=self._llm,
            context_aggregator=self._context_aggregator,
            context_strategy=self._context_strategy,
            global_functions=self._build_global_functions(),
        )
        self._flow_manager.register_action("end_conversation", self._handle_end_conversation)

        return task

    async def _handle_end_conversation(self, action: dict) -> None:
        await self.end(reason=action.get("reason"))
