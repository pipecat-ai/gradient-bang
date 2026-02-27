import { assertEquals } from "https://deno.land/std@0.197.0/testing/asserts.ts";

import { runBFS, findDisconnectedSectors } from "./local_map_bfs.ts";
import type { MapKnowledge } from "./map.ts";

function makeKnowledge(
  sectors: Record<
    string,
    { adjacent_sectors?: number[]; position?: [number, number] }
  >,
): MapKnowledge {
  const sectors_visited: Record<string, Record<string, unknown>> = {};
  for (const [id, data] of Object.entries(sectors)) {
    sectors_visited[id] = { ...data };
  }
  return {
    total_sectors_visited: Object.keys(sectors).length,
    sectors_visited,
    current_sector: Number(Object.keys(sectors)[0] ?? 0),
    last_update: "2026-01-01T00:00:00Z",
  };
}

// ============================================================================
// runBFS tests
// ============================================================================

Deno.test("runBFS: center sector only (maxHops=0)", () => {
  const knowledge = makeKnowledge({
    "1": { adjacent_sectors: [2, 3], position: [0, 0] },
  });
  const result = runBFS(1, 0, 100, knowledge);
  assertEquals(result.distanceMap.size, 1);
  assertEquals(result.distanceMap.get(1), 0);
  assertEquals(result.unvisitedFrontier.size, 0);
});

Deno.test("runBFS: linear chain with correct hop distances", () => {
  const knowledge = makeKnowledge({
    "1": { adjacent_sectors: [2], position: [0, 0] },
    "2": { adjacent_sectors: [1, 3], position: [1, 0] },
    "3": { adjacent_sectors: [2, 4], position: [2, 0] },
    "4": { adjacent_sectors: [3], position: [3, 0] },
  });
  const result = runBFS(1, 10, 100, knowledge);
  assertEquals(result.distanceMap.get(1), 0);
  assertEquals(result.distanceMap.get(2), 1);
  assertEquals(result.distanceMap.get(3), 2);
  assertEquals(result.distanceMap.get(4), 3);
});

Deno.test("runBFS: unvisited sectors in frontier but not traversed", () => {
  // 1 → 2 → 3, but sector 2 is NOT visited
  const knowledge = makeKnowledge({
    "1": { adjacent_sectors: [2], position: [0, 0] },
    "3": { adjacent_sectors: [2], position: [2, 0] },
  });
  const result = runBFS(1, 10, 100, knowledge);
  // Sector 2 is discovered (adjacent to 1) but not traversed (not visited)
  assertEquals(result.distanceMap.has(2), true);
  assertEquals(result.distanceMap.get(2), 1);
  // Sector 3 is NOT discovered because BFS can't traverse through unvisited sector 2
  assertEquals(result.distanceMap.has(3), false);
  // Sector 2 is in unvisited frontier
  assertEquals(result.unvisitedFrontier.has(2), true);
  // Sector 2 was seen from sector 1
  assertEquals(result.unvisitedSeenFrom.get(2)?.has(1), true);
});

Deno.test("runBFS: branching graph with visited/unvisited mix", () => {
  //   2(visited)
  //  /
  // 1 - 3(unvisited)
  //  \
  //   4(visited) → 5(visited)
  const knowledge = makeKnowledge({
    "1": { adjacent_sectors: [2, 3, 4], position: [0, 0] },
    "2": { adjacent_sectors: [1], position: [0, 1] },
    "4": { adjacent_sectors: [1, 5], position: [1, 0] },
    "5": { adjacent_sectors: [4], position: [2, 0] },
  });
  const result = runBFS(1, 10, 100, knowledge);
  assertEquals(result.distanceMap.get(1), 0);
  assertEquals(result.distanceMap.get(2), 1);
  assertEquals(result.distanceMap.get(3), 1); // discovered but unvisited
  assertEquals(result.distanceMap.get(4), 1);
  assertEquals(result.distanceMap.get(5), 2);
  assertEquals(result.unvisitedFrontier.has(3), true);
  assertEquals(result.unvisitedFrontier.has(2), false); // visited, not in frontier
});

Deno.test("runBFS: maxSectors cap is respected", () => {
  const knowledge = makeKnowledge({
    "1": { adjacent_sectors: [2, 3, 4, 5], position: [0, 0] },
    "2": { adjacent_sectors: [1], position: [1, 0] },
    "3": { adjacent_sectors: [1], position: [0, 1] },
    "4": { adjacent_sectors: [1], position: [-1, 0] },
    "5": { adjacent_sectors: [1], position: [0, -1] },
  });
  const result = runBFS(1, 10, 3, knowledge);
  // Center (1) + at most 2 more = 3 total
  assertEquals(result.distanceMap.size, 3);
  assertEquals(result.distanceMap.has(1), true);
});

