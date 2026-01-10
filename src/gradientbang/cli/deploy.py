"""Deployment commands for Gradient Bang.

Commands for deploying to production (Supabase Cloud, Pipecat Cloud).
"""

import typer
from rich.console import Console

app = typer.Typer(
    name="deploy",
    help="Production deployment commands.",
    no_args_is_help=True,
)

console = Console()


@app.command()
def all() -> None:
    """Deploy everything to production.
    
    Deploys database migrations, edge functions, and bot.
    """
    console.print("[yellow]Full deploy not yet implemented.[/yellow]")
    console.print("This will deploy:")
    console.print("  • Database migrations")
    console.print("  • Edge functions")
    console.print("  • Pipecat bot")
    raise typer.Exit(code=1)


@app.command()
def db() -> None:
    """Deploy database migrations to Supabase Cloud."""
    console.print("[yellow]Database deploy not yet implemented.[/yellow]")
    raise typer.Exit(code=1)


@app.command()
def functions() -> None:
    """Deploy edge functions to Supabase Cloud."""
    console.print("[yellow]Functions deploy not yet implemented.[/yellow]")
    raise typer.Exit(code=1)


@app.command()
def bot() -> None:
    """Deploy bot to Pipecat Cloud."""
    console.print("[yellow]Bot deploy not yet implemented.[/yellow]")
    raise typer.Exit(code=1)


@app.command()
def secrets() -> None:
    """Push secrets to Supabase and Pipecat Cloud."""
    console.print("[yellow]Secrets deploy not yet implemented.[/yellow]")
    raise typer.Exit(code=1)

