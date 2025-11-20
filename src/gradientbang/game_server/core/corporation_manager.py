"""Filesystem-backed corporation persistence layer."""

from __future__ import annotations

import json
import secrets
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional


class CorporationManager:
    """Manage corporation records stored on disk with thread-safe access."""

    def __init__(self, world_data_dir: str | Path) -> None:
        base_dir = Path(world_data_dir)
        self._corps_dir = base_dir / "corporations"
        self._registry_path = base_dir / "corporation_registry.json"
        self._corps_dir.mkdir(parents=True, exist_ok=True)
        self._global_lock = threading.RLock()
        self._locks: Dict[str, threading.RLock] = {}
        if not self._registry_path.exists():
            self._save_registry({"by_name": {}})

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def create(self, name: str, founder_id: str) -> dict:
        """Create a new corporation and persist it."""
        normalized = name.strip()
        if not normalized:
            raise ValueError("Corporation name cannot be empty")

        with self._global_lock:
            if self.get_by_name(normalized):
                raise ValueError(f"Corporation name '{normalized}' already taken")

            corp_id = str(uuid.uuid4())
            invite_code = self.generate_invite_code()
            now = datetime.now(timezone.utc).isoformat()
            corp = {
                "corp_id": corp_id,
                "name": normalized,
                "founded": now,
                "founder_id": founder_id,
                "invite_code": invite_code,
                "invite_code_generated": now,
                "invite_code_generated_by": founder_id,
                "members": [founder_id],
                "ships": [],
            }
            self.save(corp_id, corp)
            registry = self._load_registry()
            registry["by_name"][normalized.lower()] = corp_id
            self._save_registry(registry)
            return corp

    def load(self, corp_id: str) -> dict:
        """Load a corporation record."""
        corp_path = self._corp_path(corp_id)
        if not corp_path.exists():
            raise FileNotFoundError(f"Corporation not found: {corp_id}")
        with corp_path.open("r", encoding="utf-8") as handle:
            return json.load(handle)

    def save(self, corp_id: str, corp_data: dict) -> None:
        """Persist a corporation record."""
        if corp_data.get("corp_id") != corp_id:
            raise ValueError("corp_data.corp_id does not match corp_id argument")

        lock = self._get_lock(corp_id)
        with lock:
            corp_path = self._corp_path(corp_id)
            tmp = corp_path.with_suffix(".tmp")
            with tmp.open("w", encoding="utf-8") as handle:
                json.dump(corp_data, handle, indent=2)
            tmp.replace(corp_path)

    def delete(self, corp_id: str) -> None:
        """Remove a corporation and update the registry."""
        with self._global_lock:
            lock = self._get_lock(corp_id)
            with lock:
                corp_path = self._corp_path(corp_id)
                if corp_path.exists():
                    corp_path.unlink()
            registry = self._load_registry()
            to_delete = [name for name, value in registry["by_name"].items() if value == corp_id]
            for key in to_delete:
                registry["by_name"].pop(key, None)
            self._locks.pop(corp_id, None)
            self._save_registry(registry)

    def get_by_name(self, name: str) -> Optional[str]:
        """Return corporation ID for a given name (case-insensitive)."""
        registry = self._load_registry()
        return registry["by_name"].get(name.strip().lower())

    def list_all(self) -> List[dict]:
        """Return summaries of all corporations."""
        results: List[dict] = []
        for corp_path in sorted(self._corps_dir.glob("*.json")):
            try:
                with corp_path.open("r", encoding="utf-8") as handle:
                    data = json.load(handle)
            except Exception:  # noqa: BLE001
                continue
            results.append(
                {
                    "corp_id": data.get("corp_id"),
                    "name": data.get("name"),
                    "founded": data.get("founded"),
                    "member_count": len(data.get("members", [])),
                }
            )
        return results

    def add_member(self, corp_id: str, character_id: str) -> None:
        """Add a member to the corporation."""
        lock = self._get_lock(corp_id)
        with lock:
            corp = self.load(corp_id)
            members: List[str] = list(corp.get("members", []))
            if character_id in members:
                return
            members.append(character_id)
            corp["members"] = members
            self.save(corp_id, corp)

    def remove_member(self, corp_id: str, character_id: str) -> bool:
        """Remove a member; return True if corporation becomes empty."""
        lock = self._get_lock(corp_id)
        with lock:
            corp = self.load(corp_id)
            members: List[str] = list(corp.get("members", []))
            if character_id in members:
                members.remove(character_id)
            corp["members"] = members
            self.save(corp_id, corp)
            return len(members) == 0

    def generate_invite_code(self) -> str:
        """Generate a random invite code."""
        return secrets.token_hex(4)

    def verify_invite_code(self, corp_id: str, invite_code: str) -> bool:
        """Verify invite code matches (case-insensitive)."""
        corp = self.load(corp_id)
        stored = corp.get("invite_code")
        if stored is None:
            return False
        return stored.lower() == invite_code.strip().lower()

    def regenerate_invite_code(self, corp_id: str, character_id: str) -> str:
        """Regenerate invite code and return the new code."""
        lock = self._get_lock(corp_id)
        with lock:
            corp = self.load(corp_id)
            new_code = self.generate_invite_code()
            now = datetime.now(timezone.utc).isoformat()
            corp["invite_code"] = new_code
            corp["invite_code_generated"] = now
            corp["invite_code_generated_by"] = character_id
            self.save(corp_id, corp)
            return new_code

    def get_members(self, corp_id: str) -> List[str]:
        """Return list of member character IDs."""
        corp = self.load(corp_id)
        return list(corp.get("members", []))

    def is_member(self, corp_id: str, character_id: str) -> bool:
        """Return True if character is a member of corp."""
        corp = self.load(corp_id)
        return character_id in corp.get("members", [])

    def add_ship(self, corp_id: str, ship_id: str) -> None:
        """Associate a ship with the corporation."""
        lock = self._get_lock(corp_id)
        with lock:
            corp = self.load(corp_id)
            ships: List[str] = list(corp.get("ships", []))
            if ship_id not in ships:
                ships.append(ship_id)
                corp["ships"] = ships
                self.save(corp_id, corp)

    def remove_ship(self, corp_id: str, ship_id: str) -> None:
        """Remove a ship association from the corporation."""
        lock = self._get_lock(corp_id)
        with lock:
            corp = self.load(corp_id)
            ships: List[str] = list(corp.get("ships", []))
            if ship_id in ships:
                ships.remove(ship_id)
                corp["ships"] = ships
                self.save(corp_id, corp)

    def get_ships(self, corp_id: str) -> List[str]:
        """Return ship IDs associated with the corporation."""
        corp = self.load(corp_id)
        return list(corp.get("ships", []))

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _corp_path(self, corp_id: str) -> Path:
        safe_id = "".join(c if c.isalnum() or c in "_-" else "_" for c in corp_id)
        return self._corps_dir / f"{safe_id}.json"

    def _get_lock(self, corp_id: str) -> threading.RLock:
        with self._global_lock:
            return self._locks.setdefault(corp_id, threading.RLock())

    def _load_registry(self) -> dict:
        with self._global_lock:
            if not self._registry_path.exists():
                return {"by_name": {}}
            with self._registry_path.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
            if "by_name" not in data or not isinstance(data["by_name"], dict):
                data["by_name"] = {}
            return data

    def _save_registry(self, registry: dict) -> None:
        with self._global_lock:
            tmp = self._registry_path.with_suffix(".tmp")
            with tmp.open("w", encoding="utf-8") as handle:
                json.dump(registry, handle, indent=2)
            tmp.replace(self._registry_path)
