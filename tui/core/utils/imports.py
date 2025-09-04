from __future__ import annotations

import importlib
import importlib.util
import os
import sys
from types import ModuleType


def import_bot_module(path_or_module: str) -> ModuleType:
    """Import a bot module from a module path or a .py file path.

    - If ``path_or_module`` points to an existing .py file, load it via
      importlib.util and register as ``bot_module``.
    - Otherwise treat it as a normal module path and import it.
    """
    if os.path.exists(path_or_module) and path_or_module.endswith(".py"):
        spec = importlib.util.spec_from_file_location("bot_module", path_or_module)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"Unable to import bot file: {path_or_module}")
        mod = importlib.util.module_from_spec(spec)
        sys.modules["bot_module"] = mod
        spec.loader.exec_module(mod)  # type: ignore[attr-defined]
        return mod
    return importlib.import_module(path_or_module)

