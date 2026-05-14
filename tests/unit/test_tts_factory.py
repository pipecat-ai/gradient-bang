"""Unit tests for the Pipecat TTS factory."""

import pytest
from pipecat.transcriptions.language import Language

from gradientbang.utils.tts_factory import (
    TTSProvider,
    TTSServiceConfig,
    _get_api_key,
    create_tts_service,
    get_tts_config,
    get_tts_provider,
)


@pytest.mark.unit
class TestTTSProviderConfig:
    def test_default_provider_is_gradium(self, monkeypatch):
        monkeypatch.delenv("TTS_PROVIDER", raising=False)
        config = get_tts_config(voice_id="voice-1")
        assert config.provider == TTSProvider.GRADIUM

    def test_cartesia_provider_is_selected(self, monkeypatch):
        monkeypatch.setenv("TTS_PROVIDER", "cartesia")
        config = get_tts_config(voice_id="voice-1")
        assert config.provider == TTSProvider.CARTESIA

    def test_provider_value_is_case_insensitive_and_trimmed(self, monkeypatch):
        monkeypatch.setenv("TTS_PROVIDER", "  CARTESIA  ")
        assert get_tts_provider() == TTSProvider.CARTESIA

    def test_invalid_provider_defaults_to_gradium(self, monkeypatch):
        monkeypatch.setenv("TTS_PROVIDER", "unknown")
        assert get_tts_provider() == TTSProvider.GRADIUM


@pytest.mark.unit
class TestTTSApiKeys:
    def test_gradium_api_key_env_var(self, monkeypatch):
        monkeypatch.setenv("GRADIUM_API_KEY", "gradium-key")
        assert _get_api_key(TTSProvider.GRADIUM) == "gradium-key"

    def test_cartesia_api_key_env_var(self, monkeypatch):
        monkeypatch.setenv("CARTESIA_API_KEY", "cartesia-key")
        assert _get_api_key(TTSProvider.CARTESIA) == "cartesia-key"

    def test_api_key_override_wins(self, monkeypatch):
        monkeypatch.delenv("GRADIUM_API_KEY", raising=False)
        assert _get_api_key(TTSProvider.GRADIUM, override="override-key") == "override-key"

    def test_missing_gradium_key_raises(self, monkeypatch):
        monkeypatch.delenv("GRADIUM_API_KEY", raising=False)
        with pytest.raises(ValueError, match="GRADIUM_API_KEY"):
            _get_api_key(TTSProvider.GRADIUM)

    def test_missing_cartesia_key_raises(self, monkeypatch):
        monkeypatch.delenv("CARTESIA_API_KEY", raising=False)
        with pytest.raises(ValueError, match="CARTESIA_API_KEY"):
            _get_api_key(TTSProvider.CARTESIA)


@pytest.mark.unit
class TestCreateTTSService:
    def test_creates_gradium_service_with_voice_and_language(self):
        from pipecat.services.gradium.tts import GradiumTTSService

        service = create_tts_service(
            TTSServiceConfig(
                provider=TTSProvider.GRADIUM,
                voice_id="gradium-voice",
                language=Language.EN,
                api_key="test-key",
            )
        )
        assert isinstance(service, GradiumTTSService)
        assert service._settings.voice == "gradium-voice"
        assert service._settings.language == Language.EN

    def test_creates_cartesia_service_with_voice_and_language(self):
        from pipecat.services.cartesia.tts import CartesiaTTSService

        service = create_tts_service(
            TTSServiceConfig(
                provider=TTSProvider.CARTESIA,
                voice_id="cartesia-voice",
                language=Language.EN,
                api_key="test-key",
            )
        )
        assert isinstance(service, CartesiaTTSService)
        assert service._settings.voice == "cartesia-voice"
        assert service._settings.language == "en"
