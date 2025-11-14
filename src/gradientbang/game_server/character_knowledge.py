#!/usr/bin/env python3
"""
Character map knowledge persistence for Gradient Bang.

This module handles storing and retrieving map knowledge for each character,
including visited sectors, discovered ports, and learned connections.
"""

from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import os
import threading
from typing import Dict, Iterator, List, Set, Optional, Any, Tuple

from pydantic import BaseModel, Field

from gradientbang.game_server.ships import ShipType, get_ship_stats
from gradientbang.utils.config import get_world_data_path


class SectorKnowledge(BaseModel):
    """Knowledge about a specific sector."""

    sector_id: int
    last_visited: str
    port: Optional[dict] = None
    position: Tuple[int, int] = (0, 0)
    planets: List[dict] = []
    adjacent_sectors: List[int] = []


class MapKnowledge(BaseModel):
    """Complete map knowledge for a character."""

    character_id: str
    sectors_visited: Dict[str, SectorKnowledge] = Field(default_factory=dict)
    total_sectors_visited: int = 0
    first_visit: Optional[str] = None
    last_update: Optional[str] = None
    current_ship_id: Optional[str] = None
    credits: int = 1000
    credits_in_bank: int = 0
    current_sector: Optional[int] = None
    corporation: Optional[dict] = None


