import {
  assertEquals,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import {
  resolvePlayerType,
  buildPlayerSnapshot,
  buildShipSnapshot,
  type CharacterRow,
  type ShipRow,
  type ShipDefinitionRow,
} from "./status.ts";
import type { MapKnowledge } from "./map.ts";

// ── Helpers ────────────────────────────────────────────────────────────

function makeCharacter(overrides?: Partial<CharacterRow>): CharacterRow {
  return {
    character_id: "char-1",
    name: "TestPlayer",
    current_ship_id: "ship-1",
    credits_in_megabank: 5000,
    map_knowledge: {},
    player_metadata: null,
    first_visit: "2026-01-01T00:00:00Z",
    last_active: "2026-02-26T12:00:00Z",
    corporation_id: null,
    corporation_joined_at: null,
    ...overrides,
  };
}

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
    hyperspace_destination: null,
    hyperspace_eta: null,
    in_hyperspace: false,
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

function makeDefinition(overrides?: Partial<ShipDefinitionRow>): ShipDefinitionRow {
  return {
    ship_type: "scout",
    display_name: "Scout Ship",
    cargo_holds: 100,
    warp_power_capacity: 100,
    turns_per_warp: 3,
    shields: 100,
    fighters: 50,
    purchase_price: 5000,
    ...overrides,
  };
}

function makeKnowledge(
  sectors: Record<string, { source?: "player" | "corp" | "both"; position?: [number, number] }>,
): MapKnowledge {
  return {
    total_sectors_visited: Object.keys(sectors).length,
    sectors_visited: sectors,
  };
}

// ── resolvePlayerType ──────────────────────────────────────────────────

Deno.test("resolvePlayerType: returns player_type from metadata", () => {
  assertEquals(resolvePlayerType({ player_type: "npc_trader" }), "npc_trader");
});

Deno.test("resolvePlayerType: returns human when metadata is null", () => {
  assertEquals(resolvePlayerType(null), "human");
});

Deno.test("resolvePlayerType: returns human when metadata is empty", () => {
  assertEquals(resolvePlayerType({}), "human");
});

Deno.test("resolvePlayerType: returns human when player_type is empty string", () => {
  assertEquals(resolvePlayerType({ player_type: "" }), "human");
});

Deno.test("resolvePlayerType: returns human when player_type is whitespace", () => {
  assertEquals(resolvePlayerType({ player_type: "  " }), "human");
});

Deno.test("resolvePlayerType: returns human when player_type is non-string", () => {
  assertEquals(resolvePlayerType({ player_type: 42 }), "human");
});

// ── buildPlayerSnapshot ────────────────────────────────────────────────

Deno.test("buildPlayerSnapshot: counts player-source sectors", () => {
  const character = makeCharacter();
  const knowledge = makeKnowledge({
    "1": { source: "player" },
    "2": { source: "player" },
    "3": { source: "player" },
  });
  const result = buildPlayerSnapshot(character, "human", knowledge, 1000);
  assertEquals(result.sectors_visited, 3);
  assertEquals(result.corp_sectors_visited, null);
  assertEquals(result.total_sectors_known, 3);
});

Deno.test("buildPlayerSnapshot: counts corp and both sources correctly", () => {
  const character = makeCharacter();
  const knowledge = makeKnowledge({
    "1": { source: "player" },
    "2": { source: "corp" },
    "3": { source: "both" },
  });
  const result = buildPlayerSnapshot(character, "human", knowledge, 1000);
  // player sources: "player" (1) + "both" (3) = 2
  assertEquals(result.sectors_visited, 2);
  // corp sources: "corp" (2) + "both" (3) = 2
  assertEquals(result.corp_sectors_visited, 2);
  // total known: all 3 unique sectors
  assertEquals(result.total_sectors_known, 3);
});

Deno.test("buildPlayerSnapshot: corp_sectors_visited null when no corp knowledge", () => {
  const character = makeCharacter();
  const knowledge = makeKnowledge({
    "1": { source: "player" },
    "2": { source: "player" },
  });
  const result = buildPlayerSnapshot(character, "human", knowledge, 1000);
  assertEquals(result.corp_sectors_visited, null);
});

Deno.test("buildPlayerSnapshot: passes through character fields", () => {
  const character = makeCharacter({
    character_id: "abc-123",
    name: "SpaceTrader",
    credits_in_megabank: 9999,
    first_visit: "2026-01-15T00:00:00Z",
    last_active: "2026-02-26T18:00:00Z",
  });
  const knowledge = makeKnowledge({});
  const result = buildPlayerSnapshot(character, "npc", knowledge, 500);
  assertEquals(result.id, "abc-123");
  assertEquals(result.name, "SpaceTrader");
  assertEquals(result.player_type, "npc");
  assertEquals(result.credits_in_bank, 9999);
  assertEquals(result.universe_size, 500);
  assertEquals(result.created_at, "2026-01-15T00:00:00Z");
  assertEquals(result.last_active, "2026-02-26T18:00:00Z");
});

Deno.test("buildPlayerSnapshot: empty knowledge returns zero counts", () => {
  const character = makeCharacter();
  const knowledge = makeKnowledge({});
  const result = buildPlayerSnapshot(character, "human", knowledge, 1000);
  assertEquals(result.sectors_visited, 0);
  assertEquals(result.corp_sectors_visited, null);
  assertEquals(result.total_sectors_known, 0);
});

// ── buildShipSnapshot ──────────────────────────────────────────────────

Deno.test("buildShipSnapshot: calculates cargo correctly", () => {
  const ship = makeShip({ cargo_qf: 10, cargo_ro: 20, cargo_ns: 5 });
  const def = makeDefinition({ cargo_holds: 100 });
  const result = buildShipSnapshot(ship, def);
  assertEquals((result.cargo as Record<string, number>).quantum_foam, 10);
  assertEquals((result.cargo as Record<string, number>).retro_organics, 20);
  assertEquals((result.cargo as Record<string, number>).neuro_symbolics, 5);
  assertEquals(result.cargo_capacity, 100);
  assertEquals(result.empty_holds, 65); // 100 - 35
});

Deno.test("buildShipSnapshot: empty_holds never goes negative", () => {
  const ship = makeShip({ cargo_qf: 50, cargo_ro: 50, cargo_ns: 50 });
  const def = makeDefinition({ cargo_holds: 100 });
  const result = buildShipSnapshot(ship, def);
  assertEquals(result.empty_holds, 0); // max(100 - 150, 0) = 0
});

Deno.test("buildShipSnapshot: uses ship_name when present", () => {
  const ship = makeShip({ ship_name: "My Ship" });
  const def = makeDefinition({ display_name: "Default Name" });
  const result = buildShipSnapshot(ship, def);
  assertEquals(result.ship_name, "My Ship");
});

Deno.test("buildShipSnapshot: falls back to display_name when ship_name is null", () => {
  const ship = makeShip({ ship_name: null });
  const def = makeDefinition({ display_name: "Scout Ship" });
  const result = buildShipSnapshot(ship, def);
  assertEquals(result.ship_name, "Scout Ship");
});

Deno.test("buildShipSnapshot: passes through ship identifiers", () => {
  const ship = makeShip({ ship_id: "ship-42", ship_type: "battlecruiser" });
  const def = makeDefinition();
  const result = buildShipSnapshot(ship, def);
  assertEquals(result.ship_id, "ship-42");
  assertEquals(result.ship_type, "battlecruiser");
});

Deno.test("buildShipSnapshot: uses definition defaults for capacity fields", () => {
  const def = makeDefinition({
    warp_power_capacity: 200,
    turns_per_warp: 5,
    shields: 150,
    fighters: 75,
  });
  const ship = makeShip({
    current_warp_power: 180,
    current_shields: 120,
    current_fighters: 60,
  });
  const result = buildShipSnapshot(ship, def);
  assertEquals(result.warp_power, 180);
  assertEquals(result.warp_power_capacity, 200);
  assertEquals(result.turns_per_warp, 5);
  assertEquals(result.shields, 120);
  assertEquals(result.max_shields, 150);
  assertEquals(result.fighters, 60);
  assertEquals(result.max_fighters, 75);
});

Deno.test("buildShipSnapshot: credits from ship", () => {
  const ship = makeShip({ credits: 42000 });
  const def = makeDefinition();
  const result = buildShipSnapshot(ship, def);
  assertEquals(result.credits, 42000);
});
