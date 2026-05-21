"""Re-export of the upstream :class:`WorkerBus` protocol.

Gradient Bang code imports the bus type through this module so the dependency
boundary on ``pipecat-ai`` is explicit; the factory in :mod:`.factory`
decides which concrete implementation to instantiate.
"""

from pipecat.bus import WorkerBus as AgentBus

__all__ = ["AgentBus"]
