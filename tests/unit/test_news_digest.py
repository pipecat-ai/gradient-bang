from __future__ import annotations

from datetime import datetime, timezone

from gradientbang.newspaper.scripts.digest import (
    build_digest,
    digest_from_dict,
    digest_to_dict,
    render_markdown,
)


def row(**overrides):
    base = {
        "id": 1,
        "timestamp": datetime(2026, 4, 23, 12, 0, tzinfo=timezone.utc),
        "inserted_at": datetime(2026, 4, 23, 12, 0, tzinfo=timezone.utc),
        "direction": "event_out",
        "event_type": "chat.message",
        "scope": "direct",
        "character_id": None,
        "character_name": None,
        "actor_character_id": None,
        "actor_name": None,
        "sender_id": None,
        "sender_name": None,
        "recipient_character_id": None,
        "recipient_name": None,
        "recipient_reason": None,
        "corp_id": None,
        "corp_name": None,
        "sector_id": None,
        "ship_id": None,
        "ship_name": None,
        "ship_type": None,
        "request_id": None,
        "task_id": None,
        "is_broadcast": False,
        "payload": {},
        "meta": None,
    }
    base.update(overrides)
    return base


def test_digest_deduplicates_direct_message_recipient_rows():
    start = datetime(2026, 4, 23, 12, 0, tzinfo=timezone.utc)
    end = datetime(2026, 4, 23, 13, 0, tzinfo=timezone.utc)
    payload = {
        "id": "msg-1",
        "from_name": "Alice",
        "type": "direct",
        "to_name": "Bob",
        "content": "Coordinates sent.",
        "timestamp": "2026-04-23T12:00:00Z",
    }
    rows = [
        row(
            id=10,
            sender_id="alice-id",
            sender_name="Alice",
            recipient_character_id="alice-id",
            recipient_name="Alice",
            recipient_reason="sender",
            request_id="req-chat",
            payload=payload,
        ),
        row(
            id=11,
            sender_id="alice-id",
            sender_name="Alice",
            recipient_character_id="bob-id",
            recipient_name="Bob",
            recipient_reason="recipient",
            request_id="req-chat",
            payload=payload,
        ),
    ]

    digest = build_digest(rows, start=start, end=end, leaderboard_ranks={})

    assert digest.global_stats.raw_event_rows == 2
    assert digest.global_stats.deduped_events == 1
    assert digest.global_stats.messages_direct == 1
    assert len(digest.players) == 1
    alice = digest.players["alice-id"]
    assert alice.event_count == 1
    assert alice.messages == ["12:00:00 direct message from Alice to Bob: Coordinates sent."]


def test_digest_accumulates_trading_and_movement_stats():
    start = datetime(2026, 4, 23, 12, 0, tzinfo=timezone.utc)
    end = datetime(2026, 4, 23, 13, 0, tzinfo=timezone.utc)
    rows = [
        row(
            id=20,
            event_type="trade.executed",
            character_id="alice-id",
            character_name="Alice",
            actor_character_id="alice-id",
            actor_name="Alice",
            sector_id=42,
            ship_id="ship-a",
            request_id="req-trade",
            payload={
                "trade": {
                    "trade_type": "sell",
                    "commodity": "quantum_foam",
                    "units": 10,
                    "total_price": 1200,
                }
            },
        ),
        row(
            id=21,
            timestamp=datetime(2026, 4, 23, 12, 10, tzinfo=timezone.utc),
            event_type="movement.complete",
            character_id="alice-id",
            character_name="Alice",
            actor_character_id="alice-id",
            actor_name="Alice",
            sector_id=43,
            ship_id="ship-a",
            request_id="req-move",
            payload={"sector": {"id": 43}},
        ),
    ]

    digest = build_digest(rows, start=start, end=end, leaderboard_ranks={})

    stats = digest.global_stats
    assert stats.trade_sales == 1200
    assert stats.trade_volume == 1200
    assert stats.sectors_visited == [43]
    assert stats.active_ship_ids == {"ship-a"}
    alice = digest.players["alice-id"]
    assert alice.trade_sales == 1200
    assert alice.sector_visits == 1
    assert digest.period_ranks["activity"]["alice-id"] == 1


