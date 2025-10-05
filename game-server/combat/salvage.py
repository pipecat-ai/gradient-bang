"""Lightweight salvage container store."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional


@dataclass
class SalvageContainer:
    salvage_id: str
    sector: int
    victor_id: Optional[str]
    created_at: datetime
    expires_at: datetime
    cargo: Dict[str, int]
    scrap: int
    credits: int
    claimed: bool = False
    claimed_by: Optional[str] = None
    metadata: Dict[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "salvage_id": self.salvage_id,
            "sector": self.sector,
            "victor_id": self.victor_id,
            "created_at": self.created_at.isoformat(),
            "expires_at": self.expires_at.isoformat(),
            "cargo": self.cargo,
            "scrap": self.scrap,
            "credits": self.credits,
            "claimed": self.claimed,
            "claimed_by": self.claimed_by,
            "metadata": self.metadata,
        }


class SalvageManager:
    def __init__(self, *, default_ttl: int = 900) -> None:
        self._default_ttl = default_ttl
        self._by_sector: Dict[int, Dict[str, SalvageContainer]] = {}

    def create(
        self,
        *,
        sector: int,
        victor_id: Optional[str],
        cargo: Dict[str, int],
        scrap: int,
        credits: int,
        metadata: Optional[Dict[str, object]] = None,
        ttl: Optional[int] = None,
    ) -> SalvageContainer:
        now = datetime.now(timezone.utc)
        expires = now + timedelta(seconds=ttl or self._default_ttl)
        salvage = SalvageContainer(
            salvage_id=uuid.uuid4().hex,
            sector=sector,
            victor_id=victor_id,
            created_at=now,
            expires_at=expires,
            cargo=dict(cargo),
            scrap=scrap,
            credits=credits,
            metadata=metadata or {},
        )
        sector_map = self._by_sector.setdefault(sector, {})
        sector_map[salvage.salvage_id] = salvage
        return salvage

    def claim(self, salvage_id: str, claimer_id: str) -> Optional[SalvageContainer]:
        container = self._find_by_id(salvage_id)
        if not container:
            return None
        if container.claimed:
            return None
        container.claimed = True
        container.claimed_by = claimer_id
        return container

    def list_sector(self, sector: int) -> List[SalvageContainer]:
        self.prune_expired()
        return list(self._by_sector.get(sector, {}).values())

    def remove(self, salvage_id: str) -> None:
        for sector_id, sector_map in list(self._by_sector.items()):
            if salvage_id in sector_map:
                sector_map.pop(salvage_id)
                if not sector_map:
                    self._by_sector.pop(sector_id, None)
                break

    def prune_expired(self) -> None:
        now = datetime.now(timezone.utc)
        for sector_id, sector_map in list(self._by_sector.items()):
            for salvage_id, container in list(sector_map.items()):
                if container.expires_at <= now:
                    sector_map.pop(salvage_id)
            if not sector_map:
                self._by_sector.pop(sector_id, None)

    def _find_by_id(self, salvage_id: str) -> Optional[SalvageContainer]:
        self.prune_expired()
        for sector_map in self._by_sector.values():
            container = sector_map.get(salvage_id)
            if container:
                return container
        return None
