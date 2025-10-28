#!/usr/bin/env python3
"""Pretty-print the turn-by-turn contents of a pickled Gemini invocation."""

from __future__ import annotations

import argparse
import pickle
from pathlib import Path
from textwrap import indent

try:
    from google.genai import types  # type: ignore[import]
except ImportError:
    types = None  # type: ignore[assignment]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Dump the turn history stored in a pickle emitted by GoogleLLMService "
            "or the replay harness."
        )
    )
    parser.add_argument(
        "pickle_path",
        nargs="?",
        default=Path("logs/google_llm_service_request.pkl"),
        type=Path,
        help="Path to the pickle file (default: logs/google_llm_service_request.pkl).",
    )
    return parser.parse_args()


def load_payload(path: Path) -> dict:
    if not path.exists():
        raise SystemExit(f"Pickle file not found: {path}")
    with path.open("rb") as handle:
        return pickle.load(handle)


def _to_dict(message: object) -> dict:
    if hasattr(message, "to_json_dict"):
        return message.to_json_dict()
    if hasattr(message, "model_dump"):
        return message.model_dump()
    if isinstance(message, dict):
        return message
    raise TypeError(f"Unsupported message type: {type(message)}")


def dump_turns(payload: dict) -> None:
    messages = payload.get("messages_json") or payload.get("contents") or payload.get("messages")
    if messages is None:
        raise SystemExit("Payload does not contain messages/contents.")

    normalized = [_to_dict(msg) for msg in messages]

    for idx, message in enumerate(normalized):
        role = message.get("role", "unknown")
        print(f"Turn {idx:02d} ({role})")
        parts = message.get("parts") or []
        if not parts:
            print("  (no parts)")
            continue
        for part in parts:
            if part.get("function_call"):
                print("  function_call:")
                print(indent(str(part["function_call"]), "    "))
            elif part.get("function_response"):
                print("  function_response:")
                print(indent(str(part["function_response"]), "    "))
            elif part.get("text"):
                text = part["text"]
                first_line = text.split("\n")[0]
                suffix = "..." if len(first_line) > 120 else ""
                print(f"  text: {first_line[:120]}{suffix}")
            else:
                print("  part:", part)
        print()


def main() -> None:
    args = parse_args()
    payload = load_payload(args.pickle_path)
    dump_turns(payload)


if __name__ == "__main__":
    main()
