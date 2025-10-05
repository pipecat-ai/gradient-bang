"""Port locking for atomic trade operations."""

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Dict

logger = logging.getLogger("gradient-bang.locks.port")


class PortLockManager:
    """Manages per-port locks for atomic trade operations.

    Prevents race conditions in trade operations when multiple characters
    trade at the same port concurrently. Each port (sector) gets its own lock.

    Uses asyncio.Lock for proper queueing - when multiple characters try to
    trade at the same port, they are serialized in FIFO order.
    """

    def __init__(self, timeout: float = 30.0):
        """Initialize port lock manager.

        Args:
            timeout: Lock timeout in seconds (currently unused, reserved for future timeout implementation)
        """
        self.timeout = timeout
        self._locks: Dict[int, asyncio.Lock] = {}

    def _get_lock(self, sector_id: int) -> asyncio.Lock:
        """Get or create lock for sector/port.

        Args:
            sector_id: Sector ID containing the port

        Returns:
            asyncio.Lock instance for this port
        """
        if sector_id not in self._locks:
            self._locks[sector_id] = asyncio.Lock()
        return self._locks[sector_id]

    @asynccontextmanager
    async def lock(self, sector_id: int, character_id: str):
        """Acquire port lock for trade operation.

        Multiple characters trying to trade at the same port will be queued
        and processed in FIFO order.

        Usage:
            async with port_locks.lock(sector_id, character_id):
                # Perform trade operations
                port_state = world.port_manager.load_port_state(sector_id)
                # ... validate and execute trade ...
                world.port_manager.update_port_inventory(sector_id, ...)

        Args:
            sector_id: Sector ID containing the port to lock
            character_id: Character ID performing the trade (for logging)

        Yields:
            None - lock is held for the duration of the context
        """
        lock = self._get_lock(sector_id)
        logger.debug(
            "Acquiring port lock: sector=%d character=%s", sector_id, character_id
        )
        async with lock:
            logger.debug(
                "Port lock acquired: sector=%d character=%s", sector_id, character_id
            )
            yield
        logger.debug(
            "Port lock released: sector=%d character=%s", sector_id, character_id
        )
