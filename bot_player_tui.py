#!/usr/bin/env python3
"""Entry point for the bot-driven Gradient Bang TUI.

Starts a LocalMacTransport, launches the bot (pipecat/bot.py) inside the
TUI, and updates the same UI panels as the player TUI based on RTVI
server messages.
"""

import argparse
import os
import sys
from pathlib import Path
import importlib

# Add project root to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from tui.bot_player_app import BotPlayerApp
from voice_tui_kit.core.utils.imports import import_bot_module


def main():
    parser = argparse.ArgumentParser(
        description="Gradient Bang Bot TUI - Voice-first player interface via Pipecat"
    )
    parser.add_argument(
        "--no-bot",
        action="store_true",
        help="Start UI only (do not start bot module)",
    )
    parser.add_argument(
        "--bot-module",
        default=str(Path(__file__).parent / "pipecat" / "bot.py"),
        help="Path or module to bot (default: ./pipecat/bot.py)",
    )
    args = parser.parse_args()

    if args.no_bot:
        os.environ["TUI_NO_BOT"] = "1"

    # Prefer file-path import to avoid collisions with installed 'pipecat' package
    try:
        bot_arg = args.bot_module
        if os.path.exists(bot_arg):
            bot_module = import_bot_module(bot_arg)
        else:
            bot_module = importlib.import_module(bot_arg)
    except Exception as e:
        print(f"Error importing bot module '{args.bot_module}': {e}")
        sys.exit(1)

    app = BotPlayerApp(bot_module)
    print("Starting Gradient Bang Bot TUI…")
    print("- Voice I/O via LocalMacTransport")
    print("- Ctrl+L toggles logs; Ctrl+N toggles RTVI views; Ctrl+Q quits")
    app.run()


if __name__ == "__main__":
    main()
