#!/usr/bin/env python3
"""Run legacy + Supabase integration tests and compare AsyncGameClient payloads."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts import reset_test_state

LOG_ROOT = REPO_ROOT / "logs" / "payload-parity"


def _sanitize(name: str) -> str:
    sanitized = [ch if ch.isalnum() else "_" for ch in name]
    return "".join(sanitized).strip("_") or "test"


def _write_log(path: Path, message: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(message)
        if not message.endswith("\n"):
            handle.write("\n")


def _reset_legacy_world(log_path: Path) -> None:
    with open(log_path, "w", encoding="utf-8") as log:
        try:
            log.write("Resetting legacy world-data from tests/test-world-data...\n")
            reset_test_state.reset_legacy_world("world-data")
            log.write("Legacy world-data refreshed.\n")
        except Exception as exc:  # noqa: BLE001
            log.write(f"Legacy reset failed: {exc}\n")
            raise


def _reset_supabase(log_path: Path) -> None:
    try:
        reset_test_state.reset_supabase()
        _write_log(log_path, "Supabase reset completed via helper.")
    except Exception as exc:  # noqa: BLE001
        _write_log(log_path, f"Supabase reset skipped (will rely on pytest fixtures): {exc}")


def _run_subprocess(
    name: str,
    cmd: list[str],
    env: Dict[str, str],
    log_path: Path,
) -> int:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "w", encoding="utf-8") as log:
        log.write(f"$ {' '.join(cmd)}\n\n")
        process = subprocess.run(
            cmd,
            cwd=REPO_ROOT,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        return process.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description="Double-run payload parity harness")
    parser.add_argument("test_node", help="Pytest node id, e.g. tests/...::Test::test_case")
    parser.add_argument(
        "--supabase-url",
        default=os.environ.get("SUPABASE_URL", "http://127.0.0.1:54321"),
    )
    parser.add_argument(
        "--edge-token",
        default=os.environ.get("EDGE_API_TOKEN", "testtoken"),
    )
    parser.add_argument(
        "--service-role",
        default=os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "testkey"),
    )
    parser.add_argument(
        "--anon-key",
        default=os.environ.get("SUPABASE_ANON_KEY", "anonkey"),
    )
    parser.add_argument(
        "--api-token",
        default=os.environ.get("SUPABASE_API_TOKEN", "testtoken"),
    )
    args = parser.parse_args()

    slug = _sanitize(args.test_node)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    run_dir = LOG_ROOT / slug / timestamp
    run_dir.mkdir(parents=True, exist_ok=True)

    legacy_dump = run_dir / "events.legacy.jsonl"
    supabase_dump = run_dir / "events.supabase.jsonl"

    print(f"Logs -> {run_dir}")

    _reset_legacy_world(run_dir / "step1_legacy_reset.log")
    _reset_supabase(run_dir / "step2_supabase_reset.log")

    base_env = os.environ.copy()

    legacy_env = base_env.copy()
    legacy_env["ASYNC_CLIENT_PAYLOAD_DUMP"] = str(legacy_dump)
    legacy_cmd = [
        "uv",
        "run",
        "python",
        "scripts/payload_capture_runner.py",
        args.test_node,
        "-q",
    ]
    legacy_rc = _run_subprocess(
        "legacy",
        legacy_cmd,
        legacy_env,
        run_dir / "step3_legacy_test.log",
    )
    if legacy_rc != 0:
        print("Legacy run failed; see step3 log.")
        return legacy_rc

    supabase_env = base_env.copy()
    is_cloud = "supabase.co" in args.supabase_url
    supabase_env.update(
        {
            "ASYNC_CLIENT_PAYLOAD_DUMP": str(supabase_dump),
            "USE_SUPABASE_TESTS": "1",
            "SUPABASE_TRANSPORT": "1",
            "SUPABASE_URL": args.supabase_url,
            "EDGE_API_TOKEN": args.edge_token,
            "SUPABASE_SERVICE_ROLE_KEY": args.service_role,
            "SUPABASE_ANON_KEY": args.anon_key,
            "SUPABASE_API_TOKEN": args.api_token,
            "SUPABASE_MANUAL_STACK": "1" if is_cloud else "0",
        }
    )
    supabase_cmd = [
        "uv",
        "run",
        "python",
        "scripts/payload_capture_runner.py",
        args.test_node,
        "-q",
    ]
    supabase_rc = _run_subprocess(
        "supabase",
        supabase_cmd,
        supabase_env,
        run_dir / "step4_supabase_test.log",
    )
    if supabase_rc != 0:
        print("Supabase run failed; see step4 log.")
        return supabase_rc

    compare_cmd = [
        "uv",
        "run",
        "python",
        "scripts/compare_payloads.py",
        str(legacy_dump),
        str(supabase_dump),
    ]
    compare_rc = _run_subprocess(
        "compare",
        compare_cmd,
        base_env,
        run_dir / "step5_compare.log",
    )
    if compare_rc == 0:
        print("Payloads match; see step5 log for details.")
    else:
        print("Payload mismatch detected; inspect step5 log and JSON dumps.")
    return compare_rc


if __name__ == "__main__":
    raise SystemExit(main())
