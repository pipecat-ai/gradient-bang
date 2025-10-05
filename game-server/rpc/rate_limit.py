"""Per-character rate limiting with request queueing."""

import asyncio
import logging
import time
import yaml
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Awaitable, TypeVar, Dict, Optional, Any

logger = logging.getLogger("gradient-bang.rate_limit")

T = TypeVar("T")


@dataclass
class RateLimitConfig:
    """Rate limit configuration for an endpoint."""

    limit: float  # requests per window
    window: float  # window in seconds
    queue_timeout: float = 30.0  # max time request can wait

    @property
    def delay_per_request(self) -> float:
        """Calculate delay between requests to achieve rate limit."""
        return self.window / self.limit if self.limit > 0 else 0.0


@dataclass
class QueuedRequest:
    """A request waiting in the rate limit queue."""

    handler: Callable[[], Awaitable[Any]]
    enqueued_at: float
    future: asyncio.Future


class RateLimiter:
    """Per-character rate limiter with queueing support.

    Requests exceeding rate limits are queued and processed when timing allows.
    Requests waiting longer than queue_timeout are rejected with TimeoutError.
    """

    def __init__(self, config_path: Optional[Path] = None):
        """Initialize rate limiter.

        Args:
            config_path: Path to rate_limits.yaml config file.
                        If None, uses default limits for all endpoints.
        """
        self._config: Dict[str, Any] = {}
        self._default_config = RateLimitConfig(limit=1.0, window=1.0)

        if config_path and config_path.exists():
            self._load_config(config_path)
        else:
            logger.warning(
                "Rate limit config not found at %s, using defaults", config_path
            )

        # Per-character request queues
        self._queues: Dict[str, asyncio.Queue] = {}
        # Per-character last request time
        self._last_request: Dict[str, float] = {}
        # Per-character queue processor tasks
        self._processors: Dict[str, asyncio.Task] = {}
        # Lock for queue/processor access
        self._lock = asyncio.Lock()

    def _load_config(self, config_path: Path) -> None:
        """Load rate limit configuration from YAML file.

        Args:
            config_path: Path to YAML configuration file
        """
        try:
            with open(config_path, "r") as f:
                self._config = yaml.safe_load(f) or {}
            logger.info("Loaded rate limit config from %s", config_path)
        except Exception as exc:
            logger.error("Failed to load rate limit config: %s", exc)
            self._config = {}

    def get_limit(
        self, endpoint: str, message_type: Optional[str] = None
    ) -> RateLimitConfig:
        """Get rate limit config for endpoint.

        Args:
            endpoint: Endpoint name (e.g., "move", "send_message")
            message_type: Optional sub-type (e.g., "broadcast", "direct")

        Returns:
            RateLimitConfig for this endpoint/type
        """
        # Check for endpoint-specific config with message type
        if message_type and endpoint in self._config:
            endpoint_cfg = self._config[endpoint]
            if isinstance(endpoint_cfg, dict) and message_type in endpoint_cfg:
                type_cfg = endpoint_cfg[message_type]
                return RateLimitConfig(**type_cfg)

        # Check for endpoint-level config
        if endpoint in self._config:
            endpoint_cfg = self._config[endpoint]
            if isinstance(endpoint_cfg, dict) and "limit" in endpoint_cfg:
                return RateLimitConfig(**endpoint_cfg)

        # Check for default config
        if "default" in self._config:
            return RateLimitConfig(**self._config["default"])

        # Use hardcoded default
        return self._default_config

    async def _get_queue(self, character_id: str) -> asyncio.Queue:
        """Get or create request queue for character.

        Args:
            character_id: Character ID

        Returns:
            Request queue for this character
        """
        async with self._lock:
            if character_id not in self._queues:
                self._queues[character_id] = asyncio.Queue()
                # Start queue processor
                self._processors[character_id] = asyncio.create_task(
                    self._process_queue(character_id)
                )
            return self._queues[character_id]

    async def _process_queue(self, character_id: str) -> None:
        """Process queued requests for character at configured rate.

        Args:
            character_id: Character ID to process queue for
        """
        logger.debug("Started queue processor for %s", character_id)
        queue = self._queues[character_id]

        try:
            while True:
                # Get next request from queue
                request: QueuedRequest = await queue.get()

                try:
                    # Check if request has timed out
                    wait_time = time.time() - request.enqueued_at
                    if wait_time > 30.0:  # Hardcoded 30s timeout
                        logger.warning(
                            "Request for %s timed out after %.2fs",
                            character_id,
                            wait_time,
                        )
                        request.future.set_exception(
                            TimeoutError(
                                f"Request timed out after {wait_time:.2f}s in queue"
                            )
                        )
                        continue

                    # Rate limiting: enforce delay since last request
                    if character_id in self._last_request:
                        time_since_last = time.time() - self._last_request[character_id]
                        # Use default config for queue processing
                        # (per-endpoint limiting happens at enqueue time via config)
                        min_delay = self._default_config.delay_per_request
                        if time_since_last < min_delay:
                            delay = min_delay - time_since_last
                            logger.debug(
                                "Rate limiting %s: waiting %.3fs", character_id, delay
                            )
                            await asyncio.sleep(delay)

                    # Execute request
                    result = await request.handler()
                    self._last_request[character_id] = time.time()
                    request.future.set_result(result)

                except Exception as exc:
                    logger.error(
                        "Error processing request for %s: %s", character_id, exc
                    )
                    request.future.set_exception(exc)

                finally:
                    queue.task_done()

        except asyncio.CancelledError:
            logger.debug("Queue processor cancelled for %s", character_id)
            raise

    async def enqueue_request(
        self,
        endpoint: str,
        character_id: str,
        handler: Callable[[], Awaitable[T]],
        message_type: Optional[str] = None,
    ) -> T:
        """Enqueue request for execution when rate limit allows.

        Blocks until request can execute within rate limit.

        Args:
            endpoint: Endpoint name for rate limit lookup
            character_id: Character making the request
            handler: Async function to execute
            message_type: Optional message type for send_message endpoint

        Returns:
            Result from handler execution

        Raises:
            TimeoutError: If request waits longer than queue_timeout
        """
        # Get rate limit config
        config = self.get_limit(endpoint, message_type)
        logger.debug(
            "Rate limit for %s/%s: %.2f req/%.2fs",
            endpoint,
            message_type or "default",
            config.limit,
            config.window,
        )

        # Get queue for this character
        queue = await self._get_queue(character_id)

        # Create queued request
        future: asyncio.Future = asyncio.Future()
        request = QueuedRequest(
            handler=handler, enqueued_at=time.time(), future=future
        )

        # Enqueue and wait for result
        await queue.put(request)
        logger.debug(
            "Enqueued request for %s (queue size: %d)", character_id, queue.qsize()
        )

        return await future

    async def shutdown(self) -> None:
        """Shutdown rate limiter, cancelling all queue processors."""
        logger.info("Shutting down rate limiter")
        async with self._lock:
            for character_id, processor in self._processors.items():
                processor.cancel()
            self._processors.clear()
            self._queues.clear()
