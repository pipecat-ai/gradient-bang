"""Utility functions for the Gradient Bang CLI."""

import os
import secrets
import subprocess
import tomllib
from pathlib import Path

from rich.console import Console

from gradientbang.cli.config import DEFAULT_WORKDIR, LOCAL_ENV_FILE

# Module-level workdir override (set by CLI --workdir flag)
_workdir_override: str | None = None


def set_workdir_override(workdir: str | None) -> None:
    """Set a workdir override from the CLI --workdir flag."""
    global _workdir_override
    _workdir_override = workdir


def get_project_root() -> Path:
    """Get the project root directory.
    
    Walks up from current working directory looking for pyproject.toml.
    Falls back to cwd if not found.
    """
    current = Path.cwd()
    for parent in [current, *current.parents]:
        if (parent / "pyproject.toml").exists():
            return parent
    return current


def get_workdir() -> Path:
    """Get the Supabase workdir path.
    
    Priority: --workdir flag > GB_WORKDIR env var > default 'deployment'.
    Returns an absolute path relative to project root.
    """
    if _workdir_override:
        workdir = _workdir_override
    else:
        workdir = os.environ.get("GB_WORKDIR", DEFAULT_WORKDIR)
    return get_project_root() / workdir


def ensure_project_root() -> Path:
    """Ensure we're running from the project root and return it.
    
    Changes the current working directory to the project root.
    """
    root = get_project_root()
    os.chdir(root)
    return root


def get_supabase_config() -> dict:
    """Parse the Supabase config.toml file.
    
    Returns:
        Parsed config as a dictionary
    """
    config_path = get_workdir() / "supabase" / "config.toml"
    with open(config_path, "rb") as f:
        return tomllib.load(f)


def get_project_id() -> str:
    """Get the Supabase project_id from config.toml.
    
    Returns:
        The project_id string
    """
    return get_supabase_config()["project_id"]


def get_db_container_name() -> str:
    """Get the Docker container name for the Supabase database.
    
    Returns:
        Container name in format: supabase_db_{project_id}
    """
    return f"supabase_db_{get_project_id()}"


def print_header(console: Console) -> None:
    """Print standard CLI header with project info.
    
    Also ensures we're in the project root directory.
    """
    root = ensure_project_root()
    console.print(f"[bold]Project root:[/bold] [cyan]{root}[/cyan]")
    console.print(f"[bold]Supabase workdir:[/bold] [cyan]{get_workdir()}[/cyan]")
    console.print(f"[bold]Project ID:[/bold] [cyan]{get_project_id()}[/cyan]")
    console.print()


def is_supabase_running() -> bool:
    """Check if Supabase is currently running.
    
    Returns:
        True if Supabase is running, False otherwise
    """
    result = run_supabase("status", capture_output=True)
    # If status succeeds and doesn't contain "not running", it's running
    if result.returncode == 0:
        return "not running" not in result.stdout.lower()
    return False


def run_docker_psql(sql: str, capture_output: bool = False) -> subprocess.CompletedProcess:
    """Run a SQL command against the Supabase database via docker exec.
    
    Args:
        sql: SQL command to execute
        capture_output: If True, capture stdout/stderr
        
    Returns:
        CompletedProcess with return code and optionally captured output
    """
    container = get_db_container_name()
    cmd = [
        "docker", "exec",
        "-e", "PGPASSWORD=postgres",
        container,
        "psql", "-U", "supabase_admin", "-d", "postgres",
        "-v", "ON_ERROR_STOP=1",
        "-t",  # Tuples only (no headers)
        "-A",  # Unaligned output
        "-c", sql,
    ]
    return subprocess.run(
        cmd,
        capture_output=capture_output,
        text=True,
    )


def is_runtime_config_seeded() -> bool:
    """Check if app_runtime_config has the required rows.
    
    Returns:
        True if all required config keys exist, False otherwise
    """
    required_keys = ["supabase_url", "edge_api_token", "supabase_anon_key"]
    sql = f"""
        SELECT COUNT(*) FROM app_runtime_config 
        WHERE key IN ({', '.join(f"'{k}'" for k in required_keys)})
    """
    result = run_docker_psql(sql, capture_output=True)
    if result.returncode != 0:
        return False
    try:
        count = int(result.stdout.strip())
        return count >= len(required_keys)
    except (ValueError, AttributeError):
        return False


def is_schema_applied() -> bool:
    """Check if the database schema has been applied.
    
    Checks for existence of user_characters table as indicator.
    
    Returns:
        True if schema appears to be applied, False otherwise
    """
    sql = """
        SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = 'user_characters'
        )
    """
    result = run_docker_psql(sql, capture_output=True)
    if result.returncode != 0:
        return False
    return result.stdout.strip().lower() == "t"


