"""Base lock class with automatic timeout protection."""

import asyncio
import logging
import time
from typing import Optional

logger = logging.getLogger("gradient-bang.locks")


class TimedLock:
    """Async lock with automatic timeout.

    If lock is held longer than timeout, subsequent acquire() calls
    will forcibly release the old lock and acquire for new owner.

    This prevents bugs from permanently locking resources.
    """

    def __init__(self, timeout: float = 30.0):
        """Initialize timed lock.

        Args:
            timeout: Seconds after which lock can be forcibly released
        """
        self.timeout = timeout
        self._lock = asyncio.Lock()
        self._owner: Optional[str] = None
        self._acquired_at: Optional[float] = None

    async def acquire(self, owner: str) -> bool:
        """Acquire lock for owner.

        If current lock holder has exceeded timeout, forcibly releases
        and grants to new owner.

        Args:
            owner: Identifier for the lock owner

        Returns:
            True if acquired, False if already held by another owner
        """
        async with self._lock:
            # Check if lock is currently held
            if self._owner is not None:
                # Check if timeout has been exceeded
                if self._acquired_at is not None:
                    elapsed = time.time() - self._acquired_at
                    if elapsed >= self.timeout:
                        logger.warning(
                            "Lock timeout: forcibly releasing lock held by '%s' for %.2fs (timeout: %.2fs)",
                            self._owner,
                            elapsed,
                            self.timeout,
                        )
                        self._owner = None
                        self._acquired_at = None
                    elif self._owner == owner:
                        # Same owner reacquiring - this is fine
                        logger.debug("Lock reacquired by owner '%s'", owner)
                        return True
                    else:
                        # Lock held by another owner and not timed out
                        logger.debug(
                            "Lock acquisition failed: held by '%s' (elapsed: %.2fs)",
                            self._owner,
                            elapsed,
                        )
                        return False

            # Acquire lock for new owner
            self._owner = owner
            self._acquired_at = time.time()
            logger.debug("Lock acquired by '%s'", owner)
            return True

    async def release(self, owner: str) -> None:
        """Release lock if owned by this owner.

        Args:
            owner: Identifier for the lock owner
        """
        async with self._lock:
            if self._owner == owner:
                logger.debug("Lock released by '%s'", owner)
                self._owner = None
                self._acquired_at = None
            else:
                logger.warning(
                    "Lock release failed: owned by '%s', requested by '%s'",
                    self._owner,
                    owner,
                )

    async def __aenter__(self):
        """Async context manager support.

        Note: Context manager requires owner to be set via configure().
        """
        if not hasattr(self, "_context_owner"):
            raise RuntimeError(
                "TimedLock context manager requires owner. Use: "
                "async with lock.for_owner(owner_id):"
            )
        success = await self.acquire(self._context_owner)
        if not success:
            raise RuntimeError(
                f"Failed to acquire lock for '{self._context_owner}'"
            )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager support."""
        if hasattr(self, "_context_owner"):
            await self.release(self._context_owner)
        return False

    def for_owner(self, owner: str) -> "TimedLock":
        """Configure lock for context manager usage.

        Usage:
            async with lock.for_owner("character_123"):
                # Perform locked operations

        Args:
            owner: Identifier for the lock owner

        Returns:
            Self for chaining
        """
        self._context_owner = owner
        return self
