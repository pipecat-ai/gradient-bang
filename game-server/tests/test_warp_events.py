from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from api import recharge_warp_power, transfer_warp_power


class DummyCharacter:
    def __init__(self, sector: int) -> None:
        self.sector = sector
        self.in_hyperspace = False
        now = datetime.now(timezone.utc)
        self.last_active = now

    def update_activity(self) -> None:
        self.last_active = datetime.now(timezone.utc)


class DummyShipConfig:
    def __init__(self, *, ship_type: str, current_warp_power: int) -> None:
        self.ship_type = ship_type
        self.current_warp_power = current_warp_power


class DummyKnowledge:
    def __init__(self, *, credits: int, ship_type: str, warp_power: int) -> None:
        self.credits = credits
        self.ship_config = DummyShipConfig(
            ship_type=ship_type,
            current_warp_power=warp_power,
        )


class DummyKnowledgeManager:
    def __init__(self, mapping: dict[str, DummyKnowledge]) -> None:
        self._mapping = mapping

    def load_knowledge(self, character_id: str) -> DummyKnowledge:
        return self._mapping[character_id]

    def save_knowledge(self, knowledge: DummyKnowledge) -> None:  # noqa: D401 - simple no-op
        """Persist updated knowledge (no-op for tests)."""
        return None


@pytest.mark.asyncio
async def test_recharge_warp_power_emits_enhanced_event(monkeypatch):
    character_id = "pilot"
    knowledge = DummyKnowledge(credits=1_000, ship_type="kestrel_courier", warp_power=50)
    world = SimpleNamespace(
        characters={character_id: DummyCharacter(sector=0)},
        knowledge_manager=DummyKnowledgeManager({character_id: knowledge}),
    )

    mock_emit = AsyncMock()
    monkeypatch.setattr(
        recharge_warp_power, "event_dispatcher", SimpleNamespace(emit=mock_emit)
    )
    monkeypatch.setattr(recharge_warp_power, "log_trade", lambda **_: None)
    monkeypatch.setattr(
        recharge_warp_power,
        "build_status_payload",
        AsyncMock(return_value={"status": "ok"}),
    )

    result = await recharge_warp_power.handle(
        {
            "character_id": character_id,
            "units": 25,
            "request_id": "req-warp-123",
        },
        world,
    )

    assert result == {"success": True}

    warp_calls = [
        call for call in mock_emit.await_args_list if call.args[0] == "warp.purchase"
    ]
    assert len(warp_calls) == 1
    _, payload = warp_calls[0].args[:2]

    assert warp_calls[0].kwargs["character_filter"] == [character_id]
    assert payload["source"]["method"] == "recharge_warp_power"
    assert payload["source"]["request_id"] == "req-warp-123"
    assert payload["new_warp_power"] == knowledge.ship_config.current_warp_power
    assert payload["warp_power_capacity"] >= payload["new_warp_power"]
    assert payload["new_credits"] == knowledge.credits
    assert payload["units"] == 25
    assert payload["total_cost"] == payload["price_per_unit"] * 25


@pytest.mark.asyncio
async def test_recharge_warp_power_returns_failure_when_full(monkeypatch):
    character_id = "pilot"
    # Set warp power to capacity to trigger failure
    knowledge = DummyKnowledge(credits=1_000, ship_type="kestrel_courier", warp_power=300)
    world = SimpleNamespace(
        characters={character_id: DummyCharacter(sector=0)},
        knowledge_manager=DummyKnowledgeManager({character_id: knowledge}),
    )

    mock_emit = AsyncMock()
    monkeypatch.setattr(
        recharge_warp_power, "event_dispatcher", SimpleNamespace(emit=mock_emit)
    )

    with pytest.raises(HTTPException) as exc:
        await recharge_warp_power.handle(
            {
                "character_id": character_id,
                "units": 10,
                "request_id": "req-max",
            },
            world,
        )

    assert exc.value.status_code == 400
    assert exc.value.detail == "Warp power is already at maximum"

    # The helper should emit an error event before raising
    mock_emit.assert_awaited_once()
    event_name, payload = mock_emit.await_args.args[:2]
    assert event_name == "error"
    assert payload["endpoint"] == "recharge_warp_power"
    assert payload["error"] == "Warp power is already at maximum"


