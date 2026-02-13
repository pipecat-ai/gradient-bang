/**
 * SectorMap
 *
 * Wrapper around SectorMapFX that handles lifecycle and render optimization.
 *
 * Performance strategy:
 * - memo comparator does cheap checks only (primitives, reference equality)
 * - Heavy diffing (topology, course plot) happens inside useEffect
 * - Early-exit when nothing meaningful changed avoids unnecessary canvas ops
 * - Config stabilized via JSON to handle inline object props
 */
import { memo, useEffect, useMemo, useRef, useState } from "react"

import { deepmerge } from "deepmerge-ts"
import { ErrorBoundary } from "react-error-boundary"

import type {
  LabelStyles,
  LaneStyles,
  NodeStyles,
  PortStyles,
  SectorMapConfigBase,
  SectorMapController,
  UIStyles,
} from "@/fx/map/SectorMapFX"
import { createSectorMapController, DEFAULT_SECTORMAP_CONFIG } from "@/fx/map/SectorMapFX"

import { Button } from "./primitives/Button"

export type MapConfig = Partial<
  Omit<
    SectorMapConfigBase,
    "center_sector_id" | "nodeStyles" | "laneStyles" | "labelStyles" | "portStyles" | "uiStyles"
  >
> & {
  nodeStyles?: {
    [K in keyof NodeStyles]?: Partial<NodeStyles[K]>
  }
  laneStyles?: {
    [K in keyof LaneStyles]?: Partial<LaneStyles[K]>
  }
  labelStyles?: {
    [K in keyof LabelStyles]?: Partial<LabelStyles[K]>
  }
  portStyles?: {
    [K in keyof PortStyles]?: Partial<PortStyles[K]>
  }
  uiStyles?: Partial<UIStyles>
}

interface MapProps {
  center_sector_id?: number
  current_sector_id?: number
  config?: MapConfig
  map_data: MapData
  width?: number
  height?: number
  maxDistance?: number
  showLegend?: boolean
  coursePlot?: CoursePlot | null
  ships?: number[]
  onNodeClick?: (node: MapSectorNode | null) => void
  onNodeEnter?: (node: MapSectorNode) => void
  onNodeExit?: (node: MapSectorNode) => void
  onMapFetch?: (centerSectorId: number) => void
  /** World-coordinate center override (zoomMode). Undefined for boundMode. */
  center_world?: [number, number]
  /** World-coordinate bounding box override (zoomMode). Undefined for boundMode. */
  fit_bounds_world?: [number, number, number, number]
  /** Monotonic counter from fitMapToSectors to force re-render on fit resolution. */
  mapFitEpoch?: number
}

