"""Test helper for mapping human-readable character names to canonical IDs."""

from __future__ import annotations

import os
from functools import lru_cache

from utils.legacy_ids import canonicalize_character_id

os.environ.setdefault("SUPABASE_ALLOW_LEGACY_IDS", "1")


@lru_cache(maxsize=None)
def char_id(label: str) -> str:
    """Return canonical UUID for the given test character label."""

    if not label:
        raise ValueError("character label cannot be empty")
    normalized = label.strip()
    if not normalized:
        raise ValueError("character label cannot be blank")
    return canonicalize_character_id(normalized)

