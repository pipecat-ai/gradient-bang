"""Re-export of the upstream :class:`AgentBus` protocol.

Gradient Bang code imports the bus type through this module so the dependency
boundary on ``pipecat-ai-subagents`` is explicit; the factory in
:mod:`.factory` decides which concrete implementation to instantiate.
"""

from pipecat_subagents.bus import AgentBus

__all__ = ["AgentBus"]
