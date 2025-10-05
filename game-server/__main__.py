#!/usr/bin/env python3
"""Entry point for running the Gradient Bang server.

Run with: uv run -m game-server
Or from the game-server directory: uv run python -m .
Or directly: cd game-server && uv run python server.py
"""

import sys
from pathlib import Path

# Add game-server directory to path so we can import server module
GAME_SERVER_DIR = Path(__file__).parent
if str(GAME_SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(GAME_SERVER_DIR))

import uvicorn
from server import app

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
