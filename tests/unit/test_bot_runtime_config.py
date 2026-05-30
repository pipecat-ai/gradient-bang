import pytest

from gradientbang.bot import BotRuntimeConfig

pytestmark = pytest.mark.unit


def test_bot_runtime_config_collects_bypass_tutorial_body_param() -> None:
    config = BotRuntimeConfig.from_body(
        {
            "voice": "Pilot",
            "voice_id": "voice-id",
            "personality_tone": "dry",
            "bypass_tutorial": True,
        }
    )

    assert config.voice_name == "Pilot"
    assert config.voice_id_hint == "voice-id"
    assert config.personality_tone == "dry"
    assert config.bypass_tutorial is True


def test_bot_runtime_config_parses_string_boolean_body_param() -> None:
    assert BotRuntimeConfig.from_body({"bypass_tutorial": "false"}).bypass_tutorial is False
    assert BotRuntimeConfig.from_body({"bypass_tutorial": "true"}).bypass_tutorial is True
