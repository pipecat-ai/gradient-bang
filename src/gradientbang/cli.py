#!/usr/bin/env python3
"""CLI entry points for Gradient Bang.

Provides clean commands for running bots, NPCs, and tests with different
environment configurations (local Supabase, cloud Supabase, legacy game-server).
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path

def _get_repo_root() -> Path:
    """Return the repository root directory."""
    return Path.cwd()


def _load_env_file(env_file: Path) -> dict[str, str]:
    """Load environment variables from a .env file."""
    env = {}
    if not env_file.exists():
        return env

    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                env[key.strip()] = value.strip()
    return env


def _detect_environment(args) -> tuple[str, Path]:
    """Detect which environment to use based on flags.

    Returns:
        Tuple of (mode_name, env_file_path)
    """
    repo_root = _get_repo_root()

    # Check for explicit flags
    if hasattr(args, 'local') and args.local:
        return ('local', repo_root / '.env.supabase')
    if hasattr(args, 'cloud') and args.cloud:
        return ('cloud', repo_root / '.env.cloud')
    if hasattr(args, 'legacy') and args.legacy:
        return ('legacy', repo_root / '.env.legacy')

    # Auto-detect from existing SUPABASE_URL
    if 'SUPABASE_URL' in os.environ:
        url = os.environ['SUPABASE_URL']
        if '127.0.0.1' in url or 'localhost' in url:
            return ('local', repo_root / '.env.supabase')
        else:
            return ('cloud', repo_root / '.env.cloud')

    # Default to local
    return ('local', repo_root / '.env.supabase')


def _setup_environment(mode: str, env_file: Path) -> dict[str, str]:
    """Set up environment variables for the given mode.

    Args:
        mode: One of 'local', 'cloud', 'legacy'
        env_file: Path to .env file to load

    Returns:
        Environment dict to use for subprocess
    """
    env = os.environ.copy()

    # Check that env file exists
    if not env_file.exists():
        print(f"ERROR: Environment file not found: {env_file}", file=sys.stderr)
        print("\nExpected environment files:", file=sys.stderr)
        print("  .env.supabase - Local Supabase development", file=sys.stderr)
        print("  .env.cloud - Cloud Supabase production", file=sys.stderr)
        print("  .env.legacy - Legacy game-server WebSocket", file=sys.stderr)
        sys.exit(1)

    # Load environment file
    env_vars = _load_env_file(env_file)
    env.update(env_vars)

    # Set mode-specific variables
    if mode in ('local', 'cloud'):
        env['SUPABASE_USE_POLLING'] = '1'
        env['SUPABASE_ALLOW_LEGACY_IDS'] = '1'

    # Check for local Supabase running
    if mode == 'local':
        try:
            import socket
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            result = sock.connect_ex(('127.0.0.1', 54321))
            sock.close()
            if result != 0:
                print("WARNING: Supabase doesn't appear to be running on port 54321", file=sys.stderr)
                print("Start it with: supabase start", file=sys.stderr)
                print("\nContinuing anyway...\n", file=sys.stderr)
        except Exception:
            pass

    return env


def run_bot():
    """Entry point for 'gb-bot' command - runs the Pipecat voice bot."""
    parser = argparse.ArgumentParser(
        description="Start the Pipecat voice bot",
        epilog="All unrecognized arguments are passed through to the bot."
    )
    parser.add_argument('--local', action='store_true',
                       help='Use local Supabase development (.env.supabase)')
    parser.add_argument('--cloud', action='store_true',
                       help='Use cloud Supabase production (.env.cloud)')
    parser.add_argument('--legacy', action='store_true',
                       help='Use legacy game-server WebSocket (.env.legacy)')

    args, remaining = parser.parse_known_args()

    # Detect environment
    mode, env_file = _detect_environment(args)
    env = _setup_environment(mode, env_file)

    # Build command
    repo_root = _get_repo_root()
    os.chdir(repo_root)
    cmd = ['python', 'src/gradientbang/pipecat_server/bot.py'] + remaining

    # Show what we're running
    print(f"Starting Pipecat bot ({mode} mode)")
    print(f"Config: {env_file.name}")
    print(f"Command: {' '.join(cmd)}\n")

    # Run
    try:
        sys.exit(subprocess.run(cmd, env=env).returncode)
    except KeyboardInterrupt:
        print("\nInterrupted", file=sys.stderr)
        sys.exit(130)


def run_npc():
    """Entry point for 'gb-npc' command - runs task-based NPC agents."""
    parser = argparse.ArgumentParser(
        description="Start a task-based NPC agent"
    )
    parser.add_argument('character_id', help='Character ID for the NPC')
    parser.add_argument('task', help='Task description (e.g., "Patrol sector 5")')
    parser.add_argument('--local', action='store_true',
                       help='Use local Supabase development (.env.supabase)')
    parser.add_argument('--cloud', action='store_true',
                       help='Use cloud Supabase production (.env.cloud)')
    parser.add_argument('--legacy', action='store_true',
                       help='Use legacy game-server WebSocket (.env.legacy)')
    parser.add_argument('--long-running', action='store_true',
                       help='Use long-running mode (auto-restarts tasks)')

    args = parser.parse_args()

    # Detect environment
    mode, env_file = _detect_environment(args)
    env = _setup_environment(mode, env_file)

    # Check for OPENAI_API_KEY
    if 'OPENAI_API_KEY' not in env:
        print("ERROR: OPENAI_API_KEY not found", file=sys.stderr)
        print(f"Add it to {env_file} or export it", file=sys.stderr)
        sys.exit(1)

    # Build command
    repo_root = _get_repo_root()
    os.chdir(repo_root)

    if args.long_running:
        script = 'src/gradientbang/npc/run_long_npc.py'
        mode_desc = 'long-running'
    else:
        script = 'src/gradientbang/npc/run_npc.py'
        mode_desc = 'one-shot'

    cmd = ['python', script, args.character_id, args.task]

    # Show what we're running
    print(f"Starting {mode_desc} NPC ({mode} mode)")
    print(f"Character: {args.character_id}")
    print(f"Task: {args.task}")
    print(f"Config: {env_file.name}\n")

    # Run
    try:
        sys.exit(subprocess.run(cmd, env=env).returncode)
    except KeyboardInterrupt:
        print("\nInterrupted", file=sys.stderr)
        sys.exit(130)


def test_local():
    """Entry point for 'gb-test-local' - run tests against local Supabase."""
    repo_root = _get_repo_root()
    env_file = repo_root / '.env.supabase'

    if not env_file.exists():
        print(f"ERROR: {env_file} not found", file=sys.stderr)
        print("Create it with:", file=sys.stderr)
        print("  SUPABASE_URL=http://127.0.0.1:54321", file=sys.stderr)
        print("  SUPABASE_ANON_KEY=...", file=sys.stderr)
        print("  SUPABASE_SERVICE_ROLE_KEY=...", file=sys.stderr)
        sys.exit(1)

    # Load environment
    env = os.environ.copy()
    env_vars = _load_env_file(env_file)
    env.update(env_vars)

    # Set test variables
    env['USE_SUPABASE_TESTS'] = '1'
    env['SUPABASE_USE_POLLING'] = '1'

    # Check Supabase is running
    try:
        import socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        result = sock.connect_ex(('127.0.0.1', 54321))
        sock.close()
        if result != 0:
            print("WARNING: Supabase not running on port 54321", file=sys.stderr)
            print("Start it with: supabase start\n", file=sys.stderr)
    except Exception:
        pass

    # Build pytest command
    os.chdir(repo_root)
    pytest_args = sys.argv[1:] if len(sys.argv) > 1 else ['tests/integration/', '-v', '--tb=line']
    cmd = ['pytest'] + pytest_args

    print("Running tests against LOCAL Supabase")
    print(f"Config: {env_file.name}")
    print(f"Command: {' '.join(cmd)}\n")

    try:
        sys.exit(subprocess.run(cmd, env=env).returncode)
    except KeyboardInterrupt:
        print("\nInterrupted", file=sys.stderr)
        sys.exit(130)


def test_cloud():
    """Entry point for 'gb-test-cloud' - run tests against cloud Supabase."""
    repo_root = _get_repo_root()
    env_file = repo_root / '.env.cloud'

    if not env_file.exists():
        print(f"ERROR: {env_file} not found", file=sys.stderr)
        print("Create it with:", file=sys.stderr)
        print("  SUPABASE_URL=https://your-project.supabase.co", file=sys.stderr)
        print("  SUPABASE_ANON_KEY=...", file=sys.stderr)
        print("  SUPABASE_SERVICE_ROLE_KEY=...", file=sys.stderr)
        sys.exit(1)

    # Validate cloud URL
    env_vars = _load_env_file(env_file)
    if 'SUPABASE_URL' in env_vars:
        url = env_vars['SUPABASE_URL']
        if '127.0.0.1' in url or 'localhost' in url:
            print("ERROR: .env.cloud contains a local URL", file=sys.stderr)
            print(f"Found: {url}", file=sys.stderr)
            sys.exit(1)

    # Load environment
    env = os.environ.copy()
    env.update(env_vars)

    # Set test variables
    env['USE_SUPABASE_TESTS'] = '1'
    env['SUPABASE_USE_POLLING'] = '1'

    # Build pytest command
    os.chdir(repo_root)
    pytest_args = sys.argv[1:] if len(sys.argv) > 1 else ['tests/integration/', '-v', '--tb=line']
    cmd = ['pytest'] + pytest_args

    print("Running tests against CLOUD Supabase")
    print(f"Config: {env_file.name}")
    print(f"Command: {' '.join(cmd)}")
    print("\nWARNING: Tests will modify cloud database state!")
    print("Press Ctrl+C within 5 seconds to cancel...\n")

    # Safety countdown
    try:
        import time
        for i in range(5, 0, -1):
            print(f"Starting in {i}...", end='\r')
            time.sleep(1)
        print("\nStarting tests now.\n")
    except KeyboardInterrupt:
        print("\nCancelled", file=sys.stderr)
        sys.exit(130)

    try:
        sys.exit(subprocess.run(cmd, env=env).returncode)
    except KeyboardInterrupt:
        print("\nInterrupted", file=sys.stderr)
        sys.exit(130)


if __name__ == '__main__':
    # Allow running as a module for testing
    print("This module provides CLI entry points.")
    print("Install with: uv sync")
    print("\nAvailable commands:")
    print("  uv run gb-bot [--local|--cloud|--legacy]")
    print("  uv run gb-npc <char> <task> [--local|--cloud|--legacy]")
    print("  uv run gb-test-local [pytest-args...]")
    print("  uv run gb-test-cloud [pytest-args...]")