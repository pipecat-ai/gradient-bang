"""Character registry management for Gradient Bang."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
import hashlib
import json
import secrets
from datetime import datetime, timezone


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class CharacterProfile:
    character_id: str
    name: str
    player: dict[str, Any] = field(default_factory=dict)
    ship: dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=_utcnow)
    updated_at: str = field(default_factory=_utcnow)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "player": self.player,
            "ship": self.ship,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, character_id: str, data: dict[str, Any]) -> "CharacterProfile":
        return cls(
            character_id=character_id,
            name=data.get("name", character_id),
            player=data.get("player", {}) or {},
            ship=data.get("ship", {}) or {},
            created_at=data.get("created_at") or _utcnow(),
            updated_at=data.get("updated_at") or _utcnow(),
        )


class CharacterRegistry:
    """Persisted index of characters plus admin password metadata."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._data: dict[str, Any] = {}
        self._name_index: dict[str, str] = {}

    @property
    def admin_password_plain(self) -> str:
        return self._data.get("admin_password_plain") or ""

    @property
    def password_hash(self) -> str:
        return self._data.get("password_hash") or ""

    def load(self) -> None:
        """Load registry data from disk, creating a default file if needed."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            with self.path.open("r", encoding="utf-8") as handle:
                self._data = json.load(handle)
        else:
            self._data = {
                "admin_password_plain": "",
                "password_hash": "",
                "characters": {},
            }
            self._flush()

        if "characters" not in self._data or not isinstance(
            self._data["characters"], dict
        ):
            self._data["characters"] = {}

        self._rebuild_name_index()

    def _flush(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as handle:
            json.dump(self._data, handle, indent=2)
        tmp.replace(self.path)

    def _rebuild_name_index(self) -> None:
        self._name_index.clear()
        for character_id, entry in self._data.get("characters", {}).items():
            name = (entry.get("name") or "").strip()
            if name:
                self._name_index[name.lower()] = character_id

    def set_admin_password(self, password: str) -> None:
        """Persist a new admin password."""
        self._data["admin_password_plain"] = password
        self._data["password_hash"] = hashlib.sha256(password.encode()).hexdigest()
        self._flush()

    def validate_admin_password(self, candidate: str | None) -> bool:
        """Return True if the candidate matches the stored password."""
        if not self.admin_password_plain and not self.password_hash:
            # No password configured; allow open access (used during development)
            return True
        if not candidate:
            return False
        plain = self.admin_password_plain
        if plain:
            return secrets.compare_digest(plain, candidate)
        password_hash = self.password_hash
        if password_hash:
            candidate_hash = hashlib.sha256(candidate.encode()).hexdigest()
            return secrets.compare_digest(password_hash, candidate_hash)
        return False

    def get_profile(self, character_id: str) -> CharacterProfile | None:
        entry = self._data["characters"].get(character_id)
        if not entry:
            return None
        return CharacterProfile.from_dict(character_id, entry)

    def iter_profiles(self) -> list[CharacterProfile]:
        return [
            CharacterProfile.from_dict(cid, entry)
            for cid, entry in self._data["characters"].items()
        ]

    def name_exists(self, name: str) -> bool:
        return name.lower() in self._name_index

    def add_or_update(self, profile: CharacterProfile) -> None:
        self._data["characters"][profile.character_id] = profile.to_dict()
        self._data["characters"][profile.character_id]["updated_at"] = _utcnow()
        self._rebuild_name_index()
        self._flush()

    def delete(self, character_id: str) -> None:
        if character_id in self._data["characters"]:
            self._data["characters"].pop(character_id)
            self._rebuild_name_index()
            self._flush()

    def find_by_name(self, name: str) -> CharacterProfile | None:
        key = name.lower()
        character_id = self._name_index.get(key)
        if not character_id:
            return None
        return self.get_profile(character_id)
