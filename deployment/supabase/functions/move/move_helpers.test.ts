import { assertEquals } from "https://deno.land/std@0.197.0/testing/asserts.ts";

import { buildPostMoveShip } from "./move_helpers.ts";
import type { ShipRow } from "../_shared/status.ts";

function makeShip(overrides?: Partial<ShipRow>): ShipRow {
  return {
    ship_id: "ship-1",
    owner_id: "char-1",
    owner_type: "character",
    owner_character_id: "char-1",
    owner_corporation_id: null,
    acquired: "2026-01-01T00:00:00Z",
    became_unowned: null,
    former_owner_name: null,
    ship_type: "scout",
    ship_name: "The Explorer",
    current_sector: 5,
    hyperspace_destination: 10,
    hyperspace_eta: "2026-02-27T12:00:00Z",
    in_hyperspace: true,
    credits: 1000,
    cargo_qf: 10,
    cargo_ro: 20,
    cargo_ns: 5,
    current_warp_power: 50,
    current_shields: 80,
    current_fighters: 30,
    ...overrides,
  };
}

Deno.test("buildPostMoveShip: sets current_sector to destination", () => {
  const ship = makeShip({ current_sector: 5 });
  const result = buildPostMoveShip(ship, 10, 3);
  assertEquals(result.current_sector, 10);
});

Deno.test("buildPostMoveShip: deducts warp cost from current_warp_power", () => {
  const ship = makeShip({ current_warp_power: 50 });
  const result = buildPostMoveShip(ship, 10, 3);
  assertEquals(result.current_warp_power, 47);
});

Deno.test("buildPostMoveShip: clears hyperspace fields", () => {
  const ship = makeShip({
    in_hyperspace: true,
    hyperspace_destination: 10,
    hyperspace_eta: "2026-02-27T12:00:00Z",
  });
  const result = buildPostMoveShip(ship, 10, 3);
  assertEquals(result.in_hyperspace, false);
  assertEquals(result.hyperspace_destination, null);
  assertEquals(result.hyperspace_eta, null);
});

Deno.test("buildPostMoveShip: preserves other ship fields", () => {
  const ship = makeShip({
    ship_id: "ship-42",
    ship_type: "battlecruiser",
    ship_name: "War Machine",
    credits: 5000,
    cargo_qf: 15,
    cargo_ro: 25,
    cargo_ns: 10,
    current_shields: 120,
    current_fighters: 60,
    owner_type: "corporation",
    owner_corporation_id: "corp-1",
  });
  const result = buildPostMoveShip(ship, 20, 5);
  assertEquals(result.ship_id, "ship-42");
  assertEquals(result.ship_type, "battlecruiser");
  assertEquals(result.ship_name, "War Machine");
  assertEquals(result.credits, 5000);
  assertEquals(result.cargo_qf, 15);
  assertEquals(result.cargo_ro, 25);
  assertEquals(result.cargo_ns, 10);
  assertEquals(result.current_shields, 120);
  assertEquals(result.current_fighters, 60);
  assertEquals(result.owner_type, "corporation");
  assertEquals(result.owner_corporation_id, "corp-1");
});

Deno.test("buildPostMoveShip: does not mutate original ship", () => {
  const ship = makeShip({ current_sector: 5, current_warp_power: 50 });
  buildPostMoveShip(ship, 10, 3);
  assertEquals(ship.current_sector, 5);
  assertEquals(ship.current_warp_power, 50);
  assertEquals(ship.in_hyperspace, true);
});

Deno.test("buildPostMoveShip: handles zero warp cost", () => {
  const ship = makeShip({ current_warp_power: 50 });
  const result = buildPostMoveShip(ship, 10, 0);
  assertEquals(result.current_warp_power, 50);
});
