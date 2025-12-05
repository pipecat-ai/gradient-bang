"""Utilities for resetting the Supabase database between tests."""

from __future__ import annotations

import json
import logging
import os
import shlex
import subprocess
import uuid
import copy
from datetime import datetime, timezone
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import psycopg
from psycopg.types.json import Json

from gradientbang.utils.legacy_ids import canonicalize_character_id, deterministic_ship_id

os.environ.setdefault("SUPABASE_ALLOW_LEGACY_IDS", "1")

logger = logging.getLogger(__name__)


def _get_repo_root() -> Path:
    """Get the repository root directory."""
    current = Path(__file__).resolve().parent
    while current != current.parent:
        if (current / ".git").exists() or (current / "pyproject.toml").exists():
            return current
        current = current.parent
    return Path.cwd()


def _get_supabase_workdir() -> Path:
    """Get the Supabase workdir (deployment directory)."""
    if workdir := os.environ.get("SUPABASE_WORKDIR"):
        return Path(workdir)
    
    repo_root = _get_repo_root()
    return repo_root / "deployment"


def _resolve_supabase_cli_command() -> Optional[List[str]]:
    """Resolve the Supabase CLI command to use."""
    # Check for explicit command override
    if cmd := os.environ.get("SUPABASE_CLI_COMMAND"):
        return shlex.split(cmd)
    
    # Check for CLI path override
    if path_override := os.environ.get("SUPABASE_CLI"):
        candidate = Path(path_override)
        if candidate.exists():
            return [str(candidate)]
    
    # Try to find supabase binary in PATH
    from shutil import which
    if binary := which("supabase"):
        return [binary]
    
    # Fall back to npx if available
    if which("npx"):
        return ["npx", "supabase@latest"]
    
    return None


def _get_database_url() -> str:
    """Get the Supabase database URL with fallback chain.

    Attempts to get DB URL in this order:
    1. For cloud (SUPABASE_URL contains supabase.co): Use POSTGRES_POOLER_URL
    2. For local: Query from Supabase CLI (supabase status -o env)
    3. Fall back to standard local default

    Returns:
        Database connection URL
    """
    # 1. For cloud tests, use POSTGRES_POOLER_URL from environment
    supabase_url = os.environ.get("SUPABASE_URL", "")
    if "supabase.co" in supabase_url:
        pooler_url = os.environ.get("POSTGRES_POOLER_URL")
        if pooler_url:
            logger.debug("Using POSTGRES_POOLER_URL for cloud database access")
            return pooler_url
        logger.warning("Cloud SUPABASE_URL detected but POSTGRES_POOLER_URL not set")

    repo_root = _get_repo_root()

    # 2. Try to get from Supabase CLI status with env output format (local only)
    try:
        cli_command = _resolve_supabase_cli_command()
        if cli_command:
            workdir = _get_supabase_workdir()
            cmd = [*cli_command, "--workdir", str(workdir), "status", "-o", "env"]
            result = subprocess.run(
                cmd,
                cwd=str(repo_root),
                capture_output=True,
                text=True,
                check=False,
                timeout=10,
            )

            if result.returncode == 0 and result.stdout:
                # Parse env format output: look for DB_URL=... line
                for line in result.stdout.splitlines():
                    stripped = line.strip()
                    if stripped.startswith("DB_URL="):
                        db_url = stripped.split("=", 1)[1].strip()
                        if db_url:
                            logger.debug("Using DB_URL from Supabase CLI status")
                            return db_url
    except Exception as e:
        logger.debug(f"Failed to get DB URL from Supabase CLI: {e}")

    # 3. Use standard local Supabase default
    default_url = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
    logger.debug("Using default local Supabase DB URL")
    return default_url


# Deterministic namespaces so character + ship UUIDs remain stable between runs
SHIP_NAMESPACE = uuid.UUID(
    os.environ.get(
        "SUPABASE_TEST_SHIP_NAMESPACE",
        "b7b87641-1c44-4ed1-8e9c-5f671484b1a9",
    )
)

