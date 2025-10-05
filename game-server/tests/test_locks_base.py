"""Tests for core.locks.base module."""

import asyncio
import pytest
import time

from core.locks.base import TimedLock


@pytest.mark.asyncio
class TestTimedLock:
    """Tests for TimedLock class."""

    async def test_acquire_and_release(self):
        """Test basic acquire and release."""
        lock = TimedLock(timeout=30.0)

        # Acquire lock
        assert await lock.acquire("owner1") is True
        assert lock._owner == "owner1"

        # Release lock
        await lock.release("owner1")
        assert lock._owner is None

    async def test_same_owner_reacquire(self):
        """Test same owner can reacquire lock."""
        lock = TimedLock(timeout=30.0)

        # Acquire lock
        assert await lock.acquire("owner1") is True

        # Same owner reacquires
        assert await lock.acquire("owner1") is True
        assert lock._owner == "owner1"

    async def test_different_owner_blocked(self):
        """Test different owner cannot acquire until released."""
        lock = TimedLock(timeout=30.0)

        # First owner acquires
        assert await lock.acquire("owner1") is True

        # Second owner cannot acquire
        assert await lock.acquire("owner2") is False
        assert lock._owner == "owner1"

        # First owner releases
        await lock.release("owner1")

        # Now second owner can acquire
        assert await lock.acquire("owner2") is True
        assert lock._owner == "owner2"

    async def test_timeout_forces_release(self):
        """Test timeout forces lock release."""
        lock = TimedLock(timeout=0.1)  # 100ms timeout

        # First owner acquires
        assert await lock.acquire("owner1") is True

        # Wait for timeout
        await asyncio.sleep(0.15)

        # Second owner can now acquire (timeout exceeded)
        assert await lock.acquire("owner2") is True
        assert lock._owner == "owner2"

    async def test_release_by_non_owner(self):
        """Test release by non-owner does not release lock."""
        lock = TimedLock(timeout=30.0)

        # Owner1 acquires
        assert await lock.acquire("owner1") is True

        # Owner2 tries to release
        await lock.release("owner2")

        # Lock still held by owner1
        assert lock._owner == "owner1"
        assert await lock.acquire("owner2") is False

    async def test_context_manager_success(self):
        """Test context manager acquires and releases lock."""
        lock = TimedLock(timeout=30.0)

        # Use context manager
        async with lock.for_owner("owner1"):
            assert lock._owner == "owner1"

        # Lock released after context
        assert lock._owner is None

    async def test_context_manager_without_owner(self):
        """Test context manager fails without owner configuration."""
        lock = TimedLock(timeout=30.0)

        # Should raise RuntimeError
        with pytest.raises(RuntimeError, match="requires owner"):
            async with lock:
                pass

    async def test_context_manager_already_locked(self):
        """Test context manager fails if lock already held."""
        lock = TimedLock(timeout=30.0)

        # Owner1 acquires
        assert await lock.acquire("owner1") is True

        # Owner2 tries to use context manager
        with pytest.raises(RuntimeError, match="Failed to acquire lock"):
            async with lock.for_owner("owner2"):
                pass

        # Owner1 still holds lock
        assert lock._owner == "owner1"

    async def test_context_manager_releases_on_exception(self):
        """Test context manager releases lock even on exception."""
        lock = TimedLock(timeout=30.0)

        # Raises exception inside context
        with pytest.raises(ValueError):
            async with lock.for_owner("owner1"):
                assert lock._owner == "owner1"
                raise ValueError("test exception")

        # Lock released despite exception
        assert lock._owner is None

    async def test_concurrent_acquire_attempts(self):
        """Test concurrent acquire attempts with proper serialization."""
        lock = TimedLock(timeout=0.2)  # 200ms timeout
        results = []

        async def try_acquire(owner_id: str, delay: float):
            await asyncio.sleep(delay)
            result = await lock.acquire(owner_id)
            results.append((owner_id, result))

        # Start multiple concurrent acquire attempts
        await asyncio.gather(
            try_acquire("owner1", 0.0),    # Acquires immediately
            try_acquire("owner2", 0.05),   # Fails (owner1 holds)
            try_acquire("owner3", 0.25),   # Succeeds (owner1 timed out)
        )

        # Check results
        assert ("owner1", True) in results
        assert ("owner2", False) in results
        assert ("owner3", True) in results
        assert lock._owner == "owner3"

    async def test_timeout_tracking(self):
        """Test that timeout is tracked from acquisition time."""
        lock = TimedLock(timeout=0.1)

        # Acquire lock
        assert await lock.acquire("owner1") is True
        acquire_time = lock._acquired_at
        assert acquire_time is not None

        # Wait a bit
        await asyncio.sleep(0.05)

        # Reacquire by same owner doesn't reset timer
        assert await lock.acquire("owner1") is True
        assert lock._acquired_at == acquire_time  # Not updated

        # Wait for timeout
        await asyncio.sleep(0.06)

        # New owner can acquire
        assert await lock.acquire("owner2") is True
        assert lock._acquired_at > acquire_time  # Timer reset

    async def test_custom_timeout(self):
        """Test lock with custom timeout value."""
        lock = TimedLock(timeout=0.05)  # 50ms timeout

        # Acquire lock
        assert await lock.acquire("owner1") is True

        # Wait for timeout
        await asyncio.sleep(0.06)

        # New owner can acquire
        assert await lock.acquire("owner2") is True
        assert lock._owner == "owner2"

    async def test_zero_timeout(self):
        """Test lock with zero timeout (immediate expiry)."""
        lock = TimedLock(timeout=0.0)

        # Acquire lock
        assert await lock.acquire("owner1") is True

        # Immediately try with different owner (should succeed due to 0 timeout)
        assert await lock.acquire("owner2") is True
        assert lock._owner == "owner2"

    async def test_release_when_not_held(self):
        """Test releasing lock when not held is safe."""
        lock = TimedLock(timeout=30.0)

        # Release when not held (should not raise exception)
        await lock.release("owner1")
        assert lock._owner is None
