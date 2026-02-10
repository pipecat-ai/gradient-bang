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

    # UI Agent LLM (UI agent branch - lightweight, no thinking by default)
    UI_AGENT_LLM_PROVIDER: google, anthropic, openai (default: google)
    UI_AGENT_LLM_MODEL: Model name (default: gemini-2.5-flash)
    UI_AGENT_LLM_THINKING_BUDGET: Token budget for thinking (default: 0)

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
        run_in_parallel: Optional override for LLMService._run_in_parallel.
            When False, function calls are dispatched sequentially.
    """

    provider: LLMProvider
    model: str
    api_key: Optional[str] = None
    thinking: Optional[UnifiedThinkingConfig] = None
    function_call_timeout_secs: Optional[float] = None
    run_in_parallel: Optional[bool] = None


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
) -> LLMService:
    """Create Anthropic (Claude) LLM service."""
    from pipecat.services.anthropic.llm import AnthropicLLMService

    params = None
    if thinking and thinking.enabled:
        # Anthropic requires minimum 1024 tokens for thinking budget
        budget = max(1024, thinking.budget_tokens)
        params = AnthropicLLMService.InputParams(
            thinking=AnthropicLLMService.ThinkingConfig(
                type="enabled",
                budget_tokens=budget,
            )
        )

    llm_kwargs = {}
    if function_call_timeout_secs is not None:
        llm_kwargs["function_call_timeout_secs"] = function_call_timeout_secs

    return AnthropicLLMService(
        api_key=api_key,
        model=model,
        params=params,
        **llm_kwargs,
    )


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
    )
