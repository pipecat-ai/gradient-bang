from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from api import trade


class DummyCharacter:
    def __init__(self, character_id: str, sector: int = 0) -> None:
        now = datetime.now(timezone.utc)
        self.id = character_id
        self.sector = sector
        self.in_hyperspace = False
        self.first_visit = now
        self.last_active = now


class DummyShipConfig:
    def __init__(self, cargo: dict[str, int] | None = None) -> None:
        self.ship_type = "kestrel_courier"
        self.ship_name = "Test Courier"
        self.cargo = cargo or {
            "quantum_foam": 0,
            "retro_organics": 0,
            "neuro_symbolics": 0,
        }
        self.current_warp_power = 20
        self.current_shields = 10
        self.current_fighters = 5


class DummyKnowledge:
    def __init__(self, credits: int, cargo: dict[str, int] | None = None) -> None:
        self.credits = credits
        self.ship_config = DummyShipConfig(cargo)


class DummyKnowledgeManager:
    def __init__(self, knowledge_map: dict[str, DummyKnowledge]) -> None:
        self._knowledge_map = knowledge_map

    def load_knowledge(self, character_id: str) -> DummyKnowledge:
        return self._knowledge_map[character_id]

    def update_credits(self, character_id: str, new_credits: int) -> None:
        self._knowledge_map[character_id].credits = new_credits

    def update_cargo(self, character_id: str, commodity: str, delta: int) -> None:
        cargo = self._knowledge_map[character_id].ship_config.cargo
        cargo[commodity] = cargo.get(commodity, 0) + delta

    def get_cargo(self, character_id: str) -> dict[str, int]:
        cargo = self._knowledge_map[character_id].ship_config.cargo
        return dict(cargo)

    def get_credits(self, character_id: str) -> int:
        return self._knowledge_map[character_id].credits


class DummyPortState:
    def __init__(self, code: str, stock: dict[str, int], max_capacity: dict[str, int]) -> None:
        self.port_class = "A"
        self.code = code
        self.stock = stock
        self.max_capacity = max_capacity


class DummyPortManager:
    def __init__(self, state: DummyPortState) -> None:
        self._state = state

    def load_port_state(self, sector: int) -> DummyPortState:
        return self._state

    def update_port_inventory(self, sector: int, commodity_key: str, quantity: int, trade_type: str) -> None:
        if trade_type == "buy":
            self._state.stock[commodity_key] -= quantity
        else:
            self._state.stock[commodity_key] += quantity


def build_world(character_id: str, *, code: str, starting_credits: int, cargo: dict[str, int] | None = None) -> SimpleNamespace:
    knowledge = DummyKnowledge(starting_credits, cargo)
    knowledge_manager = DummyKnowledgeManager({character_id: knowledge})
    port_state = DummyPortState(
        code=code,
        stock={"QF": 120, "RO": 90, "NS": 80},
        max_capacity={"QF": 200, "RO": 150, "NS": 120},
    )
    port_manager = DummyPortManager(port_state)

    return SimpleNamespace(
        characters={character_id: DummyCharacter(character_id, sector=5)},
        knowledge_manager=knowledge_manager,
        port_manager=port_manager,
        combat_manager=None,
    )


@pytest.mark.asyncio
async def test_trade_emits_enhanced_event_for_buy(monkeypatch):
    character_id = "test_trader"
    world = build_world(
        character_id,
        code="SSB",  # Port sells quantum_foam (index 0)
        starting_credits=10_000,
    )

    mock_emit = AsyncMock()
    monkeypatch.setattr(
        trade, "event_dispatcher", SimpleNamespace(emit=mock_emit)
    )
    monkeypatch.setattr(trade, "log_trade", lambda **_: None)

    result = await trade.handle(
        {
            "character_id": character_id,
            "commodity": "quantum_foam",
            "quantity": 5,
            "trade_type": "buy",
            "request_id": "req-buy-123",
        },
        world,
    )

    assert result == {"success": True}

    trade_calls = [call for call in mock_emit.await_args_list if call.args[0] == "trade.executed"]
    assert len(trade_calls) == 1
    event_name, payload = trade_calls[0].args[:2]
    assert event_name == "trade.executed"
    assert trade_calls[0].kwargs["character_filter"] == [character_id]

    assert payload["source"]["method"] == "trade"
    assert payload["source"]["request_id"] == "req-buy-123"

    trade_data = payload["trade"]
    assert trade_data["trade_type"] == "buy"
    assert trade_data["commodity"] == "quantum_foam"
    assert trade_data["units"] == 5
    assert trade_data["total_price"] == trade_data["price_per_unit"] * 5

    initial_credits = 10_000
    assert trade_data["new_credits"] == initial_credits - trade_data["total_price"]
    assert trade_data["new_cargo"]["quantum_foam"] == 5
    assert isinstance(trade_data["new_prices"], dict)


@pytest.mark.asyncio
async def test_trade_emits_enhanced_event_for_sell(monkeypatch):
    character_id = "test_seller"
    # Provide cargo so the sell transaction is valid
    world = build_world(
        character_id,
        code="BBS",  # Port buys quantum_foam (index 0)
        starting_credits=5_000,
        cargo={"quantum_foam": 10, "retro_organics": 0, "neuro_symbolics": 0},
    )

    mock_emit = AsyncMock()
    monkeypatch.setattr(
        trade, "event_dispatcher", SimpleNamespace(emit=mock_emit)
    )
    monkeypatch.setattr(trade, "log_trade", lambda **_: None)

    result = await trade.handle(
        {
            "character_id": character_id,
            "commodity": "quantum_foam",
            "quantity": 4,
            "trade_type": "sell",
            "request_id": "req-sell-456",
        },
        world,
    )

    assert result == {"success": True}

    trade_calls = [call for call in mock_emit.await_args_list if call.args[0] == "trade.executed"]
    assert len(trade_calls) == 1
    event_name, payload = trade_calls[0].args[:2]
    assert event_name == "trade.executed"
    assert trade_calls[0].kwargs["character_filter"] == [character_id]

    assert payload["source"]["request_id"] == "req-sell-456"

    trade_data = payload["trade"]
    assert trade_data["trade_type"] == "sell"
    assert trade_data["commodity"] == "quantum_foam"
    assert trade_data["units"] == 4
    assert trade_data["total_price"] == trade_data["price_per_unit"] * 4

    initial_credits = 5_000
    assert trade_data["new_credits"] == initial_credits + trade_data["total_price"]
    assert trade_data["new_cargo"]["quantum_foam"] == 6
    assert isinstance(trade_data["new_prices"], dict)
