import {
  COVERAGE_PADDING_WORLD,
  DEFAULT_MAX_BOUNDS,
  FETCH_BOUNDS_MULTIPLIER,
  MAX_BOUNDS,
  MAX_BOUNDS_PADDING,
  MAX_COVERAGE_RECTS,
  MAX_FETCH_BOUNDS,
  MIN_BOUNDS,
} from "@/types/constants"
import { getPortCode } from "@/utils/port"

export const normalizePort = (port: PortLike): PortBase | null => {
  if (!port) return null

  if (typeof port === "string") {
    const code = port.trim()
    if (!code) return null
    return { code }
  }

  if (typeof port === "object") {
    const portObj = port as {
      code?: unknown
      port_code?: unknown
      mega?: unknown
      [key: string]: unknown
    }
    const code =
      typeof portObj.code === "string" ? portObj.code
      : typeof portObj.port_code === "string" ? portObj.port_code
      : null
    if (!code || !code.trim()) return null
    if (typeof portObj.code === "string") {
      return portObj as PortBase
    }
    return { ...portObj, code } as PortBase
  }

  return null
}

export const normalizeMapData = (mapData: MapData): MapData =>
  mapData.map((sector) => normalizeSector(sector))

export const normalizeSector = <T extends Sector>(sector: T): T => ({
  ...sector,
  port: normalizePort(sector.port as PortLike),
})

export const zoomLevels = (() => {
  const levels = Array.from({ length: 5 }, (_, index) =>
    Math.round(MIN_BOUNDS + ((MAX_BOUNDS - MIN_BOUNDS) * index) / 4)
  )
  if (!levels.includes(DEFAULT_MAX_BOUNDS)) {
    levels[1] = DEFAULT_MAX_BOUNDS
  }
  return Array.from(new Set(levels)).sort((a, b) => a - b)
})()

export const clampZoomIndex = (index: number) =>
  Math.max(0, Math.min(zoomLevels.length - 1, index))

export const getClosestZoomIndex = (zoomLevel: number) => {
  let closestIndex = 0
  let closestDistance = Infinity
  zoomLevels.forEach((level, index) => {
    const distance = Math.abs(level - zoomLevel)
    if (distance < closestDistance) {
      closestDistance = distance
      closestIndex = index
    }
  })
  return closestIndex
}

export const getNextZoomLevel = (currentZoom: number, direction: "in" | "out") => {
  const currentIndex = getClosestZoomIndex(currentZoom)
  const nextIndex = clampZoomIndex(direction === "in" ? currentIndex - 1 : currentIndex + 1)
  return zoomLevels[nextIndex]
}

export const getFetchBounds = (zoomLevel: number) => {
  const requested = Math.ceil(zoomLevel * FETCH_BOUNDS_MULTIPLIER + MAX_BOUNDS_PADDING)
  return Math.max(0, Math.min(MAX_FETCH_BOUNDS, requested))
}

/**
 * Compute fetch bounds scaled by the viewport's dominant aspect ratio so
 * non-square viewports fetch enough data to fill the wider axis.
 */
export const getViewportFetchBounds = (
  zoomLevel: number,
  viewportWidth: number,
  viewportHeight: number
) => {
  const safeWidth = Math.max(1, viewportWidth)
  const safeHeight = Math.max(1, viewportHeight)
  const dominantAspect = Math.max(safeWidth / safeHeight, safeHeight / safeWidth)
  return getFetchBounds(zoomLevel * dominantAspect)
}

// =========================================================================
// Sector comparison
// =========================================================================

/** Stable string signature of a sector's lanes for change detection. */
const getLaneSignature = (node: MapSectorNode): string => {
  if (!node.lanes || node.lanes.length === 0) return ""
  return node.lanes
    .map((lane) => JSON.stringify(lane))
    .sort()
    .join("|")
}

/**
 * Deep comparison of two MapSectorNode objects for render-relevant properties.
 * Returns true if both sectors would produce the same visual output.
 */
