"""Supabase admin helpers for character lifecycle scripts."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional

import httpx

from gradientbang.game_server.core.name_validation import ensure_safe_character_name
from gradientbang.utils.legacy_ids import canonicalize_character_id, deterministic_ship_id


class SupabaseAdminError(RuntimeError):
    """Raised when Supabase admin operations fail."""


CARGO_KEY_MAP = {
    "quantum_foam": "cargo_qf",
    "qf": "cargo_qf",
    "retro_organics": "cargo_ro",
    "ro": "cargo_ro",
    "neuro_symbolics": "cargo_ns",
    "ns": "cargo_ns",
}


class SupabaseAdminClient:
    """Lightweight client that talks directly to Supabase REST with a service-role key."""

    DEFAULT_CREDITS = int(os.getenv("SUPABASE_ADMIN_DEFAULT_CREDITS", "25000"))

    def __init__(
        self,
        *,
        supabase_url: Optional[str] = None,
        service_role_key: Optional[str] = None,
        timeout: float = 20.0,
    ) -> None:
        base_url = (supabase_url or os.getenv("SUPABASE_URL") or "").rstrip("/")
        if not base_url:
            raise SupabaseAdminError("SUPABASE_URL must be set to use Supabase admin helpers")
        key = service_role_key or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if not key:
            raise SupabaseAdminError("SUPABASE_SERVICE_ROLE_KEY is required for admin helpers")

        self._supabase_url = base_url
        self._rest_base = f"{self._supabase_url}/rest/v1"
        headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Prefer": "return=representation",
        }
        self._http = httpx.AsyncClient(base_url=self._rest_base, headers=headers, timeout=timeout)
        self._ship_definition_cache: Dict[str, Dict[str, Any]] = {}

    async def __aenter__(self) -> "SupabaseAdminClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:  # noqa: D401
        await self.close()

    async def close(self) -> None:
        await self._http.aclose()

    # ------------------------------------------------------------------
    # Public operations
    # ------------------------------------------------------------------

    async def create_character(
        self,
        *,
        name: str,
        player: Optional[Mapping[str, Any]] = None,
        ship: Optional[Mapping[str, Any]] = None,
        character_id: Optional[str] = None,
        ship_id: Optional[str] = None,
        start_sector: int = 0,
    ) -> Dict[str, Any]:
        sanitized_name = ensure_safe_character_name(name)
        canonical_id = canonicalize_character_id(character_id or sanitized_name)
        await self._assert_character_available(canonical_id, sanitized_name)

        timestamp = self._now_iso()
        sector_row = await self._fetch_sector(start_sector)
        map_knowledge = self._build_map_knowledge(sector_row, start_sector, timestamp)

        player_payload = self._build_player_payload(player)
        credits = player_payload.pop("credits", self.DEFAULT_CREDITS)
        player_type = player_payload.pop("player_type", None)
        metadata = player_payload or {}
        if player_type:
            metadata["player_type"] = player_type

        character_record = {
            "character_id": canonical_id,
            "name": sanitized_name,
            "credits_in_megabank": credits,
            "map_knowledge": map_knowledge,
            "player_metadata": metadata,
            "is_npc": False,
            "created_at": timestamp,
            "last_active": timestamp,
            "first_visit": timestamp,
        }
        inserted_character = await self._insert("characters", character_record)

        ship_record = await self._build_ship_insert_payload(
            owner_character_id=canonical_id,
            ship=ship,
            ship_id=ship_id,
            sector=start_sector,
            timestamp=timestamp,
        )
        inserted_ship = await self._insert("ship_instances", ship_record)

        await self._patch(
            "characters",
            {"current_ship_id": inserted_ship["ship_id"]},
            filters={"character_id": f"eq.{canonical_id}"},
        )

        return {
            "character": inserted_character,
            "ship": inserted_ship,
        }

    async def modify_character(
        self,
        *,
        character_id: str,
        name: Optional[str] = None,
        player: Optional[Mapping[str, Any]] = None,
        ship: Optional[Mapping[str, Any]] = None,
    ) -> Dict[str, Any]:
        canonical_id = canonicalize_character_id(character_id)
        character = await self._fetch_character(canonical_id)
        updates: Dict[str, Any] = {}
        if name:
            sanitized = ensure_safe_character_name(name)
            await self._assert_name_unique(sanitized, exclude_character=canonical_id)
            updates["name"] = sanitized
        if player:
            player_payload = self._build_player_payload(player)
            if "credits" in player_payload:
                updates["credits_in_megabank"] = player_payload.pop("credits")
            if player_payload:
                metadata = dict(character.get("player_metadata") or {})
                metadata.update(player_payload)
                updates["player_metadata"] = metadata
        character_after = character
        if updates:
            character_after = await self._patch(
                "characters", updates, filters={"character_id": f"eq.{canonical_id}"}
            )

        ship_after = None
        if ship:
            ship_id = character_after.get("current_ship_id")
            if not ship_id:
                raise SupabaseAdminError("Character does not currently own a ship to modify")
            ship_updates = await self._build_ship_update_payload(ship, timestamp=self._now_iso())
            if ship_updates:
                ship_after = await self._patch(
                    "ship_instances",
                    ship_updates,
                    filters={"ship_id": f"eq.{ship_id}"},
                )
        return {
            "character": character_after,
            "ship": ship_after,
        }

    async def delete_character(self, character_id: str) -> None:
        canonical_id = canonicalize_character_id(character_id)
        await self._patch(
            "characters",
            {"current_ship_id": None},
            filters={"character_id": f"eq.{canonical_id}"},
        )
        ship_ids = await self._list_ship_ids(canonical_id)
        for ship_id in ship_ids:
            await self._delete("events", filters={"ship_id": f"eq.{ship_id}"})
            await self._delete("port_transactions", filters={"ship_id": f"eq.{ship_id}"})
        await self._delete("events", filters={"character_id": f"eq.{canonical_id}"})
        await self._delete("events", filters={"sender_id": f"eq.{canonical_id}"})
        await self._delete("ship_instances", filters={"owner_character_id": f"eq.{canonical_id}"})
        await self._delete("characters", filters={"character_id": f"eq.{canonical_id}"})

    async def _list_ship_ids(self, owner_character_id: str) -> List[str]:
        params = {
            "owner_character_id": f"eq.{owner_character_id}",
            "select": "ship_id",
        }
        rows = await self._request("GET", "/ship_instances", params=params)
        if not isinstance(rows, list):
            return []
        return [row.get("ship_id") for row in rows if isinstance(row, Mapping) and row.get("ship_id")]

    # ------------------------------------------------------------------
    # Builders / validators
    # ------------------------------------------------------------------

    async def _build_ship_insert_payload(
        self,
        *,
        owner_character_id: str,
        ship: Optional[Mapping[str, Any]],
        ship_id: Optional[str],
        sector: int,
        timestamp: str,
    ) -> Dict[str, Any]:
        ship_data = dict(ship or {})
        ship_type = str(ship_data.get("ship_type", "kestrel_courier")).strip().lower()
        definition = await self._load_ship_definition(ship_type)
        warp_power = self._coerce_int(ship_data.get("current_warp_power"), definition["warp_power_capacity"])
        shields = self._coerce_int(ship_data.get("current_shields"), definition["shields"])
        fighters = self._coerce_int(ship_data.get("current_fighters"), definition["fighters"])
        cargo = self._extract_cargo(ship_data)
        canonical_owner = canonicalize_character_id(owner_character_id)
        ship_uuid = ship_id or deterministic_ship_id(f"{canonical_owner}:{ship_type}")
        return {
            "ship_id": ship_uuid,
            "owner_id": canonical_owner,
            "owner_type": "character",
            "owner_character_id": canonical_owner,
            "ship_type": ship_type,
            "ship_name": ship_data.get("ship_name") or definition.get("display_name"),
            "current_sector": sector,
            "in_hyperspace": False,
            "credits": self._coerce_int(ship_data.get("credits"), 0),
            "cargo_qf": cargo.get("cargo_qf", 0),
            "cargo_ro": cargo.get("cargo_ro", 0),
            "cargo_ns": cargo.get("cargo_ns", 0),
            "current_warp_power": warp_power,
            "current_shields": shields,
            "current_fighters": fighters,
            "metadata": ship_data.get("metadata") or {},
            "acquired": timestamp,
            "created_at": timestamp,
            "updated_at": timestamp,
        }

    async def _build_ship_update_payload(
        self,
        ship: Mapping[str, Any],
        *,
        timestamp: str,
    ) -> Dict[str, Any]:
        updates: Dict[str, Any] = {}
        cargo = self._extract_cargo(ship)
        if cargo:
            updates.update(cargo)
        if ship.get("ship_name") is not None:
            updates["ship_name"] = ship.get("ship_name")
        if ship.get("ship_type") is not None:
            ship_type = str(ship.get("ship_type")).strip().lower()
            definition = await self._load_ship_definition(ship_type)
            updates["ship_type"] = ship_type
            updates.setdefault("current_warp_power", definition["warp_power_capacity"])
            updates.setdefault("current_shields", definition["shields"])
            updates.setdefault("current_fighters", definition["fighters"])
        for key, column in (
            ("current_warp_power", "current_warp_power"),
            ("current_shields", "current_shields"),
            ("current_fighters", "current_fighters"),
            ("credits", "credits"),
        ):
            if ship.get(key) is not None:
                updates[column] = self._coerce_int(ship.get(key), 0)
        if updates:
            updates["updated_at"] = timestamp
        return updates

    def _build_player_payload(self, player: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
        if not player:
            return {}
        sanitized: Dict[str, Any] = {}
        if player.get("credits") is not None:
            sanitized["credits"] = self._coerce_int(player.get("credits"), self.DEFAULT_CREDITS)
        if player.get("player_type"):
            sanitized["player_type"] = str(player.get("player_type")).strip()
        return sanitized

    def _extract_cargo(self, ship: Mapping[str, Any]) -> Dict[str, int]:
        manifest = ship.get("cargo")
        if not isinstance(manifest, Mapping):
            return {}
        cargo: Dict[str, int] = {}
        for raw_key, raw_value in manifest.items():
            if raw_value is None:
                continue
            normalized = str(raw_key).strip().lower()
            destination = CARGO_KEY_MAP.get(normalized)
            if not destination:
                continue
            cargo[destination] = self._coerce_int(raw_value, 0)
        return cargo

    # ------------------------------------------------------------------
    # Data access helpers
    # ------------------------------------------------------------------

    async def _insert(self, table: str, payload: Mapping[str, Any]) -> Dict[str, Any]:
        rows = await self._request("POST", f"/{table}", json=payload)
        if isinstance(rows, list) and rows:
            return rows[0]
        raise SupabaseAdminError(f"Insert into {table} returned no rows")

    async def _patch(
        self,
        table: str,
        payload: Mapping[str, Any],
        *,
        filters: Mapping[str, str],
    ) -> Dict[str, Any]:
        rows = await self._request("PATCH", f"/{table}", params=dict(filters), json=payload)
        if isinstance(rows, list) and rows:
            return rows[0]
        raise SupabaseAdminError(f"Update on {table} returned no rows")

    async def _delete(self, table: str, *, filters: Mapping[str, str]) -> None:
        await self._request("DELETE", f"/{table}", params=dict(filters))

    async def _select_one(
        self,
        table: str,
        *,
        filters: Mapping[str, str],
        select: str = "*",
    ) -> Dict[str, Any]:
        params = dict(filters)
        params["select"] = select
        rows = await self._request("GET", f"/{table}", params=params)
        if isinstance(rows, list) and rows:
            return rows[0]
        raise SupabaseAdminError(f"No rows returned from {table}")

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Mapping[str, Any]] = None,
        json: Optional[Mapping[str, Any]] = None,
    ) -> Any:
        response = await self._http.request(method, path, params=params, json=json)
        if response.is_success:
            if not response.content:
                return None
            try:
                return response.json()
            except ValueError:
                return None
        detail = self._extract_error(response)
        raise SupabaseAdminError(detail)

    # ------------------------------------------------------------------
    # Lookups & validation helpers
    # ------------------------------------------------------------------

    async def _load_ship_definition(self, ship_type: str) -> Dict[str, Any]:
        ship_type = ship_type.strip().lower()
        if ship_type in self._ship_definition_cache:
            return self._ship_definition_cache[ship_type]
        definition = await self._select_one(
            "ship_definitions",
            filters={"ship_type": f"eq.{ship_type}"},
        )
        self._ship_definition_cache[ship_type] = definition
        return definition

    async def _fetch_sector(self, sector_id: int) -> Dict[str, Any]:
        return await self._select_one(
            "universe_structure",
            filters={"sector_id": f"eq.{sector_id}"},
            select="sector_id,position_x,position_y,warps",
        )

    async def _fetch_character(self, character_id: str) -> Dict[str, Any]:
        return await self._select_one(
            "characters",
            filters={"character_id": f"eq.{character_id}"},
            select="character_id,name,current_ship_id,player_metadata,credits_in_megabank",
        )

    async def _assert_character_available(self, character_id: str, name: str) -> None:
        try:
            await self._fetch_character(character_id)
        except SupabaseAdminError:
            pass
        else:
            raise SupabaseAdminError(f"Character ID {character_id} already exists")
        await self._assert_name_unique(name)

    async def _assert_name_unique(self, name: str, *, exclude_character: Optional[str] = None) -> None:
        try:
            existing = await self._select_one(
                "characters",
                filters={"name": f"eq.{name}"},
                select="character_id,name",
            )
        except SupabaseAdminError:
            return
        if exclude_character and existing.get("character_id") == exclude_character:
            return
        raise SupabaseAdminError(f"Character name '{name}' is already in use")

    def _build_map_knowledge(
        self,
        sector_row: Mapping[str, Any],
        sector_id: int,
        timestamp: str,
    ) -> Dict[str, Any]:
        position = [int(sector_row.get("position_x") or 0), int(sector_row.get("position_y") or 0)]
        adjacency: List[int] = []
        warps_raw = sector_row.get("warps")
        warps_obj: Iterable[Mapping[str, Any]] = []
        if isinstance(warps_raw, str):
            warps_obj = json.loads(warps_raw)
        elif isinstance(warps_raw, Iterable):
            warps_obj = warps_raw  # type: ignore[assignment]
        for edge in warps_obj:
            if not isinstance(edge, Mapping):
                continue
            try:
                adjacency.append(int(edge.get("to")))
            except (TypeError, ValueError):
                continue
        return {
            "current_sector": sector_id,
            "total_sectors_visited": 1,
            "sectors_visited": {
                str(sector_id): {
                    "last_visited": timestamp,
                    "adjacent_sectors": adjacency,
                    "position": position,
                }
            },
        }

    # ------------------------------------------------------------------
    # Utility helpers
    # ------------------------------------------------------------------

    def _coerce_int(self, value: Any, default: int) -> int:
        if value is None:
            return int(default)
        return int(value)

    def _now_iso(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _extract_error(self, response: httpx.Response) -> str:
        try:
            payload = response.json()
        except ValueError:
            return f"Supabase request failed ({response.status_code}): {response.text}"
        detail_parts = [
            str(payload.get("message")) if payload.get("message") else "",
            str(payload.get("details")) if payload.get("details") else "",
            str(payload.get("hint")) if payload.get("hint") else "",
        ]
        detail = "; ".join(part for part in detail_parts if part)
        if not detail:
            detail = response.text or f"Status {response.status_code}"
        return detail