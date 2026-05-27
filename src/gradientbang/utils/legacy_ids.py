"""Helpers for handling legacy (non-UUID) character identifiers."""

from __future__ import annotations

import uuid

from gradientbang.config import settings

LEGACY_NAMESPACE = uuid.UUID(settings.SUPABASE_LEGACY_ID_NAMESPACE)
SHIP_NAMESPACE = uuid.UUID(settings.SUPABASE_SHIP_ID_NAMESPACE)


def _allow_legacy_ids() -> bool:
    return settings.SUPABASE_ALLOW_LEGACY_IDS


def canonicalize_character_id(character_id: str) -> str:
    """Return a UUID string for the given character identifier.

    When the input is already a valid UUID string it is returned unchanged.
    When legacy IDs are allowed, the identifier is deterministically mapped to a
    UUID v5 using a stable namespace. Otherwise a ValueError is raised.
    """

    character_id = character_id.strip()
    try:
        return str(uuid.UUID(character_id))
    except ValueError:
        if not _allow_legacy_ids():
            raise
        return str(uuid.uuid5(LEGACY_NAMESPACE, character_id))


def deterministic_ship_id(label: str) -> str:
    """Return a stable UUID for ship identifiers derived from a label."""

    label = label.strip()
    if not label:
        raise ValueError("Ship label cannot be empty")
    return str(uuid.uuid5(SHIP_NAMESPACE, label))
