import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import {
  parseWarpEdges,
  normalizeMapKnowledge,
  mergeMapKnowledge,
  upsertVisitedSector,
  type MapKnowledge,
} from "./map.ts";

// ── parseWarpEdges ──────────────────────────────────────────────────────

Deno.test("parseWarpEdges: parses valid warp edges", () => {
  const result = parseWarpEdges([
    { to: 5, two_way: true, hyperlane: false },
    { to: 10, two_way: false, hyperlane: true },
  ]);
  assertEquals(result.length, 2);
  assertEquals(result[0], { to: 5, two_way: true, hyperlane: false });
  assertEquals(result[1], { to: 10, two_way: false, hyperlane: true });
});

Deno.test("parseWarpEdges: returns empty array for non-array input", () => {
  assertEquals(parseWarpEdges(null), []);
  assertEquals(parseWarpEdges(undefined), []);
  assertEquals(parseWarpEdges("string"), []);
  assertEquals(parseWarpEdges(42), []);
});

Deno.test("parseWarpEdges: filters out invalid entries", () => {
  const result = parseWarpEdges([
    { to: 5 },
    null,
    "invalid",
    { to: "not_a_number" },
    { to: 10 },
  ]);
  assertEquals(result.length, 2);
  assertEquals(result[0].to, 5);
  assertEquals(result[1].to, 10);
});

Deno.test("parseWarpEdges: defaults two_way to true and hyperlane to false", () => {
  const result = parseWarpEdges([{ to: 7 }]);
  assertEquals(result[0], { to: 7, two_way: true, hyperlane: false });
});

Deno.test("parseWarpEdges: coerces string to number for to field", () => {
  const result = parseWarpEdges([{ to: "42" }]);
  assertEquals(result.length, 1);
  assertEquals(result[0].to, 42);
});

// ── normalizeMapKnowledge ───────────────────────────────────────────────

Deno.test("normalizeMapKnowledge: null returns default empty knowledge", () => {
  const result = normalizeMapKnowledge(null);
  assertEquals(result.total_sectors_visited, 0);
  assertEquals(result.sectors_visited, {});
});

Deno.test("normalizeMapKnowledge: undefined returns default empty knowledge", () => {
  const result = normalizeMapKnowledge(undefined);
  assertEquals(result.total_sectors_visited, 0);
  assertEquals(result.sectors_visited, {});
});

Deno.test("normalizeMapKnowledge: preserves sector entries with fields", () => {
  const raw = {
    total_sectors_visited: 2,
    sectors_visited: {
      "5": {
        adjacent_sectors: [3, 7],
        last_visited: "2026-01-01T00:00:00Z",
        position: [10, 20],
      },
      "10": {
        adjacent_sectors: [5, 15],
      },
    },
  };
  const result = normalizeMapKnowledge(raw);
  assertEquals(result.total_sectors_visited, 2);
  assertEquals(result.sectors_visited["5"].adjacent_sectors, [3, 7]);
  assertEquals(result.sectors_visited["5"].last_visited, "2026-01-01T00:00:00Z");
  assertEquals(result.sectors_visited["5"].position, [10, 20]);
  assertEquals(result.sectors_visited["10"].adjacent_sectors, [5, 15]);
});

Deno.test("normalizeMapKnowledge: skips non-object sector values", () => {
  const raw = {
    sectors_visited: {
      "1": { adjacent_sectors: [2] },
      "2": "not_an_object",
      "3": null,
    },
  };
  const result = normalizeMapKnowledge(raw);
  assertEquals(Object.keys(result.sectors_visited).length, 1);
  assertEquals(result.sectors_visited["1"].adjacent_sectors, [2]);
});

Deno.test("normalizeMapKnowledge: coerces string adjacent sectors to numbers", () => {
  const raw = {
    sectors_visited: {
      "1": { adjacent_sectors: ["5", "10", "bad", 15] },
    },
  };
  const result = normalizeMapKnowledge(raw);
  assertEquals(result.sectors_visited["1"].adjacent_sectors, [5, 10, 15]);
});

Deno.test("normalizeMapKnowledge: handles total as number or string", () => {
  assertEquals(
    normalizeMapKnowledge({ total_sectors_visited: 5 }).total_sectors_visited,
    5,
  );
  assertEquals(
    normalizeMapKnowledge({ total: "3" }).total_sectors_visited,
    3,
  );
});

// ── mergeMapKnowledge ───────────────────────────────────────────────────

function makeKnowledge(
  sectors: Record<string, { last_visited?: string; position?: [number, number]; adjacent_sectors?: number[] }>,
): MapKnowledge {
  return {
    total_sectors_visited: Object.keys(sectors).length,
    sectors_visited: sectors,
  };
}

Deno.test("mergeMapKnowledge: personal-only sectors get source=player", () => {
  const personal = makeKnowledge({
    "1": { last_visited: "2026-01-01T00:00:00Z", position: [0, 0] },
    "2": { last_visited: "2026-01-02T00:00:00Z", position: [1, 0] },
  });
  const corp = makeKnowledge({});
  const result = mergeMapKnowledge(personal, corp);
  assertEquals(result.sectors_visited["1"].source, "player");
  assertEquals(result.sectors_visited["2"].source, "player");
  assertEquals(result.total_sectors_visited, 2);
});

Deno.test("mergeMapKnowledge: corp-only sectors get source=corp", () => {
  const personal = makeKnowledge({});
  const corp = makeKnowledge({
    "5": { last_visited: "2026-01-01T00:00:00Z", position: [3, 3] },
  });
  const result = mergeMapKnowledge(personal, corp);
  assertEquals(result.sectors_visited["5"].source, "corp");
  assertEquals(result.total_sectors_visited, 1);
});

