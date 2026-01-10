"""Environment commands for Gradient Bang.

Commands for managing environment configurations.
"""

import typer
from rich.console import Console
from rich.panel import Panel
from rich.syntax import Syntax
from rich.table import Table

from gradientbang.cli.config import ENV_VAR_MAP
from gradientbang.cli.utils import (
    fetch_and_create_local_env,
    get_current_env_values,
    get_local_env_path,
    is_supabase_running,
    parse_env_file,
    write_local_env,
)

app = typer.Typer(
    name="env",
    help="Environment management commands.",
    no_args_is_help=True,
)

console = Console()


@app.command()
def local(
    update: bool = typer.Option(
        False,
        "--update",
        "-u",
        help="Fetch fresh credentials from Supabase and update .env.local",
    ),
) -> None:
    """Manage .env.local configuration.
    
    Shows current .env.local status, or updates it with --update.
    """
    env_path = get_local_env_path()
    
    # Handle --update: fetch fresh credentials from Supabase
    if update:
        if not is_supabase_running():
            console.print("[red]Error:[/red] Supabase is not running")
            console.print("Run [bold]gb start[/bold] first.")
            raise typer.Exit(code=1)
        
        success, env_content = fetch_and_create_local_env(console)
        
        if not success:
            raise typer.Exit(code=1)
        
        # Show the content
        console.print(Panel(
            Syntax(env_content, "bash", theme="monokai", word_wrap=True),
            title="Supabase Credentials",
            border_style="blue",
        ))
        
        write_local_env(env_content, console)
        return
    
    # Just show status
    if not env_path.exists():
        console.print(f"[yellow]Note:[/yellow] {env_path.name} does not exist")
        console.print("Run [bold]gb start[/bold] or [bold]gb env local --update[/bold] to create it.")
        return
    
    # Show what's in the file
    env_vars = parse_env_file(env_path)
    console.print(f"[green]✓[/green] {env_path.name} exists ({len(env_vars)} variables)")
    for key in env_vars:
        console.print(f"  [dim]•[/dim] {key}")


@app.command()
def show() -> None:
    """Show current environment variable values.
    
    Displays all known env vars and their current values in the environment.
    Secret values are masked.
    """
    values = get_current_env_values()
    
    table = Table(title="Environment Variables", border_style="blue")
    table.add_column("Variable", style="bold")
    table.add_column("Value")
    table.add_column("Description", style="dim")
    
    set_count = 0
    for name, value in values.items():
        var_config = ENV_VAR_MAP.get(name)
        description = var_config.description if var_config else ""
        
        if value is None:
            display_value = "[dim]not set[/dim]"
        else:
            set_count += 1
            # Mask secret values
            if var_config and var_config.secret:
                if len(value) > 8:
                    display_value = f"{value[:4]}...{value[-4:]}"
                else:
                    display_value = "***"
            else:
                display_value = value
        
        table.add_row(name, display_value, description)
    
    console.print(table)
    console.print(f"\n[dim]{set_count}/{len(values)} variables set[/dim]")