export const sectorsEquivalentForRender = (a: MapSectorNode, b: MapSectorNode): boolean => {
  if (a.position[0] !== b.position[0] || a.position[1] !== b.position[1]) return false
  if (a.visited !== b.visited) return false
  if (a.source !== b.source) return false
  if (a.region !== b.region) return false
  if (a.hops_from_center !== b.hops_from_center) return false
  if (a.last_visited !== b.last_visited) return false
  if (getPortCode(a.port) !== getPortCode(b.port)) return false
  if (getLaneSignature(a) !== getLaneSignature(b)) return false
  return true
}

// =========================================================================
// Coverage tracking
// =========================================================================

export interface WorldRect {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/** Does outer fully contain inner? */
export const rectContains = (outer: WorldRect, inner: WorldRect): boolean =>
  outer.minX <= inner.minX &&
  outer.maxX >= inner.maxX &&
  outer.minY <= inner.minY &&
  outer.maxY >= inner.maxY

/** Is rect fully covered by at least one candidate? */
export const isRectCovered = (rect: WorldRect, candidates: WorldRect[]): boolean =>
  candidates.some((candidate) => rectContains(candidate, rect))

/** Add a coverage rect, pruning subsumed entries, capping at MAX_COVERAGE_RECTS. */
export const addCoverageRect = (existing: WorldRect[], rect: WorldRect): WorldRect[] => {
  if (isRectCovered(rect, existing)) return existing
  const trimmed = existing.filter((candidate) => !rectContains(rect, candidate))
  const next = [...trimmed, rect]
  if (next.length <= MAX_COVERAGE_RECTS) return next
  return next.slice(next.length - MAX_COVERAGE_RECTS)
}

/** Create a WorldRect from a fetch center (world coords) and hex-distance bounds. */
export const buildCoverageRect = (
  centerWorld: [number, number],
  bounds: number,
): WorldRect => {
  const maxWorldDistance = bounds * SQRT3
  return {
    minX: centerWorld[0] - maxWorldDistance - COVERAGE_PADDING_WORLD,
    maxX: centerWorld[0] + maxWorldDistance + COVERAGE_PADDING_WORLD,
    minY: centerWorld[1] - maxWorldDistance - COVERAGE_PADDING_WORLD,
    maxY: centerWorld[1] + maxWorldDistance + COVERAGE_PADDING_WORLD,
  }
}

// =========================================================================
// Hex grid utilities
// =========================================================================

const SQRT3 = Math.sqrt(3)

/** Convert hex offset coordinates to world position. */
export const hexToWorld = (q: number, r: number) => ({
  x: 1.5 * q,
  y: SQRT3 * (r + 0.5 * (q & 1)),
})

// =========================================================================
// Map data utilities
// =========================================================================

/** Merge multiple MapData arrays, deduplicating by sector ID (first occurrence wins). */
export const deduplicateMapNodes = (...dataSets: MapData[]): MapSectorNode[] => {
  const byId = new Map<number, MapSectorNode>()
  for (const data of dataSets) {
    for (const node of data) {
      if (!byId.has(node.id)) {
        byId.set(node.id, node)
      }
    }
  }
  return Array.from(byId.values())
}

// =========================================================================
// Spatial queries
// =========================================================================

export interface WorldBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  center: [number, number]
}

/** Compute the world-coordinate bounding box of a set of map nodes. */
export const computeWorldBounds = (nodes: MapSectorNode[]): WorldBounds | null => {
  const withPos = nodes.filter((n) => n.position)
  if (withPos.length === 0) return null

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (const node of withPos) {
    const w = hexToWorld(node.position[0], node.position[1])
    minX = Math.min(minX, w.x)
    maxX = Math.max(maxX, w.x)
    minY = Math.min(minY, w.y)
    maxY = Math.max(maxY, w.y)
  }

  return { minX, maxX, minY, maxY, center: [(minX + maxX) / 2, (minY + maxY) / 2] }
}

/** Filter map nodes that fall within a zoom-radius of a world-coordinate center. */
export const getVisibleNodes = (
  nodes: MapSectorNode[],
  center: [number, number],
  zoomLevel: number
): MapSectorNode[] => {
  const maxDist = zoomLevel * SQRT3
  return nodes.filter((node) => {
    if (!node.position) return false
    const w = hexToWorld(node.position[0], node.position[1])
    const dx = w.x - center[0]
    const dy = w.y - center[1]
    return Math.sqrt(dx * dx + dy * dy) <= maxDist
  })
}

