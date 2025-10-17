"""Unit tests covering client-side event summary formatting."""

from utils.api_client import AsyncGameClient


def _make_client() -> AsyncGameClient:
    # Use a unique character ID to avoid clashes; no network requests are made.
    return AsyncGameClient(base_url="http://localhost:8000", character_id="test_char")


def test_movement_complete_summary_applied() -> None:
    client = _make_client()

    payload = {
        "player": {"name": "test_char", "credits_on_hand": 100},
        "ship": {
            "cargo": {"quantum_foam": 1, "retro_organics": 2, "neuro_symbolics": 3},
            "cargo_capacity": 10,
            "warp_power": 50,
            "warp_power_capacity": 100,
            "shields": 25,
            "max_shields": 50,
            "fighters": 5,
            "max_fighters": 10,
        },
        "sector": {"id": 126, "adjacent_sectors": [125, 127], "port": None, "players": []},
    }

    event = client._format_event("movement.complete", payload)

    assert event["event_name"] == "movement.complete"
    assert event["payload"] is payload  # payload object is reused
    summary = event.get("summary")
    assert isinstance(summary, str) and summary.startswith("Now in sector 126.")


def test_map_local_summary_mentions_unvisited() -> None:
    client = _make_client()

    payload = {
        "center_sector": 500,
        "total_sectors": 4,
        "total_visited": 2,
        "total_unvisited": 2,
        "sectors": [
            {"id": 500, "visited": True, "hops_from_center": 0},
            {"id": 501, "visited": False, "hops_from_center": 1},
            {"id": 502, "visited": False, "hops_from_center": 2},
            {"id": 503, "visited": True, "hops_from_center": 1},
        ],
    }

    event = client._format_event("map.local", payload)

    summary = event.get("summary")
    assert isinstance(summary, str)
    assert "Local map around sector 500" in summary
    assert "Nearest unvisited: 501 (1 hops)" in summary
    assert "We are currently in sector 500." in summary


def test_trade_executed_summary_embeds_player_info() -> None:
    client = _make_client()

    payload = {
        "player": {"name": "Trader", "credits_on_hand": 1500},
        "ship": {"cargo": {"quantum_foam": 5}, "fighters": 20},
    }

    event = client._format_event("trade.executed", payload)

    summary = event.get("summary")
    assert isinstance(summary, str)
    assert summary.startswith("Trade executed.")
    assert "Credits: 1500" in summary


def test_status_snapshot_summary_present() -> None:
    client = _make_client()

    payload = {
        "player": {
            "name": "Explorer",
            "credits_on_hand": 900,
        },
        "ship": {
            "ship_name": "Kestrel Courier",
            "ship_type": "kestrel_courier",
            "cargo": {"quantum_foam": 1, "retro_organics": 0, "neuro_symbolics": 0},
            "cargo_capacity": 30,
            "warp_power": 290,
            "warp_power_capacity": 300,
            "shields": 120,
            "max_shields": 150,
            "fighters": 10,
        },
        "sector": {
            "id": 42,
            "adjacent_sectors": [41, 43],
            "port": None,
            "players": [],
        },
    }

    event = client._format_event("status.snapshot", payload)
    summary = event.get("summary")
    assert isinstance(summary, str)
    assert summary.startswith("In sector 42.")
    assert "Adjacent sectors: [41, 43]" in summary
