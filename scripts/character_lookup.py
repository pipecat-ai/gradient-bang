#!/usr/bin/env python3
"""Lookup a character ID by name using the local registry."""

from __future__ import annotations

import argparse
import sys

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "game-server"))

from core.character_registry import CharacterRegistry
from core.config import get_world_data_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Lookup a character UUID by display name.")
    parser.add_argument("name", help="Display name to search for")
    args = parser.parse_args()

    registry_path = get_world_data_path() / "characters.json"
    registry = CharacterRegistry(registry_path)
    registry.load()
    profile = registry.find_by_name(args.name)
    if not profile:
        print(f"No character found with name '{args.name}'", file=sys.stderr)
        return 1
    print(profile.character_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
