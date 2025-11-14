from __future__ import annotations

import pytest

from combat.callbacks import _emit_garrison_combat_alert
from combat.models import CombatEncounter, CombatantState, GarrisonState


class _DummyCharacter:
    def __init__(self, *, name: str, connected: bool, sector: int = 0):
        self.name = name
        self.connected = connected
        self.sector = sector
        self.in_hyperspace = False


class _DummyGarrisonStore:
    def __init__(self, garrison: GarrisonState):
        self._garrison = garrison

    async def list_sector(self, sector_id: int):
        return [self._garrison]


class _DummyWorld:
    def __init__(self, garrison: GarrisonState, *, owner_connected: bool = True, corp_connected: bool = True):
        self.characters = {
            "owner": _DummyCharacter(name="Corsair Pilot", connected=owner_connected, sector=512),
            "corp-mate": _DummyCharacter(name="Fleet Wing", connected=corp_connected, sector=40),
            "outsider": _DummyCharacter(name="Random Trader", connected=True, sector=40),
        }
        self.character_to_corp = {"owner": "corp-123", "corp-mate": "corp-123"}
        self.garrisons = _DummyGarrisonStore(garrison)


class _DummyDispatcher:
    def __init__(self):
        self.calls: list[tuple[str, dict, list[str] | None]] = []

    async def emit(self, event, payload, *, character_filter=None, log_context=None):
        self.calls.append((event, payload, character_filter))


@pytest.mark.asyncio
async def test_emit_garrison_combat_alert_notifies_owner_and_corp_mates():
    garrison_state = GarrisonState(
        owner_id="owner",
        fighters=375,
        mode="toll",
        toll_amount=2500,
        toll_balance=0,
        deployed_at="2025-11-03T00:00:00Z",
    )

    encounter = CombatEncounter(
        combat_id="combat123",
        sector_id=512,
        participants={
            "garrison:512:owner": CombatantState(
                combatant_id="garrison:512:owner",
                combatant_type="garrison",
                name="Defence Grid",
                fighters=375,
                shields=0,
                turns_per_warp=0,
                max_fighters=375,
                max_shields=0,
                owner_character_id="owner",
            )
        },
    )
    encounter.context = {"initiator": "attacker", "reason": "garrison_auto"}

    world = _DummyWorld(garrison_state)
    dispatcher = _DummyDispatcher()

    await _emit_garrison_combat_alert(encounter, world, dispatcher)

    # First call emits the alert to owner + corp mate only.
    assert dispatcher.calls, "Expected garrison alert to be emitted"
    event_name, payload, recipients = dispatcher.calls[0]
    assert event_name == "garrison.combat_alert"
    assert set(recipients) == {"owner", "corp-mate"}
    assert payload["sector"]["id"] == 512
    assert payload["garrison"]["owner_id"] == "owner"
    assert payload["garrison"]["mode"] == "toll"
    assert payload["garrison"]["fighters"] == 375
    assert payload["garrison"]["toll_amount"] == 2500
    assert payload["garrison"]["deployed_at"] == "2025-11-03T00:00:00Z"
    assert payload["combat"]["combat_id"] == "combat123"

    # Subsequent invocations should be idempotent for the same garrison owner.
    await _emit_garrison_combat_alert(encounter, world, dispatcher)
    assert len(dispatcher.calls) == 1


@pytest.mark.asyncio
async def test_emit_garrison_combat_alert_handles_offline_owner():
    garrison_state = GarrisonState(
        owner_id="owner",
        fighters=200,
        mode="offensive",
        toll_amount=0,
        toll_balance=0,
        deployed_at="2025-11-03T01:00:00Z",
    )

    encounter = CombatEncounter(
        combat_id="combat456",
        sector_id=900,
        participants={
            "garrison:900:owner": CombatantState(
                combatant_id="garrison:900:owner",
                combatant_type="garrison",
                name="Outer Rim Guard",
                fighters=200,
                shields=0,
                turns_per_warp=0,
                max_fighters=200,
                max_shields=0,
                owner_character_id="owner",
            )
        },
    )
    encounter.context = {}

    world = _DummyWorld(garrison_state, owner_connected=False)
    dispatcher = _DummyDispatcher()

    await _emit_garrison_combat_alert(encounter, world, dispatcher)

    assert dispatcher.calls, "Expected garrison alert when corp mates are connected"
    event_name, payload, recipients = dispatcher.calls[0]
    assert event_name == "garrison.combat_alert"
    assert recipients == ["corp-mate"]
    assert payload["garrison"]["owner_id"] == "owner"
    assert payload["garrison"]["owner_name"] == "Corsair Pilot"
