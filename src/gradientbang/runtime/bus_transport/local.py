"""In-process :class:`WorkerBus` backed by ``asyncio.Queue``.

Default transport. Constructed by :func:`.factory.make_subagent_bus` when
``SUBAGENT_BUS_TRANSPORT`` is unset or ``local``.
"""

from pipecat.bus import AsyncQueueBus

__all__ = ["AsyncQueueBus"]