Deno.test("runBFS: maxHops limits traversal depth", () => {
  const knowledge = makeKnowledge({
    "1": { adjacent_sectors: [2], position: [0, 0] },
    "2": { adjacent_sectors: [1, 3], position: [1, 0] },
    "3": { adjacent_sectors: [2, 4], position: [2, 0] },
    "4": { adjacent_sectors: [3], position: [3, 0] },
  });
  const result = runBFS(1, 2, 100, knowledge);
  assertEquals(result.distanceMap.has(1), true); // hop 0
  assertEquals(result.distanceMap.has(2), true); // hop 1
  assertEquals(result.distanceMap.has(3), true); // hop 2
  assertEquals(result.distanceMap.has(4), false); // hop 3 — beyond limit
});

Deno.test("runBFS: missing adjacency data is tracked", () => {
  const knowledge = makeKnowledge({
    "1": { adjacent_sectors: [2], position: [0, 0] },
    "2": { position: [1, 0] }, // no adjacent_sectors
  });
  const result = runBFS(1, 10, 100, knowledge);
  assertEquals(result.distanceMap.has(1), true);
  assertEquals(result.distanceMap.has(2), true);
  // Sector 2 is visited but has no adjacency data
  assertEquals(result.missingAdjacency.includes(2), true);
});

Deno.test("runBFS: unvisitedSeenFrom tracks correctly", () => {
  // Sectors 1 and 3 are visited, sector 2 is unvisited
  // Both 1 and 3 can see sector 2
  const knowledge = makeKnowledge({
    "1": { adjacent_sectors: [2, 3], position: [0, 0] },
    "3": { adjacent_sectors: [1, 2], position: [2, 0] },
  });
  const result = runBFS(1, 10, 100, knowledge);
  const seenFrom = result.unvisitedSeenFrom.get(2);
  assertEquals(seenFrom?.has(1), true);
  assertEquals(seenFrom?.has(3), true);
});

Deno.test("runBFS: center not in knowledge is treated as visited", () => {
  // Center sector 1 is not in knowledge.sectors_visited but should still work
  const knowledge: MapKnowledge = {
    total_sectors_visited: 0,
    sectors_visited: {},
    current_sector: 1,
    last_update: "2026-01-01T00:00:00Z",
  };
  const result = runBFS(1, 10, 100, knowledge);
  assertEquals(result.distanceMap.size, 1);
  assertEquals(result.distanceMap.get(1), 0);
  // Center has no adjacency data → tracked as missing
  assertEquals(result.missingAdjacency.includes(1), true);
});

Deno.test("runBFS: empty adjacent_sectors array stops traversal", () => {
  const knowledge = makeKnowledge({
    "1": { adjacent_sectors: [], position: [0, 0] },
  });
  const result = runBFS(1, 10, 100, knowledge);
  assertEquals(result.distanceMap.size, 1);
  assertEquals(result.missingAdjacency.length, 0);
});

// ============================================================================
// findDisconnectedSectors tests
// ============================================================================

Deno.test("findDisconnectedSectors: finds sectors in bbox not in distanceMap", () => {
  const distanceMap = new Map<number, number>([[1, 0], [2, 1]]);
  const knowledge = makeKnowledge({
    "1": { adjacent_sectors: [2], position: [0, 0] },
    "2": { adjacent_sectors: [1], position: [2, 0] },
    "3": { adjacent_sectors: [], position: [1, 0] }, // within bbox but not in distanceMap
  });
  const disconnected = findDisconnectedSectors(distanceMap, knowledge);
  assertEquals(disconnected.includes(3), true);
});

Deno.test("findDisconnectedSectors: excludes sectors outside bbox", () => {
  const distanceMap = new Map<number, number>([[1, 0], [2, 1]]);
  const knowledge = makeKnowledge({
    "1": { adjacent_sectors: [2], position: [0, 0] },
    "2": { adjacent_sectors: [1], position: [2, 0] },
    "3": { adjacent_sectors: [], position: [100, 100] }, // outside bbox
  });
  const disconnected = findDisconnectedSectors(distanceMap, knowledge);
  assertEquals(disconnected.length, 0);
});

Deno.test("findDisconnectedSectors: returns empty when no knowledge positions", () => {
  const distanceMap = new Map<number, number>([[1, 0]]);
  const knowledge = makeKnowledge({
    "1": { adjacent_sectors: [] },
  });
  const disconnected = findDisconnectedSectors(distanceMap, knowledge);
  assertEquals(disconnected.length, 0);
});

Deno.test("findDisconnectedSectors: sectors already in distanceMap are excluded", () => {
  const distanceMap = new Map<number, number>([[1, 0], [2, 1], [3, 2]]);
  const knowledge = makeKnowledge({
    "1": { adjacent_sectors: [2], position: [0, 0] },
    "2": { adjacent_sectors: [1, 3], position: [1, 0] },
    "3": { adjacent_sectors: [2], position: [2, 0] },
  });
  const disconnected = findDisconnectedSectors(distanceMap, knowledge);
  assertEquals(disconnected.length, 0);
});
