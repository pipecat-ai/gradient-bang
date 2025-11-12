"""Utilities for comparing legacy vs Supabase payloads in tests."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

from utils.legacy_ids import canonicalize_character_id

os.environ.setdefault("SUPABASE_ALLOW_LEGACY_IDS", "1")


@dataclass
class ComparisonResult:
    diffs: List[str]

    def ok(self) -> bool:
        return not self.diffs


def _canonical(value: str) -> str:
    try:
        return canonicalize_character_id(value)
    except ValueError:
        return value


def compare_status_snapshot(legacy_event: Dict[str, Any], supabase_event: Dict[str, Any]) -> ComparisonResult:
    diffs: List[str] = []
    leg_payload = legacy_event.get("payload", {})
    sup_payload = supabase_event.get("payload", {})

    # Player identity
    legacy_player = leg_payload.get("player", {})
    sup_player = sup_payload.get("player", {})
    legacy_player_id = legacy_player.get("id")
    sup_player_id = sup_player.get("id")
    if legacy_player_id is None or sup_player_id is None:
        diffs.append("player.id missing")
    else:
        expected_canonical = _canonical(str(legacy_player_id))
        if sup_player_id != expected_canonical:
            diffs.append(
                f"player.id mismatch: expected canonical {expected_canonical}, got {sup_player_id}"
            )

    for field in ("name", "player_type", "credits_in_bank"):
        if legacy_player.get(field) != sup_player.get(field):
            diffs.append(f"player.{field} mismatch: {legacy_player.get(field)!r} != {sup_player.get(field)!r}")

    legacy_visited = legacy_player.get('sectors_visited')
    sup_visited = sup_player.get('sectors_visited')
    if isinstance(legacy_visited, int) and isinstance(sup_visited, int):
        if sup_visited < legacy_visited:
            diffs.append(
                f"player.sectors_visited decreased: {sup_visited} < expected {legacy_visited}"
            )
    elif legacy_visited != sup_visited:
        diffs.append(f"player.sectors_visited mismatch: {legacy_visited!r} != {sup_visited!r}")

    # Actor ship payload (ignore ship_id)
    legacy_ship = leg_payload.get("ship", {})
    sup_ship = sup_payload.get("ship", {})
    for field in (
        "ship_type",
        "ship_name",
        "credits",
        "fighters",
        "shields",
        "warp_power",
        "warp_power_capacity",
        "cargo",
    ):
        if legacy_ship.get(field) != sup_ship.get(field):
            diffs.append(f"ship.{field} mismatch: {legacy_ship.get(field)!r} != {sup_ship.get(field)!r}")

    diffs.extend(_compare_sector(leg_payload.get("sector"), sup_payload.get("sector")))

    return ComparisonResult(diffs)


def compare_movement_start(legacy_event: Dict[str, Any], supabase_event: Dict[str, Any]) -> ComparisonResult:
    diffs = _compare_sector(
        legacy_event.get("payload", {}).get("sector"),
        supabase_event.get("payload", {}).get("sector"),
    )
    return ComparisonResult(diffs)


def compare_movement_complete(legacy_event: Dict[str, Any], supabase_event: Dict[str, Any]) -> ComparisonResult:
    diffs = _compare_sector(
        legacy_event.get("payload", {}).get("sector"),
        supabase_event.get("payload", {}).get("sector"),
    )
    leg_ship = legacy_event.get("payload", {}).get("ship", {})
    sup_ship = supabase_event.get("payload", {}).get("ship", {})
    for field in ("ship_type", "ship_name", "credits", "fighters", "shields", "warp_power", "warp_power_capacity"):
        if leg_ship.get(field) != sup_ship.get(field):
            diffs.append(f"ship.{field} mismatch: {leg_ship.get(field)!r} != {sup_ship.get(field)!r}")
    return ComparisonResult(diffs)


def _build_player_map(players: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    mapping: Dict[str, Dict[str, Any]] = {}
    for entry in players:
        player_id = entry.get("id")
        if not player_id:
            continue
        canonical = _canonical(str(player_id))
        mapping[canonical] = entry
    return mapping


def _compare_sector(legacy_sector: Any, sup_sector: Any) -> List[str]:
    diffs: List[str] = []
    if legacy_sector is None or sup_sector is None:
        diffs.append("sector payload missing")
        return diffs
    for field in ("id", "adjacent_sectors"):
        if legacy_sector.get(field) != sup_sector.get(field):
            diffs.append(f"sector.{field} mismatch: {legacy_sector.get(field)!r} != {sup_sector.get(field)!r}")
    norm_legacy_port = _normalize_port(legacy_sector.get("port"))
    norm_sup_port = _normalize_port(sup_sector.get("port"))
    if norm_legacy_port != norm_sup_port:
        diffs.append(f"sector.port mismatch: {norm_legacy_port!r} != {norm_sup_port!r}")
    if bool(legacy_sector.get("garrison")) != bool(sup_sector.get("garrison")):
        diffs.append("sector.garrison mismatch (null vs non-null)")

    legacy_players = _build_player_map(legacy_sector.get("players", []))
    sup_players = _build_player_map(sup_sector.get("players", []))

    missing = set(legacy_players) - set(sup_players)
    if missing:
        diffs.append(f"sector.players missing: {sorted(missing)}")

    for player_id in sorted(set(legacy_players) & set(sup_players)):
        leg_player, sup_player_entry = legacy_players[player_id], sup_players[player_id]
        for field in ("name", "player_type"):
            if leg_player.get(field) != sup_player_entry.get(field):
                diffs.append(
                    f"sector.player[{player_id}].{field} mismatch: {leg_player.get(field)!r} != {sup_player_entry.get(field)!r}"
                )
        leg_ship = leg_player.get("ship", {})
        sup_ship_entry = sup_player_entry.get("ship", {})
        for field in ("ship_type", "ship_name"):
            if leg_ship.get(field) != sup_ship_entry.get(field):
                diffs.append(
                    f"sector.player[{player_id}].ship.{field} mismatch: {leg_ship.get(field)!r} != {sup_ship_entry.get(field)!r}"
                )

    return diffs


def _normalize_port(port: Any) -> Tuple[str, Tuple[int, int, int]] | None:
    if not port:
        return None
    try:
        code = port.get('code') if isinstance(port, dict) else None
    except AttributeError:
        return None
    stock = port.get('stock') or {}
    qf = int(stock.get('quantum_foam', 0) or 0)
    ro = int(stock.get('retro_organics', 0) or 0)
    ns = int(stock.get('neuro_symbolics', 0) or 0)
    return (code or '', (qf, ro, ns))


def compare_map_local(legacy_event: Dict[str, Any], supabase_event: Dict[str, Any]) -> ComparisonResult:
    diffs: List[str] = []
    leg = legacy_event.get("payload", {})
    sup = supabase_event.get("payload", {})

    if leg.get("center_sector") != sup.get("center_sector"):
        diffs.append(
            f"center_sector mismatch: {leg.get('center_sector')} != {sup.get('center_sector')}"
        )

    leg_sectors = {sector.get("id"): sector for sector in leg.get("sectors", [])}
    sup_sectors = {sector.get("id"): sector for sector in sup.get("sectors", [])}

    missing = sorted(id_ for id_ in leg_sectors if id_ not in sup_sectors)
    if missing:
        diffs.append(f"map sectors missing in Supabase: {missing}")

    for sector_id, leg_sector in leg_sectors.items():
        sup_sector = sup_sectors.get(sector_id)
        if not sup_sector:
            continue
        for field in ("visited", "hops_from_center", "port"):
            if leg_sector.get(field) != sup_sector.get(field):
                diffs.append(
                    f"sector {sector_id} field {field} mismatch: {leg_sector.get(field)!r} != {sup_sector.get(field)!r}"
                )
        leg_adj = sorted(leg_sector.get("adjacent_sectors") or [])
        sup_adj = sorted(sup_sector.get("adjacent_sectors") or [])
        if leg_adj != sup_adj:
            diffs.append(f"sector {sector_id} adjacent mismatch: {leg_adj} != {sup_adj}")

    return ComparisonResult(diffs)


COMPARERS = {
    "status.snapshot": compare_status_snapshot,
    "status.update": compare_status_snapshot,
    "map.local": compare_map_local,
    "map.region": compare_map_local,
    "movement.start": compare_movement_start,
    "movement.complete": compare_movement_complete,
}


def compare_trade_executed(legacy_event: Dict[str, Any], supabase_event: Dict[str, Any]) -> ComparisonResult:
    diffs: List[str] = []
    leg_payload = legacy_event.get("payload", {})
    sup_payload = supabase_event.get("payload", {})

    legacy_player = leg_payload.get("player", {})
    sup_player = sup_payload.get("player", {})
    legacy_player_id = legacy_player.get("id")
    sup_player_id = sup_player.get("id")
    if legacy_player_id and sup_player_id:
        expected_canonical = _canonical(str(legacy_player_id))
        if sup_player_id != expected_canonical:
            diffs.append(
                f"player.id mismatch: expected canonical {expected_canonical}, got {sup_player_id}"
            )
    for field in ("name", "player_type"):
        if legacy_player.get(field) != sup_player.get(field):
            diffs.append(f"player.{field} mismatch: {legacy_player.get(field)!r} != {sup_player.get(field)!r}")

    legacy_sectors = legacy_player.get("sectors_visited")
    sup_sectors = sup_player.get("sectors_visited")
    if isinstance(legacy_sectors, int) and isinstance(sup_sectors, int):
        if sup_sectors < legacy_sectors:
            diffs.append(
                f"player.sectors_visited decreased: {sup_sectors} < expected {legacy_sectors}"
            )
    elif legacy_sectors != sup_sectors:
        diffs.append(
            f"player.sectors_visited mismatch: {legacy_sectors!r} != {sup_sectors!r}"
        )

    legacy_ship = leg_payload.get("ship", {})
    sup_ship = sup_payload.get("ship", {})
    for field in (
        "ship_type",
        "ship_name",
        "credits",
        "fighters",
        "shields",
        "warp_power",
        "warp_power_capacity",
        "cargo",
    ):
        if legacy_ship.get(field) != sup_ship.get(field):
            diffs.append(f"ship.{field} mismatch: {legacy_ship.get(field)!r} != {sup_ship.get(field)!r}")

    legacy_trade = leg_payload.get("trade", {})
    sup_trade = sup_payload.get("trade", {})
    for field in (
        "trade_type",
        "commodity",
        "units",
        "price_per_unit",
        "total_price",
        "new_credits",
        "new_cargo",
        "new_prices",
    ):
        if legacy_trade.get(field) != sup_trade.get(field):
            diffs.append(
                f"trade.{field} mismatch: {legacy_trade.get(field)!r} != {sup_trade.get(field)!r}"
            )

    return ComparisonResult(diffs)


COMPARERS["trade.executed"] = compare_trade_executed


def compare_port_update(legacy_event: Dict[str, Any], supabase_event: Dict[str, Any]) -> ComparisonResult:
    diffs: List[str] = []
    leg = legacy_event.get("payload", {})
    sup = supabase_event.get("payload", {})

    leg_sector = leg.get("sector", {})
    sup_sector = sup.get("sector", {})
    if leg_sector.get("id") != sup_sector.get("id"):
        diffs.append(f"sector.id mismatch: {leg_sector.get('id')} != {sup_sector.get('id')}")

    leg_port = (leg_sector or {}).get("port", {})
    sup_port = (sup_sector or {}).get("port", {})
    for field in ("code",):
        if leg_port.get(field) != sup_port.get(field):
            diffs.append(f"port.{field} mismatch: {leg_port.get(field)!r} != {sup_port.get(field)!r}")

    if leg_port.get("prices") != sup_port.get("prices"):
        diffs.append(f"port.prices mismatch: {leg_port.get('prices')!r} != {sup_port.get('prices')!r}")
    if leg_port.get("stock") != sup_port.get("stock"):
        diffs.append(f"port.stock mismatch: {leg_port.get('stock')!r} != {sup_port.get('stock')!r}")

    return ComparisonResult(diffs)


COMPARERS["port.update"] = compare_port_update


def compare_warp_purchase(legacy_event: Dict[str, Any], supabase_event: Dict[str, Any]) -> ComparisonResult:
    diffs: List[str] = []
    leg = legacy_event.get("payload", {})
    sup = supabase_event.get("payload", {})

    leg_keys = set(leg.keys())
    sup_keys = set(sup.keys())
    if leg_keys != sup_keys:
        diffs.append(f"payload keys mismatch: {sorted(leg_keys)} != {sorted(sup_keys)}")

    for field in ("character_id", "units", "price_per_unit", "total_cost", "new_credits", "new_warp_power", "warp_power_capacity"):
        if leg.get(field) != sup.get(field):
            diffs.append(f"{field} mismatch: {leg.get(field)!r} != {sup.get(field)!r}")

    diffs.extend(_compare_sector(leg.get("sector"), sup.get("sector")))

    leg_source = leg.get("source") or {}
    sup_source = sup.get("source") or {}
    leg_source_keys = set(leg_source.keys())
    sup_source_keys = set(sup_source.keys())
    if leg_source_keys != sup_source_keys:
        diffs.append(f"source keys mismatch: {sorted(leg_source_keys)} != {sorted(sup_source_keys)}")

    for field in ("method", "type"):
        if leg_source.get(field) != sup_source.get(field):
            diffs.append(f"source.{field} mismatch: {leg_source.get(field)!r} != {sup_source.get(field)!r}")

    return ComparisonResult(diffs)


COMPARERS["warp.purchase"] = compare_warp_purchase