CHARACTER_REGISTRY = Path(
    os.environ.get(
        "SUPABASE_TEST_CHARACTER_REGISTRY",
        "tests/test-world-data/characters.json",
    )
)
SHIPS_PATH = Path(
    os.environ.get(
        "SUPABASE_TEST_SHIPS",
        "tests/test-world-data/ships.json",
    )
)
CHARACTER_KNOWLEDGE_DIR = Path(
    os.environ.get(
        "SUPABASE_TEST_CHARACTER_MAP_DIR",
        "tests/test-world-data/character-map-knowledge",
    )
)
UNIVERSE_STRUCTURE_PATH = Path(
    os.environ.get(
        "SUPABASE_TEST_UNIVERSE_STRUCTURE",
        "tests/test-world-data/universe_structure.json",
    )
)
SECTOR_CONTENTS_PATH = Path(
    os.environ.get(
        "SUPABASE_TEST_SECTOR_CONTENTS",
        "tests/test-world-data/sector_contents.json",
    )
)
PORT_STATES_DIR = Path(
    os.environ.get(
        "SUPABASE_TEST_PORT_STATES",
        "tests/test-world-data/port-states",
    )
)
EXTRA_CHARACTERS = {"test_reset_runner"}


def _load_json(path: Path) -> Optional[Dict]:
    if not path.exists():
        return None
    return json.loads(path.read_text())


def _compute_available_sectors() -> List[int]:
    env_value = os.environ.get("SUPABASE_TEST_SECTORS")
    if env_value:
        sectors = [int(value) for value in env_value.split(",") if value.strip()]
        return sectors or [0]

    structure_data = _load_json(UNIVERSE_STRUCTURE_PATH)
    if structure_data:
        return sorted(int(sector.get("id", 0)) for sector in structure_data.get("sectors", []))

    return [0]


AVAILABLE_SECTORS = _compute_available_sectors()
DEFAULT_SECTOR = AVAILABLE_SECTORS[0] if AVAILABLE_SECTORS else 0
DISTRIBUTION_SECTORS = [sector for sector in AVAILABLE_SECTORS if sector != DEFAULT_SECTOR] or [DEFAULT_SECTOR]
DEFAULT_SHIP_TYPE = os.environ.get("SUPABASE_TEST_SHIP_TYPE", "kestrel_courier")
DEFAULT_SHIP_NAME_SUFFIX = os.environ.get(
    "SUPABASE_TEST_SHIP_SUFFIX", "-ship"
)
DEFAULT_SHIP_CREDITS = int(
    os.environ.get("SUPABASE_TEST_DEFAULT_SHIP_CREDITS", "1000")
)
DEFAULT_FIGHTERS = int(os.environ.get("SUPABASE_TEST_DEFAULT_FIGHTERS", "300"))
DEFAULT_SHIELDS = int(os.environ.get("SUPABASE_TEST_DEFAULT_SHIELDS", "150"))
DEFAULT_WARP = int(os.environ.get("SUPABASE_TEST_DEFAULT_WARP", "300"))

PINNED_SECTORS = {
    "test_2p_player1": DEFAULT_SECTOR,
    "test_2p_player2": DEFAULT_SECTOR,
}


def _load_character_registry() -> Dict[str, Dict[str, Any]]:
    if not CHARACTER_REGISTRY.exists():
        return {character: {"name": character} for character in EXTRA_CHARACTERS}

    data = json.loads(CHARACTER_REGISTRY.read_text())
    registry = data.get("characters", {})
    for extra in EXTRA_CHARACTERS:
        registry.setdefault(extra, {"name": extra})
    return registry


