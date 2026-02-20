#!/usr/bin/env -S uv run python
"""
Quest Data Loader for Supabase

Loads quest definitions from JSON files into Supabase tables:
- quest_definitions
- quest_step_definitions
- quest_event_subscriptions

Each JSON file represents one quest. The loader upserts by quest code,
so it's safe to re-run after editing quest data.

Usage:
    # Load quest JSON files from a directory
    uv run -m gradientbang.scripts.load_quests_to_supabase --from-json quest-data/

    # Force reload (delete all quest definitions and re-insert)
    uv run -m gradientbang.scripts.load_quests_to_supabase --from-json quest-data/ --force

    # Dry-run validation
    uv run -m gradientbang.scripts.load_quests_to_supabase --from-json quest-data/ --dry-run
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List

from supabase import create_client, Client


class QuestLoader:
    """Loads quest data from JSON files into Supabase."""

    def __init__(self, supabase_url: str, supabase_key: str, dry_run: bool = False):
        self.supabase: Client = create_client(supabase_url, supabase_key)
        self.dry_run = dry_run
        self.stats = {
            "quests_loaded": 0,
            "steps_loaded": 0,
            "subscriptions_loaded": 0,
        }

    def load_json(self, filepath: Path) -> Dict[str, Any]:
        """Load and parse a JSON file."""
        print(f"  Loading {filepath}...")
        with open(filepath, "r") as f:
            data = json.load(f)
        return data

    def validate_quest(self, quest: Dict[str, Any], filepath: Path) -> None:
        """Validate a quest JSON structure."""
        required = ["code", "name", "steps"]
        for key in required:
            if key not in quest:
                raise ValueError(f"{filepath.name}: missing required key '{key}'")

        if not isinstance(quest["steps"], list) or len(quest["steps"]) == 0:
            raise ValueError(f"{filepath.name}: 'steps' must be a non-empty array")

        seen_indexes = set()
        for i, step in enumerate(quest["steps"]):
            step_required = ["step_index", "name", "eval_type", "event_types", "target_value"]
            for key in step_required:
                if key not in step:
                    raise ValueError(
                        f"{filepath.name}: step {i} missing required key '{key}'"
                    )

            idx = step["step_index"]
            if idx in seen_indexes:
                raise ValueError(
                    f"{filepath.name}: duplicate step_index {idx}"
                )
            seen_indexes.add(idx)

            valid_eval_types = ("count", "count_filtered", "aggregate", "unique_count")
            if step["eval_type"] not in valid_eval_types:
                raise ValueError(
                    f"{filepath.name}: step {idx} invalid eval_type '{step['eval_type']}'"
                )

            if not isinstance(step["event_types"], list) or len(step["event_types"]) == 0:
                raise ValueError(
                    f"{filepath.name}: step {idx} 'event_types' must be a non-empty array"
                )

    def load_quest(self, quest: Dict[str, Any]) -> None:
        """Load a single quest into Supabase (upsert by code)."""
        code = quest["code"]

        # 1. Upsert quest definition
        quest_row = {
            "code": code,
            "name": quest["name"],
            "description": quest.get("description"),
            "assign_on_creation": quest.get("assign_on_creation", False),
            "is_repeatable": quest.get("is_repeatable", False),
            "enabled": quest.get("enabled", True),
            "meta": quest.get("meta", {}),
        }

        if self.dry_run:
            print(f"  [DRY RUN] Would upsert quest '{code}' with {len(quest['steps'])} steps")
            self.stats["quests_loaded"] += 1
            self.stats["steps_loaded"] += len(quest["steps"])
            for step in quest["steps"]:
                self.stats["subscriptions_loaded"] += len(step["event_types"])
            return

        # Upsert quest definition, get back the id
        result = (
            self.supabase.table("quest_definitions")
            .upsert(quest_row, on_conflict="code")
            .execute()
        )
        quest_id = result.data[0]["id"]

        # 2. Delete existing steps and subscriptions for this quest
        #    (CASCADE from quest_step_definitions will remove subscriptions too)
        self.supabase.table("quest_step_definitions").delete().eq(
            "quest_id", quest_id
        ).execute()

        # 3. Insert steps and subscriptions
        for step in quest["steps"]:
            step_row = {
                "quest_id": quest_id,
                "step_index": step["step_index"],
                "name": step["name"],
                "description": step.get("description"),
                "eval_type": step["eval_type"],
                "event_types": step["event_types"],
                "target_value": step["target_value"],
                "payload_filter": step.get("payload_filter", {}),
                "aggregate_field": step.get("aggregate_field"),
                "unique_field": step.get("unique_field"),
                "enabled": step.get("enabled", True),
                "meta": step.get("meta", {}),
            }

            step_result = (
                self.supabase.table("quest_step_definitions")
                .insert(step_row)
                .execute()
            )
            step_id = step_result.data[0]["id"]
            self.stats["steps_loaded"] += 1

            # Insert event subscriptions for this step
            for event_type in step["event_types"]:
                self.supabase.table("quest_event_subscriptions").upsert(
                    {"event_type": event_type, "step_id": step_id},
                    on_conflict="event_type,step_id",
                ).execute()
                self.stats["subscriptions_loaded"] += 1

        self.stats["quests_loaded"] += 1
        print(f"  Loaded quest '{code}' ({len(quest['steps'])} steps)")

    def check_existing_quests(self) -> int:
        """Check how many quest definitions exist."""
        result = (
            self.supabase.table("quest_definitions")
            .select("code", count="exact")
            .execute()
        )
        return result.count or 0

    def truncate_quests(self) -> None:
        """Delete all quest definitions (cascades to steps, subscriptions)."""
        print("\n  Deleting existing quest data...")
        if self.dry_run:
            print("  [DRY RUN] Would delete all quest definitions")
            return

        self.supabase.table("quest_definitions").delete().neq(
            "code", ""
        ).execute()
        print("  Deleted all quest definitions")

    def load(self, data_path: Path) -> None:
        """Main load process."""
        # Find all JSON files
        if data_path.is_file() and data_path.suffix == ".json":
            json_files = [data_path]
        elif data_path.is_dir():
            json_files = sorted(data_path.glob("*.json"))
        else:
            raise FileNotFoundError(f"Not a JSON file or directory: {data_path}")

        if not json_files:
            raise FileNotFoundError(f"No JSON files found in {data_path}")

        print(f"\n  Found {len(json_files)} quest file(s)")

        # Load and validate all files first
        quests: List[Dict[str, Any]] = []
        for filepath in json_files:
            quest = self.load_json(filepath)
            self.validate_quest(quest, filepath)
            quests.append(quest)

        print(f"  Validated {len(quests)} quest(s)")

        # Load each quest
        print()
        for quest in quests:
            self.load_quest(quest)

        # Print summary
        print("\n" + "=" * 60)
        print("Quest load complete!")
        print("=" * 60)
        print(f"Quests loaded:         {self.stats['quests_loaded']}")
        print(f"Steps loaded:          {self.stats['steps_loaded']}")
        print(f"Subscriptions loaded:  {self.stats['subscriptions_loaded']}")
        print("=" * 60)


def main():
    parser = argparse.ArgumentParser(description="Load quest data into Supabase")
    parser.add_argument(
        "--from-json",
        dest="data_path",
        type=Path,
        required=True,
        help="Path to quest JSON file or directory containing quest JSON files",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force reload (delete all existing quest definitions first)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate files without loading to database",
    )
    parser.add_argument(
        "--env",
        dest="env_file",
        type=Path,
        default=None,
        help="Path to .env file to load (e.g. .env.supabase)",
    )

    args = parser.parse_args()

    # Load .env file if specified
    if args.env_file:
        from dotenv import load_dotenv
        if not args.env_file.exists():
            print(f"Error: env file not found: {args.env_file}")
            sys.exit(1)
        load_dotenv(args.env_file, override=True)

    # Get Supabase credentials
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

    if not supabase_url or not supabase_key:
        print("Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables required")
        print("  Set these in .env file or environment")
        sys.exit(1)

    print("=" * 60)
    print("Quest Data Loader for Supabase")
    print("=" * 60)
    print(f"Data path:      {args.data_path}")
    print(f"Supabase URL:   {supabase_url}")
    print(f"Dry run:        {args.dry_run}")
    print(f"Force reload:   {args.force}")
    print("=" * 60)

    try:
        loader = QuestLoader(supabase_url, supabase_key, dry_run=args.dry_run)

        # Check for existing data
        if not args.dry_run:
            existing = loader.check_existing_quests()
            if existing > 0 and not args.force:
                print(f"\n  {existing} quest(s) already exist in database.")
                print("  The loader will upsert (update existing, insert new).")
                print("  Use --force to delete all quest data and reload from scratch.")
                print()

            if args.force:
                loader.truncate_quests()

        loader.load(args.data_path)

        print("\nSuccess!")
        sys.exit(0)

    except Exception as e:
        print(f"\nError: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
