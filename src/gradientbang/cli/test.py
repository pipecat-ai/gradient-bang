"""Test commands for Gradient Bang.

Run tests with environment configuration loaded.
"""

import os
import subprocess

import typer
from rich.console import Console

from gradientbang.cli.config import LOCAL_ENV_FILE
from gradientbang.cli.utils import get_project_root, parse_env_file

app = typer.Typer(
    name="test",
    help="Run tests.",
)

console = Console()


@app.callback(
    invoke_without_command=True,
    context_settings={"allow_extra_args": True, "ignore_unknown_options": True},
)
def run(
    ctx: typer.Context,
    path: str = typer.Option(
        "tests/integration",
        "--path",
        "-p",
        help="Test path to run",
    ),
    env: str = typer.Option(
        LOCAL_ENV_FILE,
        "--env",
        "-e",
        help="Environment file to use",
    ),
) -> None:
    """Run tests with environment loaded.
    
    Examples:
        gb test                          # Run integration tests with .env.local
        gb test -p tests/unit            # Run unit tests
        gb test -k "test_combat"         # Filter by test name
        gb test -x                       # Stop on first failure
        gb test --env .env.production    # Use a different env file
    """
    env_path = get_project_root() / env
    
    # Check env file exists
    if not env_path.exists():
        console.print(f"[red]Error:[/red] {env} not found")
        if env == LOCAL_ENV_FILE:
            console.print("Run [bold]gb start[/bold] first to create it.")
        raise typer.Exit(code=1)
    
    # Load env vars from file
    env_vars = parse_env_file(env_path)
    run_env = os.environ.copy()
    run_env.update(env_vars)
    run_env["USE_SUPABASE_TESTS"] = "1"
    
    # Build pytest command
    cmd = ["uv", "run", "pytest", path, "-v"]
    # Pass through any extra args like -k, -x, --tb, etc.
    cmd.extend(ctx.args)
    
    console.print(f"[bold]Environment:[/bold] {env}")
    console.print(f"[bold]Running:[/bold] {' '.join(cmd)}\n")
    
    # Run pytest
    result = subprocess.run(cmd, cwd=get_project_root(), env=run_env)
    raise typer.Exit(code=result.returncode)
