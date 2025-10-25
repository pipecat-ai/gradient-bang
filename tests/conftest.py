"""Pytest configuration that stubs optional third-party deps for unit tests."""

from __future__ import annotations

import asyncio
import sys
import types
from enum import Enum
from pathlib import Path
from typing import Any, Awaitable, Callable, List, Optional

# Add game-server directory to Python path for unit tests
_project_root = Path(__file__).parent.parent
_game_server_path = _project_root / "game-server"
if str(_game_server_path) not in sys.path:
    sys.path.insert(0, str(_game_server_path))


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
