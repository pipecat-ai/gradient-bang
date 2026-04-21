#!/usr/bin/env python3
"""Regenerate tests/eval/EVALUATORS.md from the Cekura API.

Emits one markdown table per evaluator folder.

The Runs / Pass % columns and their supporting lookups are commented out for
now — they were live earlier but proved expensive and not especially useful
until the pass-rate computation is wired up. Re-enable by uncommenting the
marked blocks.

Run with `CEKURA_API_KEY` exported. No external dependencies.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

API_BASE = os.environ.get("CEKURA_API_BASE", "https://api.cekura.ai")
PROJECT_ID = int(os.environ.get("CEKURA_PROJECT_ID", "1779"))
FOLDERS = [
    "Alpha Sparrow",
    "Beta Kestrel",
    "Gamma Explorer",
    "Delta Fleet",
    "Epsilon Corp",
    "Phi Trader",
    "Orion Vale",
]
# LAST_DAYS = int(os.environ.get("EVALUATORS_LAST_DAYS", "14"))  # runs column disabled
OUT_PATH = Path(__file__).resolve().parent / "EVALUATORS.md"


def api_get(path: str, params: dict | None = None) -> dict:
    key = os.environ.get("CEKURA_API_KEY")
    if not key:
        sys.exit("CEKURA_API_KEY is not set")
    url = f"{API_BASE}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"X-CEKURA-API-KEY": key})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GET {url} -> {e.code}: {body[:400]}") from e


def list_scenarios_in_folder(folder: str) -> list[dict]:
    results: list[dict] = []
    page = 1
    while True:
        data = api_get(
            "/test_framework/v1/scenarios/",
            {
                "project_id": PROJECT_ID,
                "folder_path": folder,
                "page_size": 100,
                "page": page,
            },
        )
        results.extend(data.get("results", []))
        if not data.get("next"):
            break
        page += 1
    return results


# def count_recent_runs(run_ids: list[int], cutoff: datetime) -> int | None:
#     """Count how many of these runs were created after cutoff.
#
#     Best-effort: fetches runs in chunks via results_bulk endpoint. Returns
#     None if the run-count lookup errors out (caller prints '—').
#     """
#     if not run_ids:
#         return 0
#     # Cekura's /runs/bulk/ returns run rows keyed by the runs[] IDs on a scenario,
#     # each carrying a "timestamp" field we can filter in-memory.
#     count = 0
#     CHUNK = 50
#     for i in range(0, len(run_ids), CHUNK):
#         ids = run_ids[i : i + CHUNK]
#         try:
#             data = api_get(
#                 "/test_framework/v1/runs/bulk/",
#                 {"run_ids": ",".join(str(x) for x in ids)},
#             )
#         except RuntimeError:
#             return None
#         rows = data if isinstance(data, list) else data.get("results", [])
#         for row in rows:
#             ts_raw = row.get("timestamp") or row.get("created_at")
#             if not ts_raw:
#                 continue
#             try:
#                 ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
#             except ValueError:
#                 continue
#             if ts >= cutoff:
#                 count += 1
#     return count


_PERSONA_RE = re.compile(
    r"^you\s+are\s+[a-z0-9\s{}.\-'_,:]+\.?$", re.IGNORECASE
)
_FRAMING_SUBSTRINGS = (
    "you are playing gradient bang",
    "follow these steps one by one",
    "when the ship ai has performed",
    "scenario type:",
    "end call after response",
    "end the call",
    "after each step, wait for",
)


def paraphrase(text: str, limit: int = 180) -> str:
    """Compact first-meaningful-line paraphrase. Strips scenario tags,
    persona openers ("You are a ship commander."), and trailing framing
    clauses so the row column shows the actual action.
    """
    if not text:
        return ""
    t = re.sub(r"</?scenario>", "", text)
    t = t.replace("\\n", "\n")
    lines = [ln.strip(" \t-•*") for ln in t.splitlines() if ln.strip()]

    def _trim_trailing_framing(line: str) -> str:
        low = line.lower()
        # drop ' when ...' or ' after ...' suffixes that just describe timing
        for marker in (" when ", " after ", " once "):
            idx = low.find(marker)
            if idx > len(line) * 0.4:
                return line[:idx].rstrip(" ,.")
        return line

    for ln in lines:
        low = ln.lower()
        if any(sub in low for sub in _FRAMING_SUBSTRINGS):
            continue
        if _PERSONA_RE.match(ln):
            continue
        trimmed = _trim_trailing_framing(ln)
        s = " ".join(trimmed.split())
        if len(s) > limit:
            s = s[: limit - 1].rstrip() + "…"
        return s
    # Fallback: first non-empty line
    s = " ".join(lines[0].split()) if lines else ""
    if len(s) > limit:
        s = s[: limit - 1].rstrip() + "…"
    return s


