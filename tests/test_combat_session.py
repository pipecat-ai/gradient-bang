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
            await handler(payload)


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
        started_payload = {
            "combat_id": "c1",
            "sector": 7,
            "round": 1,
            "participants": {
                "npc": {
                    "combatant_id": "npc",
                    "name": "npc",
                    "type": "character",
                    "fighters": 20,
                    "shields": 10,
                    "max_fighters": 20,
                    "max_shields": 10,
                    "turns_per_warp": 1,
                    "owner": "npc",
                },
                "foe": {
                    "combatant_id": "foe",
                    "name": "foe",
                    "type": "character",
                    "fighters": 15,
                    "shields": 8,
                    "max_fighters": 15,
                    "max_shields": 8,
                    "turns_per_warp": 1,
                    "owner": "foe",
                },
            },
        }
        await client.emit("combat.started", started_payload)
        event_name, state, _ = await session.next_combat_event()
        assert event_name == "combat.started"
        assert session.in_active_combat()
        assert state.combat_id == "c1"

        round_waiting_payload = {
            "combat_id": "c1",
            "round": 1,
            "deadline": None,
            "participants": started_payload["participants"],
        }
        await client.emit("combat.round_waiting", round_waiting_payload)
        event_name, state, _ = await session.next_combat_event()
        assert event_name == "combat.round_waiting"
        assert state.round == 1

        round_resolved_payload = {
            "combat_id": "c1",
            "round": 1,
            "fighters_remaining": {"npc": 18, "foe": 5},
            "shields_remaining": {"npc": 5, "foe": 2},
            "result": None,
        }
        await client.emit("combat.round_resolved", round_resolved_payload)
        event_name, state, _ = await session.next_combat_event()
        assert event_name == "combat.round_resolved"
        assert state.participants["npc"].fighters == 18
        assert state.participants["foe"].fighters == 5

        ended_payload = {
            "combat_id": "c1",
            "round": 2,
            "fighters_remaining": {"npc": 18, "foe": 0},
            "shields_remaining": {"npc": 5, "foe": 0},
            "result": "foe_defeated",
            "salvage": [{"id": "salvage-1"}],
        }
        await client.emit("combat.ended", ended_payload)
        event_name, state, payload = await session.next_combat_event()
        assert event_name == "combat.ended"
        assert not session.in_active_combat()
        assert state.result == "foe_defeated"
        assert payload["salvage"][0]["id"] == "salvage-1"
