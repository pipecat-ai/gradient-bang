"""Configuration for the Gradient Bang CLI.

Defines environment variable schemas and defaults for different environments.
"""

from dataclasses import dataclass, field

# Default workdir for Supabase commands
DEFAULT_WORKDIR = "deployment"

# Default local environment file
LOCAL_ENV_FILE = ".env.local"


@dataclass
class EnvVar:
    """Definition of an environment variable."""
    
    name: str
    description: str
    default: str | None = None
    secret: bool = False  # If True, mask value in display
    generated: bool = False  # If True, auto-generate if not provided


# Environment variable definitions used across all environments
ENV_VARS: list[EnvVar] = [
    EnvVar(
        name="SUPABASE_URL",
        description="Supabase API URL",
    ),
    EnvVar(
        name="SUPABASE_ANON_KEY",
        description="Supabase anonymous/public key",
        secret=True,
    ),
    EnvVar(
        name="SUPABASE_SERVICE_ROLE_KEY",
        description="Supabase service role key (admin)",
        secret=True,
    ),
    EnvVar(
        name="POSTGRES_POOLER_URL",
        description="PostgreSQL connection URL",
        secret=True,
    ),
    EnvVar(
        name="EDGE_API_TOKEN",
        description="Token for edge function authentication",
        secret=True,
        generated=True,
    ),
]

# Map of env var name to EnvVar for quick lookup
ENV_VAR_MAP: dict[str, EnvVar] = {var.name: var for var in ENV_VARS}


@dataclass
class EnvDefaults:
    """Default values for a specific environment type."""
    
    name: str  # Environment name (local, cloud, etc.)
    values: dict[str, str] = field(default_factory=dict)


# Default values for local development
LOCAL_DEFAULTS = EnvDefaults(
    name="local",
    values={
        "POSTGRES_POOLER_URL": "postgresql://postgres:postgres@db:5432/postgres",
    },
)

# Mapping from supabase status output keys to our env var names
SUPABASE_STATUS_MAP: dict[str, str] = {
    "API_URL": "SUPABASE_URL",
    "ANON_KEY": "SUPABASE_ANON_KEY",
    "SERVICE_ROLE_KEY": "SUPABASE_SERVICE_ROLE_KEY",
}

