"""TTS service factory for Pipecat pipelines."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional

from loguru import logger
from pipecat.services.tts_service import TTSService
from pipecat.transcriptions.language import Language

from gradientbang.config import settings


class TTSProvider(Enum):
    """Supported TTS providers."""

    GRADIUM = "gradium"
    CARTESIA = "cartesia"


@dataclass
class TTSServiceConfig:
    """Configuration for creating a Pipecat TTS service."""

    provider: TTSProvider
    voice_id: str
    language: Language = Language.EN
    api_key: Optional[str] = None


def get_tts_provider() -> TTSProvider:
    """Read TTS_PROVIDER from settings, defaulting to Gradium."""
    provider_str = settings.TTS_PROVIDER.strip().lower()
    try:
        return TTSProvider(provider_str)
    except ValueError:
        logger.warning("Unknown TTS_PROVIDER '{}', defaulting to gradium", provider_str)
        return TTSProvider.GRADIUM


def _get_api_key(provider: TTSProvider, override: Optional[str] = None) -> str:
    """Get the API key for a TTS provider from settings or override."""
    if override:
        return override

    key_map = {
        TTSProvider.GRADIUM: ("GRADIUM_API_KEY", settings.GRADIUM_API_KEY),
        TTSProvider.CARTESIA: ("CARTESIA_API_KEY", settings.CARTESIA_API_KEY),
    }
    env_var, api_key = key_map[provider]
    if not api_key:
        raise ValueError(f"{provider.value.capitalize()} API key required. Set {env_var}.")
    return api_key


def get_tts_config(
    *, voice_id: str, language: Language = Language.EN, api_key: Optional[str] = None
) -> TTSServiceConfig:
    """Read TTS provider configuration and return a service config."""
    provider = get_tts_provider()
    return TTSServiceConfig(
        provider=provider,
        voice_id=voice_id,
        language=language,
        api_key=api_key,
    )


def create_tts_service(config: TTSServiceConfig) -> TTSService:
    """Create the appropriate Pipecat TTS service for the selected provider."""
    api_key = _get_api_key(config.provider, config.api_key)

    if config.provider == TTSProvider.GRADIUM:
        from pipecat.services.gradium.tts import GradiumTTSService

        return GradiumTTSService(
            api_key=api_key,
            settings=GradiumTTSService.Settings(
                voice=config.voice_id,
                language=config.language,
            ),
        )

    if config.provider == TTSProvider.CARTESIA:
        from pipecat.services.cartesia.tts import CartesiaTTSService

        return CartesiaTTSService(
            api_key=api_key,
            settings=CartesiaTTSService.Settings(
                voice=config.voice_id,
                language=config.language,
            ),
        )

    raise ValueError(f"Unsupported TTS provider: {config.provider}")
