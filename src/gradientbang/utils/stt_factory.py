"""
Flexible STT service factory for the voice bot pipeline.

Supports Cartesia realtime STT, Magpie/OpenAI-compatible HTTP STT, and
Nemotron websocket ASR with environment-based configuration.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import Enum
from typing import Optional

from loguru import logger
from pipecat.services.stt_service import STTService
from pipecat.transcriptions.language import Language


class STTProvider(Enum):
    """Supported STT providers."""

    CARTESIA = "cartesia"
    MAGPIE = "magpie"
    NEMOTRON = "nemotron"


@dataclass
class STTServiceConfig:
    """Configuration for creating an STT service."""

    provider: STTProvider
    model: str
    language: Language = Language.EN
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    sample_rate: int = 16000


def _parse_int(value: Optional[str], default: int) -> int:
    if value is None:
        return default
    cleaned = value.strip()
    if not cleaned:
        return default
    try:
        return int(cleaned)
    except ValueError:
        logger.warning(f"Invalid integer value '{value}', defaulting to {default}")
        return default


def _parse_language(value: Optional[str]) -> Language:
    """Parse language from env var, defaulting to English."""
    if not value:
        return Language.EN

    cleaned = value.strip()
    if not cleaned:
        return Language.EN

    candidates = [
        cleaned,
        cleaned.lower(),
        cleaned.replace("_", "-"),
        cleaned.replace("_", "-").lower(),
    ]
    for candidate in candidates:
        try:
            return Language(candidate)
        except ValueError:
            continue

    member_key = cleaned.replace("-", "_").upper()
    if member_key in Language.__members__:
        return Language[member_key]

    logger.warning(f"Unknown VOICE_STT_LANGUAGE '{value}', defaulting to 'en'")
    return Language.EN


def _normalize_openai_base_url(base_url: str) -> str:
    """Normalize OpenAI-compatible base URLs for transcription endpoints."""
    normalized = base_url.strip().rstrip("/")
    if normalized.endswith("/audio/transcriptions"):
        normalized = normalized[: -len("/audio/transcriptions")]
    if normalized.endswith("/chat/completions"):
        normalized = normalized[: -len("/chat/completions")]
    return normalized


def _get_api_key(provider: STTProvider, override: Optional[str] = None) -> str:
    """Get API key for provider from env or override."""
    if override:
        return override

    if provider == STTProvider.CARTESIA:
        api_key = os.getenv("CARTESIA_API_KEY")
        if not api_key:
            raise ValueError(
                "Cartesia API key required. Set CARTESIA_API_KEY environment variable."
            )
        return api_key

    # Most local OpenAI-compatible STT deployments do not enforce auth.
    api_key = os.getenv("NVIDIA_STT_API_KEY")
    if isinstance(api_key, str) and api_key.strip():
        return api_key.strip()
    return "empty"


def create_stt_service(config: STTServiceConfig) -> STTService:
    """Create an STT service from configuration."""
    api_key = _get_api_key(config.provider, config.api_key)

    if config.provider == STTProvider.CARTESIA:
        from pipecat.services.cartesia.stt import CartesiaLiveOptions, CartesiaSTTService

        cartesia_kwargs = {
            "api_key": api_key,
            "live_options": CartesiaLiveOptions(
                model=config.model,
                language=config.language.value,
            ),
        }
        if config.base_url:
            cartesia_kwargs["base_url"] = config.base_url

        logger.info(
            "Initializing STT provider=cartesia model={} language={}",
            config.model,
            config.language.value,
        )
        return CartesiaSTTService(**cartesia_kwargs)

    if config.provider == STTProvider.MAGPIE:
        from pipecat.services.openai.stt import OpenAISTTService

        if not config.base_url:
            raise ValueError(
                "Magpie STT base URL required. Set NVIDIA_STT_BASE_URL (or NEMOTRON_BASE_URL)."
            )
        base_url = _normalize_openai_base_url(config.base_url)

        logger.info(
            "Initializing STT provider=magpie model={} language={} base_url={}",
            config.model,
            config.language.value,
            base_url,
        )
        return OpenAISTTService(
            api_key=api_key,
            model=config.model,
            base_url=base_url,
            language=config.language,
        )

    if config.provider == STTProvider.NEMOTRON:
        from gradientbang.pipecat_server.nemotron_websocket_stt import (
            NemotronWebSocketSTTService,
        )

        ws_url = config.base_url or "ws://localhost:8080"
        logger.info(
            "Initializing STT provider=nemotron model={} sample_rate={} url={}",
            config.model,
            config.sample_rate,
            ws_url,
        )
        return NemotronWebSocketSTTService(
            url=ws_url,
            sample_rate=config.sample_rate,
        )

    raise ValueError(f"Unsupported STT provider: {config.provider.value}")


def get_voice_stt_config() -> STTServiceConfig:
    """Get voice STT config from environment variables."""
    provider_raw = os.getenv("VOICE_STT_PROVIDER", "cartesia").strip().lower()
    provider_aliases = {
        "nvidia": "nemotron",
        "nemotron_asr": "nemotron",
    }
    provider_raw = provider_aliases.get(provider_raw, provider_raw)
    try:
        provider = STTProvider(provider_raw)
    except ValueError as exc:
        supported = ", ".join(p.value for p in STTProvider)
        raise ValueError(
            f"Unknown VOICE_STT_PROVIDER '{provider_raw}'. Supported values: {supported}"
        ) from exc

    language = _parse_language(os.getenv("VOICE_STT_LANGUAGE"))

    if provider == STTProvider.CARTESIA:
        model = os.getenv("CARTESIA_STT_MODEL") or os.getenv("VOICE_STT_MODEL") or "ink-whisper"
        base_url = os.getenv("CARTESIA_STT_BASE_URL")
        sample_rate = _parse_int(os.getenv("VOICE_STT_SAMPLE_RATE"), 16000)
    elif provider == STTProvider.MAGPIE:
        model = os.getenv("NVIDIA_STT_MODEL") or os.getenv("VOICE_STT_MODEL") or "whisper-1"
        base_url = os.getenv("NVIDIA_STT_BASE_URL") or os.getenv("NEMOTRON_BASE_URL")
        sample_rate = _parse_int(os.getenv("VOICE_STT_SAMPLE_RATE"), 16000)
    else:
        model = (
            os.getenv("NEMOTRON_ASR_MODEL")
            or os.getenv("VOICE_STT_MODEL")
            or "nvidia/nemotron-speech-streaming-en-0.6b"
        )
        base_url = os.getenv("NEMOTRON_ASR_URL") or os.getenv("NVIDIA_ASR_URL")
        sample_rate = _parse_int(
            os.getenv("NEMOTRON_ASR_SAMPLE_RATE")
            or os.getenv("VOICE_STT_SAMPLE_RATE"),
            16000,
        )

    return STTServiceConfig(
        provider=provider,
        model=model,
        language=language,
        base_url=base_url,
        sample_rate=sample_rate,
    )
