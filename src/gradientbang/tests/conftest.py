"""Pytest configuration that stubs optional third-party deps for unit tests."""

from __future__ import annotations

import asyncio
import sys
import types
from enum import Enum
from pathlib import Path
from typing import Any, Awaitable, Callable, List, Optional

TESTS_DIR = Path(__file__).resolve().parent
WORLD_DATA_DIR = TESTS_DIR / "test-world-data"

# Ensure legacy top-level imports used throughout tests (e.g. `import api`)
# resolve correctly by adding the original module roots to sys.path.
PROJECT_SRC_DIR = TESTS_DIR.parent
GAME_SERVER_DIR = PROJECT_SRC_DIR / "game_server"

for extra_path in (PROJECT_SRC_DIR, GAME_SERVER_DIR):
    path_str = str(extra_path)
    if extra_path.exists() and path_str not in sys.path:
        sys.path.insert(0, path_str)


def _ensure_openai_stub() -> None:
    if "openai" in sys.modules:
        return

    class _AsyncOpenAIStub:  # pragma: no cover - minimal test stub
        def __init__(self, *args, **kwargs):
            pass

    openai_mod = types.ModuleType("openai")
    openai_mod.AsyncOpenAI = _AsyncOpenAIStub

    openai__types_mod = types.ModuleType("openai._types")
    openai__types_mod.NOT_GIVEN = object()

    openai_types_pkg = types.ModuleType("openai.types")
    openai_types_pkg.__path__ = []  # type: ignore[attr-defined]
    openai_chat_mod = types.ModuleType("openai.types.chat")

    class ChatCompletionToolParam(dict):  # pragma: no cover - minimal stub
        pass

    openai_chat_mod.ChatCompletionToolParam = ChatCompletionToolParam
    openai_types_pkg.chat = openai_chat_mod

    openai_mod._types = openai__types_mod
    openai_mod.types = openai_types_pkg

    sys.modules["openai"] = openai_mod
    sys.modules["openai._types"] = openai__types_mod
    sys.modules["openai.types"] = openai_types_pkg
    sys.modules["openai.types.chat"] = openai_chat_mod


