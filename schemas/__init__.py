"""Helpers for working with JSON Schemas bundled with Gradient Bang."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict

PACKAGE_ROOT = Path(__file__).resolve().parent


@lru_cache(maxsize=None)
def load_schema(name: str) -> Dict[str, Any]:
    """Load a schema by filename (without extension)."""
    path = PACKAGE_ROOT / f"{name}.schema.json"
    if not path.exists():
        raise FileNotFoundError(f"Schema '{name}' not found at {path}")
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


__all__ = ["load_schema"]
