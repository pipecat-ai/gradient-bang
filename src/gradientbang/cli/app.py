"""Main Typer application for the Gradient Bang CLI.

This module defines the root CLI app and registers all command groups.
"""

import typer
from rich.console import Console

from gradientbang.cli import dev as dev_cmd
from gradientbang.cli import deploy as deploy_cmd
from gradientbang.cli import env as env_cmd
from gradientbang.cli import test as test_cmd
from gradientbang.cli.utils import print_header, set_workdir_override

# Console for rich output
console = Console()

# Main app
app = typer.Typer(
    name="gb",
    help="Gradient Bang CLI - Setup, run, and deploy your game universe.",
    rich_markup_mode="rich",
)

# Register command groups
app.add_typer(dev_cmd.app, name="dev", help="Local development commands")
app.add_typer(deploy_cmd.app, name="deploy", help="Production deployment commands")
app.add_typer(env_cmd.app, name="env", help="Environment management")
app.add_typer(test_cmd.app, name="test", help="Run tests")


# Top-level convenience commands that delegate to subcommands
@app.command()
def start(
    ctx: typer.Context,
    skip: bool = typer.Option(
        False,
        "--skip",
        "-s",
        help="Skip prompts (auto-confirm create/overwrite .env.local)",
    ),
) -> None:
    """Start the local development environment.
    
    Shortcut for: gb dev start
    """
    ctx.invoke(dev_cmd.start, skip=skip)


@app.command()
def stop(
    ctx: typer.Context,
) -> None:
    """Stop the local development environment.
    
    Shortcut for: gb dev stop
    """
    ctx.invoke(dev_cmd.stop)


@app.command()
def reset(
    ctx: typer.Context,
) -> None:
    """Reset everything locally (data, containers, etc).
    
    Shortcut for: gb dev reset
    """
    ctx.invoke(dev_cmd.reset)


def version_callback(value: bool) -> None:
    """Print version and exit."""
    if value:
        from importlib.metadata import version as get_version
        try:
            v = get_version("gradient-bang")
        except Exception:
            v = "0.1.0"
        console.print(f"[bold]Gradient Bang[/bold] v{v}")
        raise typer.Exit()


@app.callback(invoke_without_command=True)
def main(
    ctx: typer.Context,
    workdir: str = typer.Option(
        None,
        "--workdir",
        "-w",
        help="Override Supabase workdir (default: deployment, or GB_WORKDIR env)",
    ),
    version: bool = typer.Option(
        False,
        "--version",
        "-v",
        help="Show version and exit.",
        is_eager=True,
        callback=version_callback,
    ),
) -> None:
    """Gradient Bang CLI - Setup, run, and deploy your game universe."""
    # Set workdir override if provided
    if workdir:
        set_workdir_override(workdir)
    
    # Print header for all commands (but not for --help or no command)
    if ctx.invoked_subcommand is not None:
        print_header(console)
    
    if ctx.invoked_subcommand is None:
        console.print(ctx.get_help())