Deno.test("mergeMapKnowledge: overlapping sectors get source=both", () => {
  const personal = makeKnowledge({
    "1": { last_visited: "2026-01-01T00:00:00Z", position: [0, 0] },
  });
  const corp = makeKnowledge({
    "1": { last_visited: "2026-01-02T00:00:00Z", position: [0, 0] },
  });
  const result = mergeMapKnowledge(personal, corp);
  assertEquals(result.sectors_visited["1"].source, "both");
});

Deno.test("mergeMapKnowledge: newer corp timestamp wins for overlapping entries", () => {
  const personal = makeKnowledge({
    "1": { last_visited: "2026-01-01T00:00:00Z", position: [0, 0], adjacent_sectors: [2] },
  });
  const corp = makeKnowledge({
    "1": { last_visited: "2026-02-01T00:00:00Z", position: [1, 1], adjacent_sectors: [2, 3] },
  });
  const result = mergeMapKnowledge(personal, corp);
  assertEquals(result.sectors_visited["1"].position, [1, 1]);
  assertEquals(result.sectors_visited["1"].adjacent_sectors, [2, 3]);
});

Deno.test("mergeMapKnowledge: newer personal timestamp wins for overlapping entries", () => {
  const personal = makeKnowledge({
    "1": { last_visited: "2026-03-01T00:00:00Z", position: [5, 5], adjacent_sectors: [2, 3, 4] },
  });
  const corp = makeKnowledge({
    "1": { last_visited: "2026-01-01T00:00:00Z", position: [0, 0], adjacent_sectors: [2] },
  });
  const result = mergeMapKnowledge(personal, corp);
  assertEquals(result.sectors_visited["1"].position, [5, 5]);
  assertEquals(result.sectors_visited["1"].adjacent_sectors, [2, 3, 4]);
});

Deno.test("mergeMapKnowledge: mixed personal, corp, and both", () => {
  const personal = makeKnowledge({
    "1": { last_visited: "2026-01-01T00:00:00Z" },
    "2": { last_visited: "2026-01-01T00:00:00Z" },
  });
  const corp = makeKnowledge({
    "2": { last_visited: "2026-01-01T00:00:00Z" },
    "3": { last_visited: "2026-01-01T00:00:00Z" },
  });
  const result = mergeMapKnowledge(personal, corp);
  assertEquals(result.sectors_visited["1"].source, "player");
  assertEquals(result.sectors_visited["2"].source, "both");
  assertEquals(result.sectors_visited["3"].source, "corp");
  assertEquals(result.total_sectors_visited, 3);
});

Deno.test("mergeMapKnowledge: empty inputs return empty knowledge", () => {
  const result = mergeMapKnowledge(makeKnowledge({}), makeKnowledge({}));
  assertEquals(result.total_sectors_visited, 0);
  assertEquals(result.sectors_visited, {});
});

// ── upsertVisitedSector ─────────────────────────────────────────────────

Deno.test("upsertVisitedSector: adds new sector with position and adjacency", () => {
  const knowledge = makeKnowledge({});
  const result = upsertVisitedSector(
    knowledge,
    5,
    [3, 7, 10],
    [10, 20],
    "2026-02-01T00:00:00Z",
  );
  assertEquals(result.updated, true);
  assertEquals(result.knowledge.sectors_visited["5"].adjacent_sectors, [3, 7, 10]);
  assertEquals(result.knowledge.sectors_visited["5"].position, [10, 20]);
  assertEquals(result.knowledge.sectors_visited["5"].last_visited, "2026-02-01T00:00:00Z");
  assertEquals(result.knowledge.total_sectors_visited, 1);
});

Deno.test("upsertVisitedSector: updates existing sector with new data", () => {
  const knowledge = makeKnowledge({
    "5": { adjacent_sectors: [3], position: [10, 20], last_visited: "2026-01-01T00:00:00Z" },
  });
  const result = upsertVisitedSector(
    knowledge,
    5,
    [3, 7],
    [10, 20],
    "2026-02-01T00:00:00Z",
  );
  assertEquals(result.updated, true);
  assertEquals(result.knowledge.sectors_visited["5"].adjacent_sectors, [3, 7]);
  assertEquals(result.knowledge.sectors_visited["5"].last_visited, "2026-02-01T00:00:00Z");
});

Deno.test("upsertVisitedSector: returns updated=false when nothing changed", () => {
  const knowledge = makeKnowledge({
    "5": { adjacent_sectors: [3, 7], position: [10, 20], last_visited: "2026-01-01T00:00:00Z" },
  });
  const result = upsertVisitedSector(
    knowledge,
    5,
    [3, 7],
    [10, 20],
    "2026-01-01T00:00:00Z",
  );
  assertEquals(result.updated, false);
});

Deno.test("upsertVisitedSector: updates total_sectors_visited", () => {
  const knowledge = makeKnowledge({
    "1": { adjacent_sectors: [2] },
  });
  const result = upsertVisitedSector(
    knowledge,
    2,
    [1, 3],
    [5, 5],
    "2026-02-01T00:00:00Z",
  );
  assertEquals(result.updated, true);
  assertEquals(result.knowledge.total_sectors_visited, 2);
});

Deno.test("upsertVisitedSector: detects adjacency change", () => {
  const knowledge = makeKnowledge({
    "5": { adjacent_sectors: [3, 7], last_visited: "2026-01-01T00:00:00Z" },
  });
  const result = upsertVisitedSector(
    knowledge,
    5,
    [3, 7, 10],
    [10, 20],
    "2026-01-01T00:00:00Z",
  );
  assertEquals(result.updated, true);
  assertEquals(result.knowledge.sectors_visited["5"].adjacent_sectors, [3, 7, 10]);
});
