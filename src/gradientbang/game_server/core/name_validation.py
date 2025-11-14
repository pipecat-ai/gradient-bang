"""Character name validation hooks."""

from __future__ import annotations

from loguru import logger


def _default_name_hook(name: str) -> str | bool:
    logger.info("validate_character_name called for name=%r", name)
    return name


NAME_VALIDATION_HOOK = _default_name_hook


def ensure_safe_character_name(name: str) -> str:
    """Run the pluggable name hook and return the sanitized name."""
    result = NAME_VALIDATION_HOOK(name)
    if result is False:
        raise ValueError("Character name rejected by safety hook")
    if isinstance(result, str):
        return result
    raise ValueError("Character name hook must return string or False")
