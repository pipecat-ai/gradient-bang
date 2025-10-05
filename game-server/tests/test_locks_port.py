"""Tests for core.locks.port_locks module."""

import asyncio
import pytest

from core.locks.port_locks import PortLockManager


@pytest.mark.asyncio
class TestPortLockManager:
    """Tests for PortLockManager class."""

    async def test_lock_context_manager(self):
        """Test lock acquisition and release via context manager."""
        manager = PortLockManager(timeout=30.0)

        # Acquire lock
        async with manager.lock(sector_id=100, character_id="char1"):
            # Lock is held
            pass

        # Lock should be released automatically

    async def test_same_character_can_reacquire(self):
        """Test same character can reacquire lock after release."""
        manager = PortLockManager(timeout=30.0)

        # First acquisition
        async with manager.lock(sector_id=100, character_id="char1"):
            pass

        # Second acquisition by same character
        async with manager.lock(sector_id=100, character_id="char1"):
            pass

    async def test_different_characters_serialized_same_port(self):
        """Test that different characters trading at same port are serialized."""
        manager = PortLockManager(timeout=30.0)
        execution_order = []

        async def trade_char1():
            async with manager.lock(sector_id=100, character_id="char1"):
                execution_order.append("char1_start")
                await asyncio.sleep(0.1)
                execution_order.append("char1_end")

        async def trade_char2():
            # Small delay to ensure char1 acquires first
            await asyncio.sleep(0.01)
            async with manager.lock(sector_id=100, character_id="char2"):
                execution_order.append("char2_start")
                await asyncio.sleep(0.1)
                execution_order.append("char2_end")

        # Run both trades concurrently
        await asyncio.gather(trade_char1(), trade_char2())

        # Verify serialization - char1 must complete before char2 starts
        assert execution_order == ["char1_start", "char1_end", "char2_start", "char2_end"]

    async def test_different_ports_concurrent(self):
        """Test that trades at different ports can run concurrently."""
        manager = PortLockManager(timeout=30.0)
        execution_order = []

        async def trade_port100():
            async with manager.lock(sector_id=100, character_id="char1"):
                execution_order.append("port100_start")
                await asyncio.sleep(0.1)
                execution_order.append("port100_end")

        async def trade_port200():
            async with manager.lock(sector_id=200, character_id="char2"):
                execution_order.append("port200_start")
                await asyncio.sleep(0.1)
                execution_order.append("port200_end")

        # Run both trades concurrently
        await asyncio.gather(trade_port100(), trade_port200())

        # Both should start before either ends (concurrent execution)
        port100_start_idx = execution_order.index("port100_start")
        port200_start_idx = execution_order.index("port200_start")
        port100_end_idx = execution_order.index("port100_end")
        port200_end_idx = execution_order.index("port200_end")

        # Both should have started
        assert port100_start_idx < 2
        assert port200_start_idx < 2

        # Both should have ended
        assert port100_end_idx > 1
        assert port200_end_idx > 1

    async def test_lock_timeout_forces_release(self):
        """Test that lock timeout allows forcible release."""
        manager = PortLockManager(timeout=0.1)

        # Acquire lock with short timeout
        async with manager.lock(sector_id=100, character_id="char1"):
            # Wait for timeout to expire
            await asyncio.sleep(0.15)

        # Different character should be able to forcibly acquire after timeout
        async with manager.lock(sector_id=100, character_id="char2"):
            pass

    async def test_lock_released_on_exception(self):
        """Test that lock is released even when exception occurs."""
        manager = PortLockManager(timeout=30.0)

        # Lock and raise exception
        with pytest.raises(ValueError, match="test error"):
            async with manager.lock(sector_id=100, character_id="char1"):
                raise ValueError("test error")

        # Lock should be released, allowing reacquisition
        async with manager.lock(sector_id=100, character_id="char2"):
            pass

    async def test_multiple_concurrent_waiters_same_port(self):
        """Test multiple characters waiting for same port lock."""
        manager = PortLockManager(timeout=30.0)
        results = []

        async def trade(character_id: str, delay: float):
            if delay > 0:
                await asyncio.sleep(delay)
            async with manager.lock(sector_id=100, character_id=character_id):
                results.append(f"{character_id}_acquired")
                await asyncio.sleep(0.05)
                results.append(f"{character_id}_released")

        # Start 3 trades concurrently
        await asyncio.gather(
            trade("char1", 0.0),
            trade("char2", 0.01),
            trade("char3", 0.02),
        )

        # All should have completed
        assert len(results) == 6

        # Each character should acquire then release (serialized)
        for i in range(0, 6, 2):
            char_id = results[i].split("_")[0]
            assert results[i] == f"{char_id}_acquired"
            assert results[i + 1] == f"{char_id}_released"

    async def test_lock_timeout_configuration(self):
        """Test lock timeout can be configured."""
        # Short timeout
        manager_short = PortLockManager(timeout=0.1)
        assert manager_short.timeout == 0.1

        # Long timeout
        manager_long = PortLockManager(timeout=60.0)
        assert manager_long.timeout == 60.0

    async def test_same_character_different_ports(self):
        """Test same character can hold locks on different ports."""
        manager = PortLockManager(timeout=30.0)

        # Acquire locks on two different ports simultaneously
        async with manager.lock(sector_id=100, character_id="char1"):
            async with manager.lock(sector_id=200, character_id="char1"):
                # Both locks held
                pass

    async def test_lock_acquisition_order_preserved(self):
        """Test that lock waiters are served in FIFO order."""
        manager = PortLockManager(timeout=30.0)
        acquisition_order = []

        async def try_lock(character_id: str, delay: float):
            await asyncio.sleep(delay)
            async with manager.lock(sector_id=100, character_id=character_id):
                acquisition_order.append(character_id)

        # Start multiple tasks with staggered delays
        await asyncio.gather(
            try_lock("char1", 0.0),
            try_lock("char2", 0.01),
            try_lock("char3", 0.02),
            try_lock("char4", 0.03),
        )

        # Should acquire in request order
        assert acquisition_order == ["char1", "char2", "char3", "char4"]

    async def test_lock_manager_handles_many_ports(self):
        """Test lock manager can handle many different ports."""
        manager = PortLockManager(timeout=30.0)

        # Acquire locks on 100 different ports concurrently
        async def lock_port(sector_id: int):
            async with manager.lock(sector_id=sector_id, character_id=f"char{sector_id}"):
                pass

        await asyncio.gather(*[lock_port(i) for i in range(100)])

        # All locks should have been created and released
        assert len(manager._locks) == 100
