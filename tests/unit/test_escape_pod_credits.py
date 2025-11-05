from __future__ import annotations

import pytest

from core.ships_manager import ShipsManager
from ships import ShipType


@pytest.fixture
def ships_manager(tmp_path) -> ShipsManager:
    world_dir = tmp_path / "world-data"
    world_dir.mkdir()
    return ShipsManager(world_dir)


def _create_ship(
    ships_manager: ShipsManager,
    *,
    ship_type: ShipType,
    owner_type: str = "character",
    owner_id: str | None = "pilot",
    sector: int = 0,
) -> str:
    return ships_manager.create_ship(
        ship_type=ship_type.value,
        sector=sector,
        owner_type=owner_type,
        owner_id=owner_id,
        name=None,
    )


def test_escape_pod_initialized_with_zero_credits(ships_manager: ShipsManager):
    """Escape pods must never be provisioned with credits."""
    pod_id = _create_ship(ships_manager, ship_type=ShipType.ESCAPE_POD)
    pod = ships_manager.get_ship(pod_id)
    assert pod is not None
    assert pod["state"]["credits"] == 0


def test_escape_pod_rejects_credit_updates(ships_manager: ShipsManager):
    """Setting a non-zero balance on an escape pod raises immediately."""
    pod_id = _create_ship(ships_manager, ship_type=ShipType.ESCAPE_POD)
    with pytest.raises(ValueError, match="Escape pods cannot hold credits"):
        ships_manager.update_ship_state(pod_id, credits=25)


def test_transfer_to_escape_pod_is_blocked(ships_manager: ShipsManager):
    """Ship-to-ship transfers should prevent credits from reaching escape pods."""
    source_id = _create_ship(ships_manager, ship_type=ShipType.SPARROW_SCOUT)
    ships_manager.update_ship_state(source_id, credits=500)
    pod_id = _create_ship(ships_manager, ship_type=ShipType.ESCAPE_POD)

    with pytest.raises(ValueError, match="escape pod"):
        ships_manager.transfer_credits_between_ships(source_id, pod_id, 100)


def test_validate_ship_credits_disallows_positive_escape_pod_balance(ships_manager: ShipsManager):
    """validate_ship_credits should mirror update_ship_state restrictions."""
    pod_id = _create_ship(ships_manager, ship_type=ShipType.ESCAPE_POD)
    with pytest.raises(ValueError):
        ships_manager.validate_ship_credits(pod_id, 1)
