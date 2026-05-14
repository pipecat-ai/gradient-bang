"""Provider-aware voice registry for bot TTS."""

from __future__ import annotations

import os
from typing import Any

CARTESIA_VOICES: dict[str, dict[str, str]] = {
    "ariel": {"voice_id": "ec1e269e-9ca0-402f-8a18-58e0e022355a", "language": "en"},
    "sterling": {"voice_id": "79a125e8-cd45-4c13-8a67-188112f4dd22", "language": "en"},
    "dani": {"voice_id": "11af83e2-23eb-452f-956e-7fee218ccb5c", "language": "en"},
    "caine": {"voice_id": "c45bc5ec-dc68-4feb-8829-6e6b2748095d", "language": "en"},
    "voss": {"voice_id": "db69127a-dbaf-4fa9-b425-2fe67680c348", "language": "en"},
    "gordon": {"voice_id": "36b42fcb-60c5-4bec-b077-cb1a00a92ec6", "language": "en"},
    "taylan": {"voice_id": "fa7bfcdc-603c-4bf1-a600-a371400d2f8c", "language": "tr"},
    "priya": {"voice_id": "faf0731e-dfb9-4cfc-8119-259a79b27e12", "language": "hi"},
    "lucia": {"voice_id": "9d8c6b2e-0a23-4a15-ae1b-121d5b5af417", "language": "es"},
    "celeste": {"voice_id": "7c58f4a4-a72c-42fa-a503-41b9408820f3", "language": "fr"},
    "estrela": {"voice_id": "8d826d43-20ad-4c56-8d37-1048eccca1bf", "language": "pt"},
    "marco": {"voice_id": "ee16f140-f6dc-490e-a1ed-c1d537ea0086", "language": "it"},
}

GRADIUM_DEFAULT_VOICE_ID = "YTpq7expH9539ERJ"
GRADIUM_VOICES: dict[str, dict[str, str]] = {
    "ariel": {"voice_id": GRADIUM_DEFAULT_VOICE_ID, "language": "en"},
    "sterling": {"voice_id": "7c5UOKm7AiBgJADg", "language": "en"},
    "dani": {"voice_id": "WHINGSh2X5oidrhY", "language": "en"},
    "caine": {"voice_id": "vzanWTXLIajkUaaT", "language": "en"},
    "voss": {"voice_id": "LFZvm12tW_z0xfGo", "language": "en"},
    "gordon": {"voice_id": "LFZvm12tW_z0xfGo", "language": "en"},
    "taylan": {"voice_id": GRADIUM_DEFAULT_VOICE_ID, "language": "tr"},
    "priya": {"voice_id": GRADIUM_DEFAULT_VOICE_ID, "language": "hi"},
    "lucia": {"voice_id": "PqjKPYFyGNsg1YU-", "language": "es"},
    "celeste": {"voice_id": "biPZlD1tJvi7Ixhq", "language": "fr"},
    "estrela": {"voice_id": "pYcGZz9VOo4n2ynh", "language": "pt"},
    "marco": {"voice_id": GRADIUM_DEFAULT_VOICE_ID, "language": "it"},
}

PROVIDER_VOICES: dict[str, dict[str, dict[str, str]]] = {
    "cartesia": CARTESIA_VOICES,
    "gradium": GRADIUM_VOICES,
}

DEFAULT_VOICE = "ariel"

# Backwards-compatible alias for older Cartesia-only imports.
VOICES = CARTESIA_VOICES
DEFAULT_VOICE_ID = CARTESIA_VOICES[DEFAULT_VOICE]["voice_id"]


def normalize_tts_provider(provider: Any = None) -> str:
    """Return a supported TTS provider name, defaulting to the current env."""
    if provider is None:
        provider_value = os.getenv("TTS_PROVIDER", "gradium")
    else:
        provider_value = getattr(provider, "value", provider)
    provider_name = str(provider_value).strip().lower()
    return provider_name if provider_name in PROVIDER_VOICES else "gradium"


def get_voices_for_provider(provider: Any = None) -> dict[str, dict[str, str]]:
    """Return the short-name voice registry for a TTS provider."""
    return PROVIDER_VOICES[normalize_tts_provider(provider)]


def get_voice_config(voice_name: str, provider: Any = None) -> dict[str, str] | None:
    """Return one short-name voice config for the selected provider."""
    return get_voices_for_provider(provider).get(voice_name)


def get_default_voice_id(provider: Any = None) -> str:
    """Return the default short-name voice ID for the selected provider."""
    return get_voices_for_provider(provider)[DEFAULT_VOICE]["voice_id"]