def _load_character_ids() -> List[str]:
    """Load ALL character IDs from registry.

    We seed all characters from the registry so that tests work.
    Map knowledge will be loaded from files where available, or use
    minimal defaults for characters without knowledge files.
    """
    registry = _load_character_registry()
    selected: List[str] = []

    # Include all characters from the registry
    for legacy_id in registry.keys():
        try:
            canonicalize_character_id(legacy_id)  # Validate it's a valid ID
            selected.append(legacy_id)
        except ValueError:
            # Skip invalid character IDs
            continue

    # Add any extra characters that aren't already included
    for extra in EXTRA_CHARACTERS:
        if extra not in selected and extra in registry:
            selected.append(extra)

    return sorted(selected)


def _load_ships_data() -> Dict[str, Dict[str, Any]]:
    if not SHIPS_PATH.exists():
        return {}
    return json.loads(SHIPS_PATH.read_text())


def _load_map_knowledge(canonical_id: str) -> Optional[Dict[str, Any]]:
    path = CHARACTER_KNOWLEDGE_DIR / f"{canonical_id}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:  # pragma: no cover - corrupted fixture
        logger.warning("Failed to parse map knowledge for %s", canonical_id)
        return None


@dataclass
class ShipSeed:
    ship_id: str
    ship_type: str
    ship_name: Optional[str]
    sector: int
    credits: int
    fighters: int
    shields: int
    warp_power: int
    warp_power_capacity: int
    cargo_qf: int
    cargo_ro: int
    cargo_ns: int
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class CharacterSeed:
    legacy_id: str
    canonical_id: str
    display_name: str
    legacy_display_name: str
    bank_credits: int
    map_knowledge: Dict[str, Any]
    current_sector: int
    ship: ShipSeed


def _ship_id_for(character_id: str) -> str:
    return str(uuid.uuid5(SHIP_NAMESPACE, character_id))


def _map_payload(sector_id: int) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "current_sector": sector_id,
        "total_sectors_visited": 1,
        "sectors_visited": {
            str(sector_id): {
                "last_visited": now,
                "adjacent_sectors": [],
                "position": [0, 0],
            }
        },
    }


def _sector_for_index(index: int) -> int:
    if not DISTRIBUTION_SECTORS:
        return DEFAULT_SECTOR
    return DISTRIBUTION_SECTORS[index % len(DISTRIBUTION_SECTORS)]


def _build_character_seeds(character_ids: Sequence[str]) -> List[CharacterSeed]:
    registry = _load_character_registry()
    ships_data = _load_ships_data()
    owner_index: Dict[str, List[str]] = {}
    for ship_id, record in ships_data.items():
        if record.get("owner_type") != "character":
            continue
        owner_id = record.get("owner_id")
        if not owner_id:
            continue
        owner_index.setdefault(owner_id, []).append(ship_id)
        try:
            canonical_owner = canonicalize_character_id(owner_id)
            owner_index.setdefault(canonical_owner, []).append(ship_id)
        except ValueError:
            continue

    seeds: List[CharacterSeed] = []
    used_names: set[str] = set()
    for idx, legacy_id in enumerate(character_ids):
        legacy_display = registry.get(legacy_id, {}).get("name") or legacy_id
        display = legacy_display
        if display in used_names:
            display = f"{legacy_display} ({legacy_id})"
        used_names.add(display)
        canonical = canonicalize_character_id(legacy_id)
        map_data = _load_map_knowledge(canonical)
        desired_sector = None
        if map_data and map_data.get("current_sector") is not None:
            desired_sector = int(map_data.get("current_sector"))
        if desired_sector is None:
            desired_sector = PINNED_SECTORS.get(legacy_id, DEFAULT_SECTOR)
        fallback_sector = PINNED_SECTORS.get(legacy_id, _sector_for_index(idx))
        ship_record, from_fixture = _select_ship_record(
            legacy_id,
            canonical,
            map_data,
            ships_data,
            owner_index,
            desired_sector,
            fallback_sector,
        )
        if map_data and map_data.get("current_sector") is not None:
            current_sector = int(map_data.get("current_sector"))
        else:
            record_sector = ship_record.get("sector")
            current_sector = int(record_sector) if record_sector is not None else fallback_sector
        map_payload = map_data or _map_payload(current_sector)
        bank_credits = int((map_data or {}).get("credits_in_bank", 0))

        ship_seed = _ship_seed_from_record(
            ship_record,
            legacy_id,
            canonical,
            current_sector,
        )

        seeds.append(
            CharacterSeed(
                legacy_id=legacy_id,
                canonical_id=canonical,
                display_name=display,
                legacy_display_name=legacy_display,
                bank_credits=bank_credits,
                map_knowledge=map_payload,
                current_sector=current_sector,
                ship=ship_seed,
            )
        )

    return seeds


