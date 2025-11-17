import os
from pathlib import Path


def get_world_data_path(ensure_exists: bool = False) -> Path:
    """Get world-data path (must run from repo root or set WORLD_DATA_DIR).
    
    Args:
        ensure_exists: If True, raises error if directory doesn't exist.
                      If False, returns path even if it doesn't exist (for creation).
                      Default is False to allow graceful startup.
    """
    env_path = os.getenv("WORLD_DATA_DIR")
    if env_path:
        return Path(env_path)
    
    # Assume CWD is repo root
    world_data = Path.cwd() / "world-data"
    
    if ensure_exists and not world_data.exists():
        raise RuntimeError(
            f"world-data not found at {world_data}. "
            f"Please run from repo root or set WORLD_DATA_DIR environment variable."
        )
    
    return world_data


def get_repo_root() -> Path:
    """Get repo root (must run from repo root or set REPO_ROOT)."""
    env_path = os.getenv("REPO_ROOT")
    if env_path:
        return Path(env_path)
    
    # Assume CWD is repo root - validate by checking for pyproject.toml
    repo_root = Path.cwd()
    
    if not (repo_root / "pyproject.toml").exists():
        raise RuntimeError(
            f"pyproject.toml not found at {repo_root}. "
            f"Please run from repo root or set REPO_ROOT environment variable."
        )
    
    return repo_root
