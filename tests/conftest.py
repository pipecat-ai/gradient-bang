"""Pytest configuration that stubs optional third-party deps for unit tests."""

from __future__ import annotations

import asyncio
import logging
import os
import shlex
import subprocess
import sys
import time
import types
from enum import Enum
from pathlib import Path
from shutil import which
from typing import Any, Awaitable, Callable, Dict, List, Optional

# Add project root to Python path for utils module
_project_root = Path(__file__).parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

REPO_ROOT = _project_root
LOG_DIR = REPO_ROOT / "logs"
ENV_PATH = REPO_ROOT / ".env.supabase"
SUPABASE_START_LOG = LOG_DIR / "supabase-start.log"
EDGE_FUNCTION_LOG = LOG_DIR / "supabase-functions.log"
_SUPABASE_ENV_CACHE: Optional[Dict[str, str]] = None
_SUPABASE_STACK_READY = False
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

import httpx
import pytest
from helpers.character_setup import register_all_test_characters
from helpers.server_fixture import (
    start_test_server,
    stop_test_server,
    wait_for_server_ready,
)

from utils import api_client as _api_client_module

_TRUTHY = {"1", "true", "on", "yes"}


def _env_truthy(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in _TRUTHY


USE_SUPABASE_TESTS = _env_truthy("USE_SUPABASE_TESTS")


def _resolve_supabase_cli_command() -> Optional[List[str]]:
    cmd = os.environ.get("SUPABASE_CLI_COMMAND")
    if cmd:
        return shlex.split(cmd)

    path_override = os.environ.get("SUPABASE_CLI")
    if path_override:
        candidate = Path(path_override)
        if candidate.exists():
            return [str(candidate)]

    binary = which("supabase")
    if binary:
        return [binary]

    if which("npx"):
        return ["npx", "supabase@latest"]

    return None


SUPABASE_CLI_COMMAND = _resolve_supabase_cli_command() if USE_SUPABASE_TESTS else None

if USE_SUPABASE_TESTS:
    os.environ.setdefault("SUPABASE_ALLOW_LEGACY_IDS", "1")
    os.environ.setdefault("SUPABASE_TEST_MOVE_DELAY_SCALE", "0.1")
    from utils.supabase_client import AsyncGameClient as _SupabaseAsyncGameClient

    _api_client_module.AsyncGameClient = _SupabaseAsyncGameClient  # type: ignore[attr-defined]


def _load_supabase_env() -> Dict[str, str]:
    global _SUPABASE_ENV_CACHE
    if _SUPABASE_ENV_CACHE is not None:
        return _SUPABASE_ENV_CACHE

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

    _SUPABASE_ENV_CACHE = env_vars
    ENV_EXPORTS.clear()
    ENV_EXPORTS.update(env_vars)
    return env_vars


def _run_supabase_cli(*args: str) -> subprocess.CompletedProcess[str]:
    if SUPABASE_CLI_COMMAND is None:
        raise RuntimeError(
            "Supabase CLI is required for USE_SUPABASE_TESTS=1. Install the CLI or set SUPABASE_CLI_COMMAND."
        )

    return subprocess.run(
        [*SUPABASE_CLI_COMMAND, *args],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
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
        [*SUPABASE_CLI_COMMAND, "start"],
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


def _ensure_supabase_stack_running() -> None:
    global _SUPABASE_STACK_READY
    if _SUPABASE_STACK_READY:
        return

    if _env_truthy("SUPABASE_SKIP_START"):
        _SUPABASE_STACK_READY = True
        return

    if _stack_running():
        _SUPABASE_STACK_READY = True
        return

    _start_supabase_stack()
    _SUPABASE_STACK_READY = True


def _ensure_supabase_ready() -> Dict[str, str]:
    if not USE_SUPABASE_TESTS:
        return {}

    _ensure_supabase_stack_running()
    env = _load_supabase_env()
    _run_supabase_db_reset()
    _ensure_functions_served_for_tests()
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


def _ensure_functions_served_for_tests() -> None:
    global FUNCTION_PROC
    if not USE_SUPABASE_TESTS:
        return

    if SUPABASE_CLI_COMMAND is None:
        raise RuntimeError(
            "Supabase CLI is required for USE_SUPABASE_TESTS=1. Install it or set SUPABASE_CLI_COMMAND."
        )

    if FUNCTION_PROC:
        if all(_function_available(name) for name in REQUIRED_FUNCTIONS):
            return
        _stop_functions_proc()

    _cleanup_edge_container()
    env_file = _write_function_env()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_handle = open(EDGE_FUNCTION_LOG, "a", buffering=1, encoding="utf-8")
    log_handle.write("[pytest] launching supabase functions serve (integration suite)\n")

    cmd = [*SUPABASE_CLI_COMMAND, "functions", "serve", "--env-file", str(env_file), "--no-verify-jwt"]
    proc = subprocess.Popen(  # noqa: S603
        cmd,
        cwd=str(REPO_ROOT),
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
    )
    FUNCTION_PROC = (proc, log_handle)

    deadline = time.time() + 120
    while time.time() < deadline:
        if all(_function_available(name) for name in REQUIRED_FUNCTIONS):
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


def _run_supabase_db_reset() -> None:
    if _env_truthy("SUPABASE_SKIP_DB_RESET"):
        return

    if SUPABASE_CLI_COMMAND is None:
        raise RuntimeError(
            "Supabase CLI is required for USE_SUPABASE_TESTS=1. Install the CLI or set SUPABASE_CLI_COMMAND."
        )

    cmd = [*SUPABASE_CLI_COMMAND, "--yes", "db", "reset"]
    result = subprocess.run(
        cmd,
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError(
            "supabase db reset failed:\n"
            f"STDOUT: {result.stdout}\nSTDERR: {result.stderr or '<empty>'}"
        )


async def _reset_supabase_state_async() -> None:
    if _env_truthy("SUPABASE_SKIP_DB_RESET"):
        return

    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, _run_supabase_db_reset)

# Import AsyncGameClient for test reset calls (patched above when Supabase mode is enabled)
from utils.api_client import AsyncGameClient

logger = logging.getLogger(__name__)


@pytest.fixture(scope="session")
def supabase_environment():
    if not USE_SUPABASE_TESTS:
        yield {}
        return

    env = _ensure_supabase_ready()
    try:
        yield env
    finally:
        _stop_functions_proc()


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
def server_url(supabase_environment):  # noqa: ARG001 - fixture ensures Supabase readiness
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


@pytest.fixture(autouse=True)
async def reset_test_state(server_url, supabase_environment):  # noqa: ARG001 - fixture ensures Supabase readiness
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

    if USE_SUPABASE_TESTS:
        _ensure_supabase_ready()
        try:
            await _reset_supabase_state_async()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Supabase reset failed: %s", exc)
        return

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
