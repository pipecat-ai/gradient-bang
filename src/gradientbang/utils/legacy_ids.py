"""Helpers for handling legacy (non-UUID) character identifiers."""

from __future__ import annotations

import os
import uuid


LEGACY_NAMESPACE = uuid.UUID(
    os.environ.get("SUPABASE_LEGACY_ID_NAMESPACE", "5a53c4f5-8f16-4be6-8d3d-2620f4c41b3b")
)
SHIP_NAMESPACE = uuid.UUID(
    os.environ.get("SUPABASE_SHIP_ID_NAMESPACE", "b7b87641-1c44-4ed1-8e9c-5f671484b1a9")
)


def _allow_legacy_ids() -> bool:
    return os.environ.get("SUPABASE_ALLOW_LEGACY_IDS", "0").strip().lower() in {
        "1",
        "true",
        "on",
        "yes",
    }


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