@pytest.mark.asyncio
async def test_transfer_warp_power_emits_enhanced_event(monkeypatch):
    sender = "trader_a"
    receiver = "trader_b"
    sender_knowledge = DummyKnowledge(
        credits=0, ship_type="kestrel_courier", warp_power=120
    )
    receiver_knowledge = DummyKnowledge(
        credits=0, ship_type="kestrel_courier", warp_power=40
    )
    world = SimpleNamespace(
        characters={
            sender: DummyCharacter(sector=19),
            receiver: DummyCharacter(sector=19),
        },
        knowledge_manager=DummyKnowledgeManager(
            {
                sender: sender_knowledge,
                receiver: receiver_knowledge,
            }
        ),
    )

    mock_emit = AsyncMock()
    monkeypatch.setattr(
        transfer_warp_power, "event_dispatcher", SimpleNamespace(emit=mock_emit)
    )
    monkeypatch.setattr(
        transfer_warp_power,
        "build_status_payload",
        AsyncMock(return_value={"status": "ok"}),
    )

    result = await transfer_warp_power.handle(
        {
            "from_character_id": sender,
            "to_character_id": receiver,
            "units": 30,
            "request_id": "req-transfer-456",
        },
        world,
    )

    assert result == {"success": True}

    transfer_calls = [
        call for call in mock_emit.await_args_list if call.args[0] == "warp.transfer"
    ]
    assert len(transfer_calls) == 1
    _, payload = transfer_calls[0].args[:2]

    assert set(transfer_calls[0].kwargs["character_filter"]) == {sender, receiver}
    assert payload["source"]["method"] == "transfer_warp_power"
    assert payload["source"]["request_id"] == "req-transfer-456"
    assert payload["from_character_id"] == sender
    assert payload["to_character_id"] == receiver
    assert payload["units"] == 30
    assert payload["from_warp_power_remaining"] == sender_knowledge.ship_config.current_warp_power
    assert payload["to_warp_power_current"] == receiver_knowledge.ship_config.current_warp_power


@pytest.mark.asyncio
async def test_transfer_warp_power_returns_failure_for_capacity(monkeypatch):
    sender = "trader_a"
    receiver = "trader_b"
    sender_knowledge = DummyKnowledge(
        credits=0, ship_type="kestrel_courier", warp_power=30
    )
    receiver_knowledge = DummyKnowledge(
        credits=0, ship_type="kestrel_courier", warp_power=300
    )
    world = SimpleNamespace(
        characters={
            sender: DummyCharacter(sector=42),
            receiver: DummyCharacter(sector=42),
        },
        knowledge_manager=DummyKnowledgeManager(
            {
                sender: sender_knowledge,
                receiver: receiver_knowledge,
            }
        ),
    )

    mock_emit = AsyncMock()
    monkeypatch.setattr(
        transfer_warp_power, "event_dispatcher", SimpleNamespace(emit=mock_emit)
    )

    with pytest.raises(HTTPException) as exc:
        await transfer_warp_power.handle(
            {
                "from_character_id": sender,
                "to_character_id": receiver,
                "units": 20,
                "request_id": "req-cap",
            },
            world,
        )

    assert exc.value.status_code == 400
    assert exc.value.detail == "trader_b's warp power is already at maximum"

    mock_emit.assert_awaited_once()
    event_name, payload = mock_emit.await_args.args[:2]
    assert event_name == "error"
    assert payload["endpoint"] == "transfer_warp_power"
    assert payload["error"] == "trader_b's warp power is already at maximum"
