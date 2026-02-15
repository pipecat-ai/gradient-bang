"""
Flexible LLM service factory for Pipecat pipelines.

Supports Google, Anthropic, OpenAI, and Nemotron (vLLM/OpenAI-compatible)
models with environment-based configuration.

Environment Variables:
    # Voice LLM (bot.py pipeline - typically no thinking mode)
    VOICE_LLM_PROVIDER: google, anthropic, openai, nemotron (default: google)
    VOICE_LLM_MODEL: Model name (default: gemini-2.5-flash)
    VOICE_LLM_FUNCTION_CALL_TIMEOUT_SECS: Tool call timeout in seconds (default: 20)

    # Task Agent LLM (TaskAgent - with thinking mode)
    TASK_LLM_PROVIDER: google, anthropic, openai, nemotron (default: google)
    TASK_LLM_MODEL: Model name (default: gemini-2.5-flash-preview-09-2025)
    TASK_LLM_THINKING_BUDGET: Token budget for thinking (default: 2048)
    TASK_LLM_FUNCTION_CALL_TIMEOUT_SECS: Tool call timeout in seconds (default: 20)

    # UI Agent LLM (UI agent branch - lightweight, no thinking by default)
    UI_AGENT_LLM_PROVIDER: google, anthropic, openai, nemotron (default: google)
    UI_AGENT_LLM_MODEL: Model name (default: gemini-2.5-flash)
    UI_AGENT_LLM_THINKING_BUDGET: Token budget for thinking (default: 0)

    # API keys (used based on provider)
    GOOGLE_API_KEY
    ANTHROPIC_API_KEY
    OPENAI_API_KEY
    NEMOTRON_API_KEY (optional; defaults to "empty")
    OPENAI_BASE_URL (optional, OpenAI provider)
    NEMOTRON_BASE_URL (optional, Nemotron provider)
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid
from dataclasses import dataclass
from enum import Enum
from typing import Any, Optional

from loguru import logger
from openai import APITimeoutError
from pipecat.services.llm_service import LLMService


class LLMProvider(Enum):
    """Supported LLM providers."""

    GOOGLE = "google"
    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    NEMOTRON = "nemotron"


def _env_flag(name: str, default: bool = False) -> bool:
    """Parse truthy/falsey environment flags."""
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class UnifiedThinkingConfig:
    """Provider-agnostic thinking configuration.

    Attributes:
        enabled: Whether thinking mode is enabled.
        budget_tokens: Token budget for thinking. For Anthropic, minimum is 1024.
        include_thoughts: Whether to include thought summaries in response (Google-specific).
    """

    enabled: bool = True
    budget_tokens: int = 2048
    include_thoughts: bool = True  # Always True for task LLMs


@dataclass
class LLMServiceConfig:
    """Configuration for creating an LLM service.

    Attributes:
        provider: The LLM provider (Google, Anthropic, OpenAI, or Nemotron).
        model: The model name to use.
        api_key: Optional API key override (defaults to environment variable).
        thinking: Optional thinking configuration for task agents.
        function_call_timeout_secs: Optional tool call timeout override.
        run_in_parallel: Optional override for LLMService._run_in_parallel.
            When False, function calls are dispatched sequentially.
        cache_system_prompt: When True (Anthropic only), add cache_control to
            the system parameter. Useful for agents that rebuild contexts fresh
            each call but keep the same system prompt.
    """

    provider: LLMProvider
    model: str
    api_key: Optional[str] = None
    thinking: Optional[UnifiedThinkingConfig] = None
    function_call_timeout_secs: Optional[float] = None
    run_in_parallel: Optional[bool] = None
    cache_system_prompt: bool = False


def _get_api_key(provider: LLMProvider, override: Optional[str] = None) -> str:
    """Get API key for provider from environment or override.

    Args:
        provider: The LLM provider.
        override: Optional explicit API key.

    Returns:
        The API key string.

    Raises:
        ValueError: If no API key is available.
    """
    if override:
        return override

    if provider == LLMProvider.NEMOTRON:
        # Most local vLLM deployments don't enforce OpenAI keys; keep this
        # non-blocking by defaulting to a dummy string when not configured.
        nemotron_key = os.getenv("NEMOTRON_API_KEY")
        if isinstance(nemotron_key, str) and nemotron_key.strip():
            return nemotron_key.strip()
        return "empty"

    env_var_map = {
        LLMProvider.GOOGLE: "GOOGLE_API_KEY",
        LLMProvider.ANTHROPIC: "ANTHROPIC_API_KEY",
        LLMProvider.OPENAI: "OPENAI_API_KEY",
    }

    env_var = env_var_map[provider]
    api_key = os.getenv(env_var)

    if not api_key:
        raise ValueError(
            f"{provider.value.capitalize()} API key required. Set {env_var} environment variable."
        )

    return api_key


def create_llm_service(config: LLMServiceConfig) -> LLMService:
    """Create appropriate Pipecat LLM service based on config.

    Args:
        config: LLM service configuration.

    Returns:
        A Pipecat LLMService instance for the specified provider.

    Raises:
        ValueError: If API key is not available or provider is unsupported.
    """
    api_key = _get_api_key(config.provider, config.api_key)

    if config.provider == LLMProvider.GOOGLE:
        service = _create_google_service(
            api_key,
            config.model,
            config.thinking,
            config.function_call_timeout_secs,
        )
    elif config.provider == LLMProvider.ANTHROPIC:
        service = _create_anthropic_service(
            api_key,
            config.model,
            config.thinking,
            config.function_call_timeout_secs,
            cache_system_prompt=config.cache_system_prompt,
        )
    elif config.provider == LLMProvider.OPENAI:
        service = _create_openai_service(
            api_key,
            config.model,
            config.thinking,
            config.function_call_timeout_secs,
        )
    elif config.provider == LLMProvider.NEMOTRON:
        service = _create_nemotron_service(
            api_key,
            config.model,
            config.thinking,
            config.function_call_timeout_secs,
        )
    else:
        raise ValueError(f"Unsupported provider: {config.provider}")

    if config.run_in_parallel is not None:
        service._run_in_parallel = config.run_in_parallel

    return service


def _create_google_service(
    api_key: str,
    model: str,
    thinking: Optional[UnifiedThinkingConfig],
    function_call_timeout_secs: Optional[float] = None,
) -> LLMService:
    """Create Google (Gemini) LLM service."""
    from pipecat.services.google.llm import GoogleLLMService

    params = None
    if thinking and thinking.enabled:
        params = GoogleLLMService.InputParams(
            thinking=GoogleLLMService.ThinkingConfig(
                thinking_budget=thinking.budget_tokens,
                include_thoughts=thinking.include_thoughts,
            )
        )

    llm_kwargs = {}
    if function_call_timeout_secs is not None:
        llm_kwargs["function_call_timeout_secs"] = function_call_timeout_secs

    return GoogleLLMService(
        api_key=api_key,
        model=model,
        params=params,
        **llm_kwargs,
    )


def _create_anthropic_service(
    api_key: str,
    model: str,
    thinking: Optional[UnifiedThinkingConfig],
    function_call_timeout_secs: Optional[float] = None,
    *,
    cache_system_prompt: bool = False,
) -> LLMService:
    """Create Anthropic (Claude) LLM service."""
    from pipecat.services.anthropic.llm import AnthropicLLMService

    params_kwargs: dict = {"enable_prompt_caching": True}
    if thinking and thinking.enabled:
        # Anthropic requires minimum 1024 tokens for thinking budget
        budget = max(1024, thinking.budget_tokens)
        params_kwargs["thinking"] = AnthropicLLMService.ThinkingConfig(
            type="enabled",
            budget_tokens=budget,
        )

    params = AnthropicLLMService.InputParams(**params_kwargs)

    llm_kwargs = {}
    if function_call_timeout_secs is not None:
        llm_kwargs["function_call_timeout_secs"] = function_call_timeout_secs

    service_cls = AnthropicLLMService
    if cache_system_prompt:
        service_cls = _get_system_cached_anthropic_cls()

    return service_cls(
        api_key=api_key,
        model=model,
        params=params,
        **llm_kwargs,
    )


def _get_system_cached_anthropic_cls():
    """Return an AnthropicLLMService subclass that caches the system prompt.

    The base adapter only adds cache_control markers to user messages, which
    doesn't help when contexts are rebuilt fresh each call (like the UI agent).
    This subclass adds a cache_control marker to the system parameter so the
    stable system prompt is cached across calls.
    """
    import copy

    from anthropic import NOT_GIVEN
    from pipecat.services.anthropic.llm import AnthropicLLMService

    class _SystemCachedAnthropicLLMService(AnthropicLLMService):
        def _get_llm_invocation_params(self, context):
            params = super()._get_llm_invocation_params(context)
            system = params.get("system")
            if system is NOT_GIVEN or not system:
                return params
            if isinstance(system, str):
                params["system"] = [
                    {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}
                ]
            elif isinstance(system, list):
                system = copy.deepcopy(system)
                system[-1]["cache_control"] = {"type": "ephemeral"}
                params["system"] = system
            return params

    return _SystemCachedAnthropicLLMService


def _create_openai_service(
    api_key: str,
    model: str,
    thinking: Optional[UnifiedThinkingConfig],
    function_call_timeout_secs: Optional[float] = None,
) -> LLMService:
    """Create OpenAI LLM service.

    Note: OpenAI does not support thinking mode in the same way as Google/Anthropic.
    If thinking is enabled, a warning is logged and the service proceeds without it.
    """
    from pipecat.services.openai.llm import OpenAILLMService

    if thinking and thinking.enabled:
        logger.warning(
            f"OpenAI does not support thinking mode. Proceeding without thinking for model {model}."
        )

    llm_kwargs = {}
    if function_call_timeout_secs is not None:
        llm_kwargs["function_call_timeout_secs"] = function_call_timeout_secs

    return OpenAILLMService(
        api_key=api_key,
        model=model,
        **llm_kwargs,
    )


def _get_nemotron_openai_cls():
    """Return an OpenAILLMService subclass with Nemotron-specific request params.

    Nemotron via vLLM uses OpenAI-compatible chat completions but expects
    `chat_template_kwargs.enable_thinking` in the request body.
    """
    from pipecat.services.openai.llm import OpenAILLMService

    class _NemotronOpenAILLMService(OpenAILLMService):
        _TAG_START_CHAR_RE = re.compile(r"[A-Za-z/!?]")

        def __init__(self, *, enable_thinking: bool = False, **kwargs):
            self._enable_thinking = bool(enable_thinking)
            self._log_request_response = _env_flag("NEMOTRON_LOG_REQUEST_RESPONSE")
            self._strip_xml_output = _env_flag("NEMOTRON_STRIP_XML_OUTPUT", default=True)
            self._xml_filter_tail = ""
            if self._log_request_response:
                logger.warning("Nemotron request/response logging enabled")
            super().__init__(**kwargs)

        def _strip_xml_like_tags(self, text: str) -> str:
            """Strip XML/HTML-like tags from streamed text content.

            Stateful across chunks so tags split over chunk boundaries are removed.
            """
            if not text:
                return text

            buffer = f"{self._xml_filter_tail}{text}"
            self._xml_filter_tail = ""

            output_parts: list[str] = []
            i = 0
            n = len(buffer)

            while i < n:
                lt = buffer.find("<", i)
                if lt == -1:
                    output_parts.append(buffer[i:])
                    break

                # Keep text before potential tag.
                if lt > i:
                    output_parts.append(buffer[i:lt])

                # Incomplete "<" at end of chunk: hold for next chunk.
                if lt + 1 >= n:
                    self._xml_filter_tail = buffer[lt:]
                    break

                next_char = buffer[lt + 1]
                if not self._TAG_START_CHAR_RE.match(next_char):
                    # Not a tag start; keep literal '<' and continue.
                    output_parts.append("<")
                    i = lt + 1
                    continue

                gt = buffer.find(">", lt + 1)
                if gt == -1:
                    # Potential tag spans chunks; hold from '<' onward.
                    self._xml_filter_tail = buffer[lt:]
                    break

                # Skip the full tag.
                i = gt + 1

            return "".join(output_parts)

        async def _push_llm_text(self, text: str):
            """Sanitize Nemotron textual output before emitting to pipeline."""
            if self._strip_xml_output and isinstance(text, str):
                text = self._strip_xml_like_tags(text)
                if not text:
                    return
            await super()._push_llm_text(text)

        def build_chat_completion_params(self, params_from_context) -> dict:
            params = super().build_chat_completion_params(params_from_context)

            extra_body = params.get("extra_body")
            if not isinstance(extra_body, dict):
                extra_body = {}

            chat_template_kwargs = extra_body.get("chat_template_kwargs")
            if not isinstance(chat_template_kwargs, dict):
                chat_template_kwargs = {}

            chat_template_kwargs["enable_thinking"] = self._enable_thinking
            extra_body["chat_template_kwargs"] = chat_template_kwargs
            params["extra_body"] = extra_body
            return params

        @staticmethod
        def _safe_preview(value: Any, limit: int = 160) -> Optional[str]:
            if value is None:
                return None
            if isinstance(value, str):
                text = value
            else:
                text = str(value)
            if len(text) <= limit:
                return text
            return f"{text[:limit]}..."

        def _extract_tool_names(self, tools: Any) -> list[str]:
            names: list[str] = []
            if not isinstance(tools, list):
                return names
            for tool in tools:
                if not isinstance(tool, dict):
                    continue
                fn = tool.get("function")
                if isinstance(fn, dict):
                    name = fn.get("name")
                    if isinstance(name, str) and name:
                        names.append(name)
            return names

        def _request_log_payload(self, request_id: str, params: dict[str, Any]) -> dict[str, Any]:
            messages = params.get("messages")
            message_count = len(messages) if isinstance(messages, list) else None
            last_user_preview: Optional[str] = None
            if isinstance(messages, list):
                for msg in reversed(messages):
                    if isinstance(msg, dict) and msg.get("role") == "user":
                        last_user_preview = self._safe_preview(msg.get("content"))
                        break

            tools = params.get("tools")
            tool_names = self._extract_tool_names(tools)

            return {
                "request_id": request_id,
                "model": params.get("model"),
                "message_count": message_count,
                "last_user_preview": last_user_preview,
                "tool_count": len(tool_names),
                "tool_names": tool_names,
                "tool_choice": str(params.get("tool_choice")),
                "max_tokens": str(params.get("max_tokens")),
                "max_completion_tokens": str(params.get("max_completion_tokens")),
                "extra_body": params.get("extra_body"),
            }

        def _wrap_chunk_stream_for_logging(self, chunk_stream, request_id: str):
            async def _iter():
                started_at = time.monotonic()
                chunk_count = 0
                text_chars = 0
                tool_call_count = 0
                tool_call_names: set[str] = set()
                finish_reasons: set[str] = set()
                usage: dict[str, Optional[int]] = {
                    "prompt_tokens": None,
                    "completion_tokens": None,
                    "total_tokens": None,
                    "cached_tokens": None,
                    "reasoning_tokens": None,
                }
                model_name: Optional[str] = None

                try:
                    async for chunk in chunk_stream:
                        chunk_count += 1

                        if getattr(chunk, "model", None):
                            model_name = chunk.model

                        if getattr(chunk, "usage", None):
                            u = chunk.usage
                            usage["prompt_tokens"] = getattr(u, "prompt_tokens", None)
                            usage["completion_tokens"] = getattr(u, "completion_tokens", None)
                            usage["total_tokens"] = getattr(u, "total_tokens", None)
                            prompt_details = getattr(u, "prompt_tokens_details", None)
                            completion_details = getattr(u, "completion_tokens_details", None)
                            usage["cached_tokens"] = (
                                getattr(prompt_details, "cached_tokens", None) if prompt_details else None
                            )
                            usage["reasoning_tokens"] = (
                                getattr(completion_details, "reasoning_tokens", None)
                                if completion_details
                                else None
                            )

                        choices = getattr(chunk, "choices", None) or []
                        if choices:
                            choice0 = choices[0]
                            finish_reason = getattr(choice0, "finish_reason", None)
                            if finish_reason is not None:
                                finish_reasons.add(str(finish_reason))
                            delta = getattr(choice0, "delta", None)
                            if delta is not None:
                                content = getattr(delta, "content", None)
                                if isinstance(content, str):
                                    text_chars += len(content)
                                tool_calls = getattr(delta, "tool_calls", None) or []
                                if tool_calls:
                                    tool_call_count += len(tool_calls)
                                    for call in tool_calls:
                                        fn = getattr(call, "function", None)
                                        name = getattr(fn, "name", None) if fn is not None else None
                                        if isinstance(name, str) and name:
                                            tool_call_names.add(name)

                        yield chunk
                except Exception as exc:
                    logger.exception(
                        "NEMOTRON_LLM_RESPONSE_ERROR {}",
                        json.dumps({"request_id": request_id, "error": str(exc)}),
                    )
                    raise
                finally:
                    elapsed_ms = int((time.monotonic() - started_at) * 1000)
                    logger.info(
                        "NEMOTRON_LLM_RESPONSE {}",
                        json.dumps(
                            {
                                "request_id": request_id,
                                "model": model_name,
                                "chunks": chunk_count,
                                "text_chars": text_chars,
                                "tool_call_chunks": tool_call_count,
                                "tool_call_names": sorted(tool_call_names),
                                "finish_reasons": sorted(finish_reasons),
                                "usage": usage,
                                "elapsed_ms": elapsed_ms,
                            }
                        ),
                    )

            return _iter()

        async def get_chat_completions(self, params_from_context):
            # Start each model response with a clean XML filter carry buffer.
            self._xml_filter_tail = ""
            request_id = uuid.uuid4().hex[:12]
            params = self.build_chat_completion_params(params_from_context)

            if self._log_request_response:
                logger.info(
                    "NEMOTRON_LLM_REQUEST {}",
                    json.dumps(self._request_log_payload(request_id, params), ensure_ascii=False),
                )
                # Full request body as passed to chat.completions.create(**params).
                logger.info(
                    "NEMOTRON_LLM_REQUEST_RAW {}",
                    json.dumps(params, default=str, ensure_ascii=False),
                )

            if self._retry_on_timeout:
                try:
                    chunk_stream = await asyncio.wait_for(
                        self._client.chat.completions.create(**params), timeout=self._retry_timeout_secs
                    )
                except (APITimeoutError, asyncio.TimeoutError):
                    logger.debug(f"{self}: Retrying chat completion due to timeout")
                    chunk_stream = await self._client.chat.completions.create(**params)
            else:
                chunk_stream = await self._client.chat.completions.create(**params)

            if not self._log_request_response:
                return chunk_stream
            return self._wrap_chunk_stream_for_logging(chunk_stream, request_id)

    return _NemotronOpenAILLMService


def _create_nemotron_service(
    api_key: str,
    model: str,
    thinking: Optional[UnifiedThinkingConfig],
    function_call_timeout_secs: Optional[float] = None,
) -> LLMService:
    """Create Nemotron LLM service using OpenAI-compatible API semantics."""
    enable_thinking = bool(thinking and thinking.enabled)
    if thinking and thinking.budget_tokens:
        logger.info(
            "Nemotron thinking budget is controlled server-side; using enable_thinking={} only",
            enable_thinking,
        )
    nemotron_base_url = os.getenv("NEMOTRON_BASE_URL")
    if nemotron_base_url:
        logger.info("Using NEMOTRON_BASE_URL for nemotron provider")
    else:
        # Backward compatibility: if only OPENAI_BASE_URL is set, reuse it.
        nemotron_base_url = os.getenv("OPENAI_BASE_URL")

    llm_kwargs: dict[str, Any] = {}
    if function_call_timeout_secs is not None:
        llm_kwargs["function_call_timeout_secs"] = function_call_timeout_secs
    if nemotron_base_url:
        llm_kwargs["base_url"] = nemotron_base_url

    service_cls = _get_nemotron_openai_cls()
    return service_cls(
        api_key=api_key,
        model=model,
        enable_thinking=enable_thinking,
        **llm_kwargs,
    )


def get_voice_llm_config() -> LLMServiceConfig:
    """Read VOICE_LLM_* environment variables and return config.

    Environment Variables:
        VOICE_LLM_PROVIDER: google, anthropic, openai, nemotron (default: google)
        VOICE_LLM_MODEL: Model name (default: gemini-2.5-flash)
        VOICE_LLM_FUNCTION_CALL_TIMEOUT_SECS: Tool call timeout in seconds (default: 20)

    Returns:
        LLMServiceConfig for voice pipeline (no thinking enabled).
    """
    provider_str = os.getenv("VOICE_LLM_PROVIDER", "google").lower()
    try:
        provider = LLMProvider(provider_str)
    except ValueError:
        logger.warning(f"Unknown VOICE_LLM_PROVIDER '{provider_str}', defaulting to google")
        provider = LLMProvider.GOOGLE

    # Default models per provider
    default_models = {
        LLMProvider.GOOGLE: "gemini-2.5-flash",
        LLMProvider.ANTHROPIC: "claude-sonnet-4-5-20250929",
        LLMProvider.OPENAI: "gpt-4.1",
        LLMProvider.NEMOTRON: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
    }

    model = os.getenv("VOICE_LLM_MODEL", default_models[provider])

    # Parse tool call timeout
    timeout_str = os.getenv("VOICE_LLM_FUNCTION_CALL_TIMEOUT_SECS", "20")
    try:
        function_call_timeout_secs = float(timeout_str)
    except ValueError:
        logger.warning(
            f"Invalid VOICE_LLM_FUNCTION_CALL_TIMEOUT_SECS '{timeout_str}', using default 20"
        )
        function_call_timeout_secs = 20.0

    logger.info(f"Voice LLM config: provider={provider.value}, model={model}")

    return LLMServiceConfig(
        provider=provider,
        model=model,
        thinking=None,  # Voice LLM typically doesn't use thinking mode
        function_call_timeout_secs=function_call_timeout_secs,
    )


def get_task_agent_llm_config() -> LLMServiceConfig:
    """Read TASK_LLM_* environment variables and return config.

    Environment Variables:
        TASK_LLM_PROVIDER: google, anthropic, openai, nemotron (default: google)
        TASK_LLM_MODEL: Model name (default: gemini-2.5-flash-preview-09-2025)
        TASK_LLM_THINKING_BUDGET: Token budget for thinking (default: 2048)
        TASK_LLM_FUNCTION_CALL_TIMEOUT_SECS: Tool call timeout in seconds (default: 20)

    Returns:
        LLMServiceConfig for task agent (with thinking enabled).
    """
    provider_str = os.getenv("TASK_LLM_PROVIDER", "google").lower()
    try:
        provider = LLMProvider(provider_str)
    except ValueError:
        logger.warning(f"Unknown TASK_LLM_PROVIDER '{provider_str}', defaulting to google")
        provider = LLMProvider.GOOGLE

    # Default models per provider (prefer preview/reasoning models)
    default_models = {
        LLMProvider.GOOGLE: "gemini-2.5-flash-preview-09-2025",
        LLMProvider.ANTHROPIC: "claude-sonnet-4-5-20250929",
        LLMProvider.OPENAI: "gpt-4.1",
        LLMProvider.NEMOTRON: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
    }

    model = os.getenv("TASK_LLM_MODEL", default_models[provider])

    # Parse thinking budget
    thinking_budget_str = os.getenv("TASK_LLM_THINKING_BUDGET", "2048")
    try:
        thinking_budget = int(thinking_budget_str)
    except ValueError:
        logger.warning(
            f"Invalid TASK_LLM_THINKING_BUDGET '{thinking_budget_str}', using default 2048"
        )
        thinking_budget = 2048

    thinking = UnifiedThinkingConfig(
        enabled=True,
        budget_tokens=thinking_budget,
        include_thoughts=True,  # Always include thoughts for task LLMs
    )

    # Parse tool call timeout
    timeout_str = os.getenv("TASK_LLM_FUNCTION_CALL_TIMEOUT_SECS", "20")
    try:
        function_call_timeout_secs = float(timeout_str)
    except ValueError:
        logger.warning(
            f"Invalid TASK_LLM_FUNCTION_CALL_TIMEOUT_SECS '{timeout_str}', using default 20"
        )
        function_call_timeout_secs = 20.0

    logger.info(
        f"Task LLM config: provider={provider.value}, model={model}, "
        f"thinking_budget={thinking_budget}"
    )

    return LLMServiceConfig(
        provider=provider,
        model=model,
        thinking=thinking,
        function_call_timeout_secs=function_call_timeout_secs,
    )


def get_ui_agent_llm_config() -> LLMServiceConfig:
    """Read UI_AGENT_LLM_* environment variables and return config.

    Environment Variables:
        UI_AGENT_LLM_PROVIDER: google, anthropic, openai, nemotron (default: google)
        UI_AGENT_LLM_MODEL: Model name (default: gemini-2.5-flash)
        UI_AGENT_LLM_THINKING_BUDGET: Token budget for thinking (default: 0)

    Returns:
        LLMServiceConfig for UI agent (thinking disabled by default).
    """
    provider_str = os.getenv("UI_AGENT_LLM_PROVIDER", "google").lower()
    try:
        provider = LLMProvider(provider_str)
    except ValueError:
        logger.warning(
            f"Unknown UI_AGENT_LLM_PROVIDER '{provider_str}', defaulting to google"
        )
        provider = LLMProvider.GOOGLE

    default_models = {
        LLMProvider.GOOGLE: "gemini-2.5-flash",
        LLMProvider.ANTHROPIC: "claude-haiku-4-5-20251001",
        LLMProvider.OPENAI: "gpt-4.1",
        LLMProvider.NEMOTRON: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
    }
    model = os.getenv("UI_AGENT_LLM_MODEL", default_models[provider])

    thinking_budget_str = os.getenv("UI_AGENT_LLM_THINKING_BUDGET", "0")
    try:
        thinking_budget = int(thinking_budget_str)
    except ValueError:
        logger.warning(
            f"Invalid UI_AGENT_LLM_THINKING_BUDGET '{thinking_budget_str}', using default 0"
        )
        thinking_budget = 0

    thinking = None
    if thinking_budget > 0:
        thinking = UnifiedThinkingConfig(
            enabled=True,
            budget_tokens=thinking_budget,
            include_thoughts=False,
        )

    logger.info(
        f"UI agent LLM config: provider={provider.value}, model={model}, "
        f"thinking_budget={thinking_budget}"
    )

    return LLMServiceConfig(
        provider=provider,
        model=model,
        thinking=thinking,
        run_in_parallel=False,
        cache_system_prompt=True,
    )
