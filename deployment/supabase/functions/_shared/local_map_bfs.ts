import type { MapKnowledge } from "./map.ts";

export interface BFSResult {
  /** sectorId → hops from center */
  distanceMap: Map<number, number>;
  /** Unvisited sectors discovered at the frontier (for fog-of-war rendering) */
  unvisitedFrontier: Set<number>;
  /** Visited sectors whose adjacency data was missing from knowledge */
  missingAdjacency: number[];
  /** Map of unvisitedSectorId → Set<visitedSectorId> that can see it */
  unvisitedSeenFrom: Map<number, Set<number>>;
}

/**
 * Run BFS entirely in-memory using map knowledge adjacency data.
 * No DB calls — the caller is responsible for fetching universe_structure
 * data for unvisited frontier sectors and any with missing adjacency.
 *
 * The BFS only traverses through VISITED sectors (sectors in knowledge).
 * Unvisited sectors are discovered but not traversed through — they form
 * the fog-of-war frontier.
 */
export function runBFS(
  centerSector: number,
  maxHops: number,
  maxSectors: number,
  knowledge: MapKnowledge,
): BFSResult {
  const visitedSet = new Set<number>(
    Object.keys(knowledge.sectors_visited).map((key) => Number(key)),
  );
  // Center sector is always treated as visited
  visitedSet.add(centerSector);

  const distanceMap = new Map<number, number>([[centerSector, 0]]);
  const explored = new Set<number>([centerSector]);
  const unvisitedFrontier = new Set<number>();
  const unvisitedSeenFrom = new Map<number, Set<number>>();
  const missingAdjacency: number[] = [];

  let frontier: number[] = [centerSector];
  let hops = 0;
  let capacityReached = false;

  while (
    frontier.length > 0 &&
    hops < maxHops &&
    distanceMap.size < maxSectors &&
    !capacityReached
  ) {
    const next: number[] = [];

    for (const sectorId of frontier) {
      const entry = knowledge.sectors_visited[String(sectorId)];
      const neighbors = entry?.adjacent_sectors;

      if (!neighbors || neighbors.length === 0) {
        // Visited sector without adjacency data in knowledge — track for DB fallback
        if (!entry?.adjacent_sectors) {
          missingAdjacency.push(sectorId);
        }
        continue;
      }

      for (const neighbor of neighbors) {
        if (!distanceMap.has(neighbor)) {
          distanceMap.set(neighbor, hops + 1);
        }

        if (!explored.has(neighbor)) {
          explored.add(neighbor);
          if (visitedSet.has(neighbor)) {
            next.push(neighbor);
          }
        }

        // Track unvisited neighbors for fog-of-war rendering
        if (!visitedSet.has(neighbor)) {
          unvisitedFrontier.add(neighbor);
          let seenFrom = unvisitedSeenFrom.get(neighbor);
          if (!seenFrom) {
            seenFrom = new Set();
            unvisitedSeenFrom.set(neighbor, seenFrom);
          }
          seenFrom.add(sectorId);
        }

        if (distanceMap.size >= maxSectors) {
          capacityReached = true;
          break;
        }
      }
      if (capacityReached) break;
    }

    frontier = next;
    hops += 1;
  }

  return { distanceMap, unvisitedFrontier, missingAdjacency, unvisitedSeenFrom };
}

/**
 * Find visited sectors within a bounding box that weren't discovered by BFS.
 * These are "disconnected" sectors — visited but not reachable from center
 * through the current visited sector graph.
 */
export function findDisconnectedSectors(
  distanceMap: Map<number, number>,
  knowledge: MapKnowledge,
): number[] {
  // Calculate bounding box from BFS results using knowledge positions
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;

  for (const [sectorId] of distanceMap) {
    const entry = knowledge.sectors_visited[String(sectorId)];
    if (entry?.position) {
      minX = Math.min(minX, entry.position[0]);
      maxX = Math.max(maxX, entry.position[0]);
      minY = Math.min(minY, entry.position[1]);
      maxY = Math.max(maxY, entry.position[1]);
    }
  }

  if (minX === Infinity) return [];

  const disconnected: number[] = [];
  for (const [sectorIdStr, entry] of Object.entries(
    knowledge.sectors_visited,
  )) {
    const sectorId = Number(sectorIdStr);
    if (distanceMap.has(sectorId)) continue;
    const pos = entry.position;
    if (
      pos &&
      pos[0] >= minX &&
      pos[0] <= maxX &&
      pos[1] >= minY &&
      pos[1] <= maxY
    ) {
      disconnected.push(sectorId);
    }
  }

  return disconnected;
}