def _select_ship_record(
    legacy_id: str,
    canonical_id: str,
    map_data: Optional[Dict[str, Any]],
    ships_data: Dict[str, Dict[str, Any]],
    owner_index: Dict[str, List[str]],
    desired_sector: int,
    fallback_sector: int,
) -> Tuple[Dict[str, Any], bool]:
    preferred_id = (map_data or {}).get("current_ship_id")
    if preferred_id and preferred_id in ships_data:
        return copy.deepcopy(ships_data[preferred_id]), True

    candidates: List[Dict[str, Any]] = []
    for key in (canonical_id, legacy_id):
        for ship_id in owner_index.get(key, []):
            record = ships_data.get(ship_id)
            if record:
                candidates.append(record)

    if candidates:
        def _sort_key(record: Dict[str, Any]) -> Tuple[int, str]:
            sector = record.get("sector", DEFAULT_SECTOR)
            mismatch = 0 if sector == desired_sector else 1
            acquired = record.get("acquired") or ""
            return (mismatch, acquired)

        record = sorted(candidates, key=_sort_key)[0]
        return copy.deepcopy(record), True

    sector = desired_sector or fallback_sector
    return {
        "ship_id": deterministic_ship_id(f"{legacy_id}-default-ship"),
        "ship_type": DEFAULT_SHIP_TYPE,
        "name": f"{legacy_id}{DEFAULT_SHIP_NAME_SUFFIX}",
        "sector": sector,
        "state": {
            "fighters": DEFAULT_FIGHTERS,
            "shields": DEFAULT_SHIELDS,
            "credits": DEFAULT_SHIP_CREDITS,
            "cargo": {"quantum_foam": 0, "retro_organics": 0, "neuro_symbolics": 0},
            "cargo_holds": 30,
            "warp_power": DEFAULT_WARP,
            "warp_power_capacity": DEFAULT_WARP,
        },
    }, False


def _ship_seed_from_record(
    record: Dict[str, Any],
    legacy_id: str,
    canonical_id: str,
    sector_override: Optional[int] = None,
) -> ShipSeed:
    ship_id = record.get("ship_id")
    try:
        if ship_id:
            uuid.UUID(ship_id)
        else:
            raise ValueError
    except ValueError:
        ship_id = deterministic_ship_id(f"{legacy_id}-ship")
    ship_type = record.get("ship_type", DEFAULT_SHIP_TYPE)
    ship_name = record.get("name")
    sector = sector_override if sector_override is not None else record.get("sector", DEFAULT_SECTOR)
    state = record.get("state", {})
    cargo = state.get("cargo", {})
    return ShipSeed(
        ship_id=ship_id,
        ship_type=ship_type,
        ship_name=ship_name,
        sector=int(sector),
        credits=int(state.get("credits", DEFAULT_SHIP_CREDITS)),
        fighters=int(state.get("fighters", DEFAULT_FIGHTERS)),
        shields=int(state.get("shields", DEFAULT_SHIELDS)),
        warp_power=int(state.get("warp_power", DEFAULT_WARP)),
        warp_power_capacity=int(state.get("warp_power_capacity", DEFAULT_WARP)),
        cargo_qf=int(cargo.get("quantum_foam", 0)),
        cargo_ro=int(cargo.get("retro_organics", 0)),
        cargo_ns=int(cargo.get("neuro_symbolics", 0)),
        metadata={
            "legacy_owner_id": legacy_id,
            "canonical_owner_id": canonical_id,
            "legacy_display_name": record.get("name") or legacy_id,
        },
    )


