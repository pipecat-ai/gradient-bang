import os
from pathlib import Path


def get_world_data_path() -> Path:
    base = os.getenv("WORLD_DATA_DIR")
    if base:
        return Path(base)
    # Default relative to repo root (three levels up from this file)
    return Path(__file__).parent.parent.parent / "world-data"