/** Element-wise comparison for short numeric tuples. */
const tuplesEqual = (a?: number[], b?: number[]): boolean => {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

const RESIZE_DELAY = 300

const mapTopologyChanged = (previous: MapData | null, next: MapData): boolean => {
  if (!previous) return true
  if (previous.length !== next.length) return true

  // Only check if the set of sector IDs changed, not view-relative properties like hops_from_center
  const previousIds = new Set(previous.map((sector) => sector.id))

  for (const sector of next) {
    if (!previousIds.has(sector.id)) {
      return true
    }
  }

  return false
}

const courseplotsEqual = (
  a: CoursePlot | null | undefined,
  b: CoursePlot | null | undefined
): boolean => {
  if (a === b) return true
  if (!a || !b) return false
  return a.from_sector === b.from_sector && a.to_sector === b.to_sector
}

/**
 * Check if we have enough map data to display a view centered on the given sector.
 * Uses spatial distance (position vector) to find sectors within bounds,
 * then checks if any visible sector has lanes to sectors that SHOULD be visible
 * but are missing from our cache.
 */
const hasEnoughMapData = (
  mapData: MapData,
  centerSectorId: number,
  maxDistance: number
): boolean => {
  const sectorIds = new Set(mapData.map((s) => s.id))
  const sectorMap = new Map(mapData.map((s) => [s.id, s]))

  // Center must exist in our data
  const centerSector = sectorMap.get(centerSectorId)
  if (!centerSector) return false

  const centerPos = centerSector.position

  // Find all sectors within spatial bounds of center (using position vector)
  const visibleSectors = mapData.filter((sector) => {
    const dx = sector.position[0] - centerPos[0]
    const dy = sector.position[1] - centerPos[1]
    const distance = Math.sqrt(dx * dx + dy * dy)
    return distance <= maxDistance
  })

  // Check if any visible sector has lanes to sectors that:
  // 1. Are NOT in our cache, AND
  // 2. WOULD be within our spatial bounds (if we knew their position)
  // Since we don't know positions of missing sectors, we check if the lane
  // destination exists in cache - if it does, we can verify it's covered.
  // If it doesn't exist but the SOURCE sector is well inside our bounds
  // (not at the edge), then we're missing interior data.
  for (const sector of visibleSectors) {
    const sectorDx = sector.position[0] - centerPos[0]
    const sectorDy = sector.position[1] - centerPos[1]
    const sectorDistance = Math.sqrt(sectorDx * sectorDx + sectorDy * sectorDy)

    // Only check lanes from "inner" sectors (not at the edge of our bounds)
    // Edge sectors are expected to have lanes pointing outside
    const isInnerSector = sectorDistance <= maxDistance * 0.7

    if (isInnerSector) {
      for (const lane of sector.lanes) {
        if (!sectorIds.has(lane.to)) {
          // Inner sector has lane to unknown sector - likely missing data
          return false
        }
      }
    }
  }

  return true
}

const MapComponent = ({
  center_sector_id: center_sector_id_prop,
  current_sector_id,
  config,
  map_data,
  width,
  height,
  maxDistance = 2,
  coursePlot,
  ships,
  onNodeClick,
  onNodeEnter,
  onNodeExit,
  onMapFetch,
  center_world,
  fit_bounds_world,
  mapFitEpoch,
}: MapProps) => {
  // Normalize map_data to always be an array (memoized to avoid dependency changes)
  const normalizedMapData = useMemo(() => map_data ?? [], [map_data])

  // Stabilize ships data - convert flat array to Map<sectorId, count>
  const shipsKey = ships?.join(",") ?? ""
  const shipsMap = useMemo(() => {
    if (!ships || ships.length === 0) return undefined
    const map = new Map<number, number>()
    for (const sectorId of ships) {
      map.set(sectorId, (map.get(sectorId) ?? 0) + 1)
    }
    return map
  }, [ships])

  // Default center_sector_id to current_sector_id if not provided
  const center_sector_id = center_sector_id_prop ?? current_sector_id ?? 0

  // Warn if center sector doesn't exist in map data
  useEffect(() => {
    const exists = normalizedMapData.some((sector) => sector.id === center_sector_id)
    if (!exists && normalizedMapData.length > 0) {
      console.warn(
        `[SectorMap] Center sector ${center_sector_id} not found in map data. ` +
          `Map will render without centering.`
      )
    }
  }, [normalizedMapData, center_sector_id])
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const controllerRef = useRef<SectorMapController | null>(null)
  const prevCenterSectorIdRef = useRef<number>(center_sector_id)
  const prevCurrentSectorIdRef = useRef<number | undefined>(current_sector_id)
  const previousMapRef = useRef<MapData | null>(null)
  const lastMaxDistanceRef = useRef<number | undefined>(maxDistance)
  const lastConfigRef = useRef<Omit<SectorMapConfigBase, "center_sector_id"> | null>(null)
  const lastCoursePlotRef = useRef<CoursePlot | null | undefined>(coursePlot)
  const lastShipsKeyRef = useRef<string>(shipsKey)
  const lastCenterWorldRef = useRef<[number, number] | undefined>(center_world)
  const lastFitBoundsWorldRef = useRef<[number, number, number, number] | undefined>(
    fit_bounds_world
  )
  const lastMapFitEpochRef = useRef<number | undefined>(mapFitEpoch)
  const maxZoomFetchedRef = useRef<Map<number, number>>(new Map())

  const [measuredSize, setMeasuredSize] = useState<{
    width: number
    height: number
  } | null>(null)

  // Track whether the controller has completed its first render with data.
  // Uses a ref (not state) to avoid cascading renders and effect destabilization.
  // The canvas opacity is set imperatively via the DOM when this flips to true.
  const hasRenderedRef = useRef(false)

  const isAutoSizing = width === undefined && height === undefined
  const isWaitingForMeasurement = isAutoSizing && measuredSize === null

  // Memoize effective dimensions to prevent unnecessary effect triggers
  const effectiveWidth = useMemo(
    () => width ?? measuredSize?.width ?? 440,
    [width, measuredSize?.width]
  )

  const effectiveHeight = useMemo(
    () => height ?? measuredSize?.height ?? 440,
    [height, measuredSize?.height]
  )

  const lastDimensionsRef = useRef<{ width: number; height: number }>({
    width: effectiveWidth,
    height: effectiveHeight,
  })

  // Stabilize config comparison using JSON serialization to avoid
  // re-renders when parent passes a new object with the same values
  const configKey = JSON.stringify(config)

  const baseConfig = useMemo<Omit<SectorMapConfigBase, "center_sector_id">>(() => {
    const parsedConfig = configKey ? JSON.parse(configKey) : {}
    return deepmerge(DEFAULT_SECTORMAP_CONFIG, parsedConfig) as Omit<
      SectorMapConfigBase,
      "center_sector_id"
    >
  }, [configKey])

  // ResizeObserver effect for auto-sizing
  useEffect(() => {
    if (!isAutoSizing || !containerRef.current) return

    let timeoutId: number | null = null
    const observer = new ResizeObserver((entries) => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId)
      }
      timeoutId = window.setTimeout(() => {
        const entry = entries[0]
        if (entry) {
          const { width, height } = entry.contentRect
          console.debug("[GAME SECTOR MAP] Resizing", { width, height })
          setMeasuredSize({ width, height })
        }
      }, RESIZE_DELAY)
    })

    observer.observe(containerRef.current)

    return () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId)
      }
      observer.disconnect()
    }
  }, [isAutoSizing])

  useEffect(() => {
    const controller = controllerRef.current
    if (!controller) return // Not initialized yet

    const dimensionsChanged =
      lastDimensionsRef.current.width !== effectiveWidth ||
      lastDimensionsRef.current.height !== effectiveHeight

    if (dimensionsChanged) {
      console.debug("[GAME SECTOR MAP] Dimensions changed, updating", {
        from: lastDimensionsRef.current,
        to: { width: effectiveWidth, height: effectiveHeight },
      })

      controller.updateProps({
        width: effectiveWidth,
        height: effectiveHeight,
      })
      controller.render()

      lastDimensionsRef.current = {
        width: effectiveWidth,
        height: effectiveHeight,
      }
    }
  }, [effectiveWidth, effectiveHeight])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let controller = controllerRef.current

    if (!controller) {
      console.debug("%c[SectorMap] Init", "color: red; font-weight: bold", {
        center_sector_id,
        maxDistance,
        center_world,
        fit_bounds_world,
      })

      controller = createSectorMapController(canvas, {
        width: lastDimensionsRef.current.width,
        height: lastDimensionsRef.current.height,
        data: normalizedMapData,
        config: {
          ...baseConfig,
          center_sector_id,
          current_sector_id,
          center_world,
          fit_bounds_world,
        },
        maxDistance,
        coursePlot,
        ships: shipsMap,
      })
      controllerRef.current = controller
      prevCenterSectorIdRef.current = center_sector_id
      prevCurrentSectorIdRef.current = current_sector_id
      previousMapRef.current = normalizedMapData
      lastMaxDistanceRef.current = maxDistance
      lastConfigRef.current = baseConfig
      lastCoursePlotRef.current = coursePlot
      lastShipsKeyRef.current = shipsKey
      lastCenterWorldRef.current = center_world
      lastFitBoundsWorldRef.current = fit_bounds_world
      lastMapFitEpochRef.current = mapFitEpoch
      maxZoomFetchedRef.current.set(center_sector_id, maxDistance)

      // Trigger CSS fade-in once the first render with data completes
      if (!hasRenderedRef.current && normalizedMapData.length > 0) {
        hasRenderedRef.current = true
        canvas.style.opacity = "1"
      }
      return
    }

    // Compute changes BEFORE logging to enable early exit
    const topologyChanged = mapTopologyChanged(previousMapRef.current, normalizedMapData)
    const centerSectorChanged = center_sector_id !== prevCenterSectorIdRef.current
    const currentSectorChanged = current_sector_id !== prevCurrentSectorIdRef.current
    const maxDistanceChanged = lastMaxDistanceRef.current !== maxDistance
    const configChanged = lastConfigRef.current !== baseConfig
    const coursePlotChanged = !courseplotsEqual(lastCoursePlotRef.current, coursePlot)
    const shipsChanged = lastShipsKeyRef.current !== shipsKey
    const centerWorldChanged = !tuplesEqual(lastCenterWorldRef.current, center_world)
    const fitBoundsWorldChanged = !tuplesEqual(lastFitBoundsWorldRef.current, fit_bounds_world)
    const mapFitEpochChanged = lastMapFitEpochRef.current !== mapFitEpoch

    // Early exit if nothing has actually changed
    if (
      !topologyChanged &&
      !centerSectorChanged &&
      !currentSectorChanged &&
      !maxDistanceChanged &&
      !configChanged &&
      !coursePlotChanged &&
      !shipsChanged &&
      !centerWorldChanged &&
      !fitBoundsWorldChanged &&
      !mapFitEpochChanged
    ) {
      return
    }

    // Build full config with overrides
    const fullConfig = {
      ...baseConfig,
      center_sector_id,
      current_sector_id,
      center_world,
      fit_bounds_world,
    }

    // Update config when config, center_sector_id, current_sector_id, or world overrides change
    const needsConfigUpdate =
      configChanged ||
      centerSectorChanged ||
      currentSectorChanged ||
      centerWorldChanged ||
      fitBoundsWorldChanged

    controller.updateProps({
      maxDistance,
      ...(needsConfigUpdate && { config: fullConfig }),
      data: normalizedMapData,
      coursePlot,
      ships: shipsMap,
    })

    // World-coordinate overrides changed (zoomMode) -- animate camera reframe
    if (centerWorldChanged || fitBoundsWorldChanged || mapFitEpochChanged) {
      console.debug("%c[SectorMap] Zoom reframe", "color: red; font-weight: bold", {
        center_world,
        fit_bounds_world,
        mapFitEpoch,
      })
      if (needsConfigUpdate) {
        controller.updateProps({ config: fullConfig })
      }
      controller.moveToSector(center_sector_id, normalizedMapData)
    } else if (centerSectorChanged || maxDistanceChanged || coursePlotChanged || topologyChanged) {
      let skipReframe = false
      const hasEnough = hasEnoughMapData(normalizedMapData, center_sector_id, maxDistance)
      const prevMax = maxZoomFetchedRef.current.get(center_sector_id) ?? 0
      const needsFetchByZoom = maxDistance > prevMax
      const needsFetchByTopology = !hasEnough

      // Trigger fetch when USER changes center OR zoom level (not on topology updates)
      // This prevents recursion: action → fetch → topology changes → fetch → ...
      if (
        (centerSectorChanged || maxDistanceChanged) &&
        (needsFetchByZoom || needsFetchByTopology)
      ) {
        const targetSector = normalizedMapData.find((s) => s.id === center_sector_id)
        const canFetch = targetSector?.visited === true

        if (canFetch) {
          console.debug("%c[SectorMap] Fetch map data", "color: red; font-weight: bold", {
            sector: center_sector_id,
            maxDistance,
            needsFetchByZoom,
            needsFetchByTopology,
          })
          if (maxDistance > prevMax) {
            maxZoomFetchedRef.current.set(center_sector_id, maxDistance)
          }
          onMapFetch?.(center_sector_id)
          if (needsFetchByTopology) {
            skipReframe = true
          }
        }
      }

      if (!skipReframe) {
        console.debug("%c[SectorMap] Move to sector", "color: red; font-weight: bold", {
          sector: center_sector_id,
          maxDistance,
          topologyChanged,
          coursePlotChanged,
        })
        controller.moveToSector(center_sector_id, normalizedMapData)
      }

      prevCenterSectorIdRef.current = center_sector_id
    } else if (needsConfigUpdate || shipsChanged) {
      console.debug("%c[SectorMap] Re-render", "color: red; font-weight: bold", {
        configChanged,
        shipsChanged,
      })
      controller.render()
    }

    // If data arrived after initial empty render, trigger fade-in
    if (!hasRenderedRef.current && normalizedMapData.length > 0 && canvasRef.current) {
      hasRenderedRef.current = true
      canvasRef.current.style.opacity = "1"
    }

    previousMapRef.current = normalizedMapData
    prevCurrentSectorIdRef.current = current_sector_id
    lastMaxDistanceRef.current = maxDistance
    lastConfigRef.current = baseConfig
    lastCoursePlotRef.current = coursePlot
    lastShipsKeyRef.current = shipsKey
    lastCenterWorldRef.current = center_world
    lastFitBoundsWorldRef.current = fit_bounds_world
    lastMapFitEpochRef.current = mapFitEpoch
  }, [
    center_sector_id,
    current_sector_id,
    normalizedMapData,
    maxDistance,
    baseConfig,
    coursePlot,
    shipsKey,
    shipsMap,
    onMapFetch,
    center_world,
    fit_bounds_world,
    mapFitEpoch,
  ])

  // Update click callback when it changes
  useEffect(() => {
    const controller = controllerRef.current
    if (controller) {
      controller.setOnNodeClick(onNodeClick ?? null)
    }
  }, [onNodeClick])

  // Update hover callbacks when they change
  useEffect(() => {
    const controller = controllerRef.current
    if (controller) {
      controller.setOnNodeEnter(onNodeEnter ?? null)
      controller.setOnNodeExit(onNodeExit ?? null)
    }
  }, [onNodeEnter, onNodeExit])

  // Cleanup effect
  useEffect(() => {
    return () => {
      console.debug("[GAME SECTOR MAP] Cleaning up SectorMap controller")
      if (controllerRef.current) {
        controllerRef.current.cleanup()
      }
      controllerRef.current = null
    }
  }, [])

  return (
    <ErrorBoundary
      onError={(error, info) =>
        console.error("[SectorMap] Render error", error, info.componentStack)
      }
      fallbackRender={({ error, resetErrorBoundary }) => (
        <div className="flex h-full w-full items-center justify-center">
          <div className="flex flex-col items-center gap-2 text-xs text-muted-foreground">
            <p>Map failed to render</p>
            <p className="text-xxs opacity-60">
              {error instanceof Error ? error.message : String(error)}
            </p>
            <Button variant="secondary" size="sm" onClick={resetErrorBoundary}>
              Retry
            </Button>
          </div>
        </div>
      )}
    >
      <div
        ref={containerRef}
        style={{
          display: "grid",
          gap: 8,
          overflow: "hidden",
          ...(isAutoSizing && { width: "100%", height: "100%" }),
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            width: `${effectiveWidth}px`,
            height: `${effectiveHeight}px`,
            maxWidth: "100%",
            maxHeight: "100%",
            display: "block",
            objectFit: "contain",
            opacity: 0,
            transition: "opacity 0.4s ease-in",
            ...(isWaitingForMeasurement && { visibility: "hidden" }),
          }}
        />
      </div>
    </ErrorBoundary>
  )
}

