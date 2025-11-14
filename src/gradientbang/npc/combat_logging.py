"""Shared logging utilities for NPC combat CLIs."""

from __future__ import annotations

import logging
import sys
from typing import Iterable, Mapping

DEFAULT_TIME_FORMAT = "%H:%M:%S"
DEFAULT_LOG_FORMAT = "%(asctime)s %(levelname)s %(message)s"


def configure_logger(
    name: str = "npc.combat",
    *,
    verbose: bool = False,
    stream = sys.stdout,
) -> logging.Logger:
    """Return a configured logger for combat utilities."""

    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler(stream)
        handler.setFormatter(logging.Formatter(DEFAULT_LOG_FORMAT, DEFAULT_TIME_FORMAT))
        logger.addHandler(handler)
    logger.setLevel(logging.DEBUG if verbose else logging.INFO)
    logger.propagate = False
    return logger


def format_participant_summary(participants: Iterable[Mapping[str, object]]) -> str:
    """Return a human-readable summary line for combat participants."""

    pieces: list[str] = []
    for entry in participants:
        name = str(entry.get("name") or entry.get("combatant_id") or "?")
        fighters = entry.get("fighters")
        shields = entry.get("shields")
        fighters_text = f"{fighters}" if fighters is not None else "?"
        shields_text = f"{shields}" if shields is not None else "?"
        pieces.append(f"{name} (F:{fighters_text} S:{shields_text})")
    return ", ".join(pieces)


__all__ = ["configure_logger", "format_participant_summary"]
