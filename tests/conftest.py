"""Pytest configuration that stubs optional third-party deps for unit tests."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
import subprocess
import contextlib
import sys
import time
import types
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from shutil import which
from typing import Any, Awaitable, Callable, Dict, List, Optional

# Add project root to Python path for utils module
_project_root = Path.cwd()
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

REPO_ROOT = _project_root
LOG_DIR = REPO_ROOT / "logs"
ENV_PATH = REPO_ROOT / ".env.supabase"
SUPABASE_START_LOG = LOG_DIR / "supabase-start.log"
EDGE_FUNCTION_LOG = LOG_DIR / "supabase-functions.log"
_SUPABASE_ENV_CACHE: Optional[Dict[str, str]] = None
_SUPABASE_STACK_READY = False
_SUPABASE_DB_BOOTSTRAPPED = False
FUNCTION_PROC: Optional[tuple[subprocess.Popen[str], Any]] = None
ENV_EXPORTS: Dict[str, str] = {}

# Add game-server directory to Python path for unit tests
_game_server_path = _project_root / "game-server"
if str(_game_server_path) not in sys.path:
    sys.path.insert(0, str(_game_server_path))

# Add tests directory to Python path for test helpers
_tests_path = Path(__file__).parent
if str(_tests_path) not in sys.path:
    sys.path.insert(0, str(_tests_path))


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

    class SystemFrame(Frame):  # pragma: no cover - minimal stub
        """Base class for system frames (StartFrame, EndFrame, etc.)."""
        pass

    class DataFrame(Frame):  # pragma: no cover - minimal stub
        pass

    class LLMContextFrame(Frame):  # pragma: no cover - minimal stub
        def __init__(self, context=None):
            self.context = context

    frames_mod.Frame = Frame
    frames_mod.SystemFrame = SystemFrame
    frames_mod.DataFrame = DataFrame
    frames_mod.FunctionCallResultProperties = FunctionCallResultProperties
    frames_mod.EndFrame = EndFrame
    frames_mod.LLMFullResponseEndFrame = LLMFullResponseEndFrame
    frames_mod.LLMMessagesAppendFrame = LLMMessagesAppendFrame
    frames_mod.LLMRunFrame = LLMRunFrame
    frames_mod.LLMTextFrame = LLMTextFrame
    frames_mod.LLMContextFrame = LLMContextFrame

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
            self._messages = messages or []
            self.tools = tools

        @property
        def messages(self) -> List[Any]:
            return self._messages

        def add_message(self, message: Any) -> None:
            self._messages.append(message)

        def set_messages(self, messages: List[Any]) -> None:
            self._messages = messages

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

    # Producer/Consumer processors
    producer_mod = _create_module("pipecat.processors.producer_processor")
    consumer_mod = _create_module("pipecat.processors.consumer_processor")

    class ProducerProcessor(FrameProcessor):  # pragma: no cover - minimal stub
        def __init__(self, filter=None, passthrough=True):
            super().__init__()
            self._filter = filter
            self._passthrough = passthrough
            self._consumers: List[asyncio.Queue] = []

        def add_consumer(self) -> asyncio.Queue:
            queue = asyncio.Queue()
            self._consumers.append(queue)
            return queue

        async def _produce(self, frame: Any) -> None:
            for consumer in self._consumers:
                await consumer.put(frame)

        def create_task(self, coro) -> asyncio.Task:
            return asyncio.create_task(coro)

    class ConsumerProcessor(FrameProcessor):  # pragma: no cover - minimal stub
        def __init__(self, producer=None, direction=None):
            super().__init__()
            self._producer = producer
            self._direction = direction

    producer_mod.ProducerProcessor = ProducerProcessor
    consumer_mod.ConsumerProcessor = ConsumerProcessor

    # Adapters
    _create_module("pipecat.adapters", is_pkg=True)
    _create_module("pipecat.adapters.services", is_pkg=True)
    gemini_adapter_mod = _create_module("pipecat.adapters.services.gemini_adapter")

    @dataclass
    class _MockContent:  # pragma: no cover - stub for google.genai.types.Content
        role: str
        parts: List[Any]

    @dataclass
    class _MockPart:  # pragma: no cover - stub for google.genai.types.Part
        text: str

    class GeminiLLMAdapter:  # pragma: no cover - minimal stub
        """Stub for GeminiLLMAdapter."""

        @dataclass
        class ConvertedMessages:
            messages: List[Any]
            system_instruction: Optional[str] = None

        def _from_universal_context_messages(self, messages: List[Any]) -> "GeminiLLMAdapter.ConvertedMessages":
            """Convert OpenAI-style messages to Gemini Content format (stub)."""
            contents = []
            for msg in messages:
                if not isinstance(msg, dict):
                    continue
                role = msg.get("role", "user")
                content = msg.get("content", "")
                gemini_role = "model" if role == "assistant" else "user"
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    text_parts = [p.get("text", "") for p in content if isinstance(p, dict) and "text" in p]
                    text = "\n".join(text_parts)
                else:
                    text = str(content)
                contents.append(_MockContent(role=gemini_role, parts=[_MockPart(text=text)]))
            return self.ConvertedMessages(messages=contents)

    gemini_adapter_mod.GeminiLLMAdapter = GeminiLLMAdapter

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

import httpx
import pytest
from config import SUPABASE_WORKDIR


# =============================================================================
# Diagnostic Logging - Print config on startup
# =============================================================================

def _print_startup_diagnostics() -> None:
    """Print comprehensive diagnostic info at test startup."""
    # Local helper since _env_truthy is defined later in the file
    _truthy_vals = {"1", "true", "on", "yes"}
    def _is_truthy(name: str) -> bool:
        return os.environ.get(name, "").strip().lower() in _truthy_vals
    
    print("\n" + "=" * 80)
    print("PYTEST CONFTEST.PY - STARTUP DIAGNOSTICS")
    print("=" * 80)
    
    # Basic paths
    print("\n[PATHS]")
    print(f"  REPO_ROOT:        {REPO_ROOT}")
    print(f"  SUPABASE_WORKDIR: {SUPABASE_WORKDIR}")
    print(f"  ENV_PATH:         {ENV_PATH} (exists: {ENV_PATH.exists()})")
    print(f"  LOG_DIR:          {LOG_DIR} (exists: {LOG_DIR.exists()})")
    print(f"  Current dir:      {Path.cwd()}")
    
    # Feature flags
    print("\n[FEATURE FLAGS]")
    print(f"  USE_SUPABASE_TESTS:     {_is_truthy('USE_SUPABASE_TESTS')} (env: {os.environ.get('USE_SUPABASE_TESTS', '<not set>')})")
    print(f"  MANUAL_SUPABASE_STACK:  {_is_truthy('SUPABASE_MANUAL_STACK')} (env: {os.environ.get('SUPABASE_MANUAL_STACK', '<not set>')})")
    print(f"  SUPABASE_SKIP_START:    {_is_truthy('SUPABASE_SKIP_START')} (env: {os.environ.get('SUPABASE_SKIP_START', '<not set>')})")
    print(f"  SUPABASE_SKIP_DB_RESET: {_is_truthy('SUPABASE_SKIP_DB_RESET')} (env: {os.environ.get('SUPABASE_SKIP_DB_RESET', '<not set>')})")
    
    # Supabase environment
    print("\n[SUPABASE ENVIRONMENT]")
    print(f"  SUPABASE_URL:              {os.environ.get('SUPABASE_URL', '<not set>')}")
    print(f"  SUPABASE_ANON_KEY:         {'<set>' if os.environ.get('SUPABASE_ANON_KEY') else '<not set>'}")
    print(f"  SUPABASE_SERVICE_ROLE_KEY: {'<set>' if os.environ.get('SUPABASE_SERVICE_ROLE_KEY') else '<not set>'}")
    print(f"  EDGE_API_TOKEN:            {'<set>' if os.environ.get('EDGE_API_TOKEN') else '<not set>'}")
    print(f"  EDGE_FUNCTIONS_URL:        {os.environ.get('EDGE_FUNCTIONS_URL', '<not set>')}")
    
    # CLI detection
    print("\n[SUPABASE CLI]")
    cli_cmd = _resolve_supabase_cli_command()
    print(f"  Resolved CLI command: {cli_cmd}")
    print(f"  SUPABASE_CLI_COMMAND env: {os.environ.get('SUPABASE_CLI_COMMAND', '<not set>')}")
    print(f"  SUPABASE_CLI env:         {os.environ.get('SUPABASE_CLI', '<not set>')}")
    print(f"  'supabase' in PATH:       {which('supabase')}")
    print(f"  'npx' in PATH:            {which('npx')}")
    
    # Check if stack is running (without blocking)
    print("\n[STACK STATUS]")
    if cli_cmd:
        try:
            result = subprocess.run(
                [*cli_cmd, "--workdir", str(SUPABASE_WORKDIR), "status", "--output", "json"],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                timeout=10,
            )
            print(f"  supabase status exit code: {result.returncode}")
            if result.returncode == 0:
                print("  Stack is RUNNING")
            else:
                print("  Stack is NOT running or error occurred")
                if result.stderr:
                    print(f"  stderr: {result.stderr[:200]}...")
        except subprocess.TimeoutExpired:
            print("  supabase status TIMED OUT (>10s)")
        except Exception as e:
            print(f"  Error checking status: {e}")
    else:
        print("  No CLI available to check status")
    
    # .env.supabase contents (redacted)
    print("\n[.env.supabase FILE]")
    if ENV_PATH.exists():
        try:
            with ENV_PATH.open() as f:
                lines = f.readlines()
            print(f"  File exists with {len(lines)} lines")
            for line in lines[:10]:
                key = line.split("=")[0].strip() if "=" in line else line.strip()
                if key and not key.startswith("#"):
                    has_value = "=" in line and len(line.split("=", 1)[1].strip()) > 0
                    print(f"    {key}: {'<has value>' if has_value else '<empty>'}")
        except Exception as e:
            print(f"  Error reading file: {e}")
    else:
        print("  File does not exist")
    
    # Test timing config
    print("\n[TIMING CONFIG]")
    print("  pytest-timeout (pyproject.toml): 60s")
    print(f"  SUPABASE_START_TIMEOUT:   {os.environ.get('SUPABASE_START_TIMEOUT', '240')}s")
    poll_interval = float(os.environ.get('SUPABASE_POLL_INTERVAL_SECONDS', '1.0'))
    print(f"  SUPABASE_POLL_INTERVAL:   {poll_interval}s")
    print(f"  EVENT_DELIVERY_WAIT:      {poll_interval + 0.5 if _is_truthy('USE_SUPABASE_TESTS') else 1.0}s")
    
    # Docker check
    print("\n[DOCKER]")
    try:
        result = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            containers = [c for c in result.stdout.strip().split("\n") if c]
            supabase_containers = [c for c in containers if "supabase" in c.lower()]
            print(f"  Docker running: Yes ({len(containers)} containers)")
            print(f"  Supabase containers: {supabase_containers or 'None'}")
        else:
            print(f"  Docker not running or error: {result.stderr}")
    except Exception as e:
        print(f"  Docker check failed: {e}")
    
    print("\n" + "=" * 80)
    print("END STARTUP DIAGNOSTICS")
    print("=" * 80 + "\n")


# NOTE: _print_startup_diagnostics() is called later in the file after all dependencies are defined
from helpers.character_setup import register_all_test_characters
from helpers.supabase_features import missing_supabase_functions
from helpers.server_fixture import (
    start_test_server,
    stop_test_server,
    wait_for_server_ready,
)

from gradientbang.utils import api_client as _api_client_module
from gradientbang.scripts.compare_payloads import load_events as _load_dump_events, compare as _compare_event_lists

_TRUTHY = {"1", "true", "on", "yes"}

_CUSTOM_MARKERS = {
    "unit": "Unit tests (fast, no server needed)",
    "integration": "Integration tests (may need server)",
    "edge": "Edge function tests (direct Supabase function calls)",
    "requires_server": "Requires live server on port 8002",
    "stress": "Stress tests (slow, concurrent operations)",
    "requires_supabase_functions": "Skip when the named Supabase edge functions have not been implemented",
}


def _env_truthy(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in _TRUTHY


MANUAL_SUPABASE_STACK = _env_truthy("SUPABASE_MANUAL_STACK")


USE_SUPABASE_TESTS = _env_truthy("USE_SUPABASE_TESTS")
SUPABASE_BACKEND_ACTIVE = USE_SUPABASE_TESTS or bool(os.environ.get("SUPABASE_URL"))

# Supabase polling: events arrive every POLL_INTERVAL, so tests must wait longer
_POLL_INTERVAL = max(0.25, float(os.environ.get("SUPABASE_POLL_INTERVAL_SECONDS", "1.0")))
EVENT_DELIVERY_WAIT = _POLL_INTERVAL + 0.5 if USE_SUPABASE_TESTS else 1.0


def pytest_addoption(parser):
    """Register custom pytest command-line options."""
    parser.addoption(
        '--supabase-dir',
        action='store',
        default=None,
        help='Path to Supabase project directory (contains config.toml)',
    )


def pytest_configure(config):
    for name, description in _CUSTOM_MARKERS.items():
        config.addinivalue_line("markers", f"{name}: {description}")
    
    # Apply --supabase-dir to update the config module if provided
    supabase_dir = config.getoption('--supabase-dir', default=None)
    if supabase_dir:
        resolved_path = Path(supabase_dir).resolve()
        if not resolved_path.exists():
            raise ValueError(f'Supabase directory does not exist: {resolved_path}')
        
        print(f"\n[pytest] Using custom Supabase directory: {resolved_path}")
        
        # Update config module (single source of truth)
        import tests.config as test_config
        test_config.SUPABASE_WORKDIR = resolved_path
        
        # Also update edge conftest if it's loaded
        try:
            from tests.edge import conftest as edge_conftest
            edge_conftest.SUPABASE_WORKDIR = resolved_path
        except ImportError:
            # Edge conftest not loaded yet, that's fine
            pass


def _resolve_supabase_cli_command() -> Optional[List[str]]:
    """Resolve the Supabase CLI command, preferring npx to match README instructions."""
    # Explicit override takes priority
    cmd = os.environ.get("SUPABASE_CLI_COMMAND")
    if cmd:
        return shlex.split(cmd)

    path_override = os.environ.get("SUPABASE_CLI")
    if path_override:
        candidate = Path(path_override)
        if candidate.exists():
            return [str(candidate)]

    # Prefer npx (matches README) over local binary to avoid version mismatches
    if which("npx"):
        return ["npx", "supabase"]

    # Fallback to local binary if npx not available
    binary = which("supabase")
    if binary:
        return [binary]

    return None


SUPABASE_CLI_COMMAND = _resolve_supabase_cli_command() if USE_SUPABASE_TESTS else None

if USE_SUPABASE_TESTS:
    os.environ.setdefault("SUPABASE_ALLOW_LEGACY_IDS", "1")
    os.environ.setdefault("SUPABASE_TEST_MOVE_DELAY_SCALE", "0.1")
    from gradientbang.utils.supabase_client import AsyncGameClient as _SupabaseAsyncGameClient

    _api_client_module.AsyncGameClient = _SupabaseAsyncGameClient  # type: ignore[attr-defined]


# Run startup diagnostics now that all dependencies are defined
_print_startup_diagnostics()


def _load_supabase_env() -> Dict[str, str]:
    global _SUPABASE_ENV_CACHE
    if _SUPABASE_ENV_CACHE is not None:
        return _SUPABASE_ENV_CACHE

    # If using manual stack with cloud credentials, or env already points to supabase.co, use env vars directly
    if (MANUAL_SUPABASE_STACK or "supabase.co" in os.environ.get("SUPABASE_URL", "")) and all(
        os.environ.get(k) for k in ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]
    ):
        env_vars = {
            "SUPABASE_URL": os.environ["SUPABASE_URL"],
            "SUPABASE_ANON_KEY": os.environ["SUPABASE_ANON_KEY"],
            "SUPABASE_SERVICE_ROLE_KEY": os.environ["SUPABASE_SERVICE_ROLE_KEY"],
        }
        # Also include optional vars if present
        for optional_key in ["EDGE_API_TOKEN", "SUPABASE_API_TOKEN", "CHARACTER_JWT_SIGNING_KEY"]:
            if optional_key in os.environ:
                env_vars[optional_key] = os.environ[optional_key]

        if USE_SUPABASE_TESTS:
            env_vars["MOVE_DELAY_SCALE"] = os.environ.get("SUPABASE_TEST_MOVE_DELAY_SCALE", "1")
            os.environ.setdefault(
                "SUPABASE_EVENT_LOG_PATH",
                str((REPO_ROOT / "tests" / "test-world-data" / "event-log.jsonl").resolve()),
            )

        _SUPABASE_ENV_CACHE = env_vars
        ENV_EXPORTS.clear()
        ENV_EXPORTS.update(env_vars)
        return env_vars

    if not ENV_PATH.exists():
        raise RuntimeError(
            ".env.supabase is missing. Run `supabase start` once to generate it or copy an existing env file."
        )

    env_vars: Dict[str, str] = {}
    with ENV_PATH.open() as env_file:
        for line in env_file:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            env_vars[key] = value

    if USE_SUPABASE_TESTS:
        env_vars["MOVE_DELAY_SCALE"] = os.environ.get("SUPABASE_TEST_MOVE_DELAY_SCALE", "1")

    for key, value in env_vars.items():
        os.environ[key] = value

    if USE_SUPABASE_TESTS:
        os.environ.setdefault(
            "SUPABASE_EVENT_LOG_PATH",
            str((REPO_ROOT / "tests" / "test-world-data" / "event-log.jsonl").resolve()),
        )

    _SUPABASE_ENV_CACHE = env_vars
    ENV_EXPORTS.clear()
    ENV_EXPORTS.update(env_vars)
    return env_vars


def _run_supabase_cli(*args: str, timeout: float = 120.0) -> subprocess.CompletedProcess[str]:
    if SUPABASE_CLI_COMMAND is None:
        raise RuntimeError(
            "Supabase CLI is required for USE_SUPABASE_TESTS=1. Install the CLI or set SUPABASE_CLI_COMMAND."
        )

    # Run from repo root but pass --workdir to tell CLI where the Supabase project is
    # The --workdir flag goes before the subcommand: supabase --workdir path start
    cmd = [*SUPABASE_CLI_COMMAND, "--workdir", str(SUPABASE_WORKDIR), *args]
    print(f"[conftest] Running: {' '.join(cmd)} (timeout={timeout}s)")
    
    try:
        result = subprocess.run(
            cmd,
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        print(f"[conftest] Command completed with exit code {result.returncode}")
        if result.returncode != 0 and result.stderr:
            print(f"[conftest] stderr: {result.stderr[:500]}")
        return result
    except subprocess.TimeoutExpired as e:
        print(f"[conftest] TIMEOUT after {timeout}s running: {' '.join(cmd)}")
        print(f"[conftest] stdout so far: {e.stdout[:500] if e.stdout else '<none>'}")
        print(f"[conftest] stderr so far: {e.stderr[:500] if e.stderr else '<none>'}")
        # Return a failed result instead of raising
        return subprocess.CompletedProcess(
            args=cmd,
            returncode=124,  # timeout exit code
            stdout=str(e.stdout or ""),
            stderr=f"TIMEOUT after {timeout}s: {e.stderr or ''}",
        )


def _stack_running() -> bool:
    if SUPABASE_CLI_COMMAND is None:
        return False
    result = _run_supabase_cli("status", "--output", "json")
    return result.returncode == 0


def _start_supabase_stack() -> None:
    if SUPABASE_CLI_COMMAND is None:
        raise RuntimeError(
            "Supabase CLI is required for USE_SUPABASE_TESTS=1. Install the CLI or set SUPABASE_CLI_COMMAND."
        )

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_handle = SUPABASE_START_LOG.open("w", encoding="utf-8")

    proc = subprocess.Popen(  # noqa: S603
        [*SUPABASE_CLI_COMMAND, "--workdir", str(SUPABASE_WORKDIR), "start"],
        cwd=str(REPO_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    if not proc.stdout:
        proc.terminate()
        raise RuntimeError("Failed to capture supabase start output")

    ready_markers = {"API URL": False, "Studio URL": False}
    timeout = float(os.environ.get("SUPABASE_START_TIMEOUT", "240"))
    start_time = time.time()

    try:
        for line in proc.stdout:
            log_handle.write(line)
            for marker in ready_markers:
                if marker in line:
                    ready_markers[marker] = True
            if all(ready_markers.values()):
                break
            if time.time() - start_time > timeout:
                proc.terminate()
                raise RuntimeError("Timed out waiting for supabase start to finish. See logs/supabase-start.log")
    finally:
        log_handle.flush()

    proc.wait(timeout=60)
    log_handle.close()


def _stop_supabase_stack() -> None:
    if SUPABASE_CLI_COMMAND is None:
        return
    try:
        subprocess.run(
            [*SUPABASE_CLI_COMMAND, '--workdir', str(SUPABASE_WORKDIR), 'stop'],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        pass


def _db_container_name() -> str:
    """Derive the local Supabase Postgres container name from config.toml."""
    config_path = SUPABASE_WORKDIR / "supabase" / "config.toml"
    if not config_path.exists():
        config_path = SUPABASE_WORKDIR / "config.toml"
    project_id = "supabase"
    try:
        import tomllib

        with config_path.open("rb") as handle:
            cfg = tomllib.load(handle)
            project_id = cfg.get("project_id", project_id)
    except Exception:
        pass
    return f"supabase_db_{project_id}"


def _internal_supabase_url() -> str:
    """URL the DB container can reach the API; overridable for Linux bridge setups."""
    override = os.environ.get("SUPABASE_INTERNAL_URL")
    if override:
        return override.rstrip("/")
    url = os.environ.get("SUPABASE_URL")
    if not url and ENV_PATH.exists():
        try:
            with ENV_PATH.open() as env_file:
                for line in env_file:
                    if line.startswith("SUPABASE_URL="):
                        url = line.strip().split("=", 1)[1]
                        break
        except Exception:
            url = None
    url = (url or "http://127.0.0.1:54321").rstrip("/")
    # host.docker.internal works on macOS/Windows; Linux users can set SUPABASE_INTERNAL_URL.
    return url.replace("127.0.0.1", "host.docker.internal")


def _seed_combat_runtime_config() -> None:
    """Seed combat cron runtime config after a local db reset (no GUCs needed)."""
    # Skip cloud deployments
    if "supabase.co" in os.environ.get("SUPABASE_URL", ""):
        return

    token = os.environ.get("EDGE_API_TOKEN")
    if not token and ENV_PATH.exists():
        try:
            with ENV_PATH.open() as env_file:
                for line in env_file:
                    if line.startswith("EDGE_API_TOKEN="):
                        token = line.strip().split("=", 1)[1]
                        break
        except Exception:
            token = None
    token = token or "local-dev-token"
    api_url = _internal_supabase_url()
    container = _db_container_name()

    api_url_sql = api_url.replace("'", "''")
    token_sql = token.replace("'", "''")
    anon_sql = (os.environ.get("SUPABASE_ANON_KEY", "anon-key")).replace("'", "''")

    stmt = (
        "INSERT INTO app_runtime_config (key, value, description) VALUES "
        f"('supabase_url', '{api_url_sql}', 'Base Supabase URL reachable from the DB container'), "
        f"('edge_api_token', '{token_sql}', 'Edge token for combat_tick auth'), "
        f"('supabase_anon_key', '{anon_sql}', 'Anon key for Supabase auth headers') "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();"
    )

    cmd = [
        "docker",
        "exec",
        "-e",
        "PGPASSWORD=postgres",
        container,
        "psql",
        "-U",
        "supabase_admin",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        stmt,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)  # noqa: S603
    if result.returncode != 0:
        print(
            "[conftest] WARNING: Failed to seed app_runtime_config "
            f"(container={container}): {result.stderr.strip()}"
        )
        return

    print("[conftest] Seeded combat cron config for local stack")


def _ensure_supabase_stack_running() -> None:
    global _SUPABASE_STACK_READY
    print("\n[conftest] _ensure_supabase_stack_running() called")
    print(f"[conftest]   _SUPABASE_STACK_READY = {_SUPABASE_STACK_READY}")
    
    if _SUPABASE_STACK_READY:
        print("[conftest]   -> Already ready, returning early")
        return

    print(f"[conftest]   MANUAL_SUPABASE_STACK = {MANUAL_SUPABASE_STACK}")
    if MANUAL_SUPABASE_STACK:
        print("[conftest]   -> Using manual stack, calling _require_manual_stack_ready()")
        _require_manual_stack_ready()
        _SUPABASE_STACK_READY = True
        return

    supabase_url = os.environ.get("SUPABASE_URL", "")
    print(f"[conftest]   SUPABASE_URL = {supabase_url}")
    if "supabase.co" in supabase_url:
        print("[conftest]   -> Remote Supabase detected; skipping local stack start/reset")
        _SUPABASE_STACK_READY = True
        return

    skip_start = _env_truthy("SUPABASE_SKIP_START")
    print(f"[conftest]   SUPABASE_SKIP_START = {skip_start}")
    if skip_start:
        print("[conftest]   -> Skip start is set, returning")
        _SUPABASE_STACK_READY = True
        return

    stack_running = _stack_running()
    print(f"[conftest]   _stack_running() = {stack_running}")
    
    if stack_running:
        # Stack is running but may have stale database state - reset it
        skip_db_reset = _env_truthy("SUPABASE_SKIP_DB_RESET")
        print(f"[conftest]   SUPABASE_SKIP_DB_RESET = {skip_db_reset}")
        print(f"[conftest]   SUPABASE_CLI_COMMAND = {SUPABASE_CLI_COMMAND}")
        
        if SUPABASE_CLI_COMMAND and not skip_db_reset:
            print("\n[conftest] >>> About to reset database (this can take 30-60s)...")
            print("[conftest] >>> If this hangs, set SUPABASE_SKIP_DB_RESET=1 to skip")
            result = _run_supabase_cli("db", "reset", "--local", timeout=90.0)
            if result.returncode != 0:
                print(f"[conftest] WARNING: DB reset failed (code {result.returncode}): {result.stderr[:300]}")
                # Continue anyway - test_reset will attempt cleanup
            else:
                print("[conftest] DB reset completed successfully")
                _seed_combat_runtime_config()
        else:
            print(f"[conftest]   -> Skipping DB reset (skip_db_reset={skip_db_reset}, cli={SUPABASE_CLI_COMMAND is not None})")
        _SUPABASE_STACK_READY = True
        return

    print("[conftest]   -> Stack not running, starting it now...")
    _start_supabase_stack()
    # Newly started stack needs the combat cron config as well
    _seed_combat_runtime_config()
    _SUPABASE_STACK_READY = True
    print("[conftest]   -> Stack started and ready")


def _ensure_supabase_ready() -> Dict[str, str]:
    print("\n[conftest] _ensure_supabase_ready() called")
    print(f"[conftest]   USE_SUPABASE_TESTS = {USE_SUPABASE_TESTS}")
    
    if not USE_SUPABASE_TESTS:
        print("[conftest]   -> Supabase tests disabled, returning empty env")
        return {}

    print(f"[conftest] Preparing Supabase stack (Supabase directory: {SUPABASE_WORKDIR})")
    
    print("[conftest]   Step 1: Ensuring stack is running...")
    _ensure_supabase_stack_running()
    
    print("[conftest]   Step 2: Loading Supabase env...")
    env = _load_supabase_env()
    print(f"[conftest]   Loaded {len(env)} env vars")
    
    print("[conftest]   Step 3: Ensuring functions are served...")
    _ensure_functions_served_for_tests()
    
    global _SUPABASE_DB_BOOTSTRAPPED
    print(f"[conftest]   Step 4: Bootstrap check (_SUPABASE_DB_BOOTSTRAPPED = {_SUPABASE_DB_BOOTSTRAPPED})")
    if not _SUPABASE_DB_BOOTSTRAPPED:
        print("[conftest]   -> Calling test_reset edge function...")
        _invoke_test_reset_sync()
        _SUPABASE_DB_BOOTSTRAPPED = True
        print("[conftest]   -> Bootstrap complete")
    else:
        print("[conftest]   -> Already bootstrapped, skipping")
    
    print("[conftest] _ensure_supabase_ready() complete\n")
    return env


def _function_available(name: str) -> bool:
    api_token = (
        os.environ.get("EDGE_API_TOKEN")
        or os.environ.get("SUPABASE_API_TOKEN")
        or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    )
    base = os.environ.get("EDGE_FUNCTIONS_URL")
    if not base:
        supabase_url = os.environ.get("SUPABASE_URL", "http://127.0.0.1:54321").rstrip("/")
        base = f"{supabase_url}/functions/v1"
    
    try:
        resp = httpx.post(
            f"{base.rstrip('/')}/{name}",
            headers={
                "Content-Type": "application/json",
                "x-api-token": api_token,
            },
            json={"healthcheck": True},
            timeout=5.0,
        )
    except httpx.HTTPError:
        return False

    if resp.status_code >= 500:
        return False
    if resp.status_code == 404 and resp.text.strip() == "Function not found":
        return False
    try:
        payload = resp.json()
    except ValueError:
        return False
    return payload.get("status") == "ok"


def _cleanup_edge_container() -> None:
    container_name = os.environ.get("SUPABASE_EDGE_RUNTIME_CONTAINER", "supabase_edge_runtime_gb-supa")
    result = subprocess.run(  # noqa: S603
        ["docker", "rm", "-f", container_name],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 and "No such container" not in result.stderr:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_DIR / "edge-container-cleanup.log", "a", encoding="utf-8") as handle:
            handle.write(f"[pytest] docker rm -f {container_name} failed: {result.stderr}\n")


def _write_function_env() -> Path:
    allowed = {k: v for k, v in ENV_EXPORTS.items() if not k.startswith("SUPABASE_")}
    env_file = LOG_DIR / ".edge-env-integration"
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with env_file.open("w", encoding="utf-8") as handle:
        for key, value in allowed.items():
            handle.write(f"{key}={value}\n")
    return env_file


REQUIRED_FUNCTIONS = (
    "join",
    "my_status",
    "move",
    "local_map_region",
    "list_known_ports",
    "plot_course",
    "path_with_region",
    "trade",
    "transfer_credits",
    "bank_transfer",
    "recharge_warp_power",
    "transfer_warp_power",
    "dump_cargo",
    "purchase_fighters",
    "ship_purchase",
)


def _kill_zombie_function_processes() -> None:
    """Kill any zombie 'supabase functions serve' processes from previous runs.

    This prevents accumulation of zombie processes when pytest is interrupted
    or crashes without proper cleanup.
    """
    try:
        # Find all supabase functions serve processes
        result = subprocess.run(
            ["pgrep", "-f", "supabase.*functions.*serve"],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and result.stdout.strip():
            pids = result.stdout.strip().split("\n")
            print(f"\n[conftest] Found {len(pids)} zombie function serve process(es), cleaning up...")
            for pid in pids:
                try:
                    subprocess.run(["kill", "-9", pid], check=False)
                except Exception:
                    pass
    except Exception:
        # If cleanup fails, continue anyway - not critical
        pass


def _ensure_functions_served_for_tests() -> None:
    global FUNCTION_PROC
    if not USE_SUPABASE_TESTS:
        return

    # When pointing at a remote Supabase project, use deployed edge functions; skip local serve.
    if "supabase.co" in os.environ.get("SUPABASE_URL", ""):
        return

    if MANUAL_SUPABASE_STACK:
        _require_manual_stack_ready()
        return

    if SUPABASE_CLI_COMMAND is None:
        raise RuntimeError(
            "Supabase CLI is required for USE_SUPABASE_TESTS=1. Install it or set SUPABASE_CLI_COMMAND."
        )

    if FUNCTION_PROC:
        if all(_function_available(name) for name in REQUIRED_FUNCTIONS):
            return
        _stop_functions_proc()

    # Kill any zombie function serve processes from previous runs
    _kill_zombie_function_processes()

    _cleanup_edge_container()
    env_file = _write_function_env()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_handle = open(EDGE_FUNCTION_LOG, "a", buffering=1, encoding="utf-8")
    log_handle.write("[pytest] launching supabase functions serve (integration suite)\n")
    log_handle.write(f"[pytest] Supabase directory (--workdir): {SUPABASE_WORKDIR}\n")
    log_handle.write(f"[pytest] Functions directory: {SUPABASE_WORKDIR / 'supabase' / 'functions'}\n")
    log_handle.write(f"[pytest] Running from (cwd): {REPO_ROOT}\n")
    
    print("\n[conftest] Starting Supabase functions serve")
    print(f"[conftest] Supabase directory: {SUPABASE_WORKDIR}")
    print(f"[conftest] Running from: {REPO_ROOT}")
    
    # Check if functions directory exists and list functions
    # SUPABASE_WORKDIR points to parent (e.g., deployment), supabase/ is subdirectory
    functions_dir = SUPABASE_WORKDIR / "supabase" / "functions"
    if functions_dir.exists():
        function_names = [d.name for d in functions_dir.iterdir() if d.is_dir() and not d.name.startswith('_')]
        log_handle.write(f"[pytest] Found {len(function_names)} functions: {', '.join(function_names[:5])}{'...' if len(function_names) > 5 else ''}\n")
        print(f"[conftest] Found {len(function_names)} functions in {functions_dir}")
    else:
        log_handle.write(f"[pytest] WARNING: Functions directory does not exist: {functions_dir}\n")
        print(f"[conftest] WARNING: Functions directory missing: {functions_dir}")
    
    # Use --workdir for ALL Supabase CLI commands, run from repo root
    cmd = [*SUPABASE_CLI_COMMAND, "--workdir", str(SUPABASE_WORKDIR), "functions", "serve", "--env-file", str(env_file), "--no-verify-jwt"]
    
    log_handle.write(f"[pytest] Command: {' '.join(cmd)}\n")
    log_handle.write(f"[pytest] CWD: {REPO_ROOT}\n")
    log_handle.flush()
    print(f"[conftest] Command: {' '.join(cmd)}")
    
    proc = subprocess.Popen(  # noqa: S603
        cmd,
        cwd=str(REPO_ROOT),
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
    )
    FUNCTION_PROC = (proc, log_handle)

    deadline = time.time() + 120
    attempt = 0
    last_check_time = time.time()
    while time.time() < deadline:
        attempt += 1
        available = [name for name in REQUIRED_FUNCTIONS if _function_available(name)]
        
        # Log progress every 10 seconds
        if time.time() - last_check_time >= 10:
            log_handle.write(f"[pytest] Waiting for functions: {len(available)}/{len(REQUIRED_FUNCTIONS)} available\n")
            log_handle.write(f"[pytest] Available: {', '.join(available[:5])}{'...' if len(available) > 5 else ''}\n")
            missing = [name for name in REQUIRED_FUNCTIONS if name not in available]
            log_handle.write(f"[pytest] Missing: {', '.join(missing[:5])}{'...' if len(missing) > 5 else ''}\n")
            log_handle.flush()
            last_check_time = time.time()
        
        if all(_function_available(name) for name in REQUIRED_FUNCTIONS):
            log_handle.write(f"[pytest] All {len(REQUIRED_FUNCTIONS)} functions are now available!\n")
            log_handle.flush()
            return
        
        if proc.poll() is not None:
            raise RuntimeError(
                f"Supabase functions serve exited early. Inspect {EDGE_FUNCTION_LOG} for details."
            )
        time.sleep(1)

    _stop_functions_proc()
    raise RuntimeError(
        f"Supabase functions were not reachable within timeout. Inspect {EDGE_FUNCTION_LOG} for details."
    )


def _stop_functions_proc() -> None:
    global FUNCTION_PROC
    if FUNCTION_PROC is None:
        return
    proc, handle = FUNCTION_PROC
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
    handle.close()
    FUNCTION_PROC = None


def _invoke_edge_test_reset() -> None:
    """Call the test_reset edge function to seed test data.

    Starts with ZERO characters (matching Legacy behavior). Tests must explicitly create
    characters they need using create_test_character_knowledge() or reset_character_state().
    """
    import httpx

    edge_url = _edge_base_url()
    headers = _edge_request_headers()

    # Start with zero characters - tests will explicitly create what they need
    character_ids = []

    max_attempts = 6
    for attempt in range(1, max_attempts + 1):
        try:
            resp = httpx.post(
                f"{edge_url}/test_reset",
                headers=headers,
                json={"character_ids": character_ids},
                timeout=120.0,
            )
            resp.raise_for_status()
            payload = resp.json()
            if not payload.get("success"):
                raise RuntimeError(f"test_reset edge function failed: {payload}")
            return
        except Exception as exc:
            if attempt == max_attempts:
                raise RuntimeError(f"Failed to invoke test_reset edge function: {exc}") from exc
            # 2xx/4xx that aren't retryable will still break fast on last attempt
            time.sleep(2.0)


async def _reset_supabase_state_async() -> None:
    if _env_truthy("SUPABASE_SKIP_DB_RESET"):
        return

    loop = asyncio.get_running_loop()
    # Call test_reset edge function - if this fails, tests should fail
    await loop.run_in_executor(None, _invoke_edge_test_reset)


def _edge_base_url() -> str:
    edge_url = os.environ.get("EDGE_FUNCTIONS_URL")
    if edge_url:
        return edge_url.rstrip("/")
    supabase_url = os.environ.get("SUPABASE_URL")
    if not supabase_url:
        raise RuntimeError("EDGE_FUNCTIONS_URL or SUPABASE_URL must be set for Supabase tests")
    return f"{supabase_url.rstrip('/')}/functions/v1"


def _edge_request_headers() -> dict:
    anon = os.environ.get("SUPABASE_ANON_KEY", "anon-key")
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {anon}",
        "apikey": anon,
    }
    token = (
        os.environ.get("EDGE_API_TOKEN")
        or os.environ.get("SUPABASE_API_TOKEN")
        or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    )
    if token:
        headers["x-api-token"] = token
    return headers


def _require_manual_stack_ready() -> None:
    payload = _fetch_edge_health("join")
    if payload is None:
        raise RuntimeError(
            "Supabase join function is unreachable. When SUPABASE_MANUAL_STACK=1 run:\n"
            "  npx supabase start\n"
            "  curl -X POST -H 'Content-Type: application/json' -H 'x-api-token: $EDGE_API_TOKEN' -d '{}' "
            "${SUPABASE_URL:-http://127.0.0.1:54321}/functions/v1/test_reset\n"
            "  npx supabase functions serve --env-file .env.supabase --no-verify-jwt"
        )

    # Only check for EDGE_API_TOKEN when using local stack (not cloud deployments)
    supabase_url = os.environ.get("SUPABASE_URL", "")
    is_cloud = "supabase.co" in supabase_url
    if not is_cloud and not payload.get("token_present"):
        raise RuntimeError(
            "Edge functions are running without EDGE_API_TOKEN. Restart `supabase functions serve --env-file "
            ".env.supabase --no-verify-jwt`."
        )

    _invoke_test_reset_sync()


def _fetch_edge_health(function_name: str) -> Optional[Dict[str, object]]:
    headers = _edge_request_headers()
    try:
        resp = httpx.post(
            f"{_edge_base_url()}/{function_name}",
            headers=headers,
            json={"healthcheck": True},
            timeout=5.0,
        )
    except httpx.HTTPError:
        return None

    if resp.status_code >= 500:
        return None
    try:
        payload = resp.json()
    except ValueError:
        return None
    return payload if payload.get("status") == "ok" else None


def _invoke_test_reset_sync() -> None:
    """Call test_reset edge function - no fallbacks."""
    _invoke_edge_test_reset()

# Import AsyncGameClient for test reset calls (patched above when Supabase mode is enabled)
from gradientbang.utils.api_client import AsyncGameClient

logger = logging.getLogger(__name__)


@pytest.fixture(scope="session")
def supabase_environment(setup_test_characters):  # noqa: ARG001 - order dependency
    if not USE_SUPABASE_TESTS:
        yield {}
        return

    env = _ensure_supabase_ready()
    try:
        yield env
    finally:
        _stop_functions_proc()


async def trigger_combat_tick():
    """
    Manually trigger combat_tick endpoint to resolve combat rounds.

    In production, pg_cron handles this automatically. In local Docker development,
    pg_cron doesn't run continuously, so tests can call this helper when needed.

    Usage in tests:
        from conftest import trigger_combat_tick

        # Wait for combat deadline to pass
        await asyncio.sleep(16.0)

        # Manually trigger resolution
        await trigger_combat_tick()

        # Check for combat.round_resolved event
        resolved = await collector.wait_for_event("combat.round_resolved")
    """
    if not USE_SUPABASE_TESTS:
        return

    import httpx

    base_url = os.environ.get("SUPABASE_URL", "http://127.0.0.1:54321")
    api_token = os.environ.get("EDGE_API_TOKEN", "local-dev-token")
    tick_url = f"{base_url.rstrip('/')}/functions/v1/combat_tick"

    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(
                tick_url,
                headers={"x-api-token": api_token},
                json={},
                timeout=5.0,
            )
            if resp.status_code == 200:
                data = resp.json()
                logger.info(f"Combat tick: checked={data.get('checked', 0)}, resolved={data.get('resolved', 0)}")
                return data
            else:
                logger.warning(f"Combat tick returned {resp.status_code}")
                return None
        except Exception as e:
            logger.warning(f"Combat tick failed: {e}")
            return None


@pytest.fixture(scope="module", autouse=True)
def supabase_module_seed(setup_test_characters):  # noqa: ARG001
    if not USE_SUPABASE_TESTS:
        yield
        return

    _ensure_supabase_ready()
    _invoke_test_reset_sync()
    yield


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

    world_data_dir = Path("tests/test-world-data")
    corps_dir = world_data_dir / "corporations"
    if corps_dir.exists():
        for corp_file in corps_dir.glob("*.json"):
            corp_file.unlink()

    registry_path = world_data_dir / "corporation_registry.json"
    registry_payload = {"by_name": {}}
    registry_path.write_text(json.dumps(registry_payload, indent=2))

    yield
    # Cleanup handled by temp directory removal if needed


@pytest.fixture(scope="session")
def server_url(supabase_environment, setup_test_characters):  # noqa: ARG001 - fixture ensures Supabase readiness
    """
    Provide the test server URL.

    Returns:
        str: The base URL for the test server (http://localhost:8002)
    """
    if USE_SUPABASE_TESTS:
        supabase_url = supabase_environment.get("SUPABASE_URL") or os.environ.get("SUPABASE_URL")
        if not supabase_url:
            pytest.skip("Set SUPABASE_URL when USE_SUPABASE_TESTS=1 to run integration tests against Supabase.")
        return supabase_url.rstrip("/")

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
    if USE_SUPABASE_TESTS:
        edge_base = os.environ.get("EDGE_FUNCTIONS_URL", f"{server_url.rstrip('/')}/functions/v1")
        anon_key = os.environ.get("SUPABASE_ANON_KEY", "anon-key")
        token = (
            os.environ.get("EDGE_API_TOKEN")
            or os.environ.get("SUPABASE_API_TOKEN")
            or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        )
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {anon_key}",
            "apikey": anon_key,
        }
        if token:
            headers["x-api-token"] = token

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{edge_base}/join",
                    headers=headers,
                    json={"healthcheck": True},
                    timeout=3.0,
                )
        except (httpx.ConnectError, httpx.TimeoutException):
            pytest.skip(
                "Supabase functions endpoint not reachable. Run `supabase start` and export EDGE_API_TOKEN."
            )
        if response.status_code != 200:
            pytest.skip(
                f"Supabase join function unhealthy ({response.status_code}). Check Supabase stack logs before running tests."
            )
        yield
        return

    try:
        async with httpx.AsyncClient() as client:
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


# ---------------------------------------------------------------------------
# Payload parity fixture (legacy vs Supabase event comparison)
# ---------------------------------------------------------------------------

class _EventCapture(contextlib.AbstractContextManager["_EventCapture"]):
    def __init__(self):
        self.events: List[Dict[str, Any]] = []
        self._orig = None

    def __enter__(self):  # noqa: D401
        from gradientbang.utils import api_client as legacy_api_client  # local import to avoid cycles

        self._orig = legacy_api_client.LegacyAsyncGameClient._deliver_event

        def patched(instance, event_name: str, event_message: Dict[str, Any]) -> None:
            serialized = json.loads(json.dumps(event_message, default=_json_default))
            self.events.append({
                "event_name": event_name,
                "payload": serialized.get("payload"),
                "summary": serialized.get("summary"),
            })
            return self._orig(instance, event_name, event_message)

        legacy_api_client.LegacyAsyncGameClient._deliver_event = patched  # type: ignore[assignment]
        return self

    def __exit__(self, exc_type, exc, tb) -> None:  # noqa: D401
        if self._orig is not None:
            from gradientbang.utils import api_client as legacy_api_client

            legacy_api_client.LegacyAsyncGameClient._deliver_event = self._orig  # type: ignore[assignment]


def _json_default(value: Any) -> Any:
    if isinstance(value, (datetime, timezone)):
        return value.isoformat()
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:  # pragma: no cover - best effort
            return str(value)
    return value


def _sanitize_nodeid(nodeid: str) -> str:
    sanitized = [ch if ch.isalnum() else "_" for ch in nodeid]
    return "".join(sanitized).strip("_") or "test"


def _env_truthy(var: str) -> bool:
    value = os.getenv(var)
    return value is not None and value.strip().lower() in _TRUTHY


def _write_event_dump(path: Path, events: List[Dict[str, Any]], mode: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    def _event_sort_key(event: Dict[str, Any]) -> tuple[int, int]:
        context = event.get("payload", {}).get("__event_context", {})
        event_id = context.get("event_id")
        if isinstance(event_id, int):
            return (event_id, 0)
        return (10**12, 0)

    ordered_events = events
    if mode == "supabase":
        ordered_events = sorted(events, key=_event_sort_key)

    with path.open("w", encoding="utf-8") as handle:
        meta = {
            "record_type": "meta",
            "mode": mode,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        handle.write(json.dumps(meta) + "\n")
        for index, event in enumerate(ordered_events):
            handle.write(json.dumps({"record_type": "event", "index": index, "event": event}) + "\n")


def _run_baseline_capture(nodeid: str, baseline_path: Path) -> None:
    env = os.environ.copy()
    env.pop("USE_SUPABASE_TESTS", None)
    env.pop("SUPABASE_TRANSPORT", None)
    env["PAYLOAD_BASELINE_RUN"] = "1"
    env["PAYLOAD_BASELINE_PATH"] = str(baseline_path)
    env["ASYNC_CLIENT_PAYLOAD_DUMP"] = str(baseline_path)
    result = subprocess.run(
        ["uv", "run", "pytest", "-q", nodeid],
        env=env,
        cwd=str(REPO_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Baseline capture for {nodeid} failed:\n{result.stdout}"
        )


@pytest.fixture
def payload_parity(request):
    nodeid = request.node.nodeid
    baseline_mode = os.getenv("PAYLOAD_BASELINE_RUN") == "1"
    supabase_mode = _env_truthy("USE_SUPABASE_TESTS")

    if not baseline_mode and not supabase_mode:
        yield
        return

    slug = _sanitize_nodeid(nodeid)
    base_dir = LOG_DIR / "payload-parity-inline" / slug
    base_dir.mkdir(parents=True, exist_ok=True)
    baseline_path = base_dir / "legacy.jsonl"
    sup_path = base_dir / f"supabase_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}Z.jsonl"

    with _EventCapture() as capture:
        if baseline_mode:
            yield
            target = Path(os.getenv("PAYLOAD_BASELINE_PATH", baseline_path))
            _write_event_dump(target, capture.events, mode="legacy")
            return

        if not baseline_path.exists():
            _run_baseline_capture(nodeid, baseline_path)

        yield

        _write_event_dump(sup_path, capture.events, mode="supabase")
        legacy_events = _load_dump_events(baseline_path)
        diffs = _compare_event_lists(legacy_events, capture.events)
        if diffs:
            raise AssertionError(
                "\n".join([f"Payload parity mismatch for {nodeid}:"] + diffs)
            )
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
    if USE_SUPABASE_TESTS:
        # Supabase stack is managed outside pytest (supabase start)
        yield server_url
        return

    # Start the server
    process = start_test_server(port=8002, world_data_dir="tests/test-world-data")

    try:
        # Wait for server to be ready (pass process for better error messages)
        await wait_for_server_ready(server_url, timeout=30.0, process=process)

        # Provide the server URL to tests
        yield server_url

    finally:
        # Stop the server after tests complete
        stop_test_server(process, timeout=5.0)


@pytest.fixture(scope="module", autouse=True)
def monitor_module_resources(request):
    """Monitor resource usage per test module to identify leaks and exhaustion."""
    if not USE_SUPABASE_TESTS:
        yield
        return

    try:
        from tests.helpers.resource_monitor import get_monitor, log_resource_summary
    except ImportError:
        logger.debug("Resource monitor not available, skipping")
        yield
        return

    monitor = get_monitor()
    module_name = request.module.__name__.replace("tests.integration.", "")

    # Set baseline on first module
    if monitor.baseline is None:
        monitor.set_baseline()

    # Log stats before module
    logger.info(f"[{module_name}] Module starting")
    log_resource_summary(monitor, prefix=f"[{module_name}] BEFORE: ")

    yield  # Run all tests in the module

    # Log stats after module
    log_resource_summary(monitor, prefix=f"[{module_name}] AFTER:  ")

    # Check for resource leaks
    stats = monitor.get_stats()
    warnings = monitor.check_thresholds(stats)
    if warnings:
        logger.warning(f"[{module_name}] Resource issues detected - may cause subsequent test failures")


@pytest.fixture(scope="module", autouse=True)
def cleanup_zombie_processes(request):
    """Kill zombie function serve processes between modules.

    Zombie processes can accumulate during long test runs and hold database
    connections and other resources, causing subsequent tests to fail.
    """
    if not USE_SUPABASE_TESTS:
        yield
        return

    module_name = request.module.__name__.replace("tests.integration.", "")

    yield  # Run all tests in the module

    # After module completes: check for and kill zombie processes
    try:
        import psutil

        result = subprocess.run(
            ['pgrep', '-f', 'supabase functions serve'],
            capture_output=True,
            text=True,
            check=False
        )

        if result.returncode == 0 and result.stdout.strip():
            pids = result.stdout.strip().split('\n')
            zombies_killed = 0

            for pid_str in pids:
                try:
                    pid = int(pid_str)
                    proc = psutil.Process(pid)
                    age_seconds = time.time() - proc.create_time()

                    # Kill processes older than 2 minutes (likely from previous test runs)
                    # Active test function serve processes should be much younger
                    if age_seconds > 120:
                        logger.warning(
                            f"[{module_name}] Killing zombie function serve process "
                            f"{pid} (age: {age_seconds:.0f}s)"
                        )
                        proc.kill()
                        try:
                            proc.wait(timeout=5)
                            zombies_killed += 1
                        except psutil.TimeoutExpired:
                            # Force kill if needed
                            proc.kill()
                            zombies_killed += 1
                except (psutil.NoSuchProcess, ValueError, psutil.AccessDenied):
                    pass

            if zombies_killed > 0:
                logger.info(f"[{module_name}] Cleaned up {zombies_killed} zombie process(es)")

    except ImportError:
        logger.debug("psutil not available, skipping zombie process cleanup")
    except Exception as e:
        logger.debug(f"Failed to cleanup zombie processes: {e}")


@pytest.fixture(autouse=True)
async def reset_test_state(server_url, supabase_environment):  # noqa: ARG001 - fixture ensures Supabase readiness
    """
    Reset server state between tests for proper isolation.

    Supabase mode:
        - Reset BEFORE each test via the edge test_reset RPC (preferred) or fallback helper.
        - Skip the post-test reset when the pre-test reset succeeds to avoid redundant truncations.
    FastAPI mode:
        - Reset after each test via the legacy test.reset endpoint (matches previous behavior).
    """
    supabase_reset_ok = False

    if USE_SUPABASE_TESTS:
        _ensure_supabase_ready()
        try:
            await _reset_supabase_state_async()
            supabase_reset_ok = True
        except Exception as exc:  # noqa: BLE001
            logger.warning("Supabase reset failed before test: %s", exc)
    else:
        # For FastAPI, we still rely on the server-side reset after tests to clean disk artifacts.
        pass

    yield  # Run the test

    if USE_SUPABASE_TESTS:
        if supabase_reset_ok:
            return  # next test will trigger another reset
        _ensure_supabase_ready()
        try:
            await _reset_supabase_state_async()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Supabase reset failed after test: %s", exc)
        return

    # FastAPI/server mode: reset after each test (unchanged from previous behavior)
    try:
        client = AsyncGameClient(base_url=server_url, character_id="test_reset_runner")
        result = await client._request(
            "test.reset",
            {
                "clear_files": True,
                "file_prefixes": ["test_", "weak_", "strong_", "player", "push_"],
            },
        )
        logger.info(
            "Test reset completed: %s characters, %s combats, %s files deleted, %s ports reset",
            result["cleared_characters"],
            result["cleared_combats"],
            result["deleted_files"],
            result.get("ports_reset", 0),
        )
        await client.close()
    except Exception as e:  # noqa: BLE001
        logger.debug("Test reset skipped or failed: %s", e)


def pytest_collection_modifyitems(config, items):
    if not SUPABASE_BACKEND_ACTIVE:
        return

    for item in items:
        marker = item.get_closest_marker("requires_supabase_functions")
        if not marker:
            continue

        required = list(marker.args)
        required.extend(marker.kwargs.get("names", []))
        if not required:
            continue

        missing = missing_supabase_functions(tuple(required))
        if missing:
            reason = "Missing Supabase functions: " + ", ".join(sorted(missing))
            item.add_marker(pytest.mark.skip(reason=reason))