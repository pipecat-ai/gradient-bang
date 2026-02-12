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
    TASK_LLM_MODEL: Model name (default: gemini-2.5-flash-preview-09-2025)
    TASK_LLM_THINKING_BUDGET: Token budget for thinking (default: 2048)
    TASK_LLM_FUNCTION_CALL_TIMEOUT_SECS: Tool call timeout in seconds (default: 20)

    # API keys (used based on provider)
    GOOGLE_API_KEY
    ANTHROPIC_API_KEY
    OPENAI_API_KEY
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

from loguru import logger
from pipecat.services.llm_service import LLMService


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
        cache_system_prompt: When True (Anthropic only), add cache_control to
            the system parameter. Useful for agents that rebuild contexts fresh
            each call but keep the same system prompt.
    """

    provider: LLMProvider
    model: str
    api_key: Optional[str] = None
    thinking: Optional[UnifiedThinkingConfig] = None
    function_call_timeout_secs: Optional[float] = None
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

    env_var_map = {
        LLMProvider.GOOGLE: "GOOGLE_API_KEY",
        LLMProvider.ANTHROPIC: "ANTHROPIC_API_KEY",
        LLMProvider.OPENAI: "OPENAI_API_KEY",
    }

    env_var = env_var_map[provider]
    api_key = os.getenv(env_var)

    if not api_key:
        raise ValueError(
            f"{provider.value.capitalize()} API key required. "
            f"Set {env_var} environment variable."
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
    else:
        raise ValueError(f"Unsupported provider: {config.provider}")

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
            "OpenAI does not support thinking mode. "
            f"Proceeding without thinking for model {model}."
        )

    llm_kwargs = {}
    if function_call_timeout_secs is not None:
        llm_kwargs["function_call_timeout_secs"] = function_call_timeout_secs

    return OpenAILLMService(
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
        logger.warning(
            f"Unknown VOICE_LLM_PROVIDER '{provider_str}', defaulting to google"
        )
        provider = LLMProvider.GOOGLE

    # Default models per provider
    default_models = {
        LLMProvider.GOOGLE: "gemini-2.5-flash",
        LLMProvider.ANTHROPIC: "claude-sonnet-4-5-20250929",
        LLMProvider.OPENAI: "gpt-4.1",
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
        TASK_LLM_PROVIDER: google, anthropic, openai (default: google)
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
        logger.warning(
            f"Unknown TASK_LLM_PROVIDER '{provider_str}', defaulting to google"
        )
        provider = LLMProvider.GOOGLE

    # Default models per provider (prefer preview/reasoning models)
    default_models = {
        LLMProvider.GOOGLE: "gemini-2.5-flash-preview-09-2025",
        LLMProvider.ANTHROPIC: "claude-sonnet-4-5-20250929",
        LLMProvider.OPENAI: "gpt-4.1",
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

