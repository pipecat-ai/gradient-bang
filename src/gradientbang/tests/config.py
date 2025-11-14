"""Common test path constants"""

from pathlib import Path

PROJECT_ROOT = Path.cwd()
TESTS_DIR = PROJECT_ROOT / "src" / "gradientbang" / "tests"
TEST_WORLD_DATA_DIR = PROJECT_ROOT / ".test-world-data"
TEST_LOG_DIR = TEST_WORLD_DATA_DIR / "logs"