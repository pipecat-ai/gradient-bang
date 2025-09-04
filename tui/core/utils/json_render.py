import json
from typing import Any


def compact_json(payload: Any) -> str:
    try:
        return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    except Exception:
        return safe_str(payload)


def pretty_json(payload: Any, indent: int = 2) -> str:
    try:
        return json.dumps(payload, indent=indent, ensure_ascii=False)
    except Exception:
        return safe_str(payload)


def safe_str(value: Any) -> str:
    try:
        return str(value)
    except Exception:
        return "<unprintable>"

