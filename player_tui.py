#!/usr/bin/env python3
"""Entry point for the Gradient Bang player TUI."""

import argparse
import os
import sys
from pathlib import Path

# Add current directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from tui.player_app import PlayerApp


def main():
    """Main entry point for the player TUI."""
    parser = argparse.ArgumentParser(
        description="Gradient Bang Player TUI - Interactive terminal interface for space trading"
    )
    
    parser.add_argument(
        "character_id",
        help="Character ID to play as"
    )
    
    parser.add_argument(
        "--server",
        default="http://localhost:8000",
        help="Game server URL (default: http://localhost:8000)"
    )
    
    parser.add_argument(
        "--chat-model",
        default="gpt-4.1",
        help="LLM model for chat agent (default: gpt-4.1)"
    )
    
    parser.add_argument(
        "--task-model",
        default="gpt-5",
        help="LLM model for task agent (default: gpt-5)"
    )
    
    args = parser.parse_args()
    
    # Check for OpenAI API key
    if not os.getenv("OPENAI_API_KEY"):
        print("Error: OPENAI_API_KEY environment variable not set")
        print("Please set it with: export OPENAI_API_KEY='your-key'")
        sys.exit(1)
    
    # Create and run the app
    app = PlayerApp(
        character_id=args.character_id,
        server_url=args.server,
        chat_model=args.chat_model,
        task_model=args.task_model
    )
    
    print(f"Starting Gradient Bang Player TUI for character '{args.character_id}'...")
    print(f"Connecting to server at {args.server}...")
    print(f"Chat model: {args.chat_model}, Task model: {args.task_model}")
    print("Press F1 for help once the interface loads.")
    
    app.run()


if __name__ == "__main__":
    main()