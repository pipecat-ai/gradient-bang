"""Common test path constants"""

from pathlib import Path

PROJECT_ROOT = Path.cwd()
TESTS_DIR = PROJECT_ROOT / "tests"
TEST_WORLD_DATA_DIR = TESTS_DIR / "test-world-data"
TEST_LOG_DIR = TESTS_DIR / "logs"