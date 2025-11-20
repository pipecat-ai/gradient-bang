#!/usr/bin/env python3
"""Query the event log with filtering and formatting options."""

from __future__ import annotations

import argparse
import asyncio
import fnmatch
import json
import os
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

<<<<<<< HEAD:scripts/event_query.py
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "game-server"))

# Conditional import: Use Supabase client if SUPABASE_URL is set, otherwise use legacy
if os.getenv("SUPABASE_URL"):
    from gradientbang.utils.supabase_client import AsyncGameClient
    from gradientbang.utils.api_client import RPCError
else:
    from gradientbang.utils.api_client import AsyncGameClient, RPCError
=======
from gradientbang.utils.api_client import AsyncGameClient, RPCError
>>>>>>> main:src/gradientbang/scripts/event_query.py


def parse_relative_time(duration_str: str) -> timedelta:
    """Parse relative time strings like '1h', '30m', '7d' into timedelta.

    Supported units:
    - s: seconds
    - m: minutes
    - h: hours
    - d: days
    """
    duration_str = duration_str.strip().lower()

    # Extract number and unit
    if duration_str[-1] in ('s', 'm', 'h', 'd'):
        unit = duration_str[-1]
        try:
            value = float(duration_str[:-1])
        except ValueError:
            raise ValueError(f"Invalid duration format: {duration_str}")
    else:
        raise ValueError(f"Invalid duration format: {duration_str} (must end with s/m/h/d)")

    # Convert to timedelta
    if unit == 's':
        return timedelta(seconds=value)
    elif unit == 'm':
        return timedelta(minutes=value)
    elif unit == 'h':
        return timedelta(hours=value)
    elif unit == 'd':
        return timedelta(days=value)
    else:
        raise ValueError(f"Unknown time unit: {unit}")


