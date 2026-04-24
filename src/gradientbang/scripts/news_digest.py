#!/usr/bin/env python3
"""Generate an admin news digest from read-only game event data."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row


GAMEPLAY_EVENT_PREFIXES = (
    "bank.",
    "combat.",
    "corporation.",
    "garrison.",
    "movement.",
    "salvage.",
    "ship.",
    "trade.",
)
GAMEPLAY_EVENT_TYPES = {
    "chat.message",
    "error",
    "session.started",
    "task.start",
    "task.finish",
    "task.cancel",
}
NOISY_EVENT_TYPES = {
    "character.moved",
    "corporation.data",
    "event.query",
    "map.local",
    "map.region",
    "map.update",
    "port.update",
    "ports.list",
    "sector.update",
    "ship.definitions",
    "ships.list",
    "status.snapshot",
    "status.update",
}
ACTIVE_EVENT_PREFIXES = (
    "bank.",
    "combat.",
    "garrison.",
    "movement.",
    "salvage.",
    "ship.",
    "trade.",
    "warp.",
)
ACTIVE_EVENT_TYPES = {
    "chat.message",
    "course.plot",
    "credits.transfer",
    "error",
    "quest.status",
    "session.started",
    "task.cancel",
    "task.finish",
    "task.start",
}
COMMODITY_NAMES = {
    "quantum_foam": "quantum foam",
    "retro_organics": "retro organics",
    "neuro_symbolics": "neuro-symbolics",
    "QF": "quantum foam",
    "RO": "retro organics",
    "NS": "neuro-symbolics",
}
LEADERBOARD_QUERIES = {
    "wealth": """
        SELECT character_id, name, rank, total_wealth AS score
        FROM (
          SELECT character_id, name, total_wealth,
                 row_number() OVER (ORDER BY total_wealth DESC) AS rank
          FROM leaderboard_wealth
        ) ranked
    """,
    "trading": """
        SELECT character_id, name, rank, total_trade_volume AS score
        FROM (
          SELECT character_id, name, total_trade_volume,
                 row_number() OVER (ORDER BY total_trade_volume DESC) AS rank
          FROM leaderboard_trading
        ) ranked
    """,
    "territory": """
        SELECT character_id, name, rank, sectors_controlled AS score
        FROM (
          SELECT character_id, name, sectors_controlled,
                 row_number() OVER (
                   ORDER BY sectors_controlled DESC, total_fighters_deployed DESC NULLS LAST
                 ) AS rank
          FROM leaderboard_territory
        ) ranked
    """,
    "exploration": """
        SELECT character_id, name, rank, sectors_visited AS score
        FROM (
          SELECT character_id, name, sectors_visited,
                 row_number() OVER (ORDER BY sectors_visited DESC) AS rank
          FROM leaderboard_exploration
        ) ranked
    """,
}


Json = dict[str, Any]


@dataclass(slots=True)
class Event:
    """A deduplicated game event."""

    id: int
    timestamp: datetime
    event_type: str
    direction: str
    payload: Json
    scope: str | None = None
    character_id: str | None = None
    character_name: str | None = None
    actor_character_id: str | None = None
    actor_name: str | None = None
    sender_id: str | None = None
    sender_name: str | None = None
    recipient_character_ids: list[str] = field(default_factory=list)
    recipient_names: list[str] = field(default_factory=list)
    recipient_reasons: list[str] = field(default_factory=list)
    corp_id: str | None = None
    corp_name: str | None = None
    sector_id: int | None = None
    ship_id: str | None = None
    ship_name: str | None = None
    ship_type: str | None = None
    request_id: str | None = None
    task_id: str | None = None
    is_broadcast: bool = False


@dataclass(slots=True)
class PlayerDigest:
    """Activity accumulated for one player or character-like actor."""

    key: str
    player_id: str | None
    name: str
    event_count: int = 0
    categorized_count: int = 0
    ships: set[str] = field(default_factory=set)
    sectors: set[int] = field(default_factory=set)
    sector_visits: int = 0
    trades: list[str] = field(default_factory=list)
    trade_sales: int = 0
    trade_buys: int = 0
    trade_volume: int = 0
    ship_events: list[str] = field(default_factory=list)
    garrison_events: list[str] = field(default_factory=list)
    combat_events: list[str] = field(default_factory=list)
    combat_wins: int = 0
    combat_losses: int = 0
    combat_neutral: int = 0
    destroyed_ships: int = 0
    movement_events: list[str] = field(default_factory=list)
    messages: list[str] = field(default_factory=list)
    sessions: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    other_counts: Counter[str] = field(default_factory=Counter)

    @property
    def activity_score(self) -> int:
        return (
            self.categorized_count * 3
            + len(self.messages) * 2
            + len(self.trades) * 4
            + len(self.ship_events) * 4
            + len(self.garrison_events) * 3
            + len(self.combat_events) * 3
            + self.sector_visits * 2
            + self.event_count
        )


@dataclass(slots=True)
class GlobalStats:
    raw_event_rows: int
    deduped_events: int
    event_counts: Counter[str] = field(default_factory=Counter)
    active_player_keys: set[str] = field(default_factory=set)
    active_ship_ids: set[str] = field(default_factory=set)
    sectors_visited: list[int] = field(default_factory=list)
    unique_sectors: set[int] = field(default_factory=set)
    trade_sales: int = 0
    trade_buys: int = 0
    trade_volume: int = 0
    messages_broadcast: int = 0
    messages_direct: int = 0
    combat_ids_ended: set[str] = field(default_factory=set)
    combat_actions: int = 0
    ship_destroyed: int = 0
    garrisons_deployed: int = 0
    ships_purchased: int = 0
    ships_sold: int = 0


@dataclass(slots=True)
class Digest:
    start: datetime
    end: datetime
    generated_at: datetime
    global_stats: GlobalStats
    players: dict[str, PlayerDigest]
    leaderboard_ranks: dict[str, dict[str, dict[str, Any]]]
    period_ranks: dict[str, dict[str, int]]
    warnings: list[str] = field(default_factory=list)


def main() -> None:
    raise SystemExit(run(sys.argv[1:]))


def run(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        start, end = resolve_window(args)
        env_path = Path(args.env_file) if args.env_file else None
        if env_path and env_path.exists():
            load_dotenv(env_path, override=False)
        dsn = resolve_database_url(args.database_url)
        rows, leaderboard_ranks = fetch_digest_inputs(
            dsn=dsn,
            start=start,
            end=end,
            statement_timeout=args.statement_timeout,
            include_leaderboard=not args.no_current_leaderboard,
        )
        digest = build_digest(rows, start=start, end=end, leaderboard_ranks=leaderboard_ranks)
        if args.format == "json":
            output = json.dumps(digest_to_dict(digest), indent=2, sort_keys=True) + "\n"
        else:
            output = render_markdown(digest, max_lines_per_section=args.max_lines_per_section)
        if args.output:
            output_path = Path(args.output)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(output)
        else:
            print(output, end="")
        return 0
    except KeyboardInterrupt:
        print("Interrupted", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"news-digest: {exc}", file=sys.stderr)
        return 1


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate an admin event digest for a game event time window. "
            "All database work runs inside BEGIN READ ONLY."
        )
    )
    window = parser.add_argument_group("time window")
    window.add_argument("--start", help="Window start timestamp. Naive values are treated as UTC.")
    window.add_argument("--end", help="Window end timestamp. Defaults to now when --hours is used.")
    window.add_argument(
        "--hours",
        type=float,
        help="Relative window length ending at --end or now, for example 1 or 24.",
    )
    window.add_argument(
        "--duration",
        help="Relative window length ending at --end or now, for example 90m, 1h, 24h, 7d.",
    )

    db = parser.add_argument_group("database")
    db.add_argument(
        "--env-file",
        default=".env.cloud",
        help="Env file to load for POSTGRES_POOLER_URL. Defaults to .env.cloud.",
    )
    db.add_argument(
        "--database-url",
        help="Database URL override. Defaults to POSTGRES_POOLER_URL, POSTGRES_URL, or DATABASE_URL.",
    )
    db.add_argument(
        "--statement-timeout",
        default="60s",
        help="Postgres statement_timeout for the read-only transaction. Defaults to 60s.",
    )
    db.add_argument(
        "--no-current-leaderboard",
        action="store_true",
        help="Skip querying current leaderboard views.",
    )

    output = parser.add_argument_group("output")
    output.add_argument(
        "--format",
        choices=("markdown", "json"),
        default="markdown",
        help="Output format. Use json for downstream analysis or LLM front-page workflows.",
    )
    output.add_argument("--output", help="Write output to this file instead of stdout.")
    output.add_argument(
        "--max-lines-per-section",
        type=int,
        default=12,
        help="Maximum bullet lines per player subsection before summarizing. Defaults to 12.",
    )
    return parser.parse_args(argv)


def resolve_window(args: argparse.Namespace) -> tuple[datetime, datetime]:
    end = parse_timestamp(args.end) if args.end else datetime.now(timezone.utc)
    duration = parse_duration(args.duration) if args.duration else None
    if args.hours is not None:
        if args.hours <= 0:
            raise ValueError("--hours must be positive")
        duration = timedelta(hours=args.hours)

    if args.start:
        start = parse_timestamp(args.start)
        if duration is not None and not args.end:
            end = start + duration
    elif duration is not None:
        start = end - duration
    else:
        raise ValueError("provide --start/--end or a relative --hours/--duration window")

    if start >= end:
        raise ValueError("window start must be before window end")
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


def parse_timestamp(value: str) -> datetime:
    raw = value.strip()
    if not raw:
        raise ValueError("empty timestamp")
    if raw.endswith("Z"):
        raw = f"{raw[:-1]}+00:00"
    parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def parse_duration(value: str) -> timedelta:
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*([mhd])\s*", value, re.IGNORECASE)
    if not match:
        raise ValueError("--duration must look like 90m, 1h, 24h, or 7d")
    amount = float(match.group(1))
    if amount <= 0:
        raise ValueError("--duration must be positive")
    unit = match.group(2).lower()
    if unit == "m":
        return timedelta(minutes=amount)
    if unit == "h":
        return timedelta(hours=amount)
    return timedelta(days=amount)


def resolve_database_url(arg_value: str | None) -> str:
    dsn = arg_value or os.getenv("POSTGRES_POOLER_URL") or os.getenv("POSTGRES_URL")
    dsn = dsn or os.getenv("DATABASE_URL")
    if not dsn:
        raise ValueError(
            "database URL required: load .env.cloud or set POSTGRES_POOLER_URL"
        )
    return dsn


def fetch_digest_inputs(
    *,
    dsn: str,
    start: datetime,
    end: datetime,
    statement_timeout: str,
    include_leaderboard: bool,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, dict[str, Any]]]]:
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        conn.execute("BEGIN READ ONLY")
        try:
            conn.execute("SELECT set_config('statement_timeout', %s, true)", (statement_timeout,))
            rows = list(conn.execute(EVENT_QUERY, {"start": start, "end": end}))
            leaderboard = (
                fetch_current_leaderboard_ranks(conn) if include_leaderboard else {}
            )
            conn.execute("COMMIT")
            return rows, leaderboard
        except Exception:
            conn.execute("ROLLBACK")
            raise


EVENT_QUERY = """
SELECT
  e.id,
  e.timestamp,
  e.inserted_at,
  e.direction,
  e.event_type,
  e.scope,
  e.character_id,
  character_row.name AS character_name,
  e.actor_character_id,
  actor_row.name AS actor_name,
  e.sender_id,
  sender_row.name AS sender_name,
  e.recipient_character_id,
  recipient_row.name AS recipient_name,
  e.recipient_reason,
  e.corp_id,
  corp_row.name AS corp_name,
  e.sector_id,
  e.ship_id,
  ship_row.ship_name,
  ship_row.ship_type,
  e.request_id,
  e.task_id,
  e.is_broadcast,
  e.payload,
  e.meta
