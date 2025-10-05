"""Persistence helpers for stationed fighters (garrisons)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Dict, List, Optional

from .models import GarrisonMode, GarrisonState


class GarrisonStore:
    """File-backed store for sector garrisons."""

    def __init__(self, data_path: Path) -> None:
        self._path = data_path
        self._lock = asyncio.Lock()
        self._by_sector: Dict[int, List[GarrisonState]] = {}
        self._load()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    async def list_sector(self, sector_id: int) -> List[GarrisonState]:
        async with self._lock:
            return [g for g in self._by_sector.get(sector_id, [])]

    async def get_sector_summary(self) -> Dict[int, List[GarrisonState]]:
        async with self._lock:
            return {sector: [g for g in garrisons] for sector, garrisons in self._by_sector.items()}

    async def deploy(
        self,
        sector_id: int,
        owner_id: str,
        fighters: int,
        mode: GarrisonMode,
        toll_amount: int = 0,
        toll_balance: Optional[int] = None,
    ) -> GarrisonState:
        # Validate toll_amount to prevent negative values
        toll_amount = max(0, int(toll_amount))
        async with self._lock:
            garrisons = self._by_sector.setdefault(sector_id, [])
            existing = _find_garrison(garrisons, owner_id)
            other_owner = next((g for g in garrisons if g.owner_id != owner_id), None)
            if other_owner:
                raise ValueError(
                    f"Sector {sector_id} already has a garrison owned by {other_owner.owner_id}"
                )
            if existing:
                existing.fighters = fighters
                existing.mode = mode
                existing.toll_amount = toll_amount
                if toll_balance is not None:
                    existing.toll_balance = toll_balance
                garrison = existing
            else:
                garrison = GarrisonState(
                    owner_id=owner_id,
                    fighters=fighters,
                    mode=mode,
                    toll_amount=toll_amount,
                    toll_balance=toll_balance or 0,
                )
                garrisons.append(garrison)
            self._save()
            return garrison

    async def adjust_fighters(self, sector_id: int, owner_id: str, delta: int) -> Optional[GarrisonState]:
        async with self._lock:
            garrisons = self._by_sector.get(sector_id)
            if not garrisons:
                return None
            garrison = _find_garrison(garrisons, owner_id)
            if not garrison:
                return None
            garrison.fighters = max(0, garrison.fighters + delta)
            if garrison.fighters == 0:
                garrisons.remove(garrison)
            self._save()
            return garrison if garrison.fighters > 0 else None

    async def set_mode(self, sector_id: int, owner_id: str, mode: GarrisonMode, toll_amount: int) -> Optional[GarrisonState]:
        # Validate toll_amount to prevent negative values
        toll_amount = max(0, int(toll_amount))
        async with self._lock:
            garrisons = self._by_sector.get(sector_id)
            if not garrisons:
                return None
            garrison = _find_garrison(garrisons, owner_id)
            if not garrison:
                return None
            garrison.mode = mode
            garrison.toll_amount = toll_amount
            if mode != "toll":
                garrison.toll_balance = 0
            self._save()
            return garrison

    async def remove(self, sector_id: int, owner_id: str) -> bool:
        async with self._lock:
            garrisons = self._by_sector.get(sector_id)
            if not garrisons:
                return False
            garrison = _find_garrison(garrisons, owner_id)
            if not garrison:
                return False
            garrisons.remove(garrison)
            if not garrisons:
                self._by_sector.pop(sector_id, None)
            self._save()
            return True

    async def pop(self, sector_id: int, owner_id: str) -> Optional[GarrisonState]:
        async with self._lock:
            garrisons = self._by_sector.get(sector_id)
            if not garrisons:
                return None
            garrison = _find_garrison(garrisons, owner_id)
            if not garrison:
                return None
            garrisons.remove(garrison)
            if not garrisons:
                self._by_sector.pop(sector_id, None)
            self._save()
            return garrison

    async def to_payload(self, sector_id: int) -> List[dict]:
        garrisons = await self.list_sector(sector_id)
        return [garrison.to_dict() for garrison in garrisons]

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _load(self) -> None:
        if not self._path.exists():
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._write_file({"meta": {"version": 1}, "sectors": []})
        with self._path.open("r", encoding="utf-8") as handle:
            raw = json.load(handle)
        sectors = raw.get("sectors", [])
        self._by_sector.clear()
        for entry in sectors:
            sector_id = int(entry.get("sector"))
            garrisons = [GarrisonState.from_dict(item) for item in entry.get("garrisons", [])]
            if garrisons:
                self._by_sector[sector_id] = garrisons

    def _save(self) -> None:
        data = {
            "meta": {"version": 1},
            "sectors": [
                {"sector": sector_id, "garrisons": [g.to_dict() for g in garrisons]}
                for sector_id, garrisons in sorted(self._by_sector.items())
            ],
        }
        self._write_file(data)

    def _write_file(self, payload: dict) -> None:
        tmp_path = self._path.with_suffix(".tmp")
        with tmp_path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        tmp_path.replace(self._path)


def _find_garrison(garrisons: List[GarrisonState], owner_id: str) -> Optional[GarrisonState]:
    for garrison in garrisons:
        if garrison.owner_id == owner_id:
            return garrison
    return None
