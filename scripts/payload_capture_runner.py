#!/usr/bin/env python3
"""Run pytest while capturing AsyncGameClient event payloads via monkey patch."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any
import threading

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import pytest  # type: ignore


def _json_default(value: Any) -> Any:
    if isinstance(value, (datetime,)):
        return value.isoformat()
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:
            pass
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, set):
        return sorted(value)
    if hasattr(value, "__dict__"):
        return dict(value.__dict__)
    return str(value)


def _install_capture_patch(dump_path: Path, test_id: str) -> None:
    dump_path.parent.mkdir(parents=True, exist_ok=True)
    fh = dump_path.open("w", encoding="utf-8")
    lock = threading.Lock()

    def write_record(record: dict[str, Any]) -> None:
        with lock:
            fh.write(json.dumps(record, default=_json_default))
            fh.write("\n")
            fh.flush()

    write_record(
        {
            "record_type": "meta",
            "test_id": test_id,
            "mode": "supabase"
            if os.getenv("USE_SUPABASE_TESTS")
            else "legacy",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    )

    from utils import api_client as legacy_api_client

    original_deliver = legacy_api_client.LegacyAsyncGameClient._deliver_event
    counter = {"value": 0}

    def patched_deliver(self, event_name: str, event_message: dict) -> None:  # type: ignore[override]
        serialized_event = json.loads(
            json.dumps(event_message, default=_json_default)
        )
        record = {
            "record_type": "event",
            "index": counter["value"],
            "event_name": event_name,
            "event": serialized_event,
        }
        counter["value"] += 1
        write_record(record)
        original_deliver(self, event_name, event_message)

    legacy_api_client.LegacyAsyncGameClient._deliver_event = patched_deliver  # type: ignore[assignment]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Run pytest with payload capture")
    parser.add_argument("pytest_args", nargs=argparse.REMAINDER, help="Args for pytest")
    args = parser.parse_args(argv)

    dump_path_env = os.getenv("ASYNC_CLIENT_PAYLOAD_DUMP")
    if not dump_path_env:
        print("ASYNC_CLIENT_PAYLOAD_DUMP env var is required", file=sys.stderr)
        return 2

    dump_path = Path(dump_path_env)
    test_id = " ".join(args.pytest_args) if args.pytest_args else "pytest"
    _install_capture_patch(dump_path, test_id)

    pytest_args = args.pytest_args or []
    return pytest.main(pytest_args)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
