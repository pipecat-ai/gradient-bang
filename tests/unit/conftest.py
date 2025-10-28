"""Pytest configuration for game-server tests."""

import sys
from pathlib import Path

# Add game-server directory to Python path
GAME_SERVER_DIR = Path(__file__).parent.parent
if str(GAME_SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(GAME_SERVER_DIR))
