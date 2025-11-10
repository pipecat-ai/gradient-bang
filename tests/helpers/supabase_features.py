"""Helpers for gating pytest suites on Supabase feature availability."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Iterable, List


FUNCTIONS_ROOT = Path(__file__).resolve().parents[2] / "supabase" / "functions"


@lru_cache(maxsize=1)
def _existing_functions() -> set[str]:
    if not FUNCTIONS_ROOT.exists():
        return set()
    return {
        entry.name
        for entry in FUNCTIONS_ROOT.iterdir()
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
