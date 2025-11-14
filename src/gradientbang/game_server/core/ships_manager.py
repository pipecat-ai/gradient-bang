"""File-backed ship persistence and helpers."""

from __future__ import annotations

import copy
import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from gradientbang.game_server.ships import ShipType, get_ship_stats

_OWNER_TYPES = {"character", "corporation", "unowned"}
_CARGO_KEYS = ("quantum_foam", "retro_organics", "neuro_symbolics")


class ShipsManager:
    """Manage ship records stored in world-data/ships.json."""

    def __init__(self, world_data_dir: str | Path) -> None:
        base_path = Path(world_data_dir)
        self._ships_file = base_path / "ships.json"
        self._ships_file.parent.mkdir(parents=True, exist_ok=True)
        if not self._ships_file.exists():
            self._ships_file.write_text("{}\n", encoding="utf-8")
        self._lock = threading.RLock()
        self._per_ship_locks: Dict[str, threading.RLock] = {}
        self._ships_cache: Dict[str, dict] = {}
        self._ships_mtime: int = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def load_all_ships(self) -> Dict[str, dict]:
        """Load every ship into the in-memory cache."""
        with self._lock:
            data = self._read_from_disk()
            self._ships_cache = {ship_id: value for ship_id, value in data.items()}
            self._sync_per_ship_locks()
            return copy.deepcopy(self._ships_cache)

    def get_ship(self, ship_id: str) -> Optional[dict]:
        """Return a deep copy of a ship record."""
        with self._lock:
            self._ensure_loaded()
            ship = self._ships_cache.get(ship_id)
            if ship is None:
                self._reload_from_disk()
                ship = self._ships_cache.get(ship_id)
            return copy.deepcopy(ship) if ship else None

    def save_ship(self, ship_id: str, ship_data: dict) -> None:
        """Persist a full ship record (create or replace)."""
        if not isinstance(ship_data, dict):  # pragma: no cover - defensive
            raise TypeError("ship_data must be a dict")
        owner_type = ship_data.get("owner_type")
        if owner_type not in _OWNER_TYPES:
            raise ValueError(f"Invalid owner_type: {owner_type}")

        with self._lock:
            self._ensure_loaded()
            record = copy.deepcopy(ship_data)
            self._ships_cache[ship_id] = record
            self._per_ship_locks.setdefault(ship_id, threading.RLock())
            self._flush_locked()

    def delete_ship(self, ship_id: str) -> None:
        """Remove a ship record."""
        with self._lock:
            self._ensure_loaded()
            if ship_id in self._ships_cache:
                self._ships_cache.pop(ship_id)
                self._per_ship_locks.pop(ship_id, None)
                self._flush_locked()

    def create_ship(
        self,
        *,
        ship_type: str,
        sector: int,
        owner_type: str,
        owner_id: Optional[str],
        name: Optional[str] = None,
    ) -> str:
        """Create a new ship with stats seeded from the registry."""
        ship_type_enum = ShipType(ship_type)
        if owner_type not in _OWNER_TYPES:
            raise ValueError(f"Invalid owner_type: {owner_type}")
        if owner_type != "unowned" and not owner_id:
            raise ValueError("owner_id is required for character/corporation owned ships")

        stats = get_ship_stats(ship_type_enum)
        ship_id = _generate_uuid()
        ship_record = {
            "ship_id": ship_id,
            "ship_type": ship_type_enum.value,
            "name": name,
            "sector": sector,
            "owner_type": owner_type,
            "owner_id": owner_id if owner_type != "unowned" else None,
            "acquired": datetime.now(timezone.utc).isoformat(),
            "state": {
                "fighters": stats.fighters,
                "shields": stats.shields,
                "credits": 0,
                "cargo": {key: 0 for key in _CARGO_KEYS},
                "cargo_holds": stats.cargo_holds,
                "warp_power": stats.warp_power_capacity,
                "warp_power_capacity": stats.warp_power_capacity,
                "modules": [],
            },
            "became_unowned": None,
            "former_owner_name": None,
        }

        self.save_ship(ship_id, ship_record)
        return ship_id

    def update_ship_state(
        self,
        ship_id: str,
        *,
        fighters: Optional[int] = None,
        shields: Optional[int] = None,
        warp_power: Optional[int] = None,
        cargo: Optional[Dict[str, int]] = None,
        modules: Optional[List[str]] = None,
        credits: Optional[int] = None,
    ) -> None:
        """Update mutable ship state fields with clamping."""
        ship_lock = self._get_ship_lock(ship_id)
        with ship_lock:
            with self._lock:
                self._ensure_loaded()
                ship = self._ships_cache.get(ship_id)
                if ship is None:
                    self._reload_from_disk()
                    ship = self._ships_cache.get(ship_id)
                if ship is None:
                    raise KeyError(f"Ship not found: {ship_id}")

                stats = get_ship_stats(ShipType(ship["ship_type"]))
                state = ship.setdefault("state", {})

                if fighters is not None:
                    state["fighters"] = _clamp_int(fighters, 0, stats.fighters)
                if shields is not None:
                    state["shields"] = _clamp_int(shields, 0, stats.shields)
                if warp_power is not None:
                    state["warp_power"] = _clamp_int(warp_power, 0, stats.warp_power_capacity)
                if cargo is not None:
                    current_cargo = state.setdefault("cargo", {key: 0 for key in _CARGO_KEYS})
                    for key in _CARGO_KEYS:
                        if key in cargo:
                            current_cargo[key] = max(0, int(cargo[key]))
                if modules is not None:
                    state["modules"] = list(modules)
                if credits is not None:
                    clamped = max(0, int(credits))
                    ship_type = ShipType(ship["ship_type"])
                    if ship_type == ShipType.ESCAPE_POD and clamped > 0:
                        raise ValueError("Escape pods cannot hold credits")
                    state["credits"] = clamped

                self._flush_locked()

    def validate_ship_credits(self, ship_id: str, credits: int) -> int:
        """Validate a prospective credit balance for a ship."""
        ship = self.get_ship(ship_id)
        if ship is None:
            raise KeyError(f"Ship not found: {ship_id}")
        ship_type = ShipType(ship["ship_type"])
        value = max(0, int(credits))
        if ship_type == ShipType.ESCAPE_POD and value > 0:
            raise ValueError("Escape pods cannot hold credits")
        return value

    def transfer_credits_between_ships(self, from_ship_id: str, to_ship_id: str, amount: int) -> None:
        """Transfer credits from one ship to another with validation."""
        if amount <= 0:
            raise ValueError("Transfer amount must be positive")

        from_ship = self.get_ship(from_ship_id)
        if from_ship is None:
            raise KeyError(f"Ship not found: {from_ship_id}")

        to_ship = self.get_ship(to_ship_id)
        if to_ship is None:
            raise KeyError(f"Ship not found: {to_ship_id}")

        from_state = from_ship.get("state", {})
        to_state = to_ship.get("state", {})

        from_credits = int(from_state.get("credits", 0))
        to_credits = int(to_state.get("credits", 0))

        if from_credits < amount:
            raise ValueError(f"Insufficient credits: have {from_credits}, need {amount}")

        if ShipType(to_ship["ship_type"]) == ShipType.ESCAPE_POD and amount > 0:
            raise ValueError("Cannot transfer credits to an escape pod")

        new_from = from_credits - amount
        new_to = to_credits + amount

        self.update_ship_state(from_ship_id, credits=new_from)
        self.update_ship_state(to_ship_id, credits=new_to)

    def move_ship(self, ship_id: str, to_sector: int) -> None:
        ship_lock = self._get_ship_lock(ship_id)
        with ship_lock:
            with self._lock:
                self._ensure_loaded()
                ship = self._ships_cache.get(ship_id)
                if ship is None:
                    self._reload_from_disk()
                    ship = self._ships_cache.get(ship_id)
                if ship is None:
                    raise KeyError(f"Ship not found: {ship_id}")
                ship["sector"] = to_sector
                self._flush_locked()

    def transfer_ownership(self, ship_id: str, new_owner_type: str, new_owner_id: Optional[str]) -> None:
        if new_owner_type not in _OWNER_TYPES:
            raise ValueError(f"Invalid owner_type: {new_owner_type}")
        if new_owner_type != "unowned" and not new_owner_id:
            raise ValueError("owner_id is required for character/corporation owned ships")

        ship_lock = self._get_ship_lock(ship_id)
        with ship_lock:
            with self._lock:
                self._ensure_loaded()
                ship = self._ships_cache.get(ship_id)
                if ship is None:
                    self._reload_from_disk()
                    ship = self._ships_cache.get(ship_id)
                if ship is None:
                    raise KeyError(f"Ship not found: {ship_id}")
                ship["owner_type"] = new_owner_type
                ship["owner_id"] = new_owner_id if new_owner_type != "unowned" else None
                if new_owner_type != "unowned":
                    ship["became_unowned"] = None
                    ship["former_owner_name"] = None
                self._flush_locked()

    def mark_as_unowned(self, ship_id: str, former_owner_name: str) -> None:
        ship_lock = self._get_ship_lock(ship_id)
        with ship_lock:
            with self._lock:
                self._ensure_loaded()
                ship = self._ships_cache.get(ship_id)
                if ship is None:
                    self._reload_from_disk()
                    ship = self._ships_cache.get(ship_id)
                if ship is None:
                    raise KeyError(f"Ship not found: {ship_id}")
                ship["owner_type"] = "unowned"
                ship["owner_id"] = None
                ship["became_unowned"] = datetime.now(timezone.utc).isoformat()
                ship["former_owner_name"] = former_owner_name
                self._flush_locked()

    def list_ships_by_owner(self, owner_type: str, owner_id: str) -> List[dict]:
        if owner_type not in _OWNER_TYPES:
            raise ValueError(f"Invalid owner_type: {owner_type}")
        with self._lock:
            self._ensure_loaded()
            result = [copy.deepcopy(ship) for ship in self._ships_cache.values() if ship.get("owner_type") == owner_type and ship.get("owner_id") == owner_id]
            return result

    def list_unowned_ships_in_sector(self, sector_id: int) -> List[dict]:
        with self._lock:
            self._ensure_loaded()
            result = [copy.deepcopy(ship) for ship in self._ships_cache.values() if ship.get("owner_type") == "unowned" and ship.get("sector") == sector_id]
            return result

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _ensure_loaded(self) -> None:
        try:
            current_mtime = self._ships_file.stat().st_mtime_ns
        except FileNotFoundError:
            current_mtime = 0
        if not self._ships_cache or current_mtime != self._ships_mtime:
            self.load_all_ships()

    def _get_ship_lock(self, ship_id: str) -> threading.RLock:
        with self._lock:
            lock = self._per_ship_locks.get(ship_id)
            if lock is None:
                lock = threading.RLock()
                self._per_ship_locks[ship_id] = lock
            return lock

    def _sync_per_ship_locks(self) -> None:
        existing_ids = set(self._ships_cache.keys())
        for ship_id in list(self._per_ship_locks.keys()):
            if ship_id not in existing_ids:
                self._per_ship_locks.pop(ship_id, None)
        for ship_id in existing_ids:
            self._per_ship_locks.setdefault(ship_id, threading.RLock())

    def _read_from_disk(self) -> Dict[str, dict]:
        try:
            with self._ships_file.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
        except json.JSONDecodeError:  # pragma: no cover - guarded corruption
            data = {}
        if not isinstance(data, dict):
            data = {}
        try:
            self._ships_mtime = self._ships_file.stat().st_mtime_ns
        except FileNotFoundError:
            self._ships_mtime = 0
        return data

    def _reload_from_disk(self) -> None:
        data = self._read_from_disk()
        self._ships_cache = {ship_id: value for ship_id, value in data.items()}
        self._sync_per_ship_locks()

    def _flush_locked(self) -> None:
        tmp_path = self._ships_file.with_suffix(".tmp")
        with tmp_path.open("w", encoding="utf-8") as handle:
            json.dump(self._ships_cache, handle, indent=2, sort_keys=True)
        tmp_path.replace(self._ships_file)
        try:
            self._ships_mtime = self._ships_file.stat().st_mtime_ns
        except FileNotFoundError:
            self._ships_mtime = 0


def _clamp_int(value: int, lower: int, upper: int) -> int:
    return max(lower, min(int(value), upper))


def _generate_uuid() -> str:
    import uuid

    return str(uuid.uuid4())
