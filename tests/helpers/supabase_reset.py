"""Utilities for resetting the Supabase database between tests."""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import httpx
import psycopg
from psycopg.types.json import Json

from utils.legacy_ids import canonicalize_character_id

os.environ.setdefault("SUPABASE_ALLOW_LEGACY_IDS", "1")

logger = logging.getLogger(__name__)

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
    os.environ.get("SUPABASE_TEST_DEFAULT_SHIP_CREDITS", "25000")
)
DEFAULT_FIGHTERS = int(os.environ.get("SUPABASE_TEST_DEFAULT_FIGHTERS", "250"))
DEFAULT_SHIELDS = int(os.environ.get("SUPABASE_TEST_DEFAULT_SHIELDS", "150"))
DEFAULT_WARP = int(os.environ.get("SUPABASE_TEST_DEFAULT_WARP", "300"))

PINNED_SECTORS = {
    "test_2p_player1": DEFAULT_SECTOR,
    "test_2p_player2": DEFAULT_SECTOR,
}


def _load_character_ids() -> List[str]:
    if not CHARACTER_REGISTRY.exists():
        return sorted(EXTRA_CHARACTERS)

    data = json.loads(CHARACTER_REGISTRY.read_text())
    registry = data.get("characters", {})
    character_ids = set(registry.keys()) | EXTRA_CHARACTERS
    return sorted(character_ids)


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


def _character_rows(character_ids: Sequence[str], sector_map: Sequence[int]) -> List[Tuple]:
    timestamp = datetime.now(timezone.utc)
    rows: List[Tuple] = []
    for character, sector in zip(character_ids, sector_map, strict=False):
        canonical = canonicalize_character_id(character)
        rows.append(
            (
                canonical,
                character,
                DEFAULT_SHIP_CREDITS,
                Json(_map_payload(sector)),
                Json({}),
                False,
                timestamp,
                timestamp,
                timestamp,
            )
        )
    return rows


def _ship_rows(character_ids: Sequence[str], sector_map: Sequence[int]) -> List[Tuple]:
    rows: List[Tuple] = []
    for character, sector in zip(character_ids, sector_map, strict=False):
        canonical = canonicalize_character_id(character)
        rows.append(
            (
                _ship_id_for(character),
                canonical,
                canonical,
                DEFAULT_SHIP_TYPE,
                f"{character}{DEFAULT_SHIP_NAME_SUFFIX}",
                sector,
                False,
                DEFAULT_SHIP_CREDITS,
                0,
                0,
                0,
                DEFAULT_WARP,
                DEFAULT_SHIELDS,
                DEFAULT_FIGHTERS,
                Json({}),
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
    stock_max = port_data.get("stock_max") or {}

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
    return int(row[0]) if row else None


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
            INSERT INTO sector_contents (sector_id, port_id, combat, salvage, observer_channels)
            VALUES (%s, %s, NULL, %s, %s)
            """,
            (
                sector_id,
                port_id,
                Json([]),
                Json([]),
            ),
        )


def reset_supabase_state(character_ids: Iterable[str] | None = None) -> None:
    """Reset Supabase state via edge RPC (preferred) or direct SQL fallback."""

    ids: List[str]
    if character_ids is None:
        ids = _load_character_ids()
    else:
        ids = sorted(set(character_ids))

    if _try_edge_test_reset(ids):
        return

    _reset_via_sql(ids)


def _try_edge_test_reset(ids: List[str]) -> bool:
    edge_url = os.environ.get("EDGE_FUNCTIONS_URL")
    base = edge_url or os.environ.get("SUPABASE_URL")
    if not base:
        return False
    edge_base = edge_url.rstrip("/") if edge_url else f"{base.rstrip('/')}/functions/v1"
    anon = os.environ.get("SUPABASE_ANON_KEY", "anon-key")
    token = os.environ.get("EDGE_API_TOKEN") or os.environ.get("SUPABASE_API_TOKEN") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {anon}",
        "apikey": anon,
    }
    if token:
        headers["x-api-token"] = token

    payload = {"character_ids": ids}
    try:
        resp = httpx.post(
            f"{edge_base}/test_reset",
            headers=headers,
            json=payload,
            timeout=120.0,
        )
        resp.raise_for_status()
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("edge test_reset failed (%s); falling back to SQL", exc)
        return False


def _reset_via_sql(ids: List[str]) -> None:
    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        raise RuntimeError("SUPABASE_DB_URL is required to reset Supabase state")

    with psycopg.connect(db_url, autocommit=False) as conn:
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

            sector_assignments = [
                PINNED_SECTORS.get(character, _sector_for_index(idx))
                for idx, character in enumerate(ids)
            ]
            character_rows = _character_rows(ids, sector_assignments)
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

            ship_rows = _ship_rows(ids, sector_assignments)
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
                        'character',
                        NULL
                    )
                    """,
                    ship_rows,
                )

                update_rows = [(_ship_id_for(character), canonicalize_character_id(character)) for character in ids]
                cur.executemany(
                    "UPDATE characters SET current_ship_id = %s WHERE character_id = %s",
                    update_rows,
                )

        conn.commit()
