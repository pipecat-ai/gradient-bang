"""Unit tests for provider-aware bot voices."""

import pytest

from gradientbang.pipecat_server.voices import (
    CARTESIA_VOICES,
    DEFAULT_VOICE,
    GRADIUM_DEFAULT_VOICE_ID,
    get_default_voice_id,
    get_voice_config,
    get_voices_for_provider,
)


@pytest.mark.unit
class TestProviderVoices:
    def test_cartesia_ids_are_preserved(self):
        assert CARTESIA_VOICES["ariel"]["voice_id"] == "ec1e269e-9ca0-402f-8a18-58e0e022355a"
        assert CARTESIA_VOICES["sterling"]["voice_id"] == "79a125e8-cd45-4c13-8a67-188112f4dd22"
        assert CARTESIA_VOICES["dani"]["voice_id"] == "11af83e2-23eb-452f-956e-7fee218ccb5c"
        assert CARTESIA_VOICES["caine"]["voice_id"] == "c45bc5ec-dc68-4feb-8829-6e6b2748095d"
        assert CARTESIA_VOICES["voss"]["voice_id"] == "db69127a-dbaf-4fa9-b425-2fe67680c348"
        assert CARTESIA_VOICES["gordon"]["voice_id"] == "36b42fcb-60c5-4bec-b077-cb1a00a92ec6"

    def test_gradium_exposes_current_voice_names(self):
        cartesia_names = set(get_voices_for_provider("cartesia"))
        gradium_names = set(get_voices_for_provider("gradium"))
        assert gradium_names == cartesia_names

    def test_gradium_voices_use_default_gradium_voice_id(self):
        for voice in get_voices_for_provider("gradium").values():
            assert voice["voice_id"] == GRADIUM_DEFAULT_VOICE_ID

    def test_default_gradium_voice_id_resolves(self):
        assert DEFAULT_VOICE == "ariel"
        assert get_default_voice_id("gradium") == GRADIUM_DEFAULT_VOICE_ID

    def test_unknown_provider_defaults_to_gradium(self):
        assert get_voice_config("ariel", "unknown") == {
            "voice_id": GRADIUM_DEFAULT_VOICE_ID,
            "language": "en",
        }
