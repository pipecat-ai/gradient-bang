"""Local development commands for Gradient Bang.

Commands for starting, stopping, and resetting the local development environment.
"""

import typer
from rich.console import Console
from rich.panel import Panel
from rich.syntax import Syntax
from rich.table import Table

from gradientbang.cli.utils import (
    fetch_and_create_local_env,
    get_local_env_path,
    get_workdir,
    is_runtime_config_seeded,
    is_schema_applied,
    is_supabase_running,
    parse_env_file,
    run_supabase,
    seed_runtime_config,
    write_local_env,
)

app = typer.Typer(
    name="dev",
    help="Local development commands.",
    no_args_is_help=True,
)

console = Console()


@app.command()
def start(
    skip: bool = typer.Option(
        False,
        "--skip",
        "-s",
        help="Skip prompts (auto-create .env.local without asking)",
    ),
) -> None:
    """Start the local development environment.
    
    Starts Supabase local stack and creates .env.local if needed.
    """
    workdir = get_workdir()
    if not workdir.exists():
        console.print(f"[red]Error:[/red] Workdir does not exist: {workdir}")
        raise typer.Exit(code=1)
    
    # Check if already running
    console.print("[dim]Checking Supabase status...[/dim]")
    if is_supabase_running():
        console.print("[green]✓[/green] Supabase is already running!")
    else:
        # Start Supabase
        console.print("\n[bold blue]Starting Supabase...[/bold blue]")
        console.print("[dim]This may take a while on first run as Docker images are downloaded.[/dim]\n")
        
        result = run_supabase("start")
        returncode = result.returncode
        
        if returncode != 0:
            console.print(f"\n[red]Error:[/red] Supabase start failed with exit code {returncode}")
            raise typer.Exit(code=returncode)
        
        console.print("\n[green]✓[/green] Supabase started successfully!")
    
    # Step 2: Handle .env.local - only prompt if it doesn't exist
    env_path = get_local_env_path()
    
    if not env_path.exists():
        # .env.local doesn't exist - ask to create it
        should_create = skip or typer.confirm(
            f"Create {env_path.name} with Supabase credentials?",
            default=True,
        )
        
        if should_create:
            success, env_content = fetch_and_create_local_env(console)
            
            if not success:
                raise typer.Exit(code=1)
            
            # Show and write
            console.print(Panel(
                Syntax(env_content, "bash", theme="monokai", word_wrap=True),
                title="Supabase Credentials",
                border_style="blue",
            ))
            
            write_local_env(env_content, console)
    else:
        console.print(f"\n[green]✓[/green] Using existing {env_path.name}")
    
    # Step 3: Seed runtime config for combat cron if needed
    console.print("\n[dim]Checking combat cron config...[/dim]")
    if is_runtime_config_seeded():
        console.print("[green]✓[/green] Combat cron config already seeded")
    else:
        # Load env vars from .env.local
        env_vars = parse_env_file(env_path)
        edge_api_token = env_vars.get("EDGE_API_TOKEN", "")
        supabase_anon_key = env_vars.get("SUPABASE_ANON_KEY", "")
        supabase_url = env_vars.get("SUPABASE_URL", "")
        
        if not edge_api_token or not supabase_anon_key:
            console.print("[yellow]Warning:[/yellow] Missing env vars for combat cron config")
            console.print("  Run [bold]gb env local --update[/bold] to regenerate .env.local")
        else:
            success = seed_runtime_config(
                supabase_url=supabase_url,
                edge_api_token=edge_api_token,
                supabase_anon_key=supabase_anon_key,
                console=console,
            )
            if not success:
                console.print("[yellow]Warning:[/yellow] Failed to seed combat cron config")
    
    # Done!
    console.print("\n[bold green]Local environment started![/bold green]")
    console.print("\nNext steps:")
    console.print("  • Supabase Studio: [link]http://127.0.0.1:54323[/link]")
    console.print("  • Run [bold]gb dev status[/bold] to check service status")


@app.command()
def stop() -> None:
    """Stop the local development environment.
    
    Stops Supabase local stack.
    """
    console.print("[bold blue]Stopping Supabase...[/bold blue]\n")
    
    result = run_supabase("stop")
    returncode = result.returncode
    
    if returncode != 0:
        console.print(f"\n[red]Error:[/red] Supabase stop failed with exit code {returncode}")
        raise typer.Exit(code=returncode)
    
    console.print("\n[green]✓[/green] Supabase stopped.")


@app.command()
def reset() -> None:
    """Reset everything locally.
    
    Clears all local data, user accounts, edge functions, Docker images, etc.
    """
    # TODO: Implement reset command
    # - Run `npx supabase db reset`
    # - After migration completes, re-seed app_runtime_config using seed_runtime_config()
    #   (migrations wipe the table, so we need to re-seed the combat cron config)
    console.print("[yellow]Reset not yet implemented.[/yellow]")
    console.print("This will reset:")
    console.print("  • Supabase database")
    console.print("  • User accounts")
    console.print("  • World data")
    console.print("  • Docker containers/images")
    raise typer.Exit(code=1)


@app.command()
def status() -> None:
    """Show status of local development services."""
    supabase_running = is_supabase_running()
    
    # Build status table
    table = Table(title="Service Status", show_header=True, header_style="bold")
    table.add_column("Service", style="bold")
    table.add_column("Status")
    
    # Supabase
    if supabase_running:
        table.add_row("Supabase", "[green]running[/green]")
    else:
        table.add_row("Supabase", "[red]stopped[/red]")
    
    # Database schema
    if supabase_running:
        if is_schema_applied():
            table.add_row("Database schema", "[green]applied[/green]")
        else:
            table.add_row("Database schema", "[yellow]not applied[/yellow]")
    else:
        table.add_row("Database schema", "[dim]unknown[/dim]")
    
    # Combat cron config
    if supabase_running:
        if is_runtime_config_seeded():
            table.add_row("Combat cron config", "[green]seeded[/green]")
        else:
            table.add_row("Combat cron config", "[yellow]not seeded[/yellow]")
    else:
        table.add_row("Combat cron config", "[dim]unknown[/dim]")
    
    # World data placeholder
    table.add_row("World data", "[dim]not implemented[/dim]")
    
    console.print(table)
    
    # Show detailed supabase status if running
    if supabase_running:
        console.print("\n[bold]Supabase Services[/bold]")
        result = run_supabase("status")
        if result.returncode != 0:
            console.print("[red]Error:[/red] Failed to get detailed status")


@app.command()
def logs(
    service: str = typer.Argument(
        None,
        help="Service to show logs for (supabase, bot, client, functions)",
    ),
) -> None:
    """Show logs for a specific service."""
    console.print(f"[yellow]Logs not yet implemented for: {service or 'all'}[/yellow]")
    raise typer.Exit(code=1)

