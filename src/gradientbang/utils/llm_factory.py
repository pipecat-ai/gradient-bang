"""
Flexible LLM service factory for Pipecat pipelines.

Supports Google, Anthropic, and OpenAI models with environment-based configuration.

Environment Variables:
    # Voice LLM (bot.py pipeline - typically no thinking mode)
    VOICE_LLM_PROVIDER: google, anthropic, openai (default: google)
    VOICE_LLM_MODEL: Model name (default: gemini-2.5-flash)
    VOICE_LLM_THINKING_BUDGET: Token budget for thinking (default: 0)
    VOICE_LLM_FUNCTION_CALL_TIMEOUT_SECS: Tool call timeout in seconds (default: 20)

    # Task Agent LLM (TaskAgent - with thinking mode)
    TASK_LLM_PROVIDER: google, anthropic, openai (default: google)
    TASK_LLM_MODEL: Model name (default: gemini-2.5-flash)
    TASK_LLM_THINKING_BUDGET: Token budget for thinking (default: 4096)
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

        async def run_inference(self, context, max_tokens=None, system_instruction=None):
            """Override to guard against response.content.parts being None.

            Upstream iterates content.parts without a None check, which crashes
            on transient Gemini responses where content exists but parts is None.
            """
            # Call the grandparent (LLMService) implementation's setup portion
            # by delegating to the parent, but wrapping the response extraction.
            # We reproduce the parent's run_inference with the fix applied.
            from pipecat.processors.aggregators.llm_context import LLMContext as PcLLMContext

            messages = []
            system = []
            tools = []
            if isinstance(context, PcLLMContext):
                adapter = self.get_llm_adapter()
                params = adapter.get_llm_invocation_params(context)
                messages = params["messages"]
                system = params["system_instruction"]
                tools = params["tools"]
            else:
                from pipecat.services.google.llm import GoogleLLMContext

                context = GoogleLLMContext.upgrade_to_google(context)
                messages = context.messages
                system = getattr(context, "system_message", None)
                tools = context.tools or []

            if system_instruction is not None:
                if system:
                    logger.warning(
                        f"{self}: Both system_instruction and a system message in context"
                        " are set. Using system_instruction."
                    )
                system = system_instruction

            generation_params = self._build_generation_params(
                system_instruction=system, tools=tools if tools else None
            )
            if max_tokens is not None:
                generation_params["max_output_tokens"] = max_tokens

            from google.genai.types import GenerateContentConfig

            generation_config = GenerateContentConfig(**generation_params)

            response = await self._client.aio.models.generate_content(
                model=self._settings.model,
                contents=messages,
                config=generation_config,
            )

            if response.candidates and response.candidates[0].content:
                parts = response.candidates[0].content.parts
                if parts:
                    for part in parts:
                        if part.text:
                            return part.text

            return None

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


def _map_thinking_budget_to_effort(budget: int) -> str:
    """Map a thinking token budget to an OpenAI reasoning_effort level."""
    if budget >= 16384:
        return "high"
    elif budget >= 4096:
        return "medium"
    else:
        return "low"


def _create_openai_service(
    api_key: str,
    model: str,
    thinking: Optional[UnifiedThinkingConfig],
    function_call_timeout_secs: Optional[float] = None,
) -> LLMService:
    """Create OpenAI LLM service with optional reasoning_effort support.

    When thinking is enabled, uses the Responses API service which streams
    reasoning summary text as LLMThoughtTextFrame. Otherwise falls back to
    the standard Chat Completions API service.
    """
    llm_kwargs: dict = {}
    if function_call_timeout_secs is not None:
        llm_kwargs["function_call_timeout_secs"] = function_call_timeout_secs

    if thinking and thinking.enabled:
        from gradientbang.utils.openai_responses_llm import OpenAIResponsesLLMService

        effort = _map_thinking_budget_to_effort(thinking.budget_tokens)
        logger.info(
            "OpenAI Responses API: reasoning_effort={}, summary=detailed "
            "for model {} (budget={})",
            effort,
            model,
            thinking.budget_tokens,
        )
        return OpenAIResponsesLLMService(
            api_key=api_key,
            model=model,
            reasoning_effort=effort,
            reasoning_summary="detailed",
            **llm_kwargs,
        )

    from pipecat.services.openai.llm import OpenAILLMService

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
        VOICE_LLM_THINKING_BUDGET: Token budget for thinking (default: 0)
        VOICE_LLM_FUNCTION_CALL_TIMEOUT_SECS: Tool call timeout in seconds (default: 20)

    Returns:
        LLMServiceConfig for voice pipeline (thinking disabled by default).
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

    # Parse thinking budget
    thinking_budget_str = os.getenv("VOICE_LLM_THINKING_BUDGET", "0")
    try:
        thinking_budget = int(thinking_budget_str)
    except ValueError:
        logger.warning(
            f"Invalid VOICE_LLM_THINKING_BUDGET '{thinking_budget_str}', using default 0"
        )
        thinking_budget = 0

    thinking = None
    if thinking_budget > 0:
        thinking = UnifiedThinkingConfig(
            enabled=True,
            budget_tokens=thinking_budget,
            include_thoughts=False,
        )

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
        f"Voice LLM config: provider={provider.value}, model={model}, "
        f"thinking_budget={thinking_budget}"
    )

    return LLMServiceConfig(
        provider=provider,
        model=model,
        thinking=thinking,
        function_call_timeout_secs=function_call_timeout_secs,
    )


def get_task_agent_llm_config() -> LLMServiceConfig:
    """Read TASK_LLM_* environment variables and return config.

    Environment Variables:
        TASK_LLM_PROVIDER: google, anthropic, openai (default: google)
        TASK_LLM_MODEL: Model name (default: gemini-2.5-flash)
        TASK_LLM_THINKING_BUDGET: Token budget for thinking (default: 4096)
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

    # Parse thinking budget
    thinking_budget_str = os.getenv("TASK_LLM_THINKING_BUDGET", "4096")
    try:
        thinking_budget = int(thinking_budget_str)
    except ValueError:
        logger.warning(
            f"Invalid TASK_LLM_THINKING_BUDGET '{thinking_budget_str}', using default 4096"
        )
        thinking_budget = 4096

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
        run_in_parallel=False,
    )


def get_ui_agent_llm_config() -> LLMServiceConfig:
    """Read UI_AGENT_LLM_* environment variables and return config.

    Environment Variables:
        UI_AGENT_LLM_PROVIDER: google, anthropic, openai (default: google)
        UI_AGENT_LLM_MODEL: Model name (default: gemini-2.5-flash)
        UI_AGENT_LLM_THINKING_BUDGET: Token budget for thinking (default: 0)

    Returns:
        LLMServiceConfig for UI agent.
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
        cache_system_prompt=True,
    )
