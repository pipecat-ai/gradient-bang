"""Shared agent registry for tracking discovered agents across runners."""

from collections import defaultdict
from typing import Callable, Coroutine, Optional

from loguru import logger

from gradientbang.subagents.types import AgentReadyData

WatchHandler = Callable[[AgentReadyData], Coroutine]


class AgentRegistry:
    """Tracks all known agents across local and remote runners.

    Owned by a runner and shared with its agents. Organizes agents into
    local (this runner) and remote (other runners) so they are easy to
    distinguish. Deduplication is built in: each agent name is
    registered at most once.

    Notifications use a targeted watch mechanism: call
    ``watch(agent_name, handler)`` to be notified when a specific agent
    registers.
    """

    def __init__(self, runner_name: str):
        """Initialize the AgentRegistry.

        Args:
            runner_name: Name of the runner that owns this registry.
        """
        self._runner_name = runner_name
        self._local_agents: dict[str, AgentReadyData] = {}
        self._remote_runners: dict[str, dict[str, AgentReadyData]] = defaultdict(dict)
        self._watches: dict[str, list[WatchHandler]] = defaultdict(list)

    @property
    def runner_name(self) -> str:
        """The name of the runner that owns this registry."""
        return self._runner_name

    @property
    def local_agents(self) -> list[str]:
        """Names of agents registered under this runner."""
        return list(self._local_agents.keys())

    @property
    def remote_agents(self) -> list[str]:
        """Names of agents registered under remote runners."""
        result: list[str] = []
        for agents in self._remote_runners.values():
            result.extend(agents.keys())
        return result

    def get(self, agent_name: str) -> Optional[AgentReadyData]:
        """Look up a registered agent by name.

        Args:
            agent_name: The agent name to look up.

        Returns:
            The agent's ``AgentReadyData``, or None if not found.
        """
        if agent_name in self._local_agents:
            return self._local_agents[agent_name]
        for agents in self._remote_runners.values():
            if agent_name in agents:
                return agents[agent_name]
        return None

    def __contains__(self, agent_name: str) -> bool:
        return self.get(agent_name) is not None

    async def watch(self, agent_name: str, handler: WatchHandler) -> None:
        """Watch for a specific agent's registration.

        If the agent is already registered, the handler fires immediately.

        Args:
            agent_name: The agent name to watch for.
            handler: Async callable invoked with the agent's data.
        """
        self._watches[agent_name].append(handler)
        existing = self.get(agent_name)
        if existing:
            await handler(existing)

    async def register(self, agent_data: AgentReadyData) -> bool:
        """Register an agent. Returns True if the agent was new.

        If the agent is already registered, this is a no-op and returns
        False. Otherwise the agent is added and watchers are notified.

        Args:
            agent_data: Information about the agent to register.

        Returns:
            True if the agent was newly registered, False if already known.
        """
        is_local = agent_data.runner == self._runner_name
        target = self._local_agents if is_local else self._remote_runners[agent_data.runner]

        if agent_data.agent_name in target:
            return False

        # Warn if the same name exists on a different runner
        existing = self.get(agent_data.agent_name)
        if existing and existing.runner != agent_data.runner:
            logger.warning(
                f"Agent '{agent_data.agent_name}' registered on both "
                f"'{existing.runner}' and '{agent_data.runner}'"
            )

        target[agent_data.agent_name] = agent_data
        locality = "local" if is_local else agent_data.runner
        logger.debug(f"Agent '{agent_data.agent_name}' ready ({locality})")
        await self._notify(agent_data)
        return True

    async def _notify(self, agent_data: AgentReadyData) -> None:
        """Notify watchers of a new registration."""
        for handler in self._watches.get(agent_data.agent_name, []):
            await handler(agent_data)
