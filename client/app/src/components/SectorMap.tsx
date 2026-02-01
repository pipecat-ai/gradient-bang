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
  debug?: boolean
  coursePlot?: CoursePlot | null
  ships?: number[]
  onNodeClick?: (node: MapSectorNode | null) => void
  onNodeEnter?: (node: MapSectorNode) => void
  onNodeExit?: (node: MapSectorNode) => void
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

const MapComponent = ({
  center_sector_id: center_sector_id_prop,
  current_sector_id,
  config,
  map_data,
  width,
  height,
  maxDistance = 2,
  showLegend = false,
  coursePlot,
  ships,
  onNodeClick,
  onNodeEnter,
  onNodeExit,
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

  const [measuredSize, setMeasuredSize] = useState<{
    width: number
    height: number
  } | null>(null)

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
      console.debug("[GAME SECTOR MAP] Initializing SectorMap")

      controller = createSectorMapController(canvas, {
        width: lastDimensionsRef.current.width,
        height: lastDimensionsRef.current.height,
        data: normalizedMapData,
        config: { ...baseConfig, center_sector_id, current_sector_id },
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

    // Early exit if nothing has actually changed
    if (
      !topologyChanged &&
      !centerSectorChanged &&
      !currentSectorChanged &&
      !maxDistanceChanged &&
      !configChanged &&
      !coursePlotChanged &&
      !shipsChanged
    ) {
      return
    }

    console.debug("[GAME SECTOR MAP] Updating SectorMap", {
      topologyChanged,
      centerSectorChanged,
      currentSectorChanged,
      maxDistanceChanged,
      configChanged,
      coursePlotChanged,
      shipsChanged,
      "old map": previousMapRef.current,
      "new map": normalizedMapData,
    })

    // Update config when config, center_sector_id, or current_sector_id changes
    const needsConfigUpdate = configChanged || centerSectorChanged || currentSectorChanged

    controller.updateProps({
      maxDistance,
      ...(needsConfigUpdate && { config: { ...baseConfig, center_sector_id, current_sector_id } }),
      data: normalizedMapData,
      coursePlot,
      ships: shipsMap,
    })

    if (centerSectorChanged || maxDistanceChanged || coursePlotChanged || topologyChanged) {
      // Camera needs to move or topology changed - use moveToSector to ensure new data is used
      console.debug("[GAME SECTOR MAP] Moving to sector", center_sector_id)
      controller.moveToSector(center_sector_id, normalizedMapData)
      prevCenterSectorIdRef.current = center_sector_id
    } else if (needsConfigUpdate || shipsChanged) {
      // Config/ships changed but topology and camera stay the same - just re-render
      console.debug("[GAME SECTOR MAP] Rendering SectorMap (config/ships changed)")
      controller.render()
    }

    previousMapRef.current = normalizedMapData
    prevCurrentSectorIdRef.current = current_sector_id
    lastMaxDistanceRef.current = maxDistance
    lastConfigRef.current = baseConfig
    lastCoursePlotRef.current = coursePlot
    lastShipsKeyRef.current = shipsKey
  }, [
    center_sector_id,
    current_sector_id,
    normalizedMapData,
    maxDistance,
    baseConfig,
    coursePlot,
    shipsKey,
    shipsMap,
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
          // Hide until size is measured to prevent visual jump
          ...(isWaitingForMeasurement && { visibility: "hidden" }),
        }}
      />
      {showLegend && baseConfig.nodeStyles && (
        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            fontSize: 12,
            color: "#bbb",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 14,
                height: 14,
                background: baseConfig.nodeStyles.visited.fill,
                border: `${baseConfig.nodeStyles.visited.borderWidth}px solid ${baseConfig.nodeStyles.visited.border}`,
              }}
            />
            Visited
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 14,
                height: 14,
                background: baseConfig.nodeStyles.unvisited.fill,
                border: `${baseConfig.nodeStyles.unvisited.borderWidth}px solid ${baseConfig.nodeStyles.unvisited.border}`,
              }}
            />
            Unvisited
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 14,
                height: 14,
                background: baseConfig.portStyles.regular.color,
                borderRadius: 7,
              }}
            />
            Port
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 14,
                height: 14,
                background: baseConfig.portStyles.mega.color,
                borderRadius: 7,
              }}
            />
            Mega Port
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 16,
                height: 2,
                background: baseConfig.laneStyles.normal.color,
              }}
            />
            Lane
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 14,
                height: 14,
                border: `${baseConfig.nodeStyles.crossRegion.borderWidth}px solid ${baseConfig.nodeStyles.crossRegion.border}`,
                background: baseConfig.nodeStyles.crossRegion.fill,
              }}
            />
            Cross-region sector (vs current)
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ position: "relative", width: 18, height: 10 }}>
              <span
                style={{
                  position: "absolute",
                  top: 4,
                  left: 0,
                  width: 12,
                  height: 2,
                  background: baseConfig.laneStyles.oneWay.color,
                }}
              />
              <span
                style={{
                  position: "absolute",
                  top: 1,
                  left: 10,
                  width: 0,
                  height: 0,
                  borderTop: "4px solid transparent",
                  borderBottom: "4px solid transparent",
                  borderLeft: `6px solid ${baseConfig.laneStyles.oneWay.arrowColor}`,
                }}
              />
            </span>
            One-way
          </span>
          {baseConfig.show_hyperlanes && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  width: 16,
                  height: 2,
                  background: `linear-gradient(90deg, transparent, ${baseConfig.laneStyles.hyperlane.color}, transparent)`,
                }}
              />
              Hyperlane
            </span>
          )}
        </div>
      )}
    </div>
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

  // Callback - reference equality (updates handled by separate useEffect)
  /*
  if (prevProps.onNodeClick !== nextProps.onNodeClick) return false
  if (prevProps.onNodeEnter !== nextProps.onNodeEnter) return false
  if (prevProps.onNodeExit !== nextProps.onNodeExit) return false*/

  return true
}

export const SectorMap = memo(MapComponent, areMapPropsEqual)

export default SectorMap
