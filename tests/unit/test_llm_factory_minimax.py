"""Unit tests for MiniMax provider support in llm_factory."""

import os
from unittest.mock import MagicMock, patch

import pytest

from gradientbang.utils.llm_factory import (
    LLMProvider,
    LLMServiceConfig,
    _create_minimax_service,
    _get_api_key,
    create_llm_service,
    get_task_agent_llm_config,
    get_ui_agent_llm_config,
    get_voice_llm_config,
)


@pytest.mark.unit
class TestMiniMaxProviderEnum:
    def test_minimax_in_provider_enum(self):
        assert LLMProvider.MINIMAX in LLMProvider
        assert LLMProvider.MINIMAX.value == "minimax"

    def test_minimax_parseable_from_string(self):
        assert LLMProvider("minimax") == LLMProvider.MINIMAX

    def test_all_providers_present(self):
        values = {p.value for p in LLMProvider}
        assert values == {"google", "anthropic", "openai", "minimax"}


@pytest.mark.unit
class TestMiniMaxApiKey:
    def test_minimax_api_key_env_var(self):
        with patch.dict(os.environ, {"MINIMAX_API_KEY": "test-key-123"}):
            key = _get_api_key(LLMProvider.MINIMAX)
        assert key == "test-key-123"

    def test_minimax_api_key_override(self):
        key = _get_api_key(LLMProvider.MINIMAX, override="override-key")
        assert key == "override-key"

    def test_minimax_api_key_missing_raises(self):
        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop("MINIMAX_API_KEY", None)
            with pytest.raises(ValueError, match="MINIMAX_API_KEY"):
                _get_api_key(LLMProvider.MINIMAX)


@pytest.mark.unit
class TestCreateMiniMaxService:
    @patch("gradientbang.utils.llm_factory.OpenAILLMService", create=True)
    def test_creates_openai_service_with_minimax_base_url(self, _mock):
        from unittest.mock import call

        from pipecat.services.openai.llm import OpenAILLMService

        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MINIMAX_BASE_URL", None)
            with patch("pipecat.services.openai.llm.OpenAILLMService") as mock_cls:
                mock_cls.return_value = MagicMock()
                mock_cls.Settings = OpenAILLMService.Settings
                _create_minimax_service(api_key="test-key", model="MiniMax-M2.7")
                mock_cls.assert_called_once()
                _, kwargs = mock_cls.call_args
                assert kwargs["api_key"] == "test-key"
                assert "api.minimax.io/v1" in kwargs["base_url"]

    @patch("gradientbang.utils.llm_factory.OpenAILLMService", create=True)
    def test_respects_minimax_base_url_env_var(self, _mock):
        from pipecat.services.openai.llm import OpenAILLMService

        with patch.dict(os.environ, {"MINIMAX_BASE_URL": "https://custom.minimax.io/v1"}):
            with patch("pipecat.services.openai.llm.OpenAILLMService") as mock_cls:
                mock_cls.return_value = MagicMock()
                mock_cls.Settings = OpenAILLMService.Settings
                _create_minimax_service(api_key="test-key", model="MiniMax-M2.7")
                _, kwargs = mock_cls.call_args
                assert kwargs["base_url"] == "https://custom.minimax.io/v1"

    def test_default_temperature_is_1(self):
        """MiniMax does not accept temperature=0; default must be 1.0."""
        with patch.dict(os.environ, {"MINIMAX_API_KEY": "test-key"}):
            service = _create_minimax_service(api_key="test-key", model="MiniMax-M2.7")
            assert service._settings.temperature == 1.0

    def test_passes_function_call_timeout(self):
        from pipecat.services.openai.llm import OpenAILLMService

        with patch("pipecat.services.openai.llm.OpenAILLMService") as mock_cls:
            mock_cls.return_value = MagicMock()
            mock_cls.Settings = OpenAILLMService.Settings
            _create_minimax_service(
                api_key="test-key", model="MiniMax-M2.7", function_call_timeout_secs=30.0
            )
            _, kwargs = mock_cls.call_args
            assert kwargs["function_call_timeout_secs"] == 30.0


@pytest.mark.unit
class TestCreateLLMServiceMiniMax:
    def test_create_llm_service_routes_minimax(self):
        config = LLMServiceConfig(
            provider=LLMProvider.MINIMAX,
            model="MiniMax-M2.7",
            api_key="test-key",
        )
        with patch(
            "gradientbang.utils.llm_factory._create_minimax_service"
        ) as mock_minimax:
            mock_minimax.return_value = MagicMock()
            create_llm_service(config)
            mock_minimax.assert_called_once_with("test-key", "MiniMax-M2.7", None)

    def test_create_llm_service_minimax_with_timeout(self):
        config = LLMServiceConfig(
            provider=LLMProvider.MINIMAX,
            model="MiniMax-M2.7-highspeed",
            api_key="test-key",
            function_call_timeout_secs=15.0,
        )
        with patch(
            "gradientbang.utils.llm_factory._create_minimax_service"
        ) as mock_minimax:
            mock_minimax.return_value = MagicMock()
            create_llm_service(config)
            mock_minimax.assert_called_once_with("test-key", "MiniMax-M2.7-highspeed", 15.0)


@pytest.mark.unit
class TestMiniMaxDefaultModels:
    def test_voice_llm_config_minimax_default_model(self):
        with patch.dict(
            os.environ,
            {"VOICE_LLM_PROVIDER": "minimax", "MINIMAX_API_KEY": "k"},
            clear=False,
        ):
            os.environ.pop("VOICE_LLM_MODEL", None)
            config = get_voice_llm_config()
        assert config.provider == LLMProvider.MINIMAX
        assert config.model == "MiniMax-M2.7"

    def test_task_llm_config_minimax_default_model(self):
        with patch.dict(
            os.environ,
            {"TASK_LLM_PROVIDER": "minimax", "MINIMAX_API_KEY": "k"},
            clear=False,
        ):
            os.environ.pop("TASK_LLM_MODEL", None)
            config = get_task_agent_llm_config()
        assert config.provider == LLMProvider.MINIMAX
        assert config.model == "MiniMax-M2.7"

    def test_ui_agent_llm_config_minimax_default_model(self):
        with patch.dict(
            os.environ,
            {"UI_AGENT_LLM_PROVIDER": "minimax", "MINIMAX_API_KEY": "k"},
            clear=False,
        ):
            os.environ.pop("UI_AGENT_LLM_MODEL", None)
            config = get_ui_agent_llm_config()
        assert config.provider == LLMProvider.MINIMAX
        assert config.model == "MiniMax-M2.7"

    def test_voice_llm_config_minimax_custom_model(self):
        with patch.dict(
            os.environ,
            {
                "VOICE_LLM_PROVIDER": "minimax",
                "VOICE_LLM_MODEL": "MiniMax-M2.7-highspeed",
                "MINIMAX_API_KEY": "k",
            },
            clear=False,
        ):
            config = get_voice_llm_config()
        assert config.model == "MiniMax-M2.7-highspeed"
