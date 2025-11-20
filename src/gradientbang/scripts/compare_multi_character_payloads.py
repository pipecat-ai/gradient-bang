#!/usr/bin/env python3
"""Compare payload dumps for multi-character tests by filtering each character separately."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent


def get_character_ids(jsonl_path: Path) -> set[str]:
    """Extract all unique character_ids from a JSONL dump."""
    character_ids: set[str] = set()
    with jsonl_path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            if record.get("record_type") != "event":
                continue
            char_id = record.get("character_id")
            if char_id:
                character_ids.add(char_id)
    return character_ids


def compare_character(
    legacy_path: Path,
    supabase_path: Path,
    character_id: str,
) -> tuple[bool, str]:
    """Compare events for a specific character."""
    cmd = [
        "uv",
        "run",
        "python",
        str(REPO_ROOT / "scripts" / "compare_payloads.py"),
        str(legacy_path),
        str(supabase_path),
        "--character-id",
        character_id,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.returncode == 0, result.stdout + result.stderr


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Compare multi-character payload dumps by character"
    )
    parser.add_argument("legacy", type=Path, help="Legacy JSONL dump")
    parser.add_argument("supabase", type=Path, help="Supabase JSONL dump")
    args = parser.parse_args(argv)

    # Get all character_ids from both dumps
    legacy_chars = get_character_ids(args.legacy)
    supabase_chars = get_character_ids(args.supabase)
    all_chars = legacy_chars | supabase_chars

    if not all_chars:
        print("No character_ids found in dumps (single-character test?)")
        print("Use compare_payloads.py directly for single-character tests.")
        return 1

    print(f"Found {len(all_chars)} character(s): {', '.join(sorted(all_chars))}")
    print()

    all_passed = True
    for char_id in sorted(all_chars):
        print(f"Comparing events for character: {char_id}")
        passed, output = compare_character(args.legacy, args.supabase, char_id)
        if passed:
            print(f"  ✓ {output.strip()}")
        else:
            print(f"  ✗ Mismatch detected:")
            for line in output.strip().split("\n"):
                print(f"    {line}")
            all_passed = False
        print()

    if all_passed:
        print(f"All {len(all_chars)} character(s) match!")
        return 0
    else:
        print("Some character(s) have mismatches.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