def test_combat_ended_counts_one_combat_but_one_result_per_player():
    start = datetime(2026, 4, 23, 12, 0, tzinfo=timezone.utc)
    end = datetime(2026, 4, 23, 13, 0, tzinfo=timezone.utc)
    payload = {
        "combat_id": "combat-123456",
        "result": "Bob_defeated",
        "participants": [
            {"id": "alice-id", "name": "Alice", "ship": {"fighter_loss": 1}},
            {"id": "bob-id", "name": "Bob", "ship": {"fighter_loss": 5}},
        ],
    }
    rows = [
        row(
            id=30,
            event_type="combat.ended",
            character_id="alice-id",
            character_name="Alice",
            request_id="req-combat",
            payload={**payload, "ship": {"ship_id": "ship-a", "ship_type": "sparrow_scout"}},
        ),
        row(
            id=31,
            event_type="combat.ended",
            character_id="bob-id",
            character_name="Bob",
            request_id="req-combat",
            payload={**payload, "ship": {"ship_id": "ship-b", "ship_type": "escape_pod"}},
        ),
    ]

    digest = build_digest(rows, start=start, end=end, leaderboard_ranks={})
    markdown = render_markdown(digest, max_lines_per_section=5)

    assert len(digest.global_stats.combat_ids_ended) == 1
    assert digest.players["alice-id"].combat_wins == 1
    assert digest.players["bob-id"].combat_losses == 1
    assert digest.players["bob-id"].destroyed_ships == 1
    assert "ended in an escape pod" in markdown


def test_noisy_fanout_events_do_not_create_active_players():
    start = datetime(2026, 4, 23, 12, 0, tzinfo=timezone.utc)
    end = datetime(2026, 4, 23, 13, 0, tzinfo=timezone.utc)
    rows = [
        row(
            id=40,
            event_type="port.update",
            character_id="observer-id",
            character_name="Observer",
            actor_character_id="observer-id",
            actor_name="Observer",
            recipient_character_id="observer-id",
            recipient_name="Observer",
            sector_id=42,
            payload={"sector": {"id": 42}},
        ),
        row(
            id=41,
            event_type="corporation.data",
            character_id="member-id",
            character_name="Corp Member",
            actor_character_id="member-id",
            actor_name="Corp Member",
            recipient_character_id="member-id",
            recipient_name="Corp Member",
            payload={"corporation": {"name": "Example Corp"}},
        ),
    ]

    digest = build_digest(rows, start=start, end=end, leaderboard_ranks={})

    assert digest.global_stats.deduped_events == 2
    assert digest.global_stats.active_player_keys == set()
    assert digest.players == {}


def test_digest_json_round_trip_preserves_front_page_inputs():
    start = datetime(2026, 4, 23, 12, 0, tzinfo=timezone.utc)
    end = datetime(2026, 4, 23, 13, 0, tzinfo=timezone.utc)
    digest = build_digest(
        [
            row(
                id=50,
                event_type="trade.executed",
                character_id="alice-id",
                character_name="Alice",
                actor_character_id="alice-id",
                actor_name="Alice",
                sector_id=42,
                ship_id="ship-a",
                request_id="req-trade",
                payload={
                    "trade": {
                        "trade_type": "sell",
                        "commodity": "quantum_foam",
                        "units": 10,
                        "total_price": 1200,
                    }
                },
            )
        ],
        start=start,
        end=end,
        leaderboard_ranks={},
    )

    restored = digest_from_dict(digest_to_dict(digest))

    assert restored.start == digest.start
    assert restored.end == digest.end
    assert restored.global_stats.trade_volume == 1200
    assert restored.players["alice-id"].name == "Alice"
    assert restored.players["alice-id"].trade_volume == 1200
