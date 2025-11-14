"""Tests for rpc.rate_limit module."""

import asyncio
import pytest
import time
from pathlib import Path
import tempfile

from gradientbang.game_server.rpc.rate_limit import RateLimiter, RateLimitConfig


class TestRateLimitConfig:
    """Tests for RateLimitConfig class."""

    def test_delay_per_request_calculation(self):
        """Test delay calculation for rate limits."""
        # 1 request per second = 1 second delay
        config = RateLimitConfig(limit=1.0, window=1.0)
        assert config.delay_per_request == 1.0

        # 2 requests per second = 0.5 second delay
        config = RateLimitConfig(limit=2.0, window=1.0)
        assert config.delay_per_request == 0.5

        # 0.1 requests per second (1 per 10s) = 10 second delay
        config = RateLimitConfig(limit=0.1, window=1.0)
        assert config.delay_per_request == 10.0

    def test_zero_limit(self):
        """Test zero limit returns zero delay."""
        config = RateLimitConfig(limit=0.0, window=1.0)
        assert config.delay_per_request == 0.0


@pytest.mark.asyncio
class TestRateLimiter:
    """Tests for RateLimiter class."""

    async def test_single_request_no_delay(self):
        """Test single request executes immediately."""
        limiter = RateLimiter()

        call_count = 0
        async def handler():
            nonlocal call_count
            call_count += 1
            return "result"

        start = time.time()
        result = await limiter.enqueue_request("test", "char1", handler)
        elapsed = time.time() - start

        assert result == "result"
        assert call_count == 1
        assert elapsed < 0.1  # Should be nearly instant

    async def test_multiple_requests_queued(self):
        """Test multiple requests are queued and processed."""
        limiter = RateLimiter()

        results = []
        async def handler(value: str):
            results.append(value)
            return value

        # Enqueue multiple requests concurrently
        await asyncio.gather(
            limiter.enqueue_request("test", "char1", lambda: handler("a")),
            limiter.enqueue_request("test", "char1", lambda: handler("b")),
            limiter.enqueue_request("test", "char1", lambda: handler("c")),
        )

        assert results == ["a", "b", "c"]

    async def test_rate_limiting_enforces_delay(self):
        """Test rate limiting enforces delays between requests."""
        # Create limiter with 2 RPS (0.5s between requests)
        limiter = RateLimiter()
        limiter._default_config = RateLimitConfig(limit=2.0, window=1.0)

        call_times = []
        async def handler():
            call_times.append(time.time())
            return "ok"

        # Execute 3 requests
        await asyncio.gather(
            limiter.enqueue_request("test", "char1", handler),
            limiter.enqueue_request("test", "char1", handler),
            limiter.enqueue_request("test", "char1", handler),
        )

        # Check delays between calls
        assert len(call_times) == 3
        # First request should be immediate
        # Second should be ~0.5s after first (rate limited)
        # Third should be ~0.5s after second (rate limited)
        delay1 = call_times[1] - call_times[0]
        delay2 = call_times[2] - call_times[1]

        assert 0.4 < delay1 < 0.7  # Second request delayed
        assert 0.4 < delay2 < 0.7  # Third request delayed

    async def test_different_characters_independent(self):
        """Test requests for different characters don't block each other."""
        limiter = RateLimiter()
        limiter._default_config = RateLimitConfig(limit=1.0, window=1.0)

        call_times = {}
        async def handler(char_id: str):
            call_times[char_id] = time.time()
            return char_id

        start = time.time()
        # Requests for different characters should execute concurrently
        await asyncio.gather(
            limiter.enqueue_request("test", "char1", lambda: handler("char1")),
            limiter.enqueue_request("test", "char2", lambda: handler("char2")),
            limiter.enqueue_request("test", "char3", lambda: handler("char3")),
        )
        elapsed = time.time() - start

        # All should complete quickly (not serialized)
        assert elapsed < 0.5
        assert len(call_times) == 3

    async def test_queue_timeout(self):
        """Test requests timeout after waiting too long."""
        limiter = RateLimiter()

        # Create a request that's already timed out
        async def handler():
            return "ok"

        # Manually create a timed-out request
        queue = await limiter._get_queue("char1")
        from gradientbang.game_server.rpc.rate_limit import QueuedRequest
        future = asyncio.Future()
        old_request = QueuedRequest(
            handler=handler,
            enqueued_at=time.time() - 35.0,  # 35s ago (past 30s timeout)
            future=future,
        )
        await queue.put(old_request)

        # Wait a bit for processor to handle it
        with pytest.raises(TimeoutError, match="timed out"):
            await asyncio.wait_for(future, timeout=2.0)

    async def test_handler_exception_propagates(self):
        """Test exceptions in handlers are propagated to caller."""
        limiter = RateLimiter()

        async def failing_handler():
            raise ValueError("test error")

        with pytest.raises(ValueError, match="test error"):
            await limiter.enqueue_request("test", "char1", failing_handler)

    async def test_config_from_dict(self):
        """Test loading config from dictionary."""
        limiter = RateLimiter()
        limiter._config = {
            "default": {"limit": 1.0, "window": 1.0},
            "send_message": {
                "broadcast": {"limit": 0.1, "window": 1.0},
                "direct": {"limit": 0.5, "window": 1.0},
            },
            "move": {"limit": 2.0, "window": 1.0},
        }

        # Test default
        config = limiter.get_limit("unknown")
        assert config.limit == 1.0

        # Test endpoint-specific
        config = limiter.get_limit("move")
        assert config.limit == 2.0

        # Test message type specific
        config = limiter.get_limit("send_message", "broadcast")
        assert config.limit == 0.1

        config = limiter.get_limit("send_message", "direct")
        assert config.limit == 0.5

    async def test_config_from_yaml_file(self):
        """Test loading config from YAML file."""
        # Create temporary YAML config
        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
            f.write("""
default:
  limit: 1.0
  window: 1.0
send_message:
  broadcast:
    limit: 0.1
    window: 1.0
move:
  limit: 2.0
  window: 1.0
""")
            config_path = Path(f.name)

        try:
            limiter = RateLimiter(config_path)

            # Verify config loaded
            config = limiter.get_limit("move")
            assert config.limit == 2.0

            config = limiter.get_limit("send_message", "broadcast")
            assert config.limit == 0.1

        finally:
            config_path.unlink()

    async def test_missing_config_file(self):
        """Test graceful handling of missing config file."""
        limiter = RateLimiter(Path("/nonexistent/config.yaml"))

        # Should use default config
        config = limiter.get_limit("anything")
        assert config.limit == 1.0

    async def test_shutdown(self):
        """Test shutdown cancels all processors."""
        limiter = RateLimiter()

        # Create some queues
        await limiter._get_queue("char1")
        await limiter._get_queue("char2")

        assert len(limiter._processors) == 2

        # Shutdown
        await limiter.shutdown()

        assert len(limiter._processors) == 0
        assert len(limiter._queues) == 0

    async def test_concurrent_queue_creation(self):
        """Test concurrent queue creation is safe."""
        limiter = RateLimiter()

        # Try to create same queue concurrently
        queues = await asyncio.gather(
            limiter._get_queue("char1"),
            limiter._get_queue("char1"),
            limiter._get_queue("char1"),
        )

        # Should all be the same queue instance
        assert queues[0] is queues[1]
        assert queues[1] is queues[2]
        assert len(limiter._queues) == 1
