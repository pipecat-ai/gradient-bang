"""
Flexible LLM service factory for Pipecat pipelines.

Supports Google, Anthropic, and OpenAI models with environment-based configuration.

Environment Variables:
    # Voice LLM (bot.py pipeline - typically no thinking mode)
    VOICE_LLM_PROVIDER: google, anthropic, openai (default: google)
    VOICE_LLM_MODEL: Model name (default: gemini-2.5-flash)
    VOICE_LLM_FUNCTION_CALL_TIMEOUT_SECS: Tool call timeout in seconds (default: 20)

    # Task Agent LLM (TaskAgent - with thinking mode)
    TASK_LLM_PROVIDER: google, anthropic, openai (default: google)
    TASK_LLM_MODEL: Model name (default: gemini-2.5-flash)
    TASK_LLM_THINKING_BUDGET: Token budget for thinking (default: 2048)
    TASK_LLM_FUNCTION_CALL_TIMEOUT_SECS: Tool call timeout in seconds (default: 20)

    # UI Agent LLM (UI agent branch - lightweight, no thinking by default)
    UI_AGENT_LLM_PROVIDER: google, anthropic, openai (default: google)
    UI_AGENT_LLM_MODEL: Model name (default: gemini-2.5-flash)
    UI_AGENT_LLM_THINKING_BUDGET: Token budget for thinking (default: 0)

    # API keys (used based on provider)
    GOOGLE_API_KEY
    ANTHROPIC_API_KEY
    OPENAI_API_KEY

    # OpenAI-compatible endpoints (global or per-scope override)
    OPENAI_BASE_URL
    VOICE_LLM_OPENAI_BASE_URL
    TASK_LLM_OPENAI_BASE_URL
    UI_AGENT_LLM_OPENAI_BASE_URL
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from enum import Enum
from typing import Optional

from loguru import logger
from pipecat.services.llm_service import LLMService

from gradientbang.utils.gemini_adapter import GradientBangGeminiLLMAdapter


class _GoogleGenAINonTextFunctionCallFilter(logging.Filter):
    """Suppress only the known non-text warning for function_call parts.

    We intentionally process function_call parts from candidates.content.parts.
    Keep other google-genai warnings visible.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        if "there are non-text parts in the response" not in message:
            return True
        return "['function_call']" not in message


_google_genai_filter_installed = False


def _install_google_genai_warning_filter() -> None:
    global _google_genai_filter_installed
    if _google_genai_filter_installed:
        return

    google_logger = logging.getLogger("google_genai.types")
    google_logger.addFilter(_GoogleGenAINonTextFunctionCallFilter())
    _google_genai_filter_installed = True


def _is_google_thinking_level_model(model: str) -> bool:
    normalized = model.strip().lower()
    return normalized.startswith("gemini-3") or normalized.startswith("supernova")


def _google_budget_to_thinking_level(budget_tokens: int) -> str:
    if budget_tokens <= 0:
        return "minimal"
    if budget_tokens <= 128:
        return "low"
    if budget_tokens <= 512:
        return "medium"
    return "high"