def _ensure_pipecat_stub() -> None:
    if "pipecat" in sys.modules:
        return

    def _create_module(name: str, *, is_pkg: bool = False) -> types.ModuleType:
        module = types.ModuleType(name)
        if is_pkg:
            module.__path__ = []  # type: ignore[attr-defined]
        sys.modules[name] = module
        return module

    pipecat_pkg = _create_module("pipecat", is_pkg=True)

    # Frames
    _create_module("pipecat.frames", is_pkg=True)
    frames_mod = _create_module("pipecat.frames.frames")

    class Frame:  # pragma: no cover - minimal stub
        pass

    class FunctionCallResultProperties:  # pragma: no cover - minimal stub
        def __init__(self, run_llm: bool = False):
            self.run_llm = run_llm

    class EndFrame(Frame):
        pass

    class LLMFullResponseEndFrame(Frame):
        pass

    class LLMMessagesAppendFrame(Frame):
        pass

    class LLMRunFrame(Frame):
        pass

    class LLMTextFrame(Frame):
        pass

    frames_mod.Frame = Frame
    frames_mod.FunctionCallResultProperties = FunctionCallResultProperties
    frames_mod.EndFrame = EndFrame
    frames_mod.LLMFullResponseEndFrame = LLMFullResponseEndFrame
    frames_mod.LLMMessagesAppendFrame = LLMMessagesAppendFrame
    frames_mod.LLMRunFrame = LLMRunFrame
    frames_mod.LLMTextFrame = LLMTextFrame

    # Pipeline
    _create_module("pipecat.pipeline", is_pkg=True)
    pipeline_mod = _create_module("pipecat.pipeline.pipeline")
    pipeline_runner_mod = _create_module("pipecat.pipeline.runner")
    pipeline_task_mod = _create_module("pipecat.pipeline.task")

    class Pipeline:  # pragma: no cover - minimal stub
        def __init__(self, steps: List[Any]):
            self.steps = steps

    class PipelineRunner:  # pragma: no cover - minimal stub
        def __init__(self, *_, **__):
            pass

        async def run(self, task: "PipelineTask") -> None:
            await asyncio.sleep(0)

    class PipelineParams:  # pragma: no cover - minimal stub
        def __init__(self, *_, **__):
            pass

    class PipelineTask:  # pragma: no cover - minimal stub
        def __init__(self, pipeline: Pipeline, params: PipelineParams, **kwargs):
            self.pipeline = pipeline
            self.params = params
            self.kwargs = kwargs

        async def cancel(self) -> None:
            return None

    pipeline_mod.Pipeline = Pipeline
    pipeline_runner_mod.PipelineRunner = PipelineRunner
    pipeline_task_mod.PipelineParams = PipelineParams
    pipeline_task_mod.PipelineTask = PipelineTask

    # Frame processor + aggregators
    _create_module("pipecat.processors", is_pkg=True)
    _create_module("pipecat.processors.aggregators", is_pkg=True)
    llm_context_mod = _create_module("pipecat.processors.aggregators.llm_context")
    llm_response_mod = _create_module(
        "pipecat.processors.aggregators.llm_response_universal"
    )
    frame_processor_mod = _create_module("pipecat.processors.frame_processor")

    class FrameDirection(Enum):  # pragma: no cover - minimal stub
        UPSTREAM = "upstream"
        DOWNSTREAM = "downstream"

    class FrameProcessor:  # pragma: no cover - minimal stub
        async def process_frame(self, frame: Any, direction: FrameDirection):
            return None

        async def push_frame(self, frame: Any, direction: FrameDirection = FrameDirection.DOWNSTREAM):
            return None

    class LLMContext:  # pragma: no cover - minimal stub
        def __init__(self, messages: Optional[List[Any]] = None, tools: Any = None):
            self.messages = messages or []
            self.tools = tools

    class LLMSpecificMessage:  # pragma: no cover - minimal stub
        def __init__(self, llm: str, message: Any):
            self.llm = llm
            self.message = message

    class _AggregatorEndpoint(FrameProcessor):
        def __init__(self, role: str):
            super().__init__()
            self.role = role

    class LLMContextAggregatorPair:  # pragma: no cover - minimal stub
        def __init__(self, context: LLMContext):
            self.context = context

        def user(self) -> FrameProcessor:
            return _AggregatorEndpoint("user")

        def assistant(self) -> FrameProcessor:
            return _AggregatorEndpoint("assistant")

    llm_context_mod.LLMContext = LLMContext
    llm_context_mod.LLMSpecificMessage = LLMSpecificMessage
    llm_response_mod.LLMContextAggregatorPair = LLMContextAggregatorPair
    frame_processor_mod.FrameDirection = FrameDirection
    frame_processor_mod.FrameProcessor = FrameProcessor

    # Services
    _create_module("pipecat.services", is_pkg=True)
    _create_module("pipecat.services.google", is_pkg=True)
    google_llm_mod = _create_module("pipecat.services.google.llm")
    llm_service_mod = _create_module("pipecat.services.llm_service")

    class _DummyLLM:  # pragma: no cover - minimal stub
        async def push_frame(self, frame: Any) -> None:
            return None

    class FunctionCallParams:  # pragma: no cover - minimal stub
        def __init__(
            self,
            function_name: Optional[str] = None,
            arguments: Optional[dict] = None,
            result_callback: Optional[Callable[..., Awaitable[Any]]] = None,
            tool_call_id: Optional[str] = None,
            llm: Optional[Any] = None,
        ):
            self.function_name = function_name or "tool"
            self.arguments = arguments or {}
            self.result_callback = result_callback or (lambda *args, **kwargs: asyncio.sleep(0))
            self.tool_call_id = tool_call_id or "tool-call"
            self.llm = llm or _DummyLLM()

    class LLMService:  # pragma: no cover - marker base
        def register_function(self, *args, **kwargs):
            return None

    class GoogleLLMService(LLMService):  # pragma: no cover - minimal stub
        def __init__(self, *_, **__):
            self._functions: List[Any] = []

        def register_function(self, name: Any, handler: Callable[..., Awaitable[Any]]):
            self._functions.append((name, handler))

        async def push_frame(self, frame: Any) -> None:
            return None

    google_llm_mod.GoogleLLMService = GoogleLLMService
    llm_service_mod.FunctionCallParams = FunctionCallParams
    llm_service_mod.LLMService = LLMService

    # Adapters / schemas
    _create_module("pipecat.adapters", is_pkg=True)
    _create_module("pipecat.adapters.schemas", is_pkg=True)
    _create_module("pipecat.adapters.services", is_pkg=True)
    tools_schema_mod = _create_module("pipecat.adapters.schemas.tools_schema")
    function_schema_mod = _create_module("pipecat.adapters.schemas.function_schema")
    openai_adapter_mod = _create_module("pipecat.adapters.services.open_ai_adapter")

    class ToolsSchema:  # pragma: no cover - minimal stub
        def __init__(self, entries: Optional[List[Any]] = None, **kwargs):
            self.entries = entries or kwargs.get("standard_tools", [])
            self.metadata = kwargs

    class FunctionSchema:  # pragma: no cover - minimal stub
        def __init__(
            self,
            name: str,
            description: str,
            properties: Optional[dict] = None,
            required: Optional[List[str]] = None,
        ):
            self.name = name
            self.description = description
            self.properties = properties or {}
            self.required = required or []

    tools_schema_mod.ToolsSchema = ToolsSchema
    function_schema_mod.FunctionSchema = FunctionSchema
    openai_adapter_mod.OpenAILLMAdapter = type(
        "OpenAILLMAdapter",
        (),
        {"to_provider_tools_format": staticmethod(lambda *_args, **_kwargs: [])},
    )

    # expose common attrs on root package for convenience
    pipecat_pkg.frames = frames_mod


