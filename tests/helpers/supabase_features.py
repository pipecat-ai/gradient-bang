"""Helpers for gating pytest suites on Supabase feature availability."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Iterable, List

# Lazy import to get the configured SUPABASE_WORKDIR
def _get_functions_root() -> Path:
    """Get the Supabase functions directory from the configured workdir."""
    try:
        from tests.edge.conftest import SUPABASE_WORKDIR
        # SUPABASE_WORKDIR points to parent (e.g., deployment), supabase/ is a subdirectory
        return SUPABASE_WORKDIR / "supabase" / "functions"
    except ImportError:
        # Fallback if edge conftest is not available
        return Path.cwd() / "supabase" / "functions"


@lru_cache(maxsize=1)
def _existing_functions() -> set[str]:
    functions_root = _get_functions_root()
    if not functions_root.exists():
        return set()
    return {
        entry.name
        for entry in functions_root.iterdir()
        if entry.is_dir() and not entry.name.startswith("_")
    }


def missing_supabase_functions(required: Iterable[str]) -> List[str]:
    existing = _existing_functions()
    missing: List[str] = []
    for name in required:
        normalized = name.strip()
        if not normalized:
            continue
        if normalized not in existing:
            missing.append(normalized)
    return missing