def _character_rows(seeds: Sequence[CharacterSeed]) -> List[Tuple]:
    timestamp = datetime.now(timezone.utc)
    rows: List[Tuple] = []
    for seed in seeds:
        rows.append(
            (
                seed.canonical_id,
                seed.display_name,
                seed.bank_credits,
                Json(seed.map_knowledge),
                Json({
                    "legacy_id": seed.legacy_id,
                    "legacy_display_name": seed.legacy_display_name,
                }),
                False,
                timestamp,
                timestamp,
                timestamp,
            )
        )
    return rows


def _ship_rows(seeds: Sequence[CharacterSeed]) -> List[Tuple]:
    rows: List[Tuple] = []
    for seed in seeds:
        ship = seed.ship
        rows.append(
            (
                ship.ship_id,
                seed.canonical_id,
                seed.canonical_id,
                ship.ship_type,
                ship.ship_name,
                ship.sector,
                False,
                ship.credits,
                ship.cargo_qf,
                ship.cargo_ro,
                ship.cargo_ns,
                ship.warp_power,
                ship.shields,
                ship.fighters,
                Json(ship.metadata),
                "character",
                None,
            )
        )
    return rows


def _insert_port(cur, sector_id: int, port_data: Dict[str, object]) -> Optional[int]:
    def _bucket_value(bucket: Optional[Dict[str, object]], key: str) -> int:
        if not bucket:
            return 0
        value = bucket.get(key, 0)
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0

    stock = port_data.get("stock") or {}
    stock_max = port_data.get("stock_max") or port_data.get("max_capacity") or {}

    cur.execute(
        """
        INSERT INTO ports (
            sector_id,
            port_code,
            port_class,
            max_qf,
            max_ro,
            max_ns,
            stock_qf,
            stock_ro,
            stock_ns
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING port_id
        """,
        (
            sector_id,
            str(port_data.get("code", "PRT")).upper()[:3],
            int(port_data.get("class", 1)),
            _bucket_value(stock_max, "QF"),
            _bucket_value(stock_max, "RO"),
            _bucket_value(stock_max, "NS"),
            _bucket_value(stock, "QF"),
            _bucket_value(stock, "RO"),
            _bucket_value(stock, "NS"),
        ),
    )
    row = cur.fetchone()
    port_id = int(row[0]) if row else None
    if port_id:
        _apply_port_state_override(cur, port_id, sector_id)
    return int(row[0]) if row else None


def _apply_port_state_override(cur, port_id: int, sector_id: int) -> None:
    state_path = PORT_STATES_DIR / f"sector_{sector_id}.json"
    if not state_path.exists():
        return
    try:
        state = json.loads(state_path.read_text())
    except json.JSONDecodeError:
        return
    stock = state.get("stock") or {}
    capacity = state.get("max_capacity") or state.get("stock_max") or {}
    updated_at = state.get("last_updated")
    cur.execute(
        """
        UPDATE ports
        SET stock_qf = %s,
            stock_ro = %s,
            stock_ns = %s,
            max_qf = %s,
            max_ro = %s,
            max_ns = %s,
            last_updated = %s
        WHERE port_id = %s
        """,
        (
            int(stock.get("QF", 0) or 0),
            int(stock.get("RO", 0) or 0),
            int(stock.get("NS", 0) or 0),
            int(capacity.get("QF", 0) or 0),
            int(capacity.get("RO", 0) or 0),
            int(capacity.get("NS", 0) or 0),
            updated_at,
            port_id,
        ),
    )


