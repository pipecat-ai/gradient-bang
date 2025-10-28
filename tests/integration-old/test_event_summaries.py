"""Unit tests covering client-side event summary formatting."""

import asyncio

import pytest

from utils.api_client import AsyncGameClient
from utils.task_agent import TaskAgent
from utils.tools_schema import WaitInIdleState


class _StubGameClient:
    def __init__(self) -> None:
        self.character_id = "stub"
        self._handlers: dict[str, list] = {}

    def on(self, event_name: str):
        def decorator(handler):
            self._handlers.setdefault(event_name, []).append(handler)
            return handler

        return decorator


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


def test_status_update_summary_is_concise() -> None:
    client = _make_client()

    payload = {
        "player": {"credits_on_hand": 1234},
        "ship": {
            "warp_power": 90,
            "warp_power_capacity": 300,
            "shields": 140,
            "max_shields": 150,
            "fighters": 45,
        },
        "sector": {"id": 77, "port": {"code": "SBS"}},
    }

    event = client._format_event("status.update", payload)
    summary = event.get("summary")
    assert isinstance(summary, str)
    assert summary.startswith("Status update:")
    assert "Sector 77" in summary
    assert "Warp 90/300" in summary
    assert summary.endswith(".")


def test_combat_round_waiting_summary_mentions_deadline() -> None:
    client = _make_client()

    payload = {
        "round": 2,
        "sector": {"id": 184},
        "deadline": "2025-10-20T03:24:50+00:00",
        "participants": [{"name": "Alpha"}, {"name": "Beta"}],
        "combat_id": "abc123",
    }

    event = client._format_event("combat.round_waiting", payload)
    summary = event.get("summary")
    assert isinstance(summary, str)
    assert "Combat abc123 round 2 waiting" in summary
    assert "Alpha" in summary and "Beta" in summary
    assert "deadline" in summary


def test_combat_action_accepted_summary_includes_action() -> None:
    client = _make_client()

    payload = {
        "round": 3,
        "action": "attack",
        "commit": 25,
        "target_id": "enemy-1",
        "round_resolved": False,
    }

    event = client._format_event("combat.action_accepted", payload)
    summary = event.get("summary")
    assert isinstance(summary, str)
    assert "attack" in summary
    assert "commit=25" in summary
    assert "Round resolved: no" in summary


def test_combat_round_resolved_summary_reports_result() -> None:
    client = _make_client()

    payload = {
        "round": 4,
        "sector": {"id": 999},
        "result": "victory",
        "defensive_losses": {"ally": 1, "enemy": 0},
        "flee_results": {"enemy": True},
    }

    event = client._format_event("combat.round_resolved", payload)
    summary = event.get("summary")
    assert isinstance(summary, str)
    assert "result victory" in summary
    assert "ally:1" in summary
    assert "Flees: enemy" in summary


def test_combat_ended_summary_focuses_on_losses() -> None:
    client = _make_client()

    payload = {
        "round": 5,
        "sector": {"id": 321},
        "result": "mutual_defeat",
        "defensive_losses": {"alpha": 3, "beta": 0},
        "offensive_losses": {"alpha": 2, "gamma": 0},
        "flee_results": {"beta": True},
        "fled_to_sector": 111,
        "salvage": [{"id": "s1"}, {"id": "s2"}],
    }

    event = client._format_event("combat.ended", payload)
    summary = event.get("summary")
    assert isinstance(summary, str)
    assert "mutual_defeat" in summary
    assert "alpha lost 5 fighters" in summary
    assert "beta fled to sector 111" in summary
    assert "gamma" not in summary  # no losses, no flee


def test_sector_update_summary_includes_port_and_players() -> None:
    client = _make_client()

    payload = {
        "id": 184,
        "adjacent_sectors": [115, 285, 376],
        "port": {"code": "BBB"},
        "players": [{"name": "khk-j"}],
        "garrisons": [],
        "salvage": [],
    }

    event = client._format_event("sector.update", payload)
    summary = event.get("summary")
    assert isinstance(summary, str)
    assert summary.startswith("Sector update:")
    assert "Sector 184" in summary
    assert "port BBB" in summary
    assert "players khk-j" in summary


@pytest.mark.asyncio
async def test_wait_in_idle_state_interrupts_on_event(monkeypatch) -> None:
    monkeypatch.setenv("GOOGLE_API_KEY", "dummy-key")

    client = _StubGameClient()
    agent = TaskAgent(
        game_client=client,
        character_id="stub",
        tools_list=[WaitInIdleState],
        llm_service_factory=lambda: None,
    )

    agent._tool_call_in_progress = True
    result = None

    try:
        wait_task = asyncio.create_task(agent.wait_in_idle_state(seconds=60))

        async def emit_event():
            await asyncio.sleep(0.05)
            await agent._handle_event(
                {
                    "event_name": "chat.message",
                    "summary": "Incoming message",
                    "payload": {"content": "hi"},
                }
            )

        asyncio.create_task(emit_event())

        result = await asyncio.wait_for(wait_task, timeout=1.0)
    finally:
        agent._tool_call_in_progress = False

    assert result["events_received"] is True
    assert result["emitted_idle_event"] is False
    assert result.get("interrupt_reason") == "chat.message"
    assert result["waited_seconds"] < 1.0