FROM events e
LEFT JOIN characters character_row ON character_row.character_id = e.character_id
LEFT JOIN characters actor_row ON actor_row.character_id = e.actor_character_id
LEFT JOIN characters sender_row ON sender_row.character_id = e.sender_id
LEFT JOIN characters recipient_row ON recipient_row.character_id = e.recipient_character_id
LEFT JOIN corporations corp_row ON corp_row.corp_id = e.corp_id
LEFT JOIN ship_instances ship_row ON ship_row.ship_id = e.ship_id
WHERE e.timestamp >= %(start)s
  AND e.timestamp < %(end)s
ORDER BY e.timestamp ASC, e.id ASC
"""


def fetch_current_leaderboard_ranks(
    conn: psycopg.Connection[Any],
) -> dict[str, dict[str, dict[str, Any]]]:
    ranks: dict[str, dict[str, dict[str, Any]]] = {}
    for category, query in LEADERBOARD_QUERIES.items():
        savepoint = f"leaderboard_{category}"
        conn.execute(f"SAVEPOINT {savepoint}")
        try:
            ranks[category] = {
                str(row["character_id"]): {
                    "rank": int(row["rank"]),
                    "score": row["score"],
                    "name": row["name"],
                }
                for row in conn.execute(query)
                if row.get("character_id") is not None
            }
            conn.execute(f"RELEASE SAVEPOINT {savepoint}")
        except psycopg.Error:
            conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            ranks[category] = {}
    return ranks


def build_digest(
    rows: list[dict[str, Any]],
    *,
    start: datetime,
    end: datetime,
    leaderboard_ranks: dict[str, dict[str, dict[str, Any]]],
) -> Digest:
    events = dedupe_events(rows)
    players: dict[str, PlayerDigest] = {}
    stats = GlobalStats(raw_event_rows=len(rows), deduped_events=len(events))
    warnings: list[str] = []
    if rows and len(events) < len(rows):
        warnings.append(
            f"Deduplicated {len(rows) - len(events):,} recipient fan-out rows."
        )
    if leaderboard_ranks:
        warnings.append(
            "Current official leaderboard ranks are query-time ranks, not historical rank deltas."
        )
    else:
        warnings.append("Current official leaderboard ranks were not available or were skipped.")

    for event in events:
        stats.event_counts[event.event_type] += 1
        if is_active_player_event(event.event_type):
            collect_active_ships(event, stats.active_ship_ids)
            actor_keys = actor_keys_for_event(event)
            for key, player_id, name in actor_keys:
                player = players.setdefault(
                    key,
                    PlayerDigest(key=key, player_id=player_id, name=name),
                )
                player.event_count += 1
                player.categorized_count += int(is_gameplay_event(event.event_type))
                if event.ship_id:
                    player.ships.add(event.ship_id)
                if event.sector_id is not None:
                    player.sectors.add(event.sector_id)
                stats.active_player_keys.add(key)
            apply_event(event, players, stats)

    period_ranks = compute_period_ranks(players)
    return Digest(
        start=start,
        end=end,
        generated_at=datetime.now(timezone.utc),
        global_stats=stats,
        players=players,
        leaderboard_ranks=leaderboard_ranks,
        period_ranks=period_ranks,
        warnings=warnings,
    )


def digest_to_dict(digest: Digest) -> dict[str, Any]:
    return {
        "schema": "gradientbang.news_digest.v1",
        "start": digest.start.isoformat(),
        "end": digest.end.isoformat(),
        "generated_at": digest.generated_at.isoformat(),
        "global_stats": global_stats_to_dict(digest.global_stats),
        "players": [
            player_to_dict(player)
            for player in sorted(
                digest.players.values(),
                key=lambda p: (-p.activity_score, -p.event_count, p.name.lower()),
            )
        ],
        "leaderboard_ranks": digest.leaderboard_ranks,
        "period_ranks": digest.period_ranks,
        "warnings": list(digest.warnings),
    }


def digest_from_dict(data: dict[str, Any]) -> Digest:
    if data.get("schema") != "gradientbang.news_digest.v1":
        raise ValueError("unsupported digest schema")
    global_stats = global_stats_from_dict(require_dict(data.get("global_stats"), "global_stats"))
    players = {
        player.key: player
        for player in (
            player_from_dict(require_dict(entry, "player"))
            for entry in require_list(data.get("players"), "players")
        )
    }
    return Digest(
        start=parse_timestamp(str(data["start"])),
        end=parse_timestamp(str(data["end"])),
        generated_at=parse_timestamp(str(data["generated_at"])),
        global_stats=global_stats,
        players=players,
        leaderboard_ranks=require_dict(data.get("leaderboard_ranks", {}), "leaderboard_ranks"),
        period_ranks={
            str(category): {str(key): int(rank) for key, rank in require_dict(ranks, category).items()}
            for category, ranks in require_dict(data.get("period_ranks", {}), "period_ranks").items()
        },
        warnings=[str(item) for item in require_list(data.get("warnings", []), "warnings")],
    )


def global_stats_to_dict(stats: GlobalStats) -> dict[str, Any]:
    return {
        "raw_event_rows": stats.raw_event_rows,
        "deduped_events": stats.deduped_events,
        "event_counts": dict(stats.event_counts),
        "active_player_keys": sorted(stats.active_player_keys),
        "active_ship_ids": sorted(stats.active_ship_ids),
        "sectors_visited": list(stats.sectors_visited),
        "unique_sectors": sorted(stats.unique_sectors),
        "trade_sales": stats.trade_sales,
        "trade_buys": stats.trade_buys,
        "trade_volume": stats.trade_volume,
        "messages_broadcast": stats.messages_broadcast,
        "messages_direct": stats.messages_direct,
        "combat_ids_ended": sorted(stats.combat_ids_ended),
        "combat_actions": stats.combat_actions,
        "ship_destroyed": stats.ship_destroyed,
        "garrisons_deployed": stats.garrisons_deployed,
        "ships_purchased": stats.ships_purchased,
        "ships_sold": stats.ships_sold,
    }


def global_stats_from_dict(data: dict[str, Any]) -> GlobalStats:
    return GlobalStats(
        raw_event_rows=int(data.get("raw_event_rows", 0)),
        deduped_events=int(data.get("deduped_events", 0)),
        event_counts=Counter(require_dict(data.get("event_counts", {}), "event_counts")),
        active_player_keys={str(value) for value in require_list(data.get("active_player_keys", []), "active_player_keys")},
        active_ship_ids={str(value) for value in require_list(data.get("active_ship_ids", []), "active_ship_ids")},
        sectors_visited=[
            int(value) for value in require_list(data.get("sectors_visited", []), "sectors_visited")
        ],
        unique_sectors={int(value) for value in require_list(data.get("unique_sectors", []), "unique_sectors")},
        trade_sales=int(data.get("trade_sales", 0)),
        trade_buys=int(data.get("trade_buys", 0)),
        trade_volume=int(data.get("trade_volume", 0)),
        messages_broadcast=int(data.get("messages_broadcast", 0)),
        messages_direct=int(data.get("messages_direct", 0)),
        combat_ids_ended={str(value) for value in require_list(data.get("combat_ids_ended", []), "combat_ids_ended")},
        combat_actions=int(data.get("combat_actions", 0)),
        ship_destroyed=int(data.get("ship_destroyed", 0)),
        garrisons_deployed=int(data.get("garrisons_deployed", 0)),
        ships_purchased=int(data.get("ships_purchased", 0)),
        ships_sold=int(data.get("ships_sold", 0)),
    )


def player_to_dict(player: PlayerDigest) -> dict[str, Any]:
    return {
        "key": player.key,
        "player_id": player.player_id,
        "name": player.name,
        "event_count": player.event_count,
        "categorized_count": player.categorized_count,
        "ships": sorted(player.ships),
        "sectors": sorted(player.sectors),
        "sector_visits": player.sector_visits,
        "trades": list(player.trades),
        "trade_sales": player.trade_sales,
        "trade_buys": player.trade_buys,
        "trade_volume": player.trade_volume,
        "ship_events": list(player.ship_events),
        "garrison_events": list(player.garrison_events),
        "combat_events": list(player.combat_events),
        "combat_wins": player.combat_wins,
        "combat_losses": player.combat_losses,
        "combat_neutral": player.combat_neutral,
        "destroyed_ships": player.destroyed_ships,
        "movement_events": list(player.movement_events),
        "messages": list(player.messages),
        "sessions": list(player.sessions),
        "errors": list(player.errors),
        "other_counts": dict(player.other_counts),
        "activity_score": player.activity_score,
    }


def player_from_dict(data: dict[str, Any]) -> PlayerDigest:
    player = PlayerDigest(
        key=str(data["key"]),
        player_id=str(data["player_id"]) if data.get("player_id") is not None else None,
        name=str(data["name"]),
    )
    player.event_count = int(data.get("event_count", 0))
    player.categorized_count = int(data.get("categorized_count", 0))
    player.ships = {str(value) for value in require_list(data.get("ships", []), "ships")}
    player.sectors = {int(value) for value in require_list(data.get("sectors", []), "sectors")}
    player.sector_visits = int(data.get("sector_visits", 0))
    player.trades = [str(value) for value in require_list(data.get("trades", []), "trades")]
    player.trade_sales = int(data.get("trade_sales", 0))
    player.trade_buys = int(data.get("trade_buys", 0))
    player.trade_volume = int(data.get("trade_volume", 0))
    player.ship_events = [
        str(value) for value in require_list(data.get("ship_events", []), "ship_events")
    ]
    player.garrison_events = [
        str(value) for value in require_list(data.get("garrison_events", []), "garrison_events")
    ]
    player.combat_events = [
        str(value) for value in require_list(data.get("combat_events", []), "combat_events")
    ]
    player.combat_wins = int(data.get("combat_wins", 0))
    player.combat_losses = int(data.get("combat_losses", 0))
    player.combat_neutral = int(data.get("combat_neutral", 0))
    player.destroyed_ships = int(data.get("destroyed_ships", 0))
    player.movement_events = [
        str(value) for value in require_list(data.get("movement_events", []), "movement_events")
    ]
    player.messages = [str(value) for value in require_list(data.get("messages", []), "messages")]
    player.sessions = [str(value) for value in require_list(data.get("sessions", []), "sessions")]
    player.errors = [str(value) for value in require_list(data.get("errors", []), "errors")]
    player.other_counts = Counter(require_dict(data.get("other_counts", {}), "other_counts"))
    return player


def require_dict(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{label} must be a list")
    return value


def dedupe_events(rows: list[dict[str, Any]]) -> list[Event]:
    grouped: dict[str, Event] = {}
    for row in rows:
        event = event_from_row(row)
        key = event_identity_key(event)
        existing = grouped.get(key)
        if existing is None:
            grouped[key] = event
            continue
        merge_delivery(existing, event)
    return sorted(grouped.values(), key=lambda event: (event.timestamp, event.id))


def event_from_row(row: dict[str, Any]) -> Event:
    payload = row.get("payload")
    if not isinstance(payload, dict):
        payload = {}
    timestamp = row["timestamp"]
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    recipient_id = clean_str(row.get("recipient_character_id"))
    recipient_name = clean_str(row.get("recipient_name"))
    recipient_reason = clean_str(row.get("recipient_reason"))
    return Event(
        id=int(row["id"]),
        timestamp=timestamp.astimezone(timezone.utc),
        event_type=str(row["event_type"]),
        direction=str(row["direction"]),
        payload=payload,
        scope=clean_str(row.get("scope")),
        character_id=clean_str(row.get("character_id")),
        character_name=clean_str(row.get("character_name")),
        actor_character_id=clean_str(row.get("actor_character_id")),
        actor_name=clean_str(row.get("actor_name")),
        sender_id=clean_str(row.get("sender_id")),
        sender_name=clean_str(row.get("sender_name")),
        recipient_character_ids=[recipient_id] if recipient_id else [],
        recipient_names=[recipient_name] if recipient_name else [],
        recipient_reasons=[recipient_reason] if recipient_reason else [],
        corp_id=clean_str(row.get("corp_id")),
        corp_name=clean_str(row.get("corp_name")),
        sector_id=optional_int(row.get("sector_id")),
        ship_id=clean_str(row.get("ship_id")),
        ship_name=clean_str(row.get("ship_name")),
        ship_type=clean_str(row.get("ship_type")),
        request_id=clean_str(row.get("request_id")),
        task_id=clean_str(row.get("task_id")),
        is_broadcast=bool(row.get("is_broadcast")),
    )


def event_identity_key(event: Event) -> str:
    payload_fingerprint = stable_json_hash(event.payload)
    base = [
        event.event_type,
        event.request_id or "",
        event.task_id or "",
        event.actor_character_id or "",
        event.sender_id or "",
        event.character_id or "",
        event.corp_id or "",
        event.ship_id or "",
        str(event.sector_id if event.sector_id is not None else ""),
        payload_fingerprint,
    ]
    if not event.request_id:
        base.append(event.timestamp.isoformat())
    return "|".join(base)


def stable_json_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha1(encoded.encode("utf-8")).hexdigest()


def merge_delivery(existing: Event, duplicate: Event) -> None:
    existing.id = min(existing.id, duplicate.id)
    existing.is_broadcast = existing.is_broadcast or duplicate.is_broadcast
    append_unique(existing.recipient_character_ids, duplicate.recipient_character_ids)
    append_unique(existing.recipient_names, duplicate.recipient_names)
    append_unique(existing.recipient_reasons, duplicate.recipient_reasons)


def append_unique(target: list[str], values: Iterable[str]) -> None:
    seen = set(target)
    for value in values:
        if value and value not in seen:
            target.append(value)
            seen.add(value)


def actor_keys_for_event(event: Event) -> list[tuple[str, str | None, str]]:
    if event.event_type == "chat.message":
        return [player_key(event.sender_id, chat_sender_name(event) or event.sender_name)]
    if event.event_type == "combat.ended":
        if event.character_id or event.character_name:
            return [player_key(event.character_id, event.character_name)]
        return participant_keys(event)
    if event.event_type in {"combat.round_resolved", "combat.round_waiting"}:
        participants = participant_keys(event)
        if participants:
            return participants
    if event.event_type == "ship.destroyed":
        return [player_key(None, clean_str(event.payload.get("player_name")))]
    if event.event_type == "corporation.ship_sold":
        return [player_key(clean_str(event.payload.get("seller_id")), clean_str(event.payload.get("seller_name")))]
    actor_id = event.actor_character_id or event.sender_id or event.character_id
    actor_name = event.actor_name or event.sender_name or event.character_name
    if actor_id or actor_name:
        return [player_key(actor_id, actor_name)]
    return []


def participant_keys(event: Event) -> list[tuple[str, str | None, str]]:
    participants = event.payload.get("participants")
    if not isinstance(participants, list):
        return []
    keys: list[tuple[str, str | None, str]] = []
    for participant in participants:
        if not isinstance(participant, dict):
            continue
        participant_id = clean_str(participant.get("id"))
        name = clean_str(participant.get("name"))
        if participant_id or name:
            keys.append(player_key(participant_id, name))
    return keys


def player_key(player_id: str | None, name: str | None) -> tuple[str, str | None, str]:
    fallback_name = name or (short_id(player_id) if player_id else "Unknown")
    if player_id:
        return player_id, player_id, fallback_name
    return f"name:{fallback_name.lower()}", None, fallback_name


def apply_event(
    event: Event,
    players: dict[str, PlayerDigest],
    stats: GlobalStats,
) -> None:
    if event.event_type == "trade.executed":
        apply_trade_event(event, players, stats)
    elif event.event_type in {"ship.purchased", "ship.traded_in", "corporation.ship_sold"}:
        apply_ship_event(event, players, stats)
    elif event.event_type.startswith("garrison."):
        apply_garrison_event(event, players, stats)
    elif event.event_type.startswith("combat.") or event.event_type == "ship.destroyed":
        apply_combat_event(event, players, stats)
    elif event.event_type == "movement.complete":
        apply_movement_event(event, players, stats)
    elif event.event_type == "chat.message":
        apply_chat_event(event, players, stats)
    elif event.event_type == "session.started":
        apply_session_event(event, players)
    elif event.event_type == "error":
        apply_error_event(event, players)
    else:
        for key, _player_id, _name in actor_keys_for_event(event):
            player = players.get(key)
            if player and should_count_other(event.event_type):
                player.other_counts[event.event_type] += 1


def apply_trade_event(
    event: Event,
    players: dict[str, PlayerDigest],
    stats: GlobalStats,
) -> None:
    trade = event.payload.get("trade")
    if not isinstance(trade, dict):
        trade = event.payload
    trade_type = clean_str(trade.get("trade_type")) or clean_str(event.payload.get("trade_type"))
    total_price = optional_int(trade.get("total_price")) or 0
    units = optional_int(trade.get("units")) or optional_int(trade.get("quantity")) or 0
    commodity = clean_str(trade.get("commodity")) or clean_str(trade.get("commodity_key")) or "commodity"
    commodity = COMMODITY_NAMES.get(commodity, commodity.replace("_", " "))
    line = (
        f"{format_time(event.timestamp)} {trade_type or 'traded'} "
        f"{units:,} {commodity} for {money(total_price)}"
    )
    if event.sector_id is not None:
        line += f" in sector {event.sector_id}"
    if trade_type == "sell":
        stats.trade_sales += total_price
    elif trade_type == "buy":
        stats.trade_buys += total_price
    stats.trade_volume += total_price
    for key, _player_id, _name in actor_keys_for_event(event):
        player = players.get(key)
        if not player:
            continue
        player.trades.append(line)
        player.trade_volume += total_price
        if trade_type == "sell":
            player.trade_sales += total_price
        elif trade_type == "buy":
            player.trade_buys += total_price


def apply_ship_event(
    event: Event,
    players: dict[str, PlayerDigest],
    stats: GlobalStats,
) -> None:
    payload = event.payload
    if event.event_type == "ship.purchased":
        stats.ships_purchased += 1
        line = (
            f"{format_time(event.timestamp)} purchased "
            f"{payload.get('ship_name') or payload.get('ship_type') or 'ship'} "
            f"for {money(optional_int(payload.get('purchase_price')) or 0)}"
        )
        net_cost = optional_int(payload.get("net_cost"))
        if net_cost is not None:
            line += f" ({money(net_cost)} net)"
    elif event.event_type == "ship.traded_in":
        line = (
            f"{format_time(event.timestamp)} traded in "
            f"{payload.get('old_ship_type') or payload.get('old_ship_id') or 'old ship'} "
            f"for {money(optional_int(payload.get('trade_in_value')) or 0)}"
        )
    else:
        stats.ships_sold += 1
        line = (
            f"{format_time(event.timestamp)} sold corporation ship "
            f"{payload.get('ship_name') or payload.get('ship_type') or payload.get('ship_id') or 'ship'} "
            f"for {money(optional_int(payload.get('trade_in_value')) or 0)}"
        )
    if event.sector_id is not None:
        line += f" in sector {event.sector_id}"
    for key, _player_id, _name in actor_keys_for_event(event):
        player = players.get(key)
        if player:
            player.ship_events.append(line)


def apply_garrison_event(
    event: Event,
    players: dict[str, PlayerDigest],
    stats: GlobalStats,
) -> None:
    payload = event.payload
    garrison = payload.get("garrison")
    if not isinstance(garrison, dict):
        garrison = {}
    sector = sector_from_payload(event)
    fighters = optional_int(garrison.get("fighters"))
    mode = clean_str(garrison.get("mode"))
    if event.event_type == "garrison.deployed":
        stats.garrisons_deployed += 1
        line = f"{format_time(event.timestamp)} placed garrison"
        if fighters is not None:
            line += f" with {fighters:,} fighters"
        if mode:
            line += f" ({mode})"
    elif event.event_type == "garrison.mode_changed":
        line = f"{format_time(event.timestamp)} changed garrison mode"
        if mode:
            line += f" to {mode}"
    elif event.event_type == "garrison.collected":
        if payload.get("disbanded"):
            line = (
                f"{format_time(event.timestamp)} disbanded garrison "
                f"({optional_int(payload.get('fighters_disbanded')) or 0:,} fighters)"
            )
        else:
            line = f"{format_time(event.timestamp)} collected garrison fighters"
            collected = optional_int(payload.get("credits_collected"))
            if collected:
                line += f" and {money(collected)} toll balance"
    else:
        line = f"{format_time(event.timestamp)} {event.event_type}"
    if sector is not None:
        line += f" in sector {sector}"
    for key, _player_id, _name in actor_keys_for_event(event):
        player = players.get(key)
        if player:
            player.garrison_events.append(line)


def apply_combat_event(
    event: Event,
    players: dict[str, PlayerDigest],
    stats: GlobalStats,
) -> None:
    if event.event_type == "combat.action_accepted":
        stats.combat_actions += 1
        action = clean_str(event.payload.get("action")) or "action"
        commit = optional_int(event.payload.get("commit")) or 0
        line = f"{format_time(event.timestamp)} combat action: {action}"
        if action == "attack" and commit:
            line += f" with {commit:,} fighters"
        target = clean_str(event.payload.get("target_id"))
        if target:
            line += f" targeting {short_id(target)}"
        for key, _player_id, _name in actor_keys_for_event(event):
            player = players.get(key)
            if player:
                player.combat_events.append(line)
        return

    if event.event_type == "combat.round_waiting":
        round_number = optional_int(event.payload.get("round"))
        if round_number != 1:
            return
        line = f"{format_time(event.timestamp)} entered combat {short_id(clean_str(event.payload.get('combat_id')))}"
        sector = sector_from_payload(event)
        if sector is not None:
            line += f" in sector {sector}"
        for key, _player_id, _name in participant_keys(event):
            player = players.get(key)
            if player:
                player.combat_events.append(line)
        return

    if event.event_type == "combat.round_resolved":
        apply_combat_round_result(event, players)
        return

    if event.event_type == "combat.ended":
        combat_id = clean_str(event.payload.get("combat_id"))
        if combat_id:
            stats.combat_ids_ended.add(combat_id)
        apply_combat_end(event, players)
        return

    if event.event_type == "ship.destroyed":
        stats.ship_destroyed += 1
        line = (
            f"{format_time(event.timestamp)} ship destroyed: "
            f"{event.payload.get('ship_name') or event.payload.get('ship_type') or event.payload.get('ship_id') or 'unknown ship'}"
        )
        sector = sector_from_payload(event)
        if sector is not None:
            line += f" in sector {sector}"
        for key, _player_id, _name in actor_keys_for_event(event):
            player = players.get(key)
            if player:
                player.destroyed_ships += 1
                player.combat_losses += 1
                player.combat_events.append(line)


def apply_combat_round_result(event: Event, players: dict[str, PlayerDigest]) -> None:
    participants = event.payload.get("participants")
    if not isinstance(participants, list):
        return
    combat_id = short_id(clean_str(event.payload.get("combat_id")))
    round_number = optional_int(event.payload.get("round"))
    for participant in participants:
        if not isinstance(participant, dict):
            continue
        key, _player_id, _name = player_key(
            clean_str(participant.get("id")),
            clean_str(participant.get("name")),
        )
        player = players.get(key)
        if not player:
            continue
        ship = participant.get("ship")
        if not isinstance(ship, dict):
            ship = {}
        fighter_loss = optional_int(ship.get("fighter_loss")) or 0
        shield_damage = ship.get("shield_damage")
        line = f"{format_time(event.timestamp)} combat round"
        if round_number:
            line += f" {round_number}"
        line += f" resolved ({combat_id})"
        details: list[str] = []
        if fighter_loss:
            details.append(f"lost {fighter_loss:,} fighters")
        if isinstance(shield_damage, (int, float)) and shield_damage:
            details.append(f"{shield_damage:g}% shield damage")
        if details:
            line += ": " + ", ".join(details)
        player.combat_events.append(line)


def apply_combat_end(event: Event, players: dict[str, PlayerDigest]) -> None:
    result = clean_str(event.payload.get("result") or event.payload.get("end"))
    participants = event.payload.get("participants")
    if not isinstance(participants, list):
        participants = []
    if event.character_id:
        participants = [
            participant
            for participant in participants
            if isinstance(participant, dict)
            and clean_str(participant.get("id")) == event.character_id
        ]
    loser_name = loser_from_result(result)
    combat_id = short_id(clean_str(event.payload.get("combat_id")))
    for participant in participants:
        if not isinstance(participant, dict):
            continue
        participant_id = clean_str(participant.get("id"))
        participant_name = clean_str(participant.get("name"))
        key, _player_id, fallback_name = player_key(participant_id, participant_name)
        player = players.get(key)
        if not player:
            continue
        outcome = classify_combat_outcome(result, participant_name or fallback_name, participant)
        if outcome == "win":
            player.combat_wins += 1
        elif outcome == "loss":
            player.combat_losses += 1
        else:
            player.combat_neutral += 1
        line = f"{format_time(event.timestamp)} combat ended ({combat_id}): {result or 'unknown result'}"
        if loser_name and participant_name == loser_name:
            line += " - defeated"
        ship = participant.get("ship")
        if isinstance(ship, dict):
            fighter_loss = optional_int(ship.get("fighter_loss")) or 0
            if fighter_loss:
                line += f"; lost {fighter_loss:,} fighters"
        event_ship = event.payload.get("ship")
        if isinstance(event_ship, dict) and event_ship.get("ship_type") == "escape_pod":
            if event.character_id == participant_id:
                line += "; ended in an escape pod"
                player.destroyed_ships += 1
        player.combat_events.append(line)


def loser_from_result(result: str | None) -> str | None:
    if not result:
        return None
    if result.endswith("_defeated"):
        return result[: -len("_defeated")]
    return None


def classify_combat_outcome(
    result: str | None,
    participant_name: str,
    participant: dict[str, Any],
) -> str:
    if not result or result in {"stalemate", "toll_satisfied", "no_hostiles"}:
        return "neutral"
    if result == "mutual_defeat":
        return "loss"
    loser = loser_from_result(result)
    if loser:
        return "loss" if participant_name == loser else "win"
    if result.endswith("_fled"):
        return "neutral"
    if result == "victory":
        ship = participant.get("ship")
        fighter_loss = optional_int(ship.get("fighter_loss")) if isinstance(ship, dict) else None
        return "loss" if fighter_loss is not None and fighter_loss > 0 else "win"
    return "neutral"


def apply_movement_event(
    event: Event,
    players: dict[str, PlayerDigest],
    stats: GlobalStats,
) -> None:
    to_sector = destination_sector(event)
    if to_sector is not None:
        stats.sectors_visited.append(to_sector)
        stats.unique_sectors.add(to_sector)
    line = f"{format_time(event.timestamp)} moved"
    from_sector = origin_sector(event)
    if from_sector is not None and to_sector is not None:
        line += f" from sector {from_sector} to {to_sector}"
    elif to_sector is not None:
        line += f" to sector {to_sector}"
    for key, _player_id, _name in actor_keys_for_event(event):
        player = players.get(key)
        if not player:
            continue
        player.sector_visits += 1
        if to_sector is not None:
            player.sectors.add(to_sector)
        player.movement_events.append(line)


def apply_chat_event(
    event: Event,
    players: dict[str, PlayerDigest],
    stats: GlobalStats,
) -> None:
    msg_type = clean_str(event.payload.get("type")) or "broadcast"
    if msg_type == "direct":
        stats.messages_direct += 1
    else:
        stats.messages_broadcast += 1
    sender = chat_sender_name(event) or event.sender_name or "Unknown"
    to_name = clean_str(event.payload.get("to_name"))
    content = clean_str(event.payload.get("content")) or ""
    line = f"{format_time(event.timestamp)} {msg_type} message"
    if msg_type == "direct" and to_name:
        line += f" to {to_name}"
    line += f": {truncate(content, 160)}"
    for key, _player_id, _name in actor_keys_for_event(event):
        player = players.get(key)
        if player:
            player.messages.append(line.replace(" message", f" message from {sender}", 1))


def apply_session_event(event: Event, players: dict[str, PlayerDigest]) -> None:
    for key, _player_id, _name in actor_keys_for_event(event):
        player = players.get(key)
        if player:
            player.sessions.append(f"{format_time(event.timestamp)} joined session")


def apply_error_event(event: Event, players: dict[str, PlayerDigest]) -> None:
    detail = clean_str(event.payload.get("detail") or event.payload.get("error"))
    method = clean_str((event.payload.get("source") or {}).get("method")) if isinstance(event.payload.get("source"), dict) else None
    line = f"{format_time(event.timestamp)} error"
    if method:
        line += f" in {method}"
    if detail:
        line += f": {truncate(detail, 140)}"
    for key, _player_id, _name in actor_keys_for_event(event):
        player = players.get(key)
        if player:
            player.errors.append(line)


def collect_active_ships(event: Event, ship_ids: set[str]) -> None:
    if event.ship_id:
        ship_ids.add(event.ship_id)
    for key in ("ship_id", "old_ship_id", "new_ship_id"):
        value = clean_str(event.payload.get(key))
        if value:
            ship_ids.add(value)
    ship = event.payload.get("ship")
    if isinstance(ship, dict):
        value = clean_str(ship.get("ship_id"))
        if value:
            ship_ids.add(value)


def compute_period_ranks(players: dict[str, PlayerDigest]) -> dict[str, dict[str, int]]:
    ranking_inputs = {
        "activity": {key: player.activity_score for key, player in players.items()},
        "trading": {key: player.trade_volume for key, player in players.items()},
        "exploration": {key: player.sector_visits for key, player in players.items()},
        "combat": {key: player.combat_wins - player.combat_losses for key, player in players.items()},
    }
    ranks: dict[str, dict[str, int]] = {}
    for category, scores in ranking_inputs.items():
        ordered = sorted(
            ((key, score) for key, score in scores.items() if score > 0),
            key=lambda item: (-item[1], players[item[0]].name.lower()),
        )
        ranks[category] = {key: idx + 1 for idx, (key, _score) in enumerate(ordered)}
    return ranks


def render_markdown(digest: Digest, *, max_lines_per_section: int) -> str:
    stats = digest.global_stats
    lines = [
        "# Game News Digest",
        "",
        f"Window: {format_datetime(digest.start)} to {format_datetime(digest.end)} UTC",
        f"Generated: {format_datetime(digest.generated_at)} UTC",
        "",
        "## Global Summary",
        "",
        f"- Active players: {len(stats.active_player_keys):,}",
        f"- Active ships: {len(stats.active_ship_ids):,}",
        f"- Events: {stats.deduped_events:,} deduped from {stats.raw_event_rows:,} database rows",
        f"- Trading: {money(stats.trade_sales)} earned from sales, {money(stats.trade_buys)} spent on buys, {money(stats.trade_volume)} gross volume",
        f"- Sectors visited: {len(stats.sectors_visited):,} visits across {len(stats.unique_sectors):,} unique sectors",
        f"- Chat: {stats.messages_broadcast:,} broadcasts, {stats.messages_direct:,} direct messages",
            f"- Combat: {stats.combat_actions:,} actions, {len(stats.combat_ids_ended):,} combats ended, {stats.ship_destroyed:,} ships destroyed",
        f"- Ships/garrisons: {stats.ships_purchased:,} ships purchased, {stats.ships_sold:,} ships sold, {stats.garrisons_deployed:,} garrisons placed",
        "",
    ]
    lines.extend(render_top_event_counts(stats.event_counts))
    lines.extend(render_period_leaders(digest))
    if digest.warnings:
        lines.append("## Notes")
        lines.append("")
        for warning in digest.warnings:
            lines.append(f"- {warning}")
        lines.append("")
    lines.append("## Player Activity")
    lines.append("")
    ordered_players = sorted(
        digest.players.values(),
        key=lambda player: (-player.activity_score, -player.event_count, player.name.lower()),
    )
    if not ordered_players:
        lines.append("No player-generated events found in this window.")
        return "\n".join(lines).rstrip() + "\n"
    for player in ordered_players:
        lines.extend(render_player(player, digest, max_lines_per_section=max_lines_per_section))
    return "\n".join(lines).rstrip() + "\n"


def render_top_event_counts(event_counts: Counter[str]) -> list[str]:
    if not event_counts:
        return []
    lines = ["### Event Mix", ""]
    for event_type, count in event_counts.most_common(12):
        lines.append(f"- {event_type}: {count:,}")
    lines.append("")
    return lines


def render_period_leaders(digest: Digest) -> list[str]:
    players = digest.players
    if not players:
        return []
    lines = ["## Period Leaderboard Signals", ""]
    categories = [
        ("activity", "most active", lambda p: f"{p.activity_score:,} activity score"),
        ("trading", "trading volume", lambda p: money(p.trade_volume)),
        ("exploration", "sector visits", lambda p: f"{p.sector_visits:,} visits"),
        ("combat", "combat net wins", lambda p: f"{p.combat_wins - p.combat_losses:+d} net"),
    ]
    for category, label, formatter in categories:
        ranked = sorted(
            (
                (key, rank)
                for key, rank in digest.period_ranks.get(category, {}).items()
                if key in players
            ),
            key=lambda item: item[1],
        )[:5]
        if not ranked:
            continue
        names = [
            f"#{rank} {players[key].name} ({formatter(players[key])})"
            for key, rank in ranked
        ]
        lines.append(f"- {label}: {', '.join(names)}")
    lines.append("")
    return lines


def render_player(
    player: PlayerDigest,
    digest: Digest,
    *,
    max_lines_per_section: int,
) -> list[str]:
    lines = [
        f"### {player.name}",
        "",
        (
            f"- Activity: {player.event_count:,} generated events, "
            f"{len(player.ships):,} ships, {player.sector_visits:,} sector visits, "
            f"{money(player.trade_volume)} trade volume"
        ),
    ]
    period_bits = []
    for category, label in (
        ("activity", "activity"),
        ("trading", "trading"),
        ("exploration", "exploration"),
        ("combat", "combat"),
    ):
        rank = digest.period_ranks.get(category, {}).get(player.key)
        if rank:
            period_bits.append(f"{label} #{rank}")
    if period_bits:
        lines.append(f"- Period ranks: {', '.join(period_bits)}")
    current = render_current_leaderboard_line(player, digest.leaderboard_ranks)
    if current:
        lines.append(current)
    if player.combat_wins or player.combat_losses or player.combat_neutral:
        lines.append(
            f"- Combat record in window: {player.combat_wins} wins, "
            f"{player.combat_losses} losses, {player.combat_neutral} neutral endings"
        )
    lines.append("")
    sections = [
        ("Trading", player.trades),
        ("Ship Activity", player.ship_events),
        ("Garrisons", player.garrison_events),
        ("Combat", player.combat_events),
        ("Movement", player.movement_events),
        ("Messages", player.messages),
        ("Sessions", player.sessions),
        ("Errors", player.errors),
    ]
    for title, items in sections:
        lines.extend(render_item_section(title, items, max_lines_per_section))
    if player.other_counts:
        other = ", ".join(
            f"{event_type} x{count}" for event_type, count in player.other_counts.most_common()
        )
        lines.extend(["Other", "", f"- {other}", ""])
    return lines


def render_current_leaderboard_line(
    player: PlayerDigest,
    leaderboard_ranks: dict[str, dict[str, dict[str, Any]]],
) -> str | None:
    if not player.player_id:
        return None
    bits: list[str] = []
    for category in ("wealth", "trading", "territory", "exploration"):
        rank_info = leaderboard_ranks.get(category, {}).get(player.player_id)
        if not rank_info:
            continue
        score = rank_info.get("score")
        score_text = f" ({format_number(score)})" if score is not None else ""
        bits.append(f"{category} #{rank_info['rank']}{score_text}")
    if not bits:
        return None
    return f"- Current official ranks: {', '.join(bits)}"


def render_item_section(title: str, items: list[str], max_lines: int) -> list[str]:
    if not items:
        return []
    lines = [title, ""]
    shown = items[:max_lines]
    for item in shown:
        lines.append(f"- {item}")
    hidden = len(items) - len(shown)
    if hidden > 0:
        lines.append(f"- ... {hidden:,} more")
    lines.append("")
    return lines


def is_gameplay_event(event_type: str) -> bool:
    return event_type in GAMEPLAY_EVENT_TYPES or event_type.startswith(GAMEPLAY_EVENT_PREFIXES)


def is_active_player_event(event_type: str) -> bool:
    if event_type in NOISY_EVENT_TYPES:
        return False
    return event_type in ACTIVE_EVENT_TYPES or event_type.startswith(ACTIVE_EVENT_PREFIXES)


def should_count_other(event_type: str) -> bool:
    return event_type not in NOISY_EVENT_TYPES


def sector_from_payload(event: Event) -> int | None:
    sector = event.payload.get("sector")
    if isinstance(sector, dict):
        sector_id = optional_int(sector.get("id"))
        if sector_id is not None:
            return sector_id
    return event.sector_id


def destination_sector(event: Event) -> int | None:
    payload = event.payload
    for key in ("to_sector", "destination_sector", "sector_id"):
        value = optional_int(payload.get(key))
        if value is not None:
            return value
    sector = payload.get("sector")
    if isinstance(sector, dict):
        value = optional_int(sector.get("id"))
        if value is not None:
            return value
    ship = payload.get("ship")
    if isinstance(ship, dict):
        value = optional_int(ship.get("current_sector"))
        if value is not None:
            return value
    return event.sector_id


def origin_sector(event: Event) -> int | None:
    payload = event.payload
    for key in ("from_sector", "origin_sector"):
        value = optional_int(payload.get(key))
        if value is not None:
            return value
    return None


def chat_sender_name(event: Event) -> str | None:
    return clean_str(event.payload.get("from_name")) or event.sender_name


def clean_str(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def money(value: int) -> str:
    return f"${value:,}"


def format_number(value: Any) -> str:
    if isinstance(value, int):
        return f"{value:,}"
    if isinstance(value, float):
        return f"{value:,.0f}"
    return str(value)


def format_datetime(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def format_time(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%H:%M:%S")


def short_id(value: str | None) -> str:
    if not value:
        return "unknown"
    return value[:8]


def truncate(value: str, max_length: int) -> str:
    if len(value) <= max_length:
        return value
    return value[: max_length - 1].rstrip() + "..."


if __name__ == "__main__":
    main()
