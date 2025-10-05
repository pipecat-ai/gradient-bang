"""Credit locking for atomic credit operations."""

import logging
from contextlib import asynccontextmanager
from typing import Dict

from .base import TimedLock

logger = logging.getLogger("gradient-bang.locks.credit")


class CreditLockManager:
    """Manages per-character credit locks with timeout protection.

    Prevents race conditions in credit spending operations (trades, toll payments, etc).
    """

    def __init__(self, timeout: float = 30.0):
        """Initialize credit lock manager.

        Args:
            timeout: Lock timeout in seconds
        """
        self.timeout = timeout
        self._locks: Dict[str, TimedLock] = {}

    def _get_lock(self, character_id: str) -> TimedLock:
        """Get or create lock for character.

        Args:
            character_id: Character ID to get lock for

        Returns:
            TimedLock instance for this character
        """
        if character_id not in self._locks:
            self._locks[character_id] = TimedLock(timeout=self.timeout)
        return self._locks[character_id]

    @asynccontextmanager
    async def lock(self, character_id: str):
        """Acquire credit lock for character.

        Usage:
            async with credit_locks.lock(character_id):
                # Perform credit operations
                credits = world.knowledge_manager.get_credits(character_id)
                world.knowledge_manager.update_credits(character_id, credits - amount)

        Args:
            character_id: Character ID to lock credits for

        Raises:
            RuntimeError: If lock acquisition fails
        """
        lock = self._get_lock(character_id)
        async with lock.for_owner(character_id):
            yield

    async def deduct_credits(
        self,
        character_id: str,
        amount: int,
        world,
    ) -> bool:
        """Atomically deduct credits from character.

        Args:
            character_id: Character ID to deduct from
            amount: Amount of credits to deduct
            world: Game world instance with knowledge_manager

        Returns:
            True if successful, False if insufficient credits

        Raises:
            ValueError: If amount is negative
        """
        if amount < 0:
            raise ValueError(f"Cannot deduct negative credits: {amount}")

        async with self.lock(character_id):
            current_credits = world.knowledge_manager.get_credits(character_id)
            if current_credits < amount:
                logger.debug(
                    "Insufficient credits for %s: has %d, needs %d",
                    character_id,
                    current_credits,
                    amount,
                )
                return False

            new_credits = current_credits - amount
            world.knowledge_manager.update_credits(character_id, new_credits)
            logger.debug(
                "Deducted %d credits from %s (%d -> %d)",
                amount,
                character_id,
                current_credits,
                new_credits,
            )
            return True

    async def add_credits(
        self,
        character_id: str,
        amount: int,
        world,
    ) -> int:
        """Atomically add credits to character.

        Args:
            character_id: Character ID to add to
            amount: Amount of credits to add
            world: Game world instance with knowledge_manager

        Returns:
            New credit balance

        Raises:
            ValueError: If amount is negative
        """
        if amount < 0:
            raise ValueError(f"Cannot add negative credits: {amount}")

        async with self.lock(character_id):
            current_credits = world.knowledge_manager.get_credits(character_id)
            new_credits = current_credits + amount
            world.knowledge_manager.update_credits(character_id, new_credits)
            logger.debug(
                "Added %d credits to %s (%d -> %d)",
                amount,
                character_id,
                current_credits,
                new_credits,
            )
            return new_credits
