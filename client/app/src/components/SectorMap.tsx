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
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

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
import { getViewportFetchBounds, sectorsEquivalentForRender } from "@/utils/map"

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
  onMapFetch?: (centerSectorId: number, bounds: number) => void
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

  const previousById = new Map<number, MapSectorNode>(
    previous.map((sector) => [sector.id, sector] as const)
  )

  for (const nextSector of next) {
    const previousSector = previousById.get(nextSector.id)
    if (!previousSector) return true
    if (!sectorsEquivalentForRender(previousSector, nextSector)) return true
  }

  return false
}

const courseplotsEqual = (
  a: CoursePlot | null | undefined,
  b: CoursePlot | null | undefined
): boolean => {
  if (a === b) return true
  if (!a || !b) return false
  if (a.from_sector !== b.from_sector || a.to_sector !== b.to_sector) return false
  if (a.path.length !== b.path.length) return false
  for (let i = 0; i < a.path.length; i++) {
    if (a.path[i] !== b.path[i]) return false
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
  const pendingControllerCleanupRef = useRef<number | null>(null)

  const [measuredSize, setMeasuredSize] = useState<{
    width: number
    height: number
  } | null>(null)

  const isAutoSizing = width === undefined && height === undefined
  const hasValidMeasurement =
    measuredSize !== null && measuredSize.width > 0 && measuredSize.height > 0
  const isWaitingForMeasurement = isAutoSizing && !hasValidMeasurement

  // Memoize effective dimensions to prevent unnecessary effect triggers
  const effectiveWidth = useMemo(
    () => width ?? (hasValidMeasurement ? measuredSize.width : 440),
    [width, hasValidMeasurement, measuredSize]
  )

  const effectiveHeight = useMemo(
    () => height ?? (hasValidMeasurement ? measuredSize.height : 440),
    [height, hasValidMeasurement, measuredSize]
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

  // Synchronously sample initial size to avoid rendering visible 440×440 fallback
  useLayoutEffect(() => {
    if (!isAutoSizing || measuredSize !== null) return
    const container = containerRef.current
    if (!container) return
    const { width: measuredWidth, height: measuredHeight } = container.getBoundingClientRect()
    if (measuredWidth > 0 && measuredHeight > 0) {
      setMeasuredSize({ width: measuredWidth, height: measuredHeight })
    }
  }, [isAutoSizing, measuredSize])

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
          const { width: measuredWidth, height: measuredHeight } = entry.contentRect
          if (measuredWidth > 0 && measuredHeight > 0) {
            console.debug("[GAME SECTOR MAP] Resizing", {
              width: measuredWidth,
              height: measuredHeight,
            })
            setMeasuredSize({ width: measuredWidth, height: measuredHeight })
          }
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

  // Dimension change effect
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

  // Main controller update effect
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

    // Determine if a camera reframe is needed
    const reframeRequested =
      centerSectorChanged ||
      centerWorldChanged ||
      fitBoundsWorldChanged ||
      maxDistanceChanged ||
      mapFitEpochChanged

    if (reframeRequested) {
      // Signal that viewport intent changed — coverage dedup happens in mapSlice
      const requiredBounds = getViewportFetchBounds(maxDistance, effectiveWidth, effectiveHeight)
      onMapFetch?.(center_sector_id, requiredBounds)

      console.debug("%c[SectorMap] Move to sector", "color: red; font-weight: bold", {
        sector: center_sector_id,
        maxDistance,
        centerWorldChanged,
        fitBoundsWorldChanged,
        mapFitEpochChanged,
      })
      controller.moveToSector(center_sector_id, normalizedMapData)

      prevCenterSectorIdRef.current = center_sector_id
    } else if (needsConfigUpdate || shipsChanged || coursePlotChanged || topologyChanged) {
      console.debug("%c[SectorMap] Re-render", "color: red; font-weight: bold", {
        configChanged,
        shipsChanged,
        coursePlotChanged,
        topologyChanged,
      })
      controller.render()
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
    effectiveWidth,
    effectiveHeight,
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

  // Wire viewport change (from manual pan/zoom) to the same fetch path
  useEffect(() => {
    const controller = controllerRef.current
    if (controller) {
      controller.setOnViewportChange(onMapFetch ?? null)
    }
  }, [onMapFetch])

  // Cleanup effect — StrictMode-safe via deferred cleanup
  useEffect(() => {
    if (pendingControllerCleanupRef.current !== null) {
      window.clearTimeout(pendingControllerCleanupRef.current)
      pendingControllerCleanupRef.current = null
    }
    return () => {
      pendingControllerCleanupRef.current = window.setTimeout(() => {
        console.debug("[GAME SECTOR MAP] Cleaning up SectorMap controller")
        if (controllerRef.current) {
          controllerRef.current.cleanup()
        }
        controllerRef.current = null
        pendingControllerCleanupRef.current = null
      }, 0)
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
