#!/usr/bin/env python3
"""Reset both the legacy filesystem universe and the Supabase database to test fixtures."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Iterable, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tests.helpers.server_fixture import copy_test_world_data


def _reset_supabase_state(character_ids: Optional[Iterable[str]] = None) -> None:
    try:
        from tests.helpers.supabase_reset import reset_supabase_state
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            "tests.helpers.supabase_reset.reset_supabase_state is unavailable; "
            "ensure psycopg and Supabase env vars are installed"
        ) from exc

    reset_supabase_state(character_ids)


def reset_legacy_world(world_data_dir: str) -> None:
    copy_test_world_data(world_data_dir)


def reset_supabase(character_ids: Optional[Iterable[str]] = None) -> None:
    _reset_supabase_state(character_ids)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Reset both test worlds to fixture state")
    parser.add_argument(
        "--world-data-dir",
        default="world-data",
        help="Destination for legacy world-data copy (default: world-data)",
    )
    parser.add_argument(
        "--character",
        action="append",
        dest="characters",
        help="Optional character ID(s) to seed. Defaults to all fixtures when omitted.",
    )
    parser.add_argument("--skip-legacy", action="store_true", help="Skip filesystem reset")
    parser.add_argument("--skip-supabase", action="store_true", help="Skip Supabase reset")
    args = parser.parse_args(argv)

    if args.skip_legacy and args.skip_supabase:
        parser.error("Nothing to do: both resets were skipped")

    if not args.skip_legacy:
        reset_legacy_world(args.world_data_dir)
        print(f"Legacy world data copied into {args.world_data_dir} from tests/test-world-data")

    if not args.skip_supabase:
        reset_supabase(args.characters)
        print("Supabase state reset from tests/test-world-data fixtures")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