// Custom comparison function for React.memo to prevent unnecessary re-renders
// Uses cheap checks only - heavy diffing (mapTopologyChanged, courseplotsEqual)
// happens inside the component's useEffect for better performance
const areMapPropsEqual = (prevProps: MapProps, nextProps: MapProps): boolean => {
  // Check cheap primitives FIRST - if any differ, skip other checks entirely
  if (prevProps.center_sector_id !== nextProps.center_sector_id) return false
  if (prevProps.current_sector_id !== nextProps.current_sector_id) return false
  if (prevProps.width !== nextProps.width) return false
  if (prevProps.height !== nextProps.height) return false
  if (prevProps.maxDistance !== nextProps.maxDistance) return false
  if (prevProps.showLegend !== nextProps.showLegend) return false

  // Config - JSON comparison (cheap for small config objects)
  if (prevProps.config !== nextProps.config) {
    if (JSON.stringify(prevProps.config) !== JSON.stringify(nextProps.config)) {
      return false
    }
  }

  // Heavy objects - REFERENCE ONLY check in memo
  // The component's internal useEffect handles the actual change detection
  // via mapTopologyChanged() and courseplotsEqual() with early-exit optimization
  if (prevProps.map_data !== nextProps.map_data) return false
  if (prevProps.coursePlot !== nextProps.coursePlot) return false

  // Ships - use join for fast string comparison
  if (prevProps.ships !== nextProps.ships) {
    if ((prevProps.ships?.join(",") ?? "") !== (nextProps.ships?.join(",") ?? "")) {
      return false
    }
  }

  // World-coordinate overrides (zoomMode)
  if (!tuplesEqual(prevProps.center_world, nextProps.center_world)) return false
  if (!tuplesEqual(prevProps.fit_bounds_world, nextProps.fit_bounds_world)) return false
  if (prevProps.mapFitEpoch !== nextProps.mapFitEpoch) return false

  return true
}

export const SectorMap = memo(MapComponent, areMapPropsEqual)

export default SectorMap
