"""Common test path constants"""

import os
from pathlib import Path

PROJECT_ROOT = Path.cwd()
TESTS_DIR = PROJECT_ROOT / "tests"
TEST_WORLD_DATA_DIR = TESTS_DIR / "test-world-data"
TEST_LOG_DIR = TESTS_DIR / "logs"

# Supabase working directory (configurable via --supabase-dir or SUPABASE_WORKDIR env var)
# This will be updated by pytest_configure in conftest.py if --supabase-dir is provided
# Note: This points to the directory CONTAINING supabase/ subdirectory (e.g., 'deployment')
# The Supabase CLI expects: --workdir deployment (which contains supabase/config.toml, supabase/functions/, etc.)
_supabase_workdir_override = os.environ.get('SUPABASE_WORKDIR')
if _supabase_workdir_override:
    SUPABASE_WORKDIR = Path(_supabase_workdir_override).resolve()
else:
    # Try deployment first (contains supabase/ subdirectory)
    SUPABASE_WORKDIR = (PROJECT_ROOT / 'deployment').resolve()
    if not (SUPABASE_WORKDIR / 'supabase').exists():
        # Fall back to project root (if it contains supabase/ subdirectory)
        if (PROJECT_ROOT / 'supabase').exists():
            SUPABASE_WORKDIR = PROJECT_ROOT
        else:
            # Last resort: use deployment/supabase directly
            SUPABASE_WORKDIR = (PROJECT_ROOT / 'deployment' / 'supabase').resolve()
