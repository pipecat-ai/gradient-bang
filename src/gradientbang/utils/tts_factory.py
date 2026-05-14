"""TTS service factory for Pipecat pipelines."""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import Enum
from typing import Optional

from loguru import logger
from pipecat.services.tts_service import TTSService
from pipecat.transcriptions.language import Language


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
    """Read TTS_PROVIDER from the environment, defaulting to Gradium."""
    provider_str = os.getenv("TTS_PROVIDER", TTSProvider.GRADIUM.value).strip().lower()
    try:
        return TTSProvider(provider_str)
    except ValueError:
        logger.warning("Unknown TTS_PROVIDER '{}', defaulting to gradium", provider_str)
        return TTSProvider.GRADIUM


def _get_api_key(provider: TTSProvider, override: Optional[str] = None) -> str:
    """Get the API key for a TTS provider from environment or override."""
    if override:
        return override

    env_var_map = {
        TTSProvider.GRADIUM: "GRADIUM_API_KEY",
        TTSProvider.CARTESIA: "CARTESIA_API_KEY",
    }
    env_var = env_var_map[provider]
    api_key = os.getenv(env_var)
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
