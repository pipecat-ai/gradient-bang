"""Snapshot generation helpers for the wealth leaderboard."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any, Dict, Mapping, MutableMapping, Optional

from ships import FIGHTER_PRICE, calculate_trade_in_value


LEADERBOARD_FILENAME = "leaderboard_resources.json"
SCHEMA_VERSION = 1


@dataclass(slots=True)
class _PlayerTotals:
    bank_credits: int = 0
    ship_credits: int = 0
    ship_trade_in_value: int = 0
    garrison_fighter_value: int = 0
    sectors_visited: int = 0
    exploration_percent: float = 0.0

    @property
    def total_resources(self) -> int:
        return (
            self.bank_credits
            + self.ship_credits
            + self.ship_trade_in_value
            + self.garrison_fighter_value
        )


class LeaderboardSnapshotError(RuntimeError):
    """Raised when the leaderboard snapshot cannot be produced or loaded."""


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


async def compute_leaderboard_snapshot(world) -> Dict[str, Any]:  # pragma: no cover - exercised via CLI
    """Compute the leaderboard snapshot from the current world state."""

    if world.character_registry is None:
        raise LeaderboardSnapshotError("Character registry is not initialized")
    if world.knowledge_manager is None:
        raise LeaderboardSnapshotError("Knowledge manager is not initialized")
    if world.ships_manager is None:
        raise LeaderboardSnapshotError("Ships manager is not initialized")

    sector_count = 0
    if world.universe_graph is not None:
        sector_count = int(world.universe_graph.sector_count or 0)
    sector_count = max(sector_count, 1)

    fighters_by_owner: MutableMapping[str, int] = defaultdict(int)
    if world.garrisons is not None:
        sector_summary = await world.garrisons.get_sector_summary()
        for garrisons in sector_summary.values():
            for garrison in garrisons:
                owner_id = getattr(garrison, "owner_id", None)
                fighters = getattr(garrison, "fighters", 0)
                if isinstance(owner_id, str) and owner_id:
                    fighters_by_owner[owner_id] += max(0, int(fighters))

    players: list[Dict[str, Any]] = []
    player_totals: Dict[str, _PlayerTotals] = {}
    character_to_name: Dict[str, str] = {}

    for profile in world.character_registry.iter_profiles():
        character_id = profile.character_id
        display_name = profile.name or character_id
        character_to_name[character_id] = display_name

        knowledge = world.knowledge_manager.load_knowledge(character_id)
        bank_credits = max(0, _safe_int(getattr(knowledge, "credits_in_bank", 0)))
        sectors_visited = _safe_int(getattr(knowledge, "total_sectors_visited", 0))
        exploration_percent = round((sectors_visited / sector_count) * 100, 2)

        ship_records = world.ships_manager.list_ships_by_owner("character", character_id)
        ship_credits = 0
        ship_trade_in_value = 0
        ship_count = 0
        for ship in ship_records:
            ship_count += 1
            state = ship.get("state", {}) or {}
            ship_credits += _safe_int(state.get("credits"))
            ship_type = ship.get("ship_type")
            if ship_type:
                try:
                    ship_trade_in_value += calculate_trade_in_value(ship)
                except (ValueError, TypeError):
                    pass

        garrison_fighters = fighters_by_owner.get(character_id, 0)
        garrison_fighter_value = garrison_fighters * FIGHTER_PRICE

        totals = _PlayerTotals(
            bank_credits=bank_credits,
            ship_credits=ship_credits,
            ship_trade_in_value=ship_trade_in_value,
            garrison_fighter_value=garrison_fighter_value,
            sectors_visited=sectors_visited,
            exploration_percent=exploration_percent,
        )
        player_totals[character_id] = totals

        players.append(
            {
                "character_id": character_id,
                "name": display_name,
                "bank_credits": bank_credits,
                "ship_credits": ship_credits,
                "ship_trade_in_value": ship_trade_in_value,
                "ship_count": ship_count,
                "garrison_fighter_value": garrison_fighter_value,
                "sectors_visited": sectors_visited,
                "exploration_percent": exploration_percent,
                "total_resources": totals.total_resources,
            }
        )

    players.sort(key=lambda entry: entry["total_resources"], reverse=True)
    for idx, entry in enumerate(players, start=1):
        entry["rank"] = idx

    corporations: list[Dict[str, Any]] = []
    corp_manager = world.corporation_manager
    if corp_manager is not None:
        try:
            corp_summaries = corp_manager.list_all()
        except Exception:  # noqa: BLE001 - defensive guard
            corp_summaries = []

        for summary in corp_summaries:
            corp_id = summary.get("corp_id")
            if not corp_id:
                continue
            try:
                corp = corp_manager.load(corp_id)
            except FileNotFoundError:
                continue

            corp_name = corp.get("name") or summary.get("name") or corp_id
            member_ids = [mid for mid in corp.get("members", []) if isinstance(mid, str)]

            member_total = sum(
                player_totals.get(mid, _PlayerTotals()).total_resources for mid in member_ids
            )

            corp_ship_credits = 0
            corp_ship_trade_in = 0
            corp_ship_count = 0
            for ship_id in corp.get("ships", []) or []:
                ship = world.ships_manager.get_ship(ship_id)
                if not ship:
                    continue
                corp_ship_count += 1
                state = ship.get("state", {}) or {}
                corp_ship_credits += _safe_int(state.get("credits"))
                ship_type = ship.get("ship_type")
                if ship_type:
                    try:
                        corp_ship_trade_in += calculate_trade_in_value(ship)
                    except (ValueError, TypeError):
                        continue

            total_resources = member_total + corp_ship_credits + corp_ship_trade_in
            corporations.append(
                {
                    "corp_id": corp_id,
                    "name": corp_name,
                    "member_count": len(member_ids),
                    "members": [
                        {
                            "character_id": member_id,
                            "name": character_to_name.get(member_id, member_id),
                            "total_resources": player_totals.get(
                                member_id, _PlayerTotals()
                            ).total_resources,
                        }
                        for member_id in member_ids
                    ],
                    "corp_ship_count": corp_ship_count,
                    "corp_ship_credits": corp_ship_credits,
                    "corp_ship_trade_in_value": corp_ship_trade_in,
                    "member_total_resources": member_total,
                    "total_resources": total_resources,
                }
            )

    corporations.sort(key=lambda entry: entry["total_resources"], reverse=True)
    for idx, entry in enumerate(corporations, start=1):
        entry["rank"] = idx

    return {
        "schema_version": SCHEMA_VERSION,
        "as_of": datetime.now(timezone.utc).isoformat(),
        "sector_count": sector_count,
        "players": players,
        "corporations": corporations,
    }


_CACHE: Dict[str, Any] = {"mtime": None, "data": None}


def leaderboard_snapshot_path(world_data_dir: Path) -> Path:
    return world_data_dir / LEADERBOARD_FILENAME


def load_leaderboard_snapshot(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise LeaderboardSnapshotError(f"Leaderboard snapshot not found: {path}")
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise LeaderboardSnapshotError("Leaderboard snapshot is malformed")
    return data


def write_leaderboard_snapshot(path: Path, snapshot: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(snapshot, handle, indent=2)
    tmp.replace(path)


def get_cached_leaderboard(path: Path) -> Dict[str, Any]:
    try:
        mtime = path.stat().st_mtime_ns
    except FileNotFoundError as exc:  # pragma: no cover - filesystem state
        raise LeaderboardSnapshotError(f"Leaderboard snapshot missing: {path}") from exc

    cache_mtime = _CACHE.get("mtime")
    if cache_mtime == mtime and _CACHE.get("data") is not None:
        return _CACHE["data"]

    snapshot = load_leaderboard_snapshot(path)
    _CACHE["mtime"] = mtime
    _CACHE["data"] = snapshot
    return snapshot


def clear_leaderboard_cache() -> None:
    """Reset the in-process leaderboard cache."""

    _CACHE["mtime"] = None
    _CACHE["data"] = None
