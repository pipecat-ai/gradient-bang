import asyncio
import pytest

from npc.combat_session import CombatSession


class FakeGameClient:
    def __init__(self):
        self.handlers = {}

    def add_event_handler(self, event_name, handler):
        self.handlers.setdefault(event_name, []).append(handler)
        return (event_name, handler)

    def remove_event_handler(self, token):
        event_name, handler = token
        handlers = self.handlers.get(event_name, [])
        try:
            handlers.remove(handler)
            return True
        except ValueError:
            return False

    async def emit(self, event_name, payload):
        for handler in list(self.handlers.get(event_name, [])):
            await handler({
                "event_name": event_name,
                "payload": payload,
            })


@pytest.mark.asyncio
async def test_combat_session_tracks_opponents():
    initial_status = {
        "character_id": "npc",
        "sector": 10,
        "sector_contents": {
            "other_players": [{"name": "raider"}],
            "garrisons": [],
            "salvage": [],
        },
    }
    client = FakeGameClient()

    async with CombatSession(client, character_id="npc", initial_status=initial_status) as session:
        players = session.other_players()
        assert "raider" in players
        assert session.sector == 10


@pytest.mark.asyncio
async def test_combat_session_waits_for_opponent():
    initial_status = {
        "character_id": "npc",
        "sector": 42,
        "sector_contents": {},
    }
    client = FakeGameClient()

    async with CombatSession(client, character_id="npc", initial_status=initial_status) as session:
        waiter = asyncio.create_task(session.wait_for_other_player(timeout=1))
        await asyncio.sleep(0)
        await client.emit(
            "status.update",
            {
                "character_id": "npc",
            "sector": 42,
            "sector_contents": {"other_players": [{"name": "intruder"}]},
            },
        )
        players = await waiter
        assert "intruder" in players


@pytest.mark.asyncio
async def test_combat_session_combat_flow_updates_state():
    initial_status = {
        "character_id": "npc",
        "sector": 7,
        "sector_contents": {},
    }
    client = FakeGameClient()

    async with CombatSession(client, character_id="npc", initial_status=initial_status) as session:
        round_waiting_payload = {
            "combat_id": "c1",
            "sector": {"id": 7},
            "round": 1,
            "deadline": None,
            "participants": [
                {
                    "created_at": "2025-10-07T00:00:00Z",
                    "name": "npc",
                    "player_type": "human",
                    "ship": {
                        "ship_type": "kestrel_courier",
                        "ship_name": "NPC Ship",
                        "shield_integrity": 100.0,
                        "shield_damage": None,
                        "fighter_loss": None,
                    },
                },
                {
                    "created_at": "2025-10-07T00:00:00Z",
                    "name": "foe",
                    "player_type": "human",
                    "ship": {
                        "ship_type": "sparrow_scout",
                        "ship_name": "Foe Ship",
                        "shield_integrity": 100.0,
                        "shield_damage": None,
                        "fighter_loss": None,
                    },
                },
            ],
            "ship": {
                "ship_type": "kestrel_courier",
                "ship_name": "NPC Ship",
                "cargo": {},
                "cargo_capacity": 0,
                "warp_power": 0,
                "warp_power_capacity": 0,
                "fighters": 20,
                "max_fighters": 20,
                "shields": 10,
                "max_shields": 10,
            },
        }
        await client.emit("combat.round_waiting", round_waiting_payload)
        event_name, state, _ = await session.next_combat_event()
        assert event_name == "combat.round_waiting"
        assert session.in_active_combat()
        assert state.combat_id == "c1"
        assert state.round == 1

        round_resolved_payload = {
            "combat_id": "c1",
            "sector": {"id": 7},
            "round": 1,
            "participants": [
                {
                    "created_at": "2025-10-07T00:00:00Z",
                    "name": "npc",
                    "player_type": "human",
                    "ship": {
                        "ship_type": "kestrel_courier",
                        "ship_name": "NPC Ship",
                        "shield_integrity": 75.0,
                        "shield_damage": -25.0,
                        "fighter_loss": 2,
                    },
                },
                {
                    "created_at": "2025-10-07T00:00:00Z",
                    "name": "foe",
                    "player_type": "human",
                    "ship": {
                        "ship_type": "sparrow_scout",
                        "ship_name": "Foe Ship",
                        "shield_integrity": 25.0,
                        "shield_damage": -50.0,
                        "fighter_loss": 10,
                    },
                },
            ],
            "garrison": None,
            "ship": {
                "ship_type": "kestrel_courier",
                "ship_name": "NPC Ship",
                "cargo": {},
                "cargo_capacity": 0,
                "warp_power": 0,
                "warp_power_capacity": 0,
                "fighters": 18,
                "max_fighters": 20,
                "shields": 5,
                "max_shields": 10,
            },
        }
        await client.emit("combat.round_resolved", round_resolved_payload)
        event_name, state, _ = await session.next_combat_event()
        assert event_name == "combat.round_resolved"
        assert state.participants["npc"].fighters == 18
        assert "foe" in state.participants

        ended_payload = {
            "combat_id": "c1",
            "sector": {"id": 7},
            "round": 2,
            "result": "foe_defeated",
            "salvage": [
                {
                    "salvage_id": "salvage-1",
                    "created_at": "2025-10-07T00:00:00Z",
                    "expires_at": "2025-10-07T00:15:00Z",
                    "cargo": {},
                    "scrap": 10,
                    "credits": 0,
                    "claimed": False,
                    "source": {"ship_name": "Foe Ship", "ship_type": "sparrow_scout"},
                    "metadata": {},
                }
            ],
            "ship": {
                "ship_type": "kestrel_courier",
                "ship_name": "NPC Ship",
                "cargo": {},
                "cargo_capacity": 0,
                "warp_power": 0,
                "warp_power_capacity": 0,
                "fighters": 18,
                "max_fighters": 20,
                "shields": 5,
                "max_shields": 10,
            },
        }
        await client.emit("combat.ended", ended_payload)
        event_name, state, payload = await session.next_combat_event()
        assert event_name == "combat.ended"
        assert not session.in_active_combat()
        assert state.result == "foe_defeated"
        assert payload["salvage"][0]["salvage_id"] == "salvage-1"
