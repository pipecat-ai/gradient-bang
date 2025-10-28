"""Tests for core.locks.credit_locks module."""

import asyncio
import pytest
from unittest.mock import Mock

from core.locks.credit_locks import CreditLockManager


class MockKnowledgeManager:
    """Mock knowledge manager for testing."""

    def __init__(self):
        self._credits = {}

    def get_credits(self, character_id: str) -> int:
        """Get character credits."""
        return self._credits.get(character_id, 0)

    def update_credits(self, character_id: str, amount: int) -> None:
        """Update character credits."""
        self._credits[character_id] = amount


class MockWorld:
    """Mock world for testing."""

    def __init__(self):
        self.knowledge_manager = MockKnowledgeManager()


@pytest.mark.asyncio
class TestCreditLockManager:
    """Tests for CreditLockManager class."""

    async def test_deduct_credits_success(self):
        """Test successful credit deduction."""
        manager = CreditLockManager(timeout=30.0)
        world = MockWorld()
        world.knowledge_manager.update_credits("char1", 1000)

        # Deduct credits
        result = await manager.deduct_credits("char1", 300, world)

        assert result is True
        assert world.knowledge_manager.get_credits("char1") == 700

    async def test_deduct_credits_insufficient(self):
        """Test deduction fails with insufficient credits."""
        manager = CreditLockManager(timeout=30.0)
        world = MockWorld()
        world.knowledge_manager.update_credits("char1", 100)

        # Try to deduct more than available
        result = await manager.deduct_credits("char1", 300, world)

        assert result is False
        assert world.knowledge_manager.get_credits("char1") == 100  # Unchanged

    async def test_deduct_credits_exact_amount(self):
        """Test deduction of exact credit balance."""
        manager = CreditLockManager(timeout=30.0)
        world = MockWorld()
        world.knowledge_manager.update_credits("char1", 500)

        # Deduct exact amount
        result = await manager.deduct_credits("char1", 500, world)

        assert result is True
        assert world.knowledge_manager.get_credits("char1") == 0

    async def test_deduct_credits_negative_amount(self):
        """Test deduction rejects negative amounts."""
        manager = CreditLockManager(timeout=30.0)
        world = MockWorld()

        # Try to deduct negative amount
        with pytest.raises(ValueError, match="negative"):
            await manager.deduct_credits("char1", -100, world)

    async def test_add_credits_success(self):
        """Test successful credit addition."""
        manager = CreditLockManager(timeout=30.0)
        world = MockWorld()
        world.knowledge_manager.update_credits("char1", 100)

        # Add credits
        new_balance = await manager.add_credits("char1", 500, world)

        assert new_balance == 600
        assert world.knowledge_manager.get_credits("char1") == 600

    async def test_add_credits_to_zero(self):
        """Test adding credits to character with zero balance."""
        manager = CreditLockManager(timeout=30.0)
        world = MockWorld()

        # Add credits to zero balance
        new_balance = await manager.add_credits("char1", 1000, world)

        assert new_balance == 1000
        assert world.knowledge_manager.get_credits("char1") == 1000

    async def test_add_credits_negative_amount(self):
        """Test addition rejects negative amounts."""
        manager = CreditLockManager(timeout=30.0)
        world = MockWorld()

        # Try to add negative amount
        with pytest.raises(ValueError, match="negative"):
            await manager.add_credits("char1", -100, world)

    async def test_lock_context_manager(self):
        """Test using lock context manager directly."""
        manager = CreditLockManager(timeout=30.0)
        world = MockWorld()
        world.knowledge_manager.update_credits("char1", 1000)

        # Use lock context manager
        async with manager.lock("char1"):
            credits = world.knowledge_manager.get_credits("char1")
            world.knowledge_manager.update_credits("char1", credits - 200)

        assert world.knowledge_manager.get_credits("char1") == 800

    async def test_concurrent_deductions_serialized(self):
        """Test concurrent deductions are properly serialized."""
        manager = CreditLockManager(timeout=30.0)
        world = MockWorld()
        world.knowledge_manager.update_credits("char1", 1000)

        results = []

        async def deduct(amount: int):
            result = await manager.deduct_credits("char1", amount, world)
            results.append(result)

        # Concurrent deductions
        await asyncio.gather(
            deduct(300),
            deduct(400),
            deduct(500),
        )

        # Only first two should succeed (300 + 400 = 700 < 1000)
        # Third should fail (700 + 500 > 1000)
        successful = sum(1 for r in results if r)
        assert successful == 2
        assert world.knowledge_manager.get_credits("char1") == 300  # 1000 - 300 - 400

    async def test_different_characters_independent(self):
        """Test locks for different characters are independent."""
        manager = CreditLockManager(timeout=30.0)
        world = MockWorld()
        world.knowledge_manager.update_credits("char1", 1000)
        world.knowledge_manager.update_credits("char2", 2000)

        # Concurrent operations on different characters
        result1 = await manager.deduct_credits("char1", 300, world)
        result2 = await manager.deduct_credits("char2", 500, world)

        assert result1 is True
        assert result2 is True
        assert world.knowledge_manager.get_credits("char1") == 700
        assert world.knowledge_manager.get_credits("char2") == 1500

    async def test_lock_released_on_exception(self):
        """Test lock is released even when exception occurs."""
        manager = CreditLockManager(timeout=30.0)
        world = MockWorld()
        world.knowledge_manager.update_credits("char1", 1000)

        # Raise exception inside lock
        with pytest.raises(ValueError):
            async with manager.lock("char1"):
                raise ValueError("test exception")

        # Lock should be released, can deduct afterward
        result = await manager.deduct_credits("char1", 300, world)
        assert result is True

    async def test_multiple_locks_per_character(self):
        """Test creating multiple locks for same character uses same lock instance."""
        manager = CreditLockManager(timeout=30.0)

        # Get lock twice
        lock1 = manager._get_lock("char1")
        lock2 = manager._get_lock("char1")

        # Should be same instance
        assert lock1 is lock2

    async def test_lock_timeout_configuration(self):
        """Test lock timeout is properly configured."""
        manager = CreditLockManager(timeout=5.0)

        lock = manager._get_lock("char1")
        assert lock.timeout == 5.0

    async def test_deduct_zero_credits(self):
        """Test deducting zero credits succeeds."""
        manager = CreditLockManager(timeout=30.0)
        world = MockWorld()
        world.knowledge_manager.update_credits("char1", 1000)

        result = await manager.deduct_credits("char1", 0, world)

        assert result is True
        assert world.knowledge_manager.get_credits("char1") == 1000

    async def test_add_zero_credits(self):
        """Test adding zero credits succeeds."""
        manager = CreditLockManager(timeout=30.0)
        world = MockWorld()
        world.knowledge_manager.update_credits("char1", 1000)

        new_balance = await manager.add_credits("char1", 0, world)

        assert new_balance == 1000
        assert world.knowledge_manager.get_credits("char1") == 1000

    async def test_concurrent_add_and_deduct(self):
        """Test concurrent additions and deductions."""
        manager = CreditLockManager(timeout=30.0)
        world = MockWorld()
        world.knowledge_manager.update_credits("char1", 1000)

        # Mix of add and deduct operations
        await asyncio.gather(
            manager.add_credits("char1", 500, world),
            manager.deduct_credits("char1", 300, world),
            manager.add_credits("char1", 200, world),
        )

        # Final balance should be: 1000 + 500 - 300 + 200 = 1400
        assert world.knowledge_manager.get_credits("char1") == 1400
