#!/usr/bin/env python3
"""Compare two AsyncGameClient payload dumps and report differences."""

from __future__ import annotations

import argparse
import json
import sys
from itertools import zip_longest
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tests.helpers.payload_assertions import COMPARERS  # noqa: E402


def load_events(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    mode = "unknown"
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            if record.get("record_type") == "meta":
                mode = record.get("mode", mode)
                continue
            if record.get("record_type") != "event":
                continue
            events.append(record["event"])

    if mode == "supabase":
        def _event_sort_key(event: dict[str, Any]) -> tuple[int, int]:
            event_id = event.get("__event_id")
            if not isinstance(event_id, int):
                ctx = event.get("payload", {}).get("__event_context", {})
                ctx_event_id = ctx.get("event_id") if isinstance(ctx, dict) else None
                if isinstance(ctx_event_id, int):
                    event_id = ctx_event_id
            if isinstance(event_id, int):
                return (event_id, 0)
            return (10**12, 0)

        events = sorted(events, key=_event_sort_key)

    return events


def compare(left: list[dict[str, Any]], right: list[dict[str, Any]]) -> list[str]:
    diffs: list[str] = []
    if len(left) != len(right):
        diffs.append(f"Event count mismatch: {len(left)} legacy vs {len(right)} supabase")
    for idx, (l_event, r_event) in enumerate(zip_longest(left, right)):
        if l_event == r_event:
            continue
        if l_event is None or r_event is None:
            diffs.append(f"Event {idx}: missing counterpart")
            continue
        l_name = l_event.get("event_name")
        r_name = r_event.get("event_name")
        comparer = COMPARERS.get(l_name) if l_name == r_name else None
        if comparer:
            result = comparer(l_event, r_event)
            if result.ok():
                continue
            diff_text = "\n- ".join(result.diffs)
            diffs.append(f"Event {idx} ({l_name}) differs:\n- {diff_text}")
            continue
        diffs.append(
            "Event {idx} differs:\nLegacy: {legacy}\nSupabase: {supabase}".format(
                idx=idx,
                legacy=json.dumps(l_event, sort_keys=True, indent=2),
                supabase=json.dumps(r_event, sort_keys=True, indent=2),
            )
        )
        if len(diffs) >= 5:
            break
    return diffs


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Compare AsyncGameClient payload dumps")
    parser.add_argument("legacy", type=Path)
    parser.add_argument("supabase", type=Path)
    args = parser.parse_args(argv)

    legacy_events = load_events(args.legacy)
    supabase_events = load_events(args.supabase)
    diffs = compare(legacy_events, supabase_events)
    if diffs:
        print("Payload mismatch detected:")
        for diff in diffs:
            print(diff)
        return 1
    print(
        f"Payloads match: {len(legacy_events)} events compared between {args.legacy} and {args.supabase}."
    )
    return 0


if __name__ == "__main__":
    import sys

    raise SystemExit(main(sys.argv[1:]))
