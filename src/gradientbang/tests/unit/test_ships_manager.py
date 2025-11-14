import uuid

import pytest

from core.ships_manager import ShipsManager
from ships import ShipType, get_ship_stats


@pytest.fixture()
def ships_manager(tmp_path):
    manager = ShipsManager(tmp_path)
    manager.load_all_ships()
    return manager


def test_create_ship_generates_uuid(ships_manager):
    ship_id = ships_manager.create_ship(
        ship_type=ShipType.KESTREL_COURIER.value,
        sector=3,
        owner_type="character",
        owner_id="char-123",
    )

    uuid_obj = uuid.UUID(ship_id)
    assert str(uuid_obj) == ship_id
    stored = ships_manager.get_ship(ship_id)
    assert stored is not None


def test_create_ship_initializes_from_ship_type(ships_manager):
    ship_id = ships_manager.create_ship(
        ship_type=ShipType.ATLAS_HAULER.value,
        sector=5,
        owner_type="character",
        owner_id="owner-1",
        name="Atlas",
    )

    stats = get_ship_stats(ShipType.ATLAS_HAULER)
    ship = ships_manager.get_ship(ship_id)
    assert ship["ship_type"] == ShipType.ATLAS_HAULER.value
    assert ship["name"] == "Atlas"
    assert ship["state"]["fighters"] == stats.fighters
    assert ship["state"]["shields"] == stats.shields
    assert ship["state"]["cargo_holds"] == stats.cargo_holds
    assert ship["state"]["warp_power"] == stats.warp_power_capacity


def test_update_ship_state_modifies_fields(ships_manager):
    ship_id = ships_manager.create_ship(
        ship_type=ShipType.SPARROW_SCOUT.value,
        sector=2,
        owner_type="character",
        owner_id="pilot-7",
    )

    ships_manager.update_ship_state(
        ship_id,
        fighters=150,
        shields=90,
        warp_power=50,
        cargo={"quantum_foam": 5},
        modules=["scanner"],
    )

    updated = ships_manager.get_ship(ship_id)
    assert updated["state"]["fighters"] == 150
    assert updated["state"]["shields"] == 90
    assert updated["state"]["warp_power"] == 50
    assert updated["state"]["cargo"]["quantum_foam"] == 5
    assert updated["state"]["modules"] == ["scanner"]


def test_move_ship_updates_sector(ships_manager):
    ship_id = ships_manager.create_ship(
        ship_type=ShipType.PIONEER_LIFTER.value,
        sector=1,
        owner_type="character",
        owner_id="hauler-7",
    )

    ships_manager.move_ship(ship_id, 42)
    ship = ships_manager.get_ship(ship_id)
    assert ship["sector"] == 42


def test_mark_as_unowned_sets_fields(ships_manager):
    ship_id = ships_manager.create_ship(
        ship_type=ShipType.CORSAIR_RAIDER.value,
        sector=9,
        owner_type="corporation",
        owner_id="corp-1",
    )

    ships_manager.mark_as_unowned(ship_id, "Corp One")
    ship = ships_manager.get_ship(ship_id)
    assert ship["owner_type"] == "unowned"
    assert ship["owner_id"] is None
    assert ship["former_owner_name"] == "Corp One"
    assert ship["became_unowned"] is not None


def test_list_ships_by_owner_filters_correctly(ships_manager):
    ship_a = ships_manager.create_ship(
        ship_type=ShipType.KESTREL_COURIER.value,
        sector=0,
        owner_type="character",
        owner_id="owner-a",
    )
    ship_b = ships_manager.create_ship(
        ship_type=ShipType.SPARROW_SCOUT.value,
        sector=0,
        owner_type="character",
        owner_id="owner-b",
    )
    ships_manager.create_ship(
        ship_type=ShipType.PIKE_FRIGATE.value,
        sector=4,
        owner_type="corporation",
        owner_id="corp-2",
    )

    ships = ships_manager.list_ships_by_owner("character", "owner-a")
    ship_ids = {ship["ship_id"] for ship in ships}
    assert ship_ids == {ship_a}

    ships_b = ships_manager.list_ships_by_owner("character", "owner-b")
    ship_ids_b = {ship["ship_id"] for ship in ships_b}
    assert ship_ids_b == {ship_b}


def test_list_unowned_ships_in_sector(ships_manager):
    ship_id = ships_manager.create_ship(
        ship_type=ShipType.WAYFARER_FREIGHTER.value,
        sector=11,
        owner_type="character",
        owner_id="hauler-1",
    )
    ships_manager.mark_as_unowned(ship_id, "Trader Joe")

    unowned = ships_manager.list_unowned_ships_in_sector(11)
    assert [ship["ship_id"] for ship in unowned] == [ship_id]

    assert ships_manager.list_unowned_ships_in_sector(5) == []

