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
    created_at: datetime
    expires_at: datetime
    cargo: Dict[str, int]
    scrap: int
    credits: int
    claimed: bool = False
    metadata: Dict[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict:
        """Convert to dict.

        Note: victor_id and claimed_by removed for privacy.
        Use metadata for ship_name and ship_type instead.
        """
        metadata_copy = dict(self.metadata or {})
        ship_name = metadata_copy.pop("ship_name", None)
        ship_type = metadata_copy.pop("ship_type", None)
        source = {
            "ship_name": ship_name or "Unknown Ship",
            "ship_type": ship_type or "unknown",
        }
        return {
            "salvage_id": self.salvage_id,
            "created_at": self.created_at.isoformat(),
            "expires_at": self.expires_at.isoformat(),
            "cargo": self.cargo,
            "scrap": self.scrap,
            "credits": self.credits,
            "claimed": self.claimed,
            "source": source,
            "metadata": metadata_copy,
        }


class SalvageManager:
    def __init__(self, *, default_ttl: int = 900) -> None:
        self._default_ttl = default_ttl
        self._by_sector: Dict[int, Dict[str, SalvageContainer]] = {}

    def create(
        self,
        *,
        sector: int,
        cargo: Dict[str, int],
        scrap: int,
        credits: int,
        metadata: Optional[Dict[str, object]] = None,
        ttl: Optional[int] = None,
    ) -> SalvageContainer:
        """Create a new salvage container.

        Args:
            sector: Sector ID where salvage is located
            cargo: Dict of commodity -> quantity
            scrap: Amount of scrap metal
            credits: Credits in the container
            metadata: Optional metadata (should include ship_name and ship_type)
            ttl: Time to live in seconds (default from manager)

        Returns:
            Created salvage container
        """
        now = datetime.now(timezone.utc)
        expires = now + timedelta(seconds=ttl or self._default_ttl)
        salvage = SalvageContainer(
            salvage_id=uuid.uuid4().hex,
            sector=sector,
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
        """Claim a salvage container.

        Args:
            salvage_id: ID of salvage to claim
            claimer_id: Character ID claiming the salvage (not exposed in events)

        Returns:
            Container if successfully claimed, None otherwise
        """
        container = self._find_by_id(salvage_id)
        if not container:
            return None
        if container.claimed:
            return None
        container.claimed = True
        # Note: claimed_by removed for privacy, only tracking claimed boolean
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
