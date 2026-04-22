"""Voice registry — maps short names to voice IDs and language codes."""

VOICES: dict[str, dict] = {
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

DEFAULT_VOICE = "ariel"
