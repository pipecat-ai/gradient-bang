#!/usr/bin/env python3
"""Run payload parity checks for multiple tests in batch."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from datetime import datetime, timezone

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.double_run_payload_parity import main as run_single_parity


# Test suites to verify after fixes
BANK_OPERATIONS_TESTS = [
    "tests/integration/test_bank_operations.py::TestBankOperations::test_deposit_credits_in_sector_0",
    "tests/integration/test_bank_operations.py::TestBankOperations::test_withdraw_credits_in_sector_0",
]

CARGO_SALVAGE_TESTS = [
    "tests/integration/test_cargo_salvage.py::TestCargoSalvage::test_dump_cargo_creates_salvage",
    "tests/integration/test_cargo_salvage.py::TestCargoSalvage::test_retrieve_own_dumped_cargo",
    "tests/integration/test_cargo_salvage.py::TestCargoSalvage::test_another_player_retrieve_salvage",
    "tests/integration/test_cargo_salvage.py::TestCargoSalvage::test_dump_then_move_new_player_arrives",
]

TEST_SUITES = {
    "bank": BANK_OPERATIONS_TESTS,
    "salvage": CARGO_SALVAGE_TESTS,
    "all": BANK_OPERATIONS_TESTS + CARGO_SALVAGE_TESTS,
}


def run_batch(test_nodes: list[str]) -> dict[str, int]:
    """Run payload parity for multiple tests and return results."""
    results = {}
    total = len(test_nodes)

    print(f"\n{'='*80}")
    print(f"Running payload parity for {total} tests")
    print(f"{'='*80}\n")

    for idx, test_node in enumerate(test_nodes, 1):
        print(f"\n[{idx}/{total}] Testing: {test_node}")
        print("-" * 80)

        # Temporarily override sys.argv to pass args to double_run_payload_parity
        original_argv = sys.argv
        try:
            sys.argv = ["double_run_payload_parity.py", test_node]
            exit_code = run_single_parity()
            results[test_node] = exit_code

            status = "✅ MATCH" if exit_code == 0 else "❌ MISMATCH"
            print(f"\n{status}: {test_node}\n")

        except Exception as e:
            print(f"❌ ERROR: {test_node} - {e}\n")
            results[test_node] = -1
        finally:
            sys.argv = original_argv

    return results


def print_summary(results: dict[str, int]) -> None:
    """Print summary of results."""
    print("\n" + "="*80)
    print("PAYLOAD PARITY SUMMARY")
    print("="*80 + "\n")

    matches = sum(1 for code in results.values() if code == 0)
    mismatches = sum(1 for code in results.values() if code != 0)
    total = len(results)

    print(f"Total: {total} | Matches: {matches} | Mismatches: {mismatches}\n")

    if matches > 0:
        print("✅ MATCHING:")
        for test_node, code in results.items():
            if code == 0:
                print(f"  - {test_node}")
        print()

    if mismatches > 0:
        print("❌ MISMATCHES/ERRORS:")
        for test_node, code in results.items():
            if code != 0:
                print(f"  - {test_node} (exit code: {code})")
        print()

    # Save summary to file
    summary_file = REPO_ROOT / "logs" / "payload-parity" / "batch_summary.txt"
    summary_file.parent.mkdir(parents=True, exist_ok=True)

    with summary_file.open("w") as f:
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        f.write(f"Payload Parity Batch Summary - {timestamp}\n")
        f.write(f"{'='*80}\n\n")
        f.write(f"Total: {total} | Matches: {matches} | Mismatches: {mismatches}\n\n")

        if matches > 0:
            f.write("MATCHING:\n")
            for test_node, code in results.items():
                if code == 0:
                    f.write(f"  ✅ {test_node}\n")
            f.write("\n")

        if mismatches > 0:
            f.write("MISMATCHES/ERRORS:\n")
            for test_node, code in results.items():
                if code != 0:
                    f.write(f"  ❌ {test_node} (exit code: {code})\n")
            f.write("\n")

    print(f"Summary saved to: {summary_file}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run payload parity checks for multiple tests"
    )
    parser.add_argument(
        "suite",
        nargs="?",
        choices=["bank", "salvage", "all"],
        default="all",
        help="Test suite to run (default: all)",
    )
    parser.add_argument(
        "--tests",
        nargs="+",
        help="Specific test node IDs to run (overrides suite)",
    )

    args = parser.parse_args()

    if args.tests:
        test_nodes = args.tests
    else:
        test_nodes = TEST_SUITES[args.suite]

    results = run_batch(test_nodes)
    print_summary(results)

    # Return 0 if all matched, 1 otherwise
    return 0 if all(code == 0 for code in results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