def seed_runtime_config(
    supabase_url: str,
    edge_api_token: str,
    supabase_anon_key: str,
    console: Console | None = None,
) -> bool:
    """Seed app_runtime_config with required values for combat cron.
    
    Args:
        supabase_url: Internal Supabase URL (for Docker container access)
        edge_api_token: Edge function authentication token
        supabase_anon_key: Supabase anonymous key
        console: Optional console for output
        
    Returns:
        True if successful, False otherwise
    """
    # Use internal Docker URL for container-to-container communication
    internal_url = "http://host.docker.internal:54321"
    
    # Escape single quotes for SQL
    def escape_sql(val: str) -> str:
        return val.replace("'", "''")
    
    sql = f"""
        INSERT INTO app_runtime_config (key, value, description) VALUES
            ('supabase_url', '{escape_sql(internal_url)}', 'Base Supabase URL reachable from the DB container'),
            ('edge_api_token', '{escape_sql(edge_api_token)}', 'Edge token for combat_tick auth'),
            ('supabase_anon_key', '{escape_sql(supabase_anon_key)}', 'Anon key for Supabase auth headers')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
    """
    
    result = run_docker_psql(sql, capture_output=True)
    
    if result.returncode != 0:
        if console:
            console.print(f"[red]Error:[/red] Failed to seed runtime config")
            console.print(result.stderr)
        return False
    
    if console:
        console.print("[green]✓[/green] Seeded app_runtime_config for combat cron")
    
    return True


def run_supabase(*args: str, capture_output: bool = False) -> subprocess.CompletedProcess:
    """Run an npx supabase command with the configured workdir.
    
    Args:
        *args: Arguments to pass to supabase CLI
        capture_output: If True, capture stdout/stderr instead of streaming
        
    Returns:
        CompletedProcess with return code and optionally captured output
    """
    workdir = get_workdir()
    cmd = ["npx", "supabase", *args, "--workdir", str(workdir)]
    
    return subprocess.run(
        cmd,
        cwd=get_project_root(),
        capture_output=capture_output,
        text=True,
    )


def parse_supabase_status(output: str) -> dict[str, str]:
    """Parse the output of 'supabase status -o env' into a dict.
    
    Args:
        output: Raw output from supabase status -o env
        
    Returns:
        Dict mapping env var names to values
    """
    result = {}
    for line in output.strip().split("\n"):
        if "=" in line:
            key, value = line.split("=", 1)
            # Remove quotes if present
            value = value.strip().strip('"')
            result[key.strip()] = value
    return result


def generate_env(
    supabase_status: dict[str, str] | None = None,
    env_type: str = "local",
) -> str:
    """Generate environment file content.
    
    Args:
        supabase_status: Parsed output from supabase status -o env
        env_type: Environment type (local, cloud, etc.)
        
    Returns:
        Content for .env file
    """
    from gradientbang.cli.config import (
        ENV_VARS,
        LOCAL_DEFAULTS,
        SUPABASE_STATUS_MAP,
    )
    
    # Get defaults for this environment type
    defaults = LOCAL_DEFAULTS if env_type == "local" else None
    
    lines = []
    
    for var in ENV_VARS:
        value = ""
        
        # Try to get value from supabase status (mapped key)
        if supabase_status:
            for status_key, env_name in SUPABASE_STATUS_MAP.items():
                if env_name == var.name and status_key in supabase_status:
                    value = supabase_status[status_key]
                    break
        
        # Fall back to defaults
        if not value and defaults and var.name in defaults.values:
            value = defaults.values[var.name]
        
        # Generate if needed
        if not value and var.generated:
            value = secrets.token_hex(32)
        
        lines.append(f"{var.name}={value}")
    
    lines.append("")
    return "\n".join(lines)


# Keep alias for backwards compatibility
def generate_local_env(status: dict[str, str]) -> str:
    """Generate .env.local content from supabase status.
    
    Deprecated: Use generate_env() instead.
    """
    return generate_env(supabase_status=status, env_type="local")


def get_local_env_path() -> Path:
    """Get the path to the local env file."""
    return get_project_root() / LOCAL_ENV_FILE


def parse_env_file(env_path: Path) -> dict[str, str]:
    """Parse an env file into a dict.
    
    Args:
        env_path: Path to the env file
        
    Returns:
        Dict of environment variables
    """
    result = {}
    
    if not env_path.exists():
        return result
    
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            # Skip empty lines and comments
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, value = line.split("=", 1)
                result[key.strip()] = value.strip()
    
    return result


def get_current_env_values() -> dict[str, str | None]:
    """Get current values for all known env vars from os.environ.
    
    Returns:
        Dict mapping env var names to their current values (or None if not set)
    """
    from gradientbang.cli.config import ENV_VARS
    
    return {var.name: os.environ.get(var.name) for var in ENV_VARS}


def fetch_and_create_local_env(console: Console | None = None) -> tuple[bool, str]:
    """Fetch Supabase credentials and create/update .env.local.
    
    Args:
        console: Optional Rich console for output
        
    Returns:
        Tuple of (success: bool, env_content: str)
    """
    if console:
        console.print("\n[bold blue]Getting Supabase credentials...[/bold blue]")
    
    status_result = run_supabase("status", "-o", "env", capture_output=True)
    
    if status_result.returncode != 0:
        if console:
            console.print("[red]Error:[/red] Failed to get Supabase status")
            console.print(status_result.stderr)
        return False, ""
    
    # Parse status and generate env content
    status = parse_supabase_status(status_result.stdout)
    env_content = generate_env(supabase_status=status, env_type="local")
    
    return True, env_content


def write_local_env(env_content: str, console: Console | None = None) -> bool:
    """Write content to .env.local file.
    
    Args:
        env_content: The content to write
        console: Optional Rich console for output
        
    Returns:
        True if successful
    """
    env_path = get_local_env_path()
    env_exists = env_path.exists()
    
    env_path.write_text(env_content)
    
    if console:
        action = "Updated" if env_exists else "Created"
        console.print(f"[green]✓[/green] {action} {env_path.name}")
    
    return True

