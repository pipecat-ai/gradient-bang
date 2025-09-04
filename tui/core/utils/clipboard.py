from __future__ import annotations

import subprocess

try:
    import pyperclip  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    pyperclip = None  # type: ignore


def copy_text(text: str) -> bool:
    """Copy text to system clipboard.

    Tries pyperclip first, then macOS pbcopy as a fallback.
    """
    if not isinstance(text, str):
        text = str(text)
    # Try pyperclip
    try:
        if pyperclip is not None:
            pyperclip.copy(text)  # type: ignore[attr-defined]
            return True
    except Exception:
        pass
    # Fallback to pbcopy (macOS)
    try:
        subprocess.run(["pbcopy"], input=text, text=True, check=True)
        return True
    except Exception:
        return False