def parse_timestamp(ts_str: str) -> datetime:
    """Parse ISO timestamp or relative time into datetime."""
    # Check if it's a relative time (ends with s/m/h/d)
    if ts_str and ts_str[-1] in ('s', 'm', 'h', 'd'):
        delta = parse_relative_time(ts_str)
        return datetime.now(timezone.utc) - delta

    # Parse as ISO timestamp
    try:
        dt = datetime.fromisoformat(ts_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError as exc:
        raise ValueError(f"Invalid timestamp format: {ts_str}. Use ISO format or relative time (1h, 30m, 7d)") from exc


def filter_events_by_type(events: List[Dict[str, Any]], pattern: str) -> List[Dict[str, Any]]:
    """Filter events by event name pattern (supports wildcards)."""
    return [
        event for event in events
        if fnmatch.fnmatch(event.get("event", ""), pattern)
    ]


def truncate_value(value: Any, max_length: int = 60) -> str:
    """Truncate long values for display."""
    value_str = str(value)
    if len(value_str) > max_length:
        return value_str[:max_length-3] + "..."
    return value_str


def format_table(events: List[Dict[str, Any]], verbose: bool = False, no_truncate: bool = False) -> str:
    """Format events as a readable table."""
    if not events:
        return "No events found."

    lines = []
    max_val_len = None if no_truncate else 60

    for i, event in enumerate(events, 1):
        timestamp = event.get("timestamp", "")
        event_name = event.get("event", "unknown")
        sender = event.get("sender", "")
        receiver = event.get("receiver", "")
        sector = event.get("sector")
        direction = event.get("direction", "")

        # Header line
        lines.append(f"\n[{i}] {timestamp}")
        lines.append(f"  Event: {event_name}")
        lines.append(f"  Direction: {direction}")

        if sender:
            lines.append(f"  Sender: {sender}")
        if receiver:
            lines.append(f"  Receiver: {receiver}")
        if sector is not None:
            lines.append(f"  Sector: {sector}")

        # Payload
        if verbose:
            payload = event.get("payload", {})
            lines.append(f"  Payload: {json.dumps(payload, indent=4)}")
        else:
            payload = event.get("payload", {})
            if payload:
                # Show truncated payload preview
                payload_str = json.dumps(payload)
                if max_val_len:
                    payload_str = truncate_value(payload_str, max_val_len)
                lines.append(f"  Payload: {payload_str}")

    return "\n".join(lines)


def format_summary(events: List[Dict[str, Any]]) -> str:
    """Format event counts by type."""
    if not events:
        return "No events found."

    event_counts = Counter(event.get("event", "unknown") for event in events)

    lines = [f"Total events: {len(events)}\n"]
    lines.append("Event counts by type:")

    # Sort by count descending
    for event_name, count in event_counts.most_common():
        lines.append(f"  {event_name}: {count}")

    return "\n".join(lines)


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Query the event log with filtering options.",
        epilog="""
Examples:
  # Player mode: Recent events
  %(prog)s <character_id> --last 1h

  # Admin mode: All events in time range
  %(prog)s --admin-password <pass> --start "2025-11-01T00:00:00Z" --end "2025-11-01T23:59:59Z"

  # Filter by sector and event type
  %(prog)s <character_id> --last 24h --sector 5 --event-type "combat.*"

  # Corporation-wide activity (requires membership)
  %(prog)s <character_id> --last 2h --corporation-id <corp_uuid>

  # Summary view
  %(prog)s --admin-password <pass> --last 1h --summary
        """,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    # Character ID (positional, optional)
    parser.add_argument(
        "character_id",
        nargs="?",
        help="Character ID to query from (player mode)",
    )

    # Admin mode
    parser.add_argument(
        "--admin-password",
        help="Admin password (admin mode - sees all events)",
    )

    # Time range
    time_group = parser.add_argument_group("time range (required)")
    time_group.add_argument(
        "--start",
        help="Start time (ISO format or relative: '1h', '30m', '7d')",
    )
    time_group.add_argument(
        "--end",
        help="End time (ISO format, default: now)",
    )
    time_group.add_argument(
        "--last",
        help="Shortcut for recent events (e.g., '1h', '30m', '7d'). Equivalent to --start <now-duration> --end now",
    )

    # Filters
    filter_group = parser.add_argument_group("filters (optional)")
    filter_group.add_argument(
        "--sector",
        type=int,
        help="Filter to events in sector N",
    )
    filter_group.add_argument(
        "--corporation-id",
        help="Filter to corporation events",
    )
    filter_group.add_argument(
        "--event-type",
        help="Filter by event name (supports wildcards, e.g., 'combat.*', 'trade.executed')",
    )

    # Output options
    output_group = parser.add_argument_group("output options")
    output_group.add_argument(
        "--json",
        action="store_true",
        help="Output raw JSON instead of formatted table",
    )
    output_group.add_argument(
        "--summary",
        action="store_true",
        help="Show only event counts by type",
    )
    output_group.add_argument(
        "--limit",
        type=int,
        help="Show only first N results",
    )
    output_group.add_argument(
        "--tail",
        type=int,
        help="Show only last N results",
    )
    output_group.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Show full event payloads (table mode only)",
    )
    output_group.add_argument(
        "--no-truncate",
        action="store_true",
        help="Don't truncate long payload values (table mode only)",
    )

    # Display options
    parser.add_argument(
        "--server",
        default="http://localhost:8000",
        help="Server base URL (default: %(default)s)",
    )

    args = parser.parse_args()

    # Validate mode
    is_admin_mode = args.admin_password is not None
    if not is_admin_mode and not args.character_id:
        print("Error: Either provide character_id (player mode) or --admin-password (admin mode)", file=sys.stderr)
        return 1

    # Parse time range
    try:
        if args.last:
            # Shortcut: --last 1h means start=now-1h, end=now
            if args.start or args.end:
                print("Error: Cannot use --last with --start or --end", file=sys.stderr)
                return 1
            end_time = datetime.now(timezone.utc)
            start_time = end_time - parse_relative_time(args.last)
        else:
            # Explicit start/end
            if not args.start:
                print("Error: --start is required (or use --last)", file=sys.stderr)
                return 1

            start_time = parse_timestamp(args.start)
            if args.end:
                end_time = parse_timestamp(args.end)
            else:
                end_time = datetime.now(timezone.utc)
    except ValueError as exc:
        print(f"Error parsing time range: {exc}", file=sys.stderr)
        return 1

    # Build request payload
    request_payload: Dict[str, Any] = {
        "start": start_time.isoformat(),
        "end": end_time.isoformat(),
    }

    if args.character_id:
        request_payload["character_id"] = args.character_id

    if args.admin_password:
        request_payload["admin_password"] = args.admin_password

    if args.sector is not None:
        request_payload["sector"] = args.sector

    if args.corporation_id:
        request_payload["corporation_id"] = args.corporation_id

    # Query events
    try:
        client_id = args.character_id or "admin-tool"
        async with AsyncGameClient(
            base_url=args.server,
            character_id=client_id,
        ) as client:
            await client.identify(character_id=client_id)

            result = await client._request("event.query", request_payload)

            events = result.get("events", [])
            count = result.get("count", 0)
            truncated = result.get("truncated", False)

            # Client-side filtering by event type
            if args.event_type:
                events = filter_events_by_type(events, args.event_type)
                count = len(events)

            # Apply limit/tail
            if args.tail:
                events = events[-args.tail:]
            elif args.limit:
                events = events[:args.limit]

            # Output results
            if args.json:
                # Raw JSON output
                output = {
                    "events": events,
                    "count": count,
                    "truncated": truncated,
                }
                print(json.dumps(output, indent=2))
            elif args.summary:
                # Summary counts
                print(format_summary(events))
            else:
                # Formatted table
                print(format_table(events, verbose=args.verbose, no_truncate=args.no_truncate))

            # Show truncation warning
            if truncated:
                print(f"\n⚠ Warning: Results truncated at 1024 events. Use more specific filters.", file=sys.stderr)

            return 0

    except RPCError as exc:
        print(f"Query failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Unexpected error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