/** Find the nearest map node to a world-coordinate center. */
export const findNearestNode = (
  center: [number, number],
  candidates: MapSectorNode[]
): MapSectorNode | undefined => {
  if (candidates.length === 0) return undefined

  let best = candidates[0]
  let bestDist = Infinity

  for (const node of candidates) {
    if (!node.position) continue
    const w = hexToWorld(node.position[0], node.position[1])
    const dx = w.x - center[0]
    const dy = w.y - center[1]
    const dist = dx * dx + dy * dy
    if (dist < bestDist) {
      best = node
      bestDist = dist
    }
  }

  return best
}

/**
 * Find the nearest discovered (visited or sourced) sector to a target sector
 * using hex-grid world-coordinate distance.
 */
export const findNearestDiscoveredSector = (
  targetSectorId: number,
  mapData: MapData
): MapSectorNode | undefined => {
  const discovered = mapData.filter((node) => node.visited || node.source)
  if (discovered.length === 0) return undefined

  const targetNode = mapData.find((node) => node.id === targetSectorId)
  if (!targetNode?.position) return discovered[0]

  const targetWorld = hexToWorld(targetNode.position[0], targetNode.position[1])
  return findNearestNode([targetWorld.x, targetWorld.y], discovered)
}

// =========================================================================
// Map fit computation
// =========================================================================

export interface MapFitResult {
  centerNode: MapSectorNode
  centerWorld: [number, number] | undefined
  fitBoundsWorld: [number, number, number, number] | undefined
  zoomLevel: number
}

/**
 * Compute the center node, world center, bounding box, and zoom level
 * needed to fit a set of sector nodes in view.
 *
 * @param sectorNodes  The specific sectors to fit.
 * @param allMapData   Full (deduplicated) map data for center-node search.
 * @param currentSector  Optional current sector as last-resort center fallback.
 */
export const computeMapFit = (
  sectorNodes: MapSectorNode[],
  allMapData: MapSectorNode[],
  currentSector?: { id: number; position: [number, number] }
): MapFitResult | null => {
  const bounds = computeWorldBounds(sectorNodes)

  // Find the closest discovered (or any) node to the computed center
  const discovered = allMapData.filter((n) => n.position && (n.visited || n.source))
  const candidates = discovered.length > 0 ? discovered : allMapData.filter((n) => n.position)

  let centerNode: MapSectorNode | undefined
  if (bounds && candidates.length > 0) {
    centerNode = findNearestNode(bounds.center, candidates)
  }

  // Fallback chain: first node with position → first node → current sector
  if (!centerNode) {
    const withPosition = sectorNodes.find((n) => n.position)
    if (withPosition) {
      centerNode = withPosition
    } else if (sectorNodes[0]) {
      centerNode = sectorNodes[0]
    } else if (currentSector) {
      const fromMap = allMapData.find((n) => n.id === currentSector.id)
      centerNode =
        fromMap ??
        ({
          id: currentSector.id,
          position: currentSector.position,
          lanes: [],
        } as MapSectorNode)
    }
  }

  if (!centerNode) return null

  // Compute zoom level from bounding box extent
  let targetZoom = DEFAULT_MAX_BOUNDS
  if (bounds) {
    const halfWidth = Math.max(0, (bounds.maxX - bounds.minX) / 2)
    const halfHeight = Math.max(0, (bounds.maxY - bounds.minY) / 2)
    const maxWorldDist = Math.sqrt(halfWidth * halfWidth + halfHeight * halfHeight)
    const maxHexDist = maxWorldDist / SQRT3
    targetZoom = Math.max(MIN_BOUNDS, Math.ceil(maxHexDist) + 1)
  }

  return {
    centerNode,
    centerWorld: bounds?.center,
    fitBoundsWorld: bounds ? [bounds.minX, bounds.maxX, bounds.minY, bounds.maxY] : undefined,
    zoomLevel: Math.max(MIN_BOUNDS, Math.min(MAX_BOUNDS, targetZoom)),
  }
}