class LLMProvider(Enum):
    """Supported LLM providers."""

    GOOGLE = "google"
    ANTHROPIC = "anthropic"
    OPENAI = "openai"


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
        provider: The LLM provider (Google, Anthropic, or OpenAI).
        model: The model name to use.
        api_key: Optional API key override (defaults to environment variable).
        thinking: Optional thinking configuration for task agents.
        function_call_timeout_secs: Optional tool call timeout override.
        run_in_parallel: Optional override for LLMService._run_in_parallel.
            When False, function calls are dispatched sequentially.
        cache_system_prompt: When True (Anthropic only), add cache_control to
            the system parameter. Useful for agents that rebuild contexts fresh
            each call but keep the same system prompt.
        openai_base_url: Optional base URL for OpenAI-compatible endpoints.
    """

    provider: LLMProvider
    model: str
    api_key: Optional[str] = None
    thinking: Optional[UnifiedThinkingConfig] = None
    function_call_timeout_secs: Optional[float] = None
    run_in_parallel: Optional[bool] = None
    cache_system_prompt: bool = False
    openai_base_url: Optional[str] = None


def _normalize_openai_base_url(base_url: str) -> str:
    normalized = base_url.strip().rstrip("/")
    if normalized.endswith("/v1"):
        return normalized
    return f"{normalized}/v1"


def _resolve_openai_base_url(scope_prefix: str) -> Optional[str]:
    scoped_key = f"{scope_prefix}_OPENAI_BASE_URL"
    return os.getenv(scoped_key) or os.getenv("OPENAI_BASE_URL")


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
            openai_base_url=config.openai_base_url,
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
    _install_google_genai_warning_filter()

    from pipecat.services.google.llm import GoogleLLMService

    class GradientBangGoogleLLMService(GoogleLLMService):
        adapter_class = GradientBangGeminiLLMAdapter

    params = None
    if thinking and thinking.enabled:
        if _is_google_thinking_level_model(model):
            params = GoogleLLMService.InputParams(
                thinking=GoogleLLMService.ThinkingConfig(
                    thinking_level=_google_budget_to_thinking_level(thinking.budget_tokens),
                    include_thoughts=thinking.include_thoughts,
                )
            )
        else:
            params = GoogleLLMService.InputParams(
                thinking=GoogleLLMService.ThinkingConfig(
                    thinking_budget=thinking.budget_tokens,
                    include_thoughts=thinking.include_thoughts,
                )
            )

    llm_kwargs = {}
    if function_call_timeout_secs is not None:
        llm_kwargs["function_call_timeout_secs"] = function_call_timeout_secs

    return GradientBangGoogleLLMService(
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
    *,
    openai_base_url: Optional[str] = None,
) -> LLMService:
    """Create OpenAI LLM service.

    For OpenAI-compatible vLLM endpoints, thinking budget is passed via
    vllm_xargs when a custom base URL is configured.
    """
    from gradientbang.utils.openai_debug_llm import DebugOpenAILLMService

    normalized_base_url = _normalize_openai_base_url(openai_base_url) if openai_base_url else None

    params = None
    if thinking and thinking.enabled and normalized_base_url:
        params = DebugOpenAILLMService.InputParams(
            extra={
                "extra_body": {
                    "vllm_xargs": {"thinking_budget": int(thinking.budget_tokens)},
                }
            }
        )
    elif thinking and thinking.enabled:
        logger.warning(
            "OpenAI thinking budget requested for model {} but no OpenAI-compatible "
            "base URL is configured; proceeding without thinking.",
            model,
        )

    llm_kwargs = {}
    if function_call_timeout_secs is not None:
        llm_kwargs["function_call_timeout_secs"] = function_call_timeout_secs
    if normalized_base_url:
        llm_kwargs["base_url"] = normalized_base_url
    if params is not None:
        llm_kwargs["params"] = params

    return DebugOpenAILLMService(
        api_key=api_key,
        model=model,
        **llm_kwargs,
    )


def get_voice_llm_config() -> LLMServiceConfig:
    """Read VOICE_LLM_* environment variables and return config.

    Environment Variables:
        VOICE_LLM_PROVIDER: google, anthropic, openai (default: google)
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
    }

    model = os.getenv("VOICE_LLM_MODEL", default_models[provider])
    openai_base_url = _resolve_openai_base_url("VOICE_LLM") if provider == LLMProvider.OPENAI else None

    # Parse tool call timeout
    timeout_str = os.getenv("VOICE_LLM_FUNCTION_CALL_TIMEOUT_SECS", "20")
    try:
        function_call_timeout_secs = float(timeout_str)
    except ValueError:
        logger.warning(
            f"Invalid VOICE_LLM_FUNCTION_CALL_TIMEOUT_SECS '{timeout_str}', using default 20"
        )
        function_call_timeout_secs = 20.0

    logger.info(
        "Voice LLM config: provider={}, model={}, openai_base_url={}",
        provider.value,
        model,
        _normalize_openai_base_url(openai_base_url) if openai_base_url else "(default)",
    )

    return LLMServiceConfig(
        provider=provider,
        model=model,
        thinking=None,  # Voice LLM typically doesn't use thinking mode
        function_call_timeout_secs=function_call_timeout_secs,
        openai_base_url=openai_base_url,
    )


def get_task_agent_llm_config() -> LLMServiceConfig:
    """Read TASK_LLM_* environment variables and return config.

    Environment Variables:
        TASK_LLM_PROVIDER: google, anthropic, openai (default: google)
        TASK_LLM_MODEL: Model name (default: gemini-2.5-flash)
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
        LLMProvider.GOOGLE: "gemini-2.5-flash",
        LLMProvider.ANTHROPIC: "claude-sonnet-4-5-20250929",
        LLMProvider.OPENAI: "gpt-4.1",
    }

    model = os.getenv("TASK_LLM_MODEL", default_models[provider])
    openai_base_url = _resolve_openai_base_url("TASK_LLM") if provider == LLMProvider.OPENAI else None

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
        "Task LLM config: provider={}, model={}, thinking_budget={}, openai_base_url={}",
        provider.value,
        model,
        thinking_budget,
        _normalize_openai_base_url(openai_base_url) if openai_base_url else "(default)",
    )

    return LLMServiceConfig(
        provider=provider,
        model=model,
        thinking=thinking,
        function_call_timeout_secs=function_call_timeout_secs,
        run_in_parallel=False,
        openai_base_url=openai_base_url,
    )


def get_ui_agent_llm_config() -> LLMServiceConfig:
    """Read UI_AGENT_LLM_* environment variables and return config.

    Environment Variables:
        UI_AGENT_LLM_PROVIDER: google, anthropic, openai (default: google)
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
    }
    model = os.getenv("UI_AGENT_LLM_MODEL", default_models[provider])
    openai_base_url = _resolve_openai_base_url("UI_AGENT_LLM") if provider == LLMProvider.OPENAI else None

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
        "UI agent LLM config: provider={}, model={}, thinking_budget={}, openai_base_url={}",
        provider.value,
        model,
        thinking_budget,
        _normalize_openai_base_url(openai_base_url) if openai_base_url else "(default)",
    )

    return LLMServiceConfig(
        provider=provider,
        model=model,
        thinking=thinking,
        run_in_parallel=False,
        cache_system_prompt=True,
        openai_base_url=openai_base_url,
    )
