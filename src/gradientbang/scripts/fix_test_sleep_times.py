#!/usr/bin/env python3
"""
Fix test sleep times for Supabase polling mode (1.0s poll interval).

Events arrive via polling every 1.0s, so tests need to wait at least:
- 1.5s after actions to ensure events have arrived (poll + processing buffer)
- Keep longer waits (>= 1.5s) unchanged

This script updates asyncio.sleep() calls that wait for event delivery.
"""

import re
import sys
from pathlib import Path

# Sleep times shorter than this need adjustment
MIN_EVENT_WAIT = 1.5

# Patterns that indicate waiting for events (not timing/rate-limiting)
EVENT_WAIT_PATTERNS = [
    r"# Wait for.*event",
    r"# Let.*connect",
    r"# Wait.*propagat",
    r"# Wait.*deliver",
    r"# Allow.*event",
    r"# Event.*propagation",
]


def should_fix_sleep(line_before: str, sleep_line: str, sleep_value: float) -> bool:
    """Determine if this sleep() call should be adjusted."""
    if sleep_value >= MIN_EVENT_WAIT:
        return False  # Already long enough

    # Check if comment indicates this is for event waiting
    combined = line_before + " " + sleep_line
    for pattern in EVENT_WAIT_PATTERNS:
        if re.search(pattern, combined, re.IGNORECASE):
            return True

    # Common patterns in test code
    if any(phrase in combined.lower() for phrase in [
        "wait for", "let it", "allow", "propagat", "deliver", "event",
        "final events", "in-flight", "remaining"
    ]):
        return True

    return False


def fix_sleep_times(file_path: Path, dry_run: bool = True) -> tuple[int, list[str]]:
    """Fix sleep times in a test file. Returns (count, changes)."""
    lines = file_path.read_text().splitlines(keepends=True)
    changes = []
    count = 0

    for i, line in enumerate(lines):
        # Match asyncio.sleep(N.M) or asyncio.sleep(N)
        match = re.search(r'await\s+asyncio\.sleep\((\d+\.?\d*)\)', line)
        if not match:
            continue

        sleep_value = float(match.group(1))
        line_before = lines[i-1] if i > 0 else ""

        if should_fix_sleep(line_before, line, sleep_value):
            new_sleep = MIN_EVENT_WAIT
            old_line = line
            new_line = re.sub(
                r'await\s+asyncio\.sleep\(\d+\.?\d*\)',
                f'await asyncio.sleep({new_sleep})',
                line
            )

            # Add inline comment if not present
            if "# " not in new_line and sleep_value < 1.0:
                indent = len(new_line) - len(new_line.lstrip())
                new_line = new_line.rstrip() + f"  # Supabase polling: wait for events\n"

            lines[i] = new_line
            count += 1
            changes.append(f"  Line {i+1}: {sleep_value}s → {new_sleep}s")

    if not dry_run and count > 0:
        file_path.write_text("".join(lines))

    return count, changes


def main():
    dry_run = "--apply" not in sys.argv
    test_dir = Path("tests/integration")

    if not test_dir.exists():
        print(f"Error: {test_dir} not found")
        return 1

    total_changes = 0
    files_changed = []

    for test_file in sorted(test_dir.glob("test_*.py")):
        count, changes = fix_sleep_times(test_file, dry_run=dry_run)
        if count > 0:
            total_changes += count
            files_changed.append(test_file.name)
            print(f"\n{test_file.name}: {count} change(s)")
            for change in changes:
                print(change)

    print(f"\n{'[DRY RUN] ' if dry_run else ''}Summary:")
    print(f"  Files affected: {len(files_changed)}")
    print(f"  Total changes: {total_changes}")

    if dry_run and total_changes > 0:
        print("\nRun with --apply to make changes")

    return 0


if __name__ == "__main__":
    sys.exit(main())
