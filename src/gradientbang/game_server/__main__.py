#!/usr/bin/env python3
"""Entry point for running the Gradient Bang server.

Run with: uv run -m game-server
Or from the game-server directory: uv run python -m .
Or directly: cd game-server && uv run python server.py
"""

import os

import uvicorn

from gradientbang.game_server.server import app

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
