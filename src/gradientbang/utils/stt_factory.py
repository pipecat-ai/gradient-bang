"""STT service factory for Pipecat pipelines.

Mirrors the shape of ``tts_factory`` so swapping providers later is a
single-line edit (add an enum value + a branch in ``create_stt_service``).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional

from loguru import logger
from pipecat.services.stt_service import STTService
from pipecat.transcriptions.language import Language

from gradientbang.config import settings


class STTProvider(Enum):
    """Supported STT providers."""

    DEEPGRAM = "deepgram"


@dataclass
class STTServiceConfig:
    """Configuration for creating a Pipecat STT service."""

    provider: STTProvider
    language: Language = Language.EN
    api_key: Optional[str] = None


def get_stt_provider() -> STTProvider:
    """Read STT_PROVIDER from settings, defaulting to Deepgram."""
    provider_str = settings.STT_PROVIDER.strip().lower()
    try:
        return STTProvider(provider_str)
    except ValueError:
        logger.warning("Unknown STT_PROVIDER '{}', defaulting to deepgram", provider_str)
        return STTProvider.DEEPGRAM


def _get_api_key(provider: STTProvider, override: Optional[str] = None) -> str:
    """Get the API key for an STT provider from settings or override."""
    if override:
        return override

    if provider == STTProvider.DEEPGRAM:
        if not settings.DEEPGRAM_API_KEY:
            raise ValueError("Deepgram API key required. Set DEEPGRAM_API_KEY.")
        return settings.DEEPGRAM_API_KEY

    raise ValueError(f"Unsupported STT provider: {provider}")


def get_stt_config(
    *, language: Language = Language.EN, api_key: Optional[str] = None
) -> STTServiceConfig:
    """Read STT provider configuration and return a service config."""
    provider = get_stt_provider()
    return STTServiceConfig(
        provider=provider,
        language=language,
        api_key=api_key,
    )


def create_stt_service(config: STTServiceConfig) -> STTService:
    """Create the appropriate Pipecat STT service for the selected provider."""
    api_key = _get_api_key(config.provider, config.api_key)

    if config.provider == STTProvider.DEEPGRAM:
        from pipecat.services.deepgram.stt import DeepgramSTTService

        return DeepgramSTTService(
            api_key=api_key,
            settings=DeepgramSTTService.Settings(language=config.language),
        )

    raise ValueError(f"Unsupported STT provider: {config.provider}")
