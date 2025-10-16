from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from api import combat_action
from combat.models import CombatantAction


@pytest.mark.asyncio
async def test_combat_action_emits_action_accepted(monkeypatch):
    character_id = "pilot"
    combat_id = "combat-123"

    combatant_state = SimpleNamespace(
        combatant_type="character",
        fighters=25,
        is_escape_pod=False,
    )
    encounter = SimpleNamespace(
        round_number=3,
        ended=False,
        participants={character_id: combatant_state},
    )

    manager = SimpleNamespace()
    manager.get_encounter = AsyncMock(
        side_effect=[encounter, encounter],
    )
    manager.submit_action = AsyncMock(return_value=None)

    world = SimpleNamespace(
        combat_manager=manager,
        characters={character_id: SimpleNamespace(in_hyperspace=False)},
    )

    mock_emit = AsyncMock()
    monkeypatch.setattr(combat_action, "event_dispatcher", SimpleNamespace(emit=mock_emit))

    result = await combat_action.handle(
        {
            "character_id": character_id,
            "combat_id": combat_id,
            "action": "brace",
            "request_id": "req-action-1",
        },
        world,
    )

    assert result == {"success": True, "combat_id": combat_id}

    mock_emit.assert_awaited_once()
    args, kwargs = mock_emit.await_args
    event_name, payload = args
    assert event_name == "combat.action_accepted"
    assert kwargs["character_filter"] == [character_id]

    assert payload["combat_id"] == combat_id
    assert payload["round"] == encounter.round_number
    assert payload["action"] == "brace"
    assert payload["round_resolved"] is False
    assert payload["source"]["method"] == "combat.action"
    assert payload["source"]["request_id"] == "req-action-1"


@pytest.mark.asyncio
async def test_combat_action_pay_includes_pay_status(monkeypatch):
    character_id = "payer"
    combat_id = "combat-456"

    combatant_state = SimpleNamespace(
        combatant_type="character",
        fighters=10,
        is_escape_pod=False,
    )
    encounter = SimpleNamespace(
        round_number=1,
        ended=False,
        participants={character_id: combatant_state},
    )
    updated = SimpleNamespace(
        round_number=1,
        ended=False,
        pending_actions={},
    )
    outcome = SimpleNamespace(
        effective_actions={
            character_id: SimpleNamespace(action=CombatantAction.PAY)
        }
    )

    manager = SimpleNamespace()
    manager.get_encounter = AsyncMock(
        side_effect=[encounter, updated],
    )
    manager.submit_action = AsyncMock(return_value=outcome)

    world = SimpleNamespace(
        combat_manager=manager,
        characters={character_id: SimpleNamespace(in_hyperspace=False)},
    )

    mock_emit = AsyncMock()
    monkeypatch.setattr(combat_action, "event_dispatcher", SimpleNamespace(emit=mock_emit))

    result = await combat_action.handle(
        {
            "character_id": character_id,
            "combat_id": combat_id,
            "action": "pay",
            "request_id": "req-pay-1",
        },
        world,
    )

    assert result == {"success": True, "combat_id": combat_id}

    mock_emit.assert_awaited_once()
    args, kwargs = mock_emit.await_args
    event_name, payload = args
    assert event_name == "combat.action_accepted"
    assert kwargs["character_filter"] == [character_id]
    assert payload["pay_processed"] is True
    assert "message" not in payload
    assert payload["round_resolved"] is True