def md_escape(s: str) -> str:
    return (s or "").replace("|", "\\|").replace("\n", " ").strip()


def main() -> None:
    # cutoff = datetime.now(timezone.utc) - timedelta(days=LAST_DAYS)  # runs column disabled
    rows_by_folder: dict[str, list[dict]] = {f: [] for f in FOLDERS}
    for folder in FOLDERS:
        print(f"Fetching folder: {folder}", file=sys.stderr)
        for sc in list_scenarios_in_folder(folder):
            profile = sc.get("test_profile_data") or {}
            info = profile.get("information") or {}
            character = info.get("character_name") or profile.get("name") or "—"
            # --- runs column: fetch disabled ---
            # scenarios list endpoint omits the `runs` field; fetch detail.
            # run_ids = sc.get("runs")
            # if run_ids is None:
            #     detail = api_get(f"/test_framework/v1/scenarios/{sc['id']}/")
            #     run_ids = detail.get("runs") or []
            # runs_recent = count_recent_runs(run_ids, cutoff)
            # -----------------------------------
            rows_by_folder[folder].append(
                {
                    "folder": folder,
                    "id": sc["id"],
                    "name": sc["name"],
                    "character": character,
                    "scenario": paraphrase(sc.get("instructions", "")),
                    "passing": paraphrase(sc.get("expected_outcome_prompt", "")),
                    # "runs_total": len(run_ids),
                    # "runs_recent": runs_recent if runs_recent is not None else "—",
                }
            )
    for folder in FOLDERS:
        rows_by_folder[folder].sort(key=lambda r: r["id"])

    header = (
        "# Evaluators\n\n"
        f"Auto-generated from the Cekura API. Regenerate with:\n\n"
        "```bash\n"
        "uv run tests/eval/generate_evaluators_md.py\n"
        "```\n\n"
        f"_Last regenerated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}. "
        f"Project {PROJECT_ID}._\n\n"
    )

    sections: list[str] = []
    for folder in FOLDERS:
        rows = rows_by_folder[folder]
        if not rows:
            continue
        if folder == "Orion Vale":
            section = (
                f"\n## {folder}\n\n"
                "Voice-agent scenarios bound to the Orion Vale world (agent 16197).\n\n"
                "| ID | Name | Character | Scenario | Passing criteria |\n"
                "|---|---|---|---|---|\n"
                # "| ID | Name | Character | Scenario | Passing criteria | "
                # f"Runs (last {LAST_DAYS}d) | Pass % |\n"
                # "|---|---|---|---|---|---|---|\n"
            )
            for r in rows:
                section += (
                    "| {id} | {name} | {char} | {scenario} | {passing} |\n".format(
                        # "| {id} | {name} | {char} | {scenario} | {passing} | {runs} | — |\n".format(
                        id=r["id"],
                        name=md_escape(r["name"]),
                        char=md_escape(r["character"]),
                        scenario=md_escape(r["scenario"]),
                        passing=md_escape(r["passing"]),
                        # runs=r.get("runs_recent", "—"),
                    )
                )
        else:
            section = (
                f"\n## {folder}\n\n"
                "| ID | Name | Character | Scenario | Passing criteria |\n"
                "|---|---|---|---|---|\n"
                # "| ID | Name | Character | Scenario | Passing criteria | "
                # f"Runs (last {LAST_DAYS}d) | Pass % |\n"
                # "|---|---|---|---|---|---|---|\n"
            )
            for r in rows:
                section += (
                    "| {id} | {name} | {char} | {scenario} | {passing} |\n".format(
                        # "| {id} | {name} | {char} | {scenario} | {passing} | {runs} | — |\n".format(
                        id=r["id"],
                        name=md_escape(r["name"]),
                        char=md_escape(r["character"]),
                        scenario=md_escape(r["scenario"]),
                        passing=md_escape(r["passing"]),
                        # runs=r.get("runs_recent", "—"),
                    )
                )
        sections.append(section)

    OUT_PATH.write_text(header + "".join(sections))
    total = sum(len(v) for v in rows_by_folder.values())
    print(f"Wrote {OUT_PATH} ({total} evaluators across {len([f for f in FOLDERS if rows_by_folder[f]])} folders)", file=sys.stderr)


if __name__ == "__main__":
    main()