_ensure_openai_stub()
_ensure_pipecat_stub()


# =============================================================================
# Test Infrastructure Fixtures
# =============================================================================

import json
import logging

import httpx
import pytest

from gradientbang.tests.helpers.character_setup import register_all_test_characters
from gradientbang.tests.helpers.server_fixture import (
    start_test_server,
    stop_test_server,
    wait_for_server_ready,
)

# Import AsyncGameClient for test reset calls
from gradientbang.utils.api_client import AsyncGameClient

logger = logging.getLogger(__name__)


@pytest.fixture(scope="session", autouse=True)
def setup_test_characters():
    """
    Register all test characters ONCE per pytest session.

    This fixture automatically runs before any tests and registers all
    ~35 test character IDs to prevent "Character is not registered" errors.

    The registration writes to tests/test-world-data/characters.json which
    is used by test servers.
    """
    register_all_test_characters()

    corps_dir = WORLD_DATA_DIR / "corporations"
    if corps_dir.exists():
        for corp_file in corps_dir.glob("*.json"):
            corp_file.unlink()

    registry_path = WORLD_DATA_DIR / "corporation_registry.json"
    registry_payload = {"by_name": {}}
    registry_path.write_text(json.dumps(registry_payload, indent=2))

    yield
    # Cleanup handled by temp directory removal if needed


@pytest.fixture(scope="session")
def server_url():
    """
    Provide the test server URL.

    Returns:
        str: The base URL for the test server (http://localhost:8002)
    """
    return "http://localhost:8002"


@pytest.fixture(scope="session")
async def check_server_available(server_url):
    """
    Check if test server is available, skip tests if not running.

    This fixture checks if a server is running on port 8002 by attempting
    to connect to the /health endpoint with a 1-second timeout.

    If the server is not available, tests marked with @pytest.mark.requires_server
    will be skipped with a helpful message.

    Usage:
        @pytest.mark.requires_server
        async def test_something(check_server_available):
            # Test code here
    """
    try:
        async with httpx.AsyncClient() as client:
            # Use root endpoint (server doesn't have /health)
            response = await client.get(f"{server_url}/", timeout=1.0)
            if response.status_code != 200:
                pytest.skip(
                    f"Test server not responding at {server_url}. "
                    f"Start with: PORT=8002 WORLD_DATA_DIR=tests/test-world-data uv run python -m game-server"
                )
    except (httpx.ConnectError, httpx.TimeoutException):
        pytest.skip(
            f"Test server not running at {server_url}. "
            f"Start with: PORT=8002 WORLD_DATA_DIR=tests/test-world-data uv run python -m game-server"
        )

    yield


@pytest.fixture(scope="session", autouse=True)
async def test_server(server_url):
    """
    Start and manage a test server for integration tests.

    This fixture:
    1. Starts a game server on port 8002 with test data
    2. Waits for the server to be ready (polls /health endpoint)
    3. Yields the server URL for tests to use
    4. Stops the server after all tests complete

    Scope: session - Server is started once for entire test session, shared across all test files
    Autouse: True - Automatically starts for all integration tests

    Usage:
        Tests can use server_url fixture which provides "http://localhost:8002"
        The test_server fixture ensures server is running for entire session
    """
    # Start the server
    process = start_test_server(port=8002, world_data_dir=str(WORLD_DATA_DIR))

    try:
        # Wait for server to be ready (pass process for better error messages)
        await wait_for_server_ready(server_url, timeout=30.0, process=process)

        # Provide the server URL to tests
        yield server_url

    finally:
        # Stop the server after tests complete
        stop_test_server(process, timeout=5.0)


@pytest.fixture(autouse=True)
async def reset_test_state(server_url):
    """
    Reset server state after each test for proper test isolation.

    This fixture calls the test.reset endpoint to clear:
    - In-memory character state (world.characters)
    - Combat manager encounters
    - Salvage manager state
    - Garrison manager state
    - Knowledge manager cache
    - Test character knowledge files on disk
    - Event log

    Scope: function - Runs after EVERY test automatically
    """
    yield  # Let the test run first

    # After test completes, reset the server state
    try:
        client = AsyncGameClient(base_url=server_url, character_id="test_reset_runner")
        # Call the test.reset endpoint
        result = await client._request("test.reset", {
            "clear_files": True,  # Delete test character files from disk
            "file_prefixes": ["test_", "weak_", "strong_", "player", "push_"]
        })
        logger.info(
            f"Test reset completed: {result['cleared_characters']} characters, "
            f"{result['cleared_combats']} combats, {result['deleted_files']} files deleted, "
            f"{result.get('ports_reset', 0)} ports reset"
        )
        await client.close()
    except Exception as e:
        # Log but don't fail the test if reset fails
        # This might happen if server isn't running (for unit tests)
        logger.debug(f"Test reset skipped or failed: {e}")