def _seed_universe(cur) -> None:
    structure_data = _load_json(UNIVERSE_STRUCTURE_PATH)
    if not structure_data:
        return

    contents_data = _load_json(SECTOR_CONTENTS_PATH) or {}
    contents_by_sector = {
        int(entry.get("id")): entry for entry in contents_data.get("sectors", []) if "id" in entry
    }

    structure_meta = structure_data.get("meta", {})
    sector_count = structure_meta.get("sector_count") or len(structure_data.get("sectors", []))

    cur.execute(
        """
        INSERT INTO universe_config (id, sector_count, generation_seed, generation_params, meta)
        VALUES (1, %s, %s, %s, %s)
        """,
        (
            sector_count,
            structure_meta.get("seed"),
            Json(structure_meta),
            Json({"source": "tests/test-world-data"}),
        ),
    )

    for sector in structure_data.get("sectors", []):
        sector_id = int(sector.get("id"))
        position = sector.get("position", {})
        region = sector.get("region") or "testbed"
        warps = sector.get("warps", [])
        cur.execute(
            """
            INSERT INTO universe_structure (sector_id, position_x, position_y, region, warps)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (
                sector_id,
                int(position.get("x", 0)),
                int(position.get("y", 0)),
                region,
                Json(warps),
            ),
        )

        port_payload = contents_by_sector.get(sector_id, {}).get("port")
        port_id = _insert_port(cur, sector_id, port_payload) if port_payload else None

        cur.execute(
            """
            INSERT INTO sector_contents (sector_id, port_id, combat, salvage)
            VALUES (%s, %s, NULL, %s)
            """,
            (
                sector_id,
                port_id,
                Json([]),
            ),
        )


def reset_supabase_state(character_ids: Iterable[str] | None = None) -> None:
    """Reset Supabase state directly via SQL using tests/test-world-data fixtures.

    Args:
        character_ids: Optional list of character IDs to pre-seed. If None, starts with
                      ZERO characters (matching Legacy behavior). Characters will be created
                      on-demand when they first join.
    """

    ids: List[str]
    if character_ids is None:
        # Start with zero characters (matching Legacy behavior)
        # Characters will be created on-demand via join edge function
        ids = []
    else:
        ids = sorted(set(character_ids))

    db_url = _get_database_url()

    # Check if using cloud pooler (PgBouncer transaction mode)
    supabase_url = os.environ.get("SUPABASE_URL", "")
    is_cloud = "supabase.co" in supabase_url

    with psycopg.connect(db_url, autocommit=False) as conn:
        # Disable prepared statements for cloud pooler (PgBouncer transaction mode)
        if is_cloud:
            conn.prepare_threshold = None
        with conn.cursor() as cur:
            cur.execute(
                """
                TRUNCATE TABLE
                    events,
                    rate_limits,
                    garrisons,
                    ports,
                    corporation_members,
                    corporation_ships,
                    corporations,
                    ship_instances,
                    characters,
                    sector_contents,
                    universe_structure,
                    universe_config
                RESTART IDENTITY CASCADE;
                """
            )

            _seed_universe(cur)

            seeds = _build_character_seeds(ids)

            character_rows = _character_rows(seeds)
            if character_rows:
                cur.executemany(
                    """
                    INSERT INTO characters (
                        character_id,
                        name,
                        credits_in_megabank,
                        map_knowledge,
                        player_metadata,
                        is_npc,
                        created_at,
                        last_active,
                        first_visit
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    character_rows,
                )

            ship_rows = _ship_rows(seeds)
            if ship_rows:
                cur.executemany(
                    """
                    INSERT INTO ship_instances (
                        ship_id,
                        owner_id,
                        owner_character_id,
                        ship_type,
                        ship_name,
                        current_sector,
                        in_hyperspace,
                        credits,
                        cargo_qf,
                        cargo_ro,
                        cargo_ns,
                        current_warp_power,
                        current_shields,
                        current_fighters,
                        metadata,
                        owner_type,
                        owner_corporation_id
                    ) VALUES (
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s
                    )
                    """,
                    ship_rows,
                )

                update_rows = [
                    (seed.ship.ship_id, seed.canonical_id) for seed in seeds
                ]
                cur.executemany(
                    "UPDATE characters SET current_ship_id = %s WHERE character_id = %s",
                    update_rows,
                )

        conn.commit()