class CharacterKnowledgeManager:
    """Manages persistent map knowledge for all characters."""

    def __init__(self, data_dir: Path | None = None):
        if data_dir is None:
            self.data_dir = get_world_data_path() / "character-map-knowledge"
        else:
            self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)

        self.cache: Dict[str, MapKnowledge] = {}
        self._locks: Dict[str, threading.Lock] = {}
        self._ships_manager = None

    # ------------------------------------------------------------------
    # Ship helpers
    # ------------------------------------------------------------------
    def set_ships_manager(self, ships_manager) -> None:
        self._ships_manager = ships_manager

    def _require_ships_manager(self) -> None:
        if self._ships_manager is None:
            raise RuntimeError("ShipsManager not configured on CharacterKnowledgeManager")

    def _default_sector(self, knowledge: MapKnowledge) -> int:
        if knowledge.current_sector is not None:
            return knowledge.current_sector
        return 0

    def _create_ship(
        self,
        knowledge: MapKnowledge,
        ship_type: ShipType,
        *,
        name: Optional[str] = None,
        fighters: Optional[int] = None,
        shields: Optional[int] = None,
        warp_power: Optional[int] = None,
        cargo: Optional[Dict[str, int]] = None,
        modules: Optional[List[str]] = None,
        credits: Optional[int] = None,
    ) -> str:
        self._require_ships_manager()
        ship_id = self._ships_manager.create_ship(
            ship_type=ship_type.value,
            sector=self._default_sector(knowledge),
            owner_type="character",
            owner_id=knowledge.character_id,
            name=name,
        )
        state_updates: Dict[str, Any] = {}
        initial_credits: Optional[int] = None
        if credits is not None:
            initial_credits = self._ships_manager.validate_ship_credits(ship_id, credits)
            state_updates["credits"] = initial_credits
        stats = get_ship_stats(ship_type)
        if fighters is not None:
            state_updates["fighters"] = max(0, min(int(fighters), stats.fighters))
        if shields is not None:
            state_updates["shields"] = max(0, min(int(shields), stats.shields))
        if warp_power is not None:
            state_updates["warp_power"] = max(0, min(int(warp_power), stats.warp_power_capacity))
        if cargo is not None:
            normalized_cargo = {
                "quantum_foam": int(cargo.get("quantum_foam", 0)),
                "retro_organics": int(cargo.get("retro_organics", 0)),
                "neuro_symbolics": int(cargo.get("neuro_symbolics", 0)),
            }
            state_updates["cargo"] = normalized_cargo
        if modules is not None:
            state_updates["modules"] = list(modules)
        if state_updates:
            self._ships_manager.update_ship_state(ship_id, **state_updates)
        if hasattr(knowledge, "credits"):
            if initial_credits is not None:
                knowledge.credits = initial_credits
            else:
                ship_record = self._ships_manager.get_ship(ship_id)
                if ship_record is not None:
                    state = ship_record.get("state", {})
                    knowledge.credits = int(state.get("credits", getattr(knowledge, "credits", 0)))
        knowledge.current_ship_id = ship_id
        return ship_id

    def create_corp_ship_character(
        self,
        *,
        ship_id: str,
        corp_id: str,
        sector: Optional[int] = None,
        joined_at: Optional[str] = None,
    ) -> MapKnowledge:
        """Create or overwrite knowledge for a corporation-owned autonomous ship."""

        self._require_ships_manager()
        lock = self._locks.setdefault(ship_id, threading.Lock())
        with lock:
            ship = self._ships_manager.get_ship(ship_id)
            if ship is None:
                raise KeyError(f"Ship not found when creating corp character: {ship_id}")

            now = datetime.now(timezone.utc).isoformat()
            ship_sector = ship.get("sector", 0)
            resolved_sector = ship_sector if sector is None else sector
            ship_state = ship.get("state", {}) or {}
            ship_credits = int(ship_state.get("credits", 0))

            knowledge = MapKnowledge(
                character_id=ship_id,
                current_ship_id=ship_id,
                current_sector=resolved_sector,
                first_visit=now,
                last_update=now,
                credits=ship_credits,
                credits_in_bank=0,
                corporation={
                    "corp_id": corp_id,
                    "joined_at": joined_at or now,
                },
            )

            self.cache[ship_id] = knowledge
            self.save_knowledge(knowledge)
            return knowledge

    def _ensure_ship(
        self,
        knowledge: MapKnowledge,
        *,
        legacy_ship: Optional[Dict[str, Any]] = None,
    ) -> str:
        self._require_ships_manager()
        ship_id = knowledge.current_ship_id
        ship = self._ships_manager.get_ship(ship_id) if ship_id else None

        if legacy_ship:
            ship_type_value = legacy_ship.get("ship_type", ShipType.KESTREL_COURIER.value)
            try:
                ship_type = ShipType(ship_type_value)
            except ValueError:
                ship_type = ShipType.KESTREL_COURIER
            fighters = legacy_ship.get("current_fighters")
            shields = legacy_ship.get("current_shields")
            warp_power = legacy_ship.get("current_warp_power")
            cargo = legacy_ship.get("cargo")
            modules = legacy_ship.get("equipped_modules", [])
            name = legacy_ship.get("ship_name")
            if ship is None:
                ship_id = self._create_ship(
                    knowledge,
                    ship_type,
                    name=name,
                    fighters=fighters,
                    shields=shields,
                    warp_power=warp_power,
                    cargo=cargo,
                    modules=modules,
                    credits=getattr(knowledge, "credits", None),
                )
            else:
                state_updates: Dict[str, Any] = {}
                stats = get_ship_stats(ship_type)
                if fighters is not None:
                    state_updates["fighters"] = max(0, min(int(fighters), stats.fighters))
                if shields is not None:
                    state_updates["shields"] = max(0, min(int(shields), stats.shields))
                if warp_power is not None:
                    state_updates["warp_power"] = max(0, min(int(warp_power), stats.warp_power_capacity))
                if cargo is not None:
                    normalized_cargo = {
                        "quantum_foam": int(cargo.get("quantum_foam", 0)),
                        "retro_organics": int(cargo.get("retro_organics", 0)),
                        "neuro_symbolics": int(cargo.get("neuro_symbolics", 0)),
                    }
                    state_updates["cargo"] = normalized_cargo
                if modules:
                    state_updates["modules"] = list(modules)
                if state_updates:
                    self._ships_manager.update_ship_state(ship_id, **state_updates)
                if name:
                    updated = self._ships_manager.get_ship(ship_id)
                    if updated is not None:
                        updated["name"] = name
                        self._ships_manager.save_ship(ship_id, updated)
            knowledge.current_ship_id = ship_id
            return ship_id

        if ship is None:
            ship_id = self._create_ship(
                knowledge,
                ShipType.KESTREL_COURIER,
                credits=getattr(knowledge, "credits", None),
            )
            return ship_id

        # Short circuit for corporation-owned autonomous ships
        if ship is not None:
            is_corp_ship = (
                ship.get("owner_type") == "corporation"
                and ship.get("ship_id") == knowledge.character_id
            )
            if is_corp_ship:
                save_required = False
                knowledge.current_ship_id = ship["ship_id"]
                sector = ship.get("sector")
                if sector is not None and knowledge.current_sector != sector:
                    knowledge.current_sector = sector
                    save_required = True
                owner_corp = ship.get("owner_id")
                if owner_corp and (
                    not isinstance(knowledge.corporation, dict)
                    or knowledge.corporation.get("corp_id") != owner_corp
                ):
                    joined_at = None
                    if isinstance(knowledge.corporation, dict):
                        joined_at = knowledge.corporation.get("joined_at")
                    knowledge.corporation = {
                        "corp_id": owner_corp,
                        "joined_at": joined_at or datetime.now(timezone.utc).isoformat(),
                    }
                    save_required = True
                if hasattr(knowledge, "credits"):
                    ship_state = ship.get("state", {}) or {}
                    ship_credits = int(ship_state.get("credits", 0))
                    if knowledge.credits != ship_credits:
                        knowledge.credits = ship_credits
                        save_required = True
                if save_required:
                    self.save_knowledge(knowledge)
                return ship["ship_id"]

        # Update owner/sector if missing or stale
        owner_changed = False
        if ship.get("owner_type") != "character" or ship.get("owner_id") != knowledge.character_id:
            owner_changed = True
        if owner_changed:
            self._ships_manager.transfer_ownership(ship_id, "character", knowledge.character_id)
        if ship.get("sector") != self._default_sector(knowledge):
            self._ships_manager.move_ship(ship_id, self._default_sector(knowledge))
        knowledge.current_ship_id = ship_id
        if hasattr(knowledge, "credits"):
            ship_state = ship.get("state", {}) if ship else {}
            ship_credits = int(ship_state.get("credits", 0))
            legacy_credits = int(getattr(knowledge, "credits", 0))
            if ship_credits == 0 and legacy_credits > 0:
                try:
                    validated = self._ships_manager.validate_ship_credits(ship_id, legacy_credits)
                except ValueError:
                    validated = 0
                if validated != ship_credits:
                    self._ships_manager.update_ship_state(ship_id, credits=validated)
                    ship_credits = validated
            knowledge.credits = ship_credits
        return ship_id

    def _get_ship(self, knowledge: MapKnowledge) -> dict:
        ship_id = self._ensure_ship(knowledge)
        ship = self._ships_manager.get_ship(ship_id)
        if ship is None:  # Should not happen, but guard
            ship_id = self._create_ship(
                knowledge,
                ShipType.KESTREL_COURIER,
                credits=getattr(knowledge, "credits", None),
            )
            ship = self._ships_manager.get_ship(ship_id)
        return ship

    def get_ship(self, character_id: str) -> dict:
        knowledge = self.load_knowledge(character_id)
        return self._get_ship(knowledge)

    def create_ship_for_character(
        self,
        character_id: str,
        ship_type: ShipType,
        *,
        name: Optional[str] = None,
        fighters: Optional[int] = None,
        shields: Optional[int] = None,
        warp_power: Optional[int] = None,
        cargo: Optional[Dict[str, int]] = None,
        modules: Optional[List[str]] = None,
        sector: Optional[int] = None,
        abandon_existing: bool = False,
        former_owner_name: Optional[str] = None,
        credits: Optional[int] = None,
    ) -> str:
        lock = self._locks.setdefault(character_id, threading.Lock())
        with lock:
            knowledge = self.load_knowledge(character_id)
            if sector is not None:
                knowledge.current_sector = sector
            if abandon_existing and knowledge.current_ship_id and self._ships_manager:
                old_ship = self._ships_manager.get_ship(knowledge.current_ship_id)
                if old_ship is not None:
                    owner_name = former_owner_name or character_id
                    self._ships_manager.mark_as_unowned(
                        knowledge.current_ship_id,
                        owner_name,
                    )
            knowledge.current_ship_id = None
            ship_id = self._create_ship(
                knowledge,
                ship_type,
                name=name,
                fighters=fighters,
                shields=shields,
                warp_power=warp_power,
                cargo=cargo,
                modules=modules,
                credits=credits if credits is not None else getattr(knowledge, "credits", None),
            )
            self.save_knowledge(knowledge)
            return ship_id

    # ------------------------------------------------------------------
    # Core persistence
    # ------------------------------------------------------------------
    def get_file_path(self, character_id: str) -> Path:
        safe_id = "".join(c if c.isalnum() or c in "_-" else "_" for c in character_id)
        return self.data_dir / f"{safe_id}.json"

    def has_knowledge(self, character_id: str) -> bool:
        return self.get_file_path(character_id).exists()

    def iter_saved_knowledge(self) -> Iterator[MapKnowledge]:
        for path in sorted(self.data_dir.glob("*.json")):
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    data = json.load(handle)
            except Exception as exc:  # noqa: BLE001
                print(f"Error iterating knowledge file {path}: {exc}")
                continue
            legacy_ship = data.pop("ship_config", None)
            try:
                knowledge = MapKnowledge(**data)
            except Exception as exc:
                print(f"Error parsing knowledge file {path}: {exc}")
                continue
            self.cache[knowledge.character_id] = knowledge
            if self._ships_manager:
                self._ensure_ship(knowledge, legacy_ship=legacy_ship)
            yield knowledge

    def load_knowledge(self, character_id: str) -> MapKnowledge:
        if character_id in self.cache:
            return self.cache[character_id]

        file_path = self.get_file_path(character_id)
        data: Dict[str, Any]
        legacy_ship: Optional[Dict[str, Any]] = None

        if file_path.exists():
            try:
                with open(file_path, "r", encoding="utf-8") as handle:
                    data = json.load(handle)
            except Exception as exc:  # noqa: BLE001
                print(f"Error loading knowledge for {character_id}: {exc}")
                data = {}
        else:
            data = {}

        legacy_ship = data.pop("ship_config", None)
        data.setdefault("character_id", character_id)
        knowledge = MapKnowledge(**data)

        self.cache[character_id] = knowledge

        if self._ships_manager:
            ship_id = self._ensure_ship(knowledge, legacy_ship=legacy_ship)
            if knowledge.current_ship_id != ship_id:
                knowledge.current_ship_id = ship_id
            if legacy_ship is not None:
                self.save_knowledge(knowledge)
        elif legacy_ship is not None:
            # Without ships manager we can't migrate immediately; drop legacy to avoid ValueError on next load
            knowledge.current_ship_id = None
            self.save_knowledge(knowledge)

        return knowledge

    def save_knowledge(self, knowledge: MapKnowledge) -> None:
        file_path = self.get_file_path(knowledge.character_id)
        payload = knowledge.model_dump()
        try:
            tmp = file_path.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2)
            tmp.replace(file_path)
            self.cache[knowledge.character_id] = knowledge
        except Exception as exc:  # noqa: BLE001
            print(f"Error saving knowledge for {knowledge.character_id}: {exc}")

    def delete_knowledge(self, character_id: str) -> None:
        file_path = self.get_file_path(character_id)
        try:
            if file_path.exists():
                file_path.unlink()
        except Exception as exc:  # noqa: BLE001
            print(f"Error deleting knowledge for {character_id}: {exc}")
        self.cache.pop(character_id, None)

    # ------------------------------------------------------------------
    # Ship state helpers (legacy API maintained for now)
    # ------------------------------------------------------------------
    def set_fighters(
        self, character_id: str, fighters: int, *, max_fighters: int | None = None
    ) -> None:
        lock = self._locks.setdefault(character_id, threading.Lock())
        with lock:
            knowledge = self.load_knowledge(character_id)
            ship = self._get_ship(knowledge)
            stats = get_ship_stats(ShipType(ship["ship_type"]))
            cap = max_fighters if max_fighters is not None else stats.fighters
            value = max(0, min(int(fighters), cap))
            self._ships_manager.update_ship_state(ship["ship_id"], fighters=value)

    def adjust_fighters(
        self, character_id: str, delta: int, *, max_fighters: int | None = None
    ) -> None:
        lock = self._locks.setdefault(character_id, threading.Lock())
        with lock:
            knowledge = self.load_knowledge(character_id)
            ship = self._get_ship(knowledge)
            stats = get_ship_stats(ShipType(ship["ship_type"]))
            cap = max_fighters if max_fighters is not None else stats.fighters
            current = ship.get("state", {}).get("fighters", stats.fighters)
            value = max(0, min(current + int(delta), cap))
            self._ships_manager.update_ship_state(ship["ship_id"], fighters=value)

    def set_shields(
        self, character_id: str, shields: int, *, max_shields: int | None = None
    ) -> None:
        lock = self._locks.setdefault(character_id, threading.Lock())
        with lock:
            knowledge = self.load_knowledge(character_id)
            ship = self._get_ship(knowledge)
            stats = get_ship_stats(ShipType(ship["ship_type"]))
            cap = max_shields if max_shields is not None else stats.shields
            value = max(0, min(int(shields), cap))
            self._ships_manager.update_ship_state(ship["ship_id"], shields=value)

    def update_cargo(
        self, character_id: str, commodity: str, quantity_delta: int
    ) -> None:
        if commodity not in {"quantum_foam", "retro_organics", "neuro_symbolics"}:
            raise ValueError(f"Unknown commodity: {commodity}")
        lock = self._locks.setdefault(character_id, threading.Lock())
        with lock:
            knowledge = self.load_knowledge(character_id)
            ship = self._get_ship(knowledge)
            state = ship.get("state", {})
            cargo = dict(state.get("cargo", {}))
            current = int(cargo.get(commodity, 0))
            cargo[commodity] = max(0, current + int(quantity_delta))
            self._ships_manager.update_ship_state(ship["ship_id"], cargo=cargo)

    def get_cargo(self, character_id: str) -> Dict[str, int]:
        knowledge = self.load_knowledge(character_id)
        ship = self._get_ship(knowledge)
        cargo = ship.get("state", {}).get("cargo", {})
        return {
            "quantum_foam": int(cargo.get("quantum_foam", 0)),
            "retro_organics": int(cargo.get("retro_organics", 0)),
            "neuro_symbolics": int(cargo.get("neuro_symbolics", 0)),
        }

    def get_ship_name(self, character_id: str) -> Optional[str]:
        knowledge = self.load_knowledge(character_id)
        ship = self._get_ship(knowledge)
        return ship.get("name")

    def set_ship_name(self, character_id: str, ship_name: Optional[str]) -> None:
        lock = self._locks.setdefault(character_id, threading.Lock())
        with lock:
            knowledge = self.load_knowledge(character_id)
            ship = self._get_ship(knowledge)
            updated = self._ships_manager.get_ship(ship["ship_id"])
            if updated is None:
                return
            updated["name"] = ship_name or None
            self._ships_manager.save_ship(ship["ship_id"], updated)

    # ------------------------------------------------------------------
    # Credit helpers
    # ------------------------------------------------------------------
    def update_credits(self, character_id: str, credits: int) -> None:
        self.update_ship_credits(character_id, credits)

    def get_credits(self, character_id: str) -> int:
        return self.get_ship_credits(character_id)

    def update_ship_credits(self, character_id: str, credits: int) -> None:
        lock = self._locks.setdefault(character_id, threading.Lock())
        with lock:
            knowledge = self.load_knowledge(character_id)
            ship = self._get_ship(knowledge)
            ship_id = ship["ship_id"]
            validated = self._ships_manager.validate_ship_credits(ship_id, credits)
            self._ships_manager.update_ship_state(ship_id, credits=validated)
            if hasattr(knowledge, "credits"):
                knowledge.credits = validated
            self.save_knowledge(knowledge)

    def get_ship_credits(self, character_id: str) -> int:
        knowledge = self.load_knowledge(character_id)
        ship = self._get_ship(knowledge)
        credits = int(ship.get("state", {}).get("credits", 0))
        if hasattr(knowledge, "credits"):
            knowledge.credits = credits
        return credits

    def update_bank_credits(self, character_id: str, credits: int) -> None:
        lock = self._locks.setdefault(character_id, threading.Lock())
        with lock:
            knowledge = self.load_knowledge(character_id)
            knowledge.credits_in_bank = max(0, credits)
            self.save_knowledge(knowledge)

    def get_bank_credits(self, character_id: str) -> int:
        knowledge = self.load_knowledge(character_id)
        return knowledge.credits_in_bank

    # ------------------------------------------------------------------
    # Sector knowledge (unchanged logic)
    # ------------------------------------------------------------------
    def update_sector_visit(
        self,
        character_id: str,
        sector_id: int,
        port: Optional[dict] = None,
        position: Tuple[int, int] = (0, 0),
        planets: Optional[List[dict]] = None,
        adjacent_sectors: Optional[List[int]] = None,
    ) -> bool:
        lock = self._locks.setdefault(character_id, threading.Lock())
        with lock:
            knowledge = self.load_knowledge(character_id)

        now = datetime.now(timezone.utc).isoformat()
        sector_key = str(sector_id)

        if knowledge.first_visit is None:
            knowledge.first_visit = now

        is_first_visit = sector_key not in knowledge.sectors_visited
        if is_first_visit:
            knowledge.total_sectors_visited += 1

        sector_knowledge = SectorKnowledge(
            sector_id=sector_id,
            last_visited=now,
            port=port,
            position=position,
            adjacent_sectors=adjacent_sectors or [],
        )

        if sector_key in knowledge.sectors_visited:
            existing = knowledge.sectors_visited[sector_key]
            if port is None:
                sector_knowledge.port = existing.port
            if not adjacent_sectors:
                sector_knowledge.adjacent_sectors = existing.adjacent_sectors

        knowledge.sectors_visited[sector_key] = sector_knowledge
        knowledge.last_update = now
        knowledge.current_sector = sector_id
        self.save_knowledge(knowledge)
        return is_first_visit

    def update_port_observation(
        self,
        character_id: str,
        sector_id: int,
        port_data: Dict[str, Any],
    ) -> None:
        port_copy = deepcopy(port_data)
        observed_at = port_copy.get("observed_at")
        if not observed_at:
            observed_at = datetime.now(timezone.utc).isoformat()
            port_copy["observed_at"] = observed_at

        sector_key = str(sector_id)
        lock = self._locks.setdefault(character_id, threading.Lock())
        with lock:
            knowledge = self.load_knowledge(character_id)
            if sector_key in knowledge.sectors_visited:
                sector_knowledge = knowledge.sectors_visited[sector_key]
                sector_knowledge.port = port_copy
            else:
                sector_knowledge = SectorKnowledge(
                    sector_id=sector_id,
                    last_visited=observed_at,
                    port=port_copy,
                )
                knowledge.sectors_visited[sector_key] = sector_knowledge
            knowledge.last_update = observed_at
            self.save_knowledge(knowledge)

    def update_current_sector(self, character_id: str, sector_id: int) -> None:
        lock = self._locks.setdefault(character_id, threading.Lock())
        with lock:
            knowledge = self.load_knowledge(character_id)
            knowledge.current_sector = sector_id
            knowledge.last_update = datetime.now(timezone.utc).isoformat()
            self.save_knowledge(knowledge)

    def get_current_sector(self, character_id: str) -> Optional[int]:
        knowledge = self.load_knowledge(character_id)
        return knowledge.current_sector

    def get_known_ports(self, character_id: str) -> List[Dict[str, Any]]:
        knowledge = self.load_knowledge(character_id)
        ports: List[Dict[str, Any]] = []
        for sector_id, sector_knowledge in knowledge.sectors_visited.items():
            if sector_knowledge.port:
                ports.append(
                    {
                        "sector_id": int(sector_id),
                        "port": sector_knowledge.port,
                    }
                )
        return ports

    def get_known_sectors(self, character_id: str) -> List[int]:
        knowledge = self.load_knowledge(character_id)
        return [int(sector_id) for sector_id in knowledge.sectors_visited.keys()]

    # ------------------------------------------------------------------
    # Debug / utility helpers
    # ------------------------------------------------------------------
    def clear_cache(self) -> None:
        self.cache.clear()
        self._locks.clear()


# Utilities for offline migration -------------------------------------------------

def migrate_legacy_knowledge_dir(data_dir: Path, ships_manager) -> None:
    manager = CharacterKnowledgeManager(data_dir)
    manager.set_ships_manager(ships_manager)
    for knowledge in manager.iter_saved_knowledge():
        manager.save_knowledge(knowledge)
