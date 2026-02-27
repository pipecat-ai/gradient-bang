import {
  assertEquals,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import {
  decodePortCode,
  calculatePriceSellToPlayer,
  calculatePriceBuyFromPlayer,
  getPortPrices,
  portMatchesFilters,
  buildPortResult,
  searchPorts,
  type PortRow,
  type SearchPortsParams,
} from "./port_search.ts";
import type { MapKnowledge } from "../_shared/map.ts";

// ── Helpers ────────────────────────────────────────────────────────────

function makePortRow(overrides: Partial<PortRow> & { sector_id: number }): PortRow {
  return {
    port_code: "BSS",
    port_class: 1,
    max_qf: 1000,
    max_ro: 1000,
    max_ns: 1000,
    stock_qf: 500,
    stock_ro: 500,
    stock_ns: 500,
    last_updated: "2026-02-26T00:00:00Z",
    ...overrides,
  };
}

function makeKnowledge(
  sectors: Record<string, { position?: [number, number]; adjacent_sectors?: number[]; last_visited?: string }>,
): MapKnowledge {
  return {
    total_sectors_visited: Object.keys(sectors).length,
    sectors_visited: sectors,
  };
}

function makeSearchParams(overrides: Partial<SearchPortsParams>): SearchPortsParams {
  return {
    fromSector: 1,
    maxHops: 100,
    filters: {
      portTypeFilter: null,
      commodityFilter: null,
      tradeTypeFilter: null,
      megaFilter: null,
    },
    portMap: new Map(),
    adjacencyMap: new Map(),
    knowledge: makeKnowledge({}),
    megaPortSectors: new Set(),
    shipCurrentSector: null,
    shipInHyperspace: false,
    rpcTimestamp: "2026-02-26T00:00:00Z",
    ...overrides,
  };
}

// ── decodePortCode ─────────────────────────────────────────────────────

Deno.test("decodePortCode: BSS -> buys QF, sells RO and NS", () => {
  const result = decodePortCode("BSS");
  assertEquals(result.buys, ["quantum_foam"]);
  assertEquals(result.sells, ["retro_organics", "neuro_symbolics"]);
});

Deno.test("decodePortCode: SBB -> sells QF, buys RO and NS", () => {
  const result = decodePortCode("SBB");
  assertEquals(result.buys, ["retro_organics", "neuro_symbolics"]);
  assertEquals(result.sells, ["quantum_foam"]);
});

Deno.test("decodePortCode: BBB -> buys all", () => {
  const result = decodePortCode("BBB");
  assertEquals(result.buys, ["quantum_foam", "retro_organics", "neuro_symbolics"]);
  assertEquals(result.sells, []);
});

Deno.test("decodePortCode: SSS -> sells all", () => {
  const result = decodePortCode("SSS");
  assertEquals(result.buys, []);
  assertEquals(result.sells, ["quantum_foam", "retro_organics", "neuro_symbolics"]);
});

Deno.test("decodePortCode: lowercase bss works", () => {
  const result = decodePortCode("bss");
  assertEquals(result.buys, ["quantum_foam"]);
  assertEquals(result.sells, ["retro_organics", "neuro_symbolics"]);
});

// ── Price calculations ─────────────────────────────────────────────────

Deno.test("calculatePriceSellToPlayer: full stock -> low price", () => {
  // fullness=1, scarcity=0, multiplier=SELL_MIN=0.75
  const price = calculatePriceSellToPlayer("quantum_foam", 1000, 1000);
  assertEquals(price, Math.round(25 * 0.75)); // 19
});

Deno.test("calculatePriceSellToPlayer: empty stock -> high price", () => {
  // fullness=0, scarcity=1, multiplier=SELL_MIN+(SELL_MAX-SELL_MIN)*1=SELL_MAX=1.1
  const price = calculatePriceSellToPlayer("quantum_foam", 0, 1000);
  assertEquals(price, Math.round(25 * 1.1)); // 28
});

Deno.test("calculatePriceSellToPlayer: zero capacity -> 0", () => {
  assertEquals(calculatePriceSellToPlayer("quantum_foam", 0, 0), 0);
});

Deno.test("calculatePriceBuyFromPlayer: empty stock -> high price", () => {
  // fullness=0, need=1, multiplier=BUY_MIN+(BUY_MAX-BUY_MIN)*1=BUY_MAX=1.3
  const price = calculatePriceBuyFromPlayer("retro_organics", 0, 1000);
  assertEquals(price, Math.round(10 * 1.3)); // 13
});

Deno.test("calculatePriceBuyFromPlayer: full stock -> low price", () => {
  // fullness=1, need=0, multiplier=BUY_MIN=0.9
  const price = calculatePriceBuyFromPlayer("retro_organics", 1000, 1000);
  assertEquals(price, Math.round(10 * 0.9)); // 9
});

Deno.test("calculatePriceBuyFromPlayer: zero capacity -> 0", () => {
  assertEquals(calculatePriceBuyFromPlayer("retro_organics", 0, 0), 0);
});

// ── getPortPrices ──────────────────────────────────────────────────────

Deno.test("getPortPrices: BSS port - sells QF (null), buys RO and NS", () => {
  // BSS = Buy QF, Sell RO, Sell NS
  // "Buy" means port buys from player -> calculatePriceBuyFromPlayer for QF
  // "Sell" means port sells to player -> calculatePriceSellToPlayer for RO, NS
  const prices = getPortPrices("BSS", 500, 500, 500, 1000, 1000, 1000);

  // QF: port buys (B), so it's a buy price
  assertEquals(typeof prices.quantum_foam, "number");
  // RO: port sells (S), so it's a sell price
  assertEquals(typeof prices.retro_organics, "number");
  // NS: port sells (S), so it's a sell price
  assertEquals(typeof prices.neuro_symbolics, "number");
});

Deno.test("getPortPrices: SSS port - all commodities have sell prices", () => {
  const prices = getPortPrices("SSS", 500, 500, 500, 1000, 1000, 1000);
  // All sell prices should be non-null
  assertEquals(typeof prices.quantum_foam, "number");
  assertEquals(typeof prices.retro_organics, "number");
  assertEquals(typeof prices.neuro_symbolics, "number");
});

Deno.test("getPortPrices: buy price null when stock equals max capacity", () => {
  // BSS port: B for QF means port buys QF
  // When stock_qf == max_qf, the buy condition requires stock < maxCap, so null
  const prices = getPortPrices("BSS", 1000, 500, 500, 1000, 1000, 1000);
  assertEquals(prices.quantum_foam, null);
});

// ── portMatchesFilters ─────────────────────────────────────────────────

Deno.test("portMatchesFilters: no filters -> matches", () => {
  const row = makePortRow({ sector_id: 1, port_code: "BSS" });
  assertEquals(portMatchesFilters(row, null, null, null, null, false), true);
});

Deno.test("portMatchesFilters: port type filter match", () => {
  const row = makePortRow({ sector_id: 1, port_code: "BSS" });
  assertEquals(portMatchesFilters(row, "BSS", null, null, null, false), true);
});

Deno.test("portMatchesFilters: port type filter mismatch", () => {
  const row = makePortRow({ sector_id: 1, port_code: "BSS" });
  assertEquals(portMatchesFilters(row, "SBB", null, null, null, false), false);
});

Deno.test("portMatchesFilters: mega filter true matches mega port", () => {
  const row = makePortRow({ sector_id: 1 });
  assertEquals(portMatchesFilters(row, null, null, null, true, true), true);
});

Deno.test("portMatchesFilters: mega filter true rejects non-mega", () => {
  const row = makePortRow({ sector_id: 1 });
  assertEquals(portMatchesFilters(row, null, null, null, true, false), false);
});

Deno.test("portMatchesFilters: mega filter false rejects mega", () => {
  const row = makePortRow({ sector_id: 1 });
  assertEquals(portMatchesFilters(row, null, null, null, false, true), false);
});

Deno.test("portMatchesFilters: commodity+trade_type buy matches S in code", () => {
  // "buy" trade_type means player wants to buy, so port must sell (S)
  const row = makePortRow({ sector_id: 1, port_code: "BSS" });
  // retro_organics is index 1, code char is 'S' -> match for buy
  assertEquals(portMatchesFilters(row, null, "retro_organics", "buy", null, false), true);
});

Deno.test("portMatchesFilters: commodity+trade_type buy rejects B in code", () => {
  const row = makePortRow({ sector_id: 1, port_code: "BSS" });
  // quantum_foam is index 0, code char is 'B' -> no match for buy
  assertEquals(portMatchesFilters(row, null, "quantum_foam", "buy", null, false), false);
});

Deno.test("portMatchesFilters: commodity+trade_type sell matches B in code", () => {
  // "sell" trade_type means player wants to sell, so port must buy (B)
  const row = makePortRow({ sector_id: 1, port_code: "BSS" });
  // quantum_foam is index 0, code char is 'B' -> match for sell
  assertEquals(portMatchesFilters(row, null, "quantum_foam", "sell", null, false), true);
});

// ── buildPortResult ────────────────────────────────────────────────────

Deno.test("buildPortResult: includes correct structure", () => {
  const row = makePortRow({ sector_id: 5 });
  const result = buildPortResult(
    { sector: 5, hops: 3 },
    3,
    row,
    { position: [10, 20], last_visited: "2026-01-01T00:00:00Z" },
    false,
    "2026-02-26T00:00:00Z",
    false,
  );

  assertEquals(result.sector.id, 5);
  assertEquals(result.sector.position, [10, 20]);
  assertEquals(result.hops_from_start, 3);
  assertEquals(result.last_visited, "2026-01-01T00:00:00Z");
  assertEquals(result.sector.port.code, "BSS");
  assertEquals(result.sector.port.mega, false);
  assertEquals(result.updated_at, "2026-02-26T00:00:00Z");
  // observed_at should be last_updated when not in sector
  assertEquals(result.sector.port.observed_at, "2026-02-26T00:00:00Z");
});

Deno.test("buildPortResult: in sector sets observed_at to null", () => {
  const row = makePortRow({ sector_id: 5 });
  const result = buildPortResult(
    { sector: 5, hops: 0 },
    0,
    row,
    { position: [10, 20] },
    true, // inSector
    "2026-02-26T00:00:00Z",
    false,
  );
  assertEquals(result.sector.port.observed_at, null);
});

Deno.test("buildPortResult: missing knowledge entry defaults position to [0,0]", () => {
  const row = makePortRow({ sector_id: 5 });
  const result = buildPortResult(
    { sector: 5, hops: 0 },
    0,
    row,
    undefined,
    false,
    "2026-02-26T00:00:00Z",
    false,
  );
  assertEquals(result.sector.position, [0, 0]);
});

// ── searchPorts BFS ────────────────────────────────────────────────────

Deno.test("searchPorts: linear chain returns correct hop distances", () => {
  // Graph: 1 -- 2 -- 3 -- 4
  // Ports at sectors 1 and 3
  const adjacencyMap = new Map([
    [1, [2]],
    [2, [1, 3]],
    [3, [2, 4]],
    [4, [3]],
  ]);
  const portMap = new Map([
    [1, makePortRow({ sector_id: 1 })],
    [3, makePortRow({ sector_id: 3 })],
  ]);
  const knowledge = makeKnowledge({
    "1": { position: [0, 0] },
    "2": { position: [1, 0] },
    "3": { position: [2, 0] },
    "4": { position: [3, 0] },
  });

  const { results, sectorsSearched } = searchPorts(makeSearchParams({
    fromSector: 1,
    portMap,
    adjacencyMap,
    knowledge,
  }));

  assertEquals(results.length, 2);
  assertEquals(results[0].sector.id, 1);
  assertEquals(results[0].hops_from_start, 0);
  assertEquals(results[1].sector.id, 3);
  assertEquals(results[1].hops_from_start, 2);
  assertEquals(sectorsSearched, 4);
});

Deno.test("searchPorts: max_hops=0 returns only starting sector port", () => {
  const adjacencyMap = new Map([
    [1, [2]],
    [2, [1, 3]],
    [3, [2]],
  ]);
  const portMap = new Map([
    [1, makePortRow({ sector_id: 1 })],
    [3, makePortRow({ sector_id: 3 })],
  ]);
  const knowledge = makeKnowledge({
    "1": { position: [0, 0] },
    "2": { position: [1, 0] },
    "3": { position: [2, 0] },
  });

  const { results } = searchPorts(makeSearchParams({
    fromSector: 1,
    maxHops: 0,
    portMap,
    adjacencyMap,
    knowledge,
  }));

  assertEquals(results.length, 1);
  assertEquals(results[0].sector.id, 1);
  assertEquals(results[0].hops_from_start, 0);
});

Deno.test("searchPorts: max_hops limits reach", () => {
  // Graph: 1 -- 2 -- 3, ports at 1 and 3
  // max_hops=1: visits 1 (hop 0) and 2 (hop 1), but 2 has no port
  const adjacencyMap = new Map([
    [1, [2]],
    [2, [1, 3]],
    [3, [2]],
  ]);
  const portMap = new Map([
    [1, makePortRow({ sector_id: 1 })],
    [3, makePortRow({ sector_id: 3 })],
  ]);
  const knowledge = makeKnowledge({
    "1": { position: [0, 0] },
    "2": { position: [1, 0] },
    "3": { position: [2, 0] },
  });

  const { results } = searchPorts(makeSearchParams({
    fromSector: 1,
    maxHops: 1,
    portMap,
    adjacencyMap,
    knowledge,
  }));

  assertEquals(results.length, 1);
  assertEquals(results[0].sector.id, 1);
});

Deno.test("searchPorts: branching graph finds all reachable ports", () => {
  // Graph: 1--2--3, 2--5--6. Ports at 1, 3, 5, 6
  const adjacencyMap = new Map([
    [1, [2]],
    [2, [1, 3, 5]],
    [3, [2]],
    [5, [2, 6]],
    [6, [5]],
  ]);
  const portMap = new Map([
    [1, makePortRow({ sector_id: 1 })],
    [3, makePortRow({ sector_id: 3 })],
    [5, makePortRow({ sector_id: 5 })],
    [6, makePortRow({ sector_id: 6 })],
  ]);
  const knowledge = makeKnowledge({
    "1": { position: [0, 0] },
    "2": { position: [1, 0] },
    "3": { position: [2, 0] },
    "5": { position: [1, 1] },
    "6": { position: [2, 1] },
  });

  const { results } = searchPorts(makeSearchParams({
    fromSector: 2,
    portMap,
    adjacencyMap,
    knowledge,
  }));

  assertEquals(results.length, 4);
  // Hop 1: sectors 1, 3, 5 (sorted by id)
  assertEquals(results[0].sector.id, 1);
  assertEquals(results[0].hops_from_start, 1);
  assertEquals(results[1].sector.id, 3);
  assertEquals(results[1].hops_from_start, 1);
  assertEquals(results[2].sector.id, 5);
  assertEquals(results[2].hops_from_start, 1);
  // Hop 2: sector 6
  assertEquals(results[3].sector.id, 6);
  assertEquals(results[3].hops_from_start, 2);
});

Deno.test("searchPorts: sector without adjacency data stops expansion", () => {
  // Graph: 1--2--3, but sector 2 has no adjacency entry
  const adjacencyMap = new Map([
    [1, [2]],
    // sector 2 missing from adjacencyMap
    [3, [2]],
  ]);
  const portMap = new Map([
    [1, makePortRow({ sector_id: 1 })],
    [3, makePortRow({ sector_id: 3 })],
  ]);
  const knowledge = makeKnowledge({
    "1": { position: [0, 0] },
    "2": { position: [1, 0] },
    "3": { position: [2, 0] },
  });

  const { results } = searchPorts(makeSearchParams({
    fromSector: 1,
    portMap,
    adjacencyMap,
    knowledge,
  }));

  // BFS reaches sector 2 (neighbor of 1), but 2 has no adjacency -> can't reach 3
  assertEquals(results.length, 1);
  assertEquals(results[0].sector.id, 1);
});

Deno.test("searchPorts: port type filter applied during search", () => {
  const adjacencyMap = new Map([
    [1, [2]],
    [2, [1, 3]],
    [3, [2]],
  ]);
  const portMap = new Map([
    [1, makePortRow({ sector_id: 1, port_code: "BSS" })],
    [3, makePortRow({ sector_id: 3, port_code: "SSB" })],
  ]);
  const knowledge = makeKnowledge({
    "1": { position: [0, 0] },
    "2": { position: [1, 0] },
    "3": { position: [2, 0] },
  });

  const { results } = searchPorts(makeSearchParams({
    fromSector: 1,
    portMap,
    adjacencyMap,
    knowledge,
    filters: {
      portTypeFilter: "BSS",
      commodityFilter: null,
      tradeTypeFilter: null,
      megaFilter: null,
    },
  }));

  assertEquals(results.length, 1);
  assertEquals(results[0].sector.id, 1);
});

Deno.test("searchPorts: mega port filtering", () => {
  const adjacencyMap = new Map([
    [1, [2]],
    [2, [1]],
  ]);
  const portMap = new Map([
    [1, makePortRow({ sector_id: 1 })],
    [2, makePortRow({ sector_id: 2 })],
  ]);
  const knowledge = makeKnowledge({
    "1": { position: [0, 0] },
    "2": { position: [1, 0] },
  });

  const { results } = searchPorts(makeSearchParams({
    fromSector: 1,
    portMap,
    adjacencyMap,
    knowledge,
    megaPortSectors: new Set([2]),
    filters: {
      portTypeFilter: null,
      commodityFilter: null,
      tradeTypeFilter: null,
      megaFilter: true,
    },
  }));

  assertEquals(results.length, 1);
  assertEquals(results[0].sector.id, 2);
});

Deno.test("searchPorts: results sorted by hops then sector id", () => {
  // Graph: 1--2, 1--3, ports at 2 and 3
  const adjacencyMap = new Map([
    [1, [3, 2]], // intentionally out of order
    [2, [1]],
    [3, [1]],
  ]);
  const portMap = new Map([
    [2, makePortRow({ sector_id: 2 })],
    [3, makePortRow({ sector_id: 3 })],
  ]);
  const knowledge = makeKnowledge({
    "1": { position: [0, 0] },
    "2": { position: [1, 0] },
    "3": { position: [0, 1] },
  });

  const { results } = searchPorts(makeSearchParams({
    fromSector: 1,
    portMap,
    adjacencyMap,
    knowledge,
  }));

  assertEquals(results.length, 2);
  // Both at hops=1, sorted by sector_id
  assertEquals(results[0].sector.id, 2);
  assertEquals(results[1].sector.id, 3);
});

Deno.test("searchPorts: empty port map returns empty results", () => {
  const adjacencyMap = new Map([
    [1, [2]],
    [2, [1, 3]],
    [3, [2]],
  ]);
  const knowledge = makeKnowledge({
    "1": { position: [0, 0] },
    "2": { position: [1, 0] },
    "3": { position: [2, 0] },
  });

  const { results, sectorsSearched } = searchPorts(makeSearchParams({
    fromSector: 1,
    portMap: new Map(),
    adjacencyMap,
    knowledge,
  }));

  assertEquals(results.length, 0);
  assertEquals(sectorsSearched, 3);
});

Deno.test("searchPorts: ship in sector sets observed_at to null", () => {
  const portMap = new Map([
    [1, makePortRow({ sector_id: 1 })],
  ]);
  const knowledge = makeKnowledge({
    "1": { position: [5, 10] },
  });

  const { results } = searchPorts(makeSearchParams({
    fromSector: 1,
    maxHops: 0,
    portMap,
    adjacencyMap: new Map([[1, []]]),
    knowledge,
    shipCurrentSector: 1,
    shipInHyperspace: false,
  }));

  assertEquals(results.length, 1);
  assertEquals(results[0].sector.port.observed_at, null);
});

Deno.test("searchPorts: ship in hyperspace does not count as in sector", () => {
  const portMap = new Map([
    [1, makePortRow({ sector_id: 1 })],
  ]);
  const knowledge = makeKnowledge({
    "1": { position: [5, 10] },
  });

  const { results } = searchPorts(makeSearchParams({
    fromSector: 1,
    maxHops: 0,
    portMap,
    adjacencyMap: new Map([[1, []]]),
    knowledge,
    shipCurrentSector: 1,
    shipInHyperspace: true,
  }));

  assertEquals(results.length, 1);
  // Should NOT be null because ship is in hyperspace
  assertEquals(results[0].sector.port.observed_at, "2026-02-26T00:00:00Z");
});